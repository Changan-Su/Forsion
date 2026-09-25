/**
 * TUI 输入历史:跨会话落盘到 <tanguHome>/tui_history(dev 形态 TANGU_HOME 已指向隔离家目录,这里不另判)。
 *
 * - 格式:每行一个 JSON 字符串(Alt+Enter 的多行输入原样保留,不会被行切碎);读到坏行按原文收下。
 * - 规则(同 shell 的 HISTCONTROL=ignoreboth):空白行不记;**以空格开头的行不记**(用户主动「别记这条」);
 *   与上一条相同不重复记;↑ 最多翻最近 500 条。盘上不是严格 500 条:攒到 2×500 = 1000 条才整理回最近 500 条
 *   (见下「偶尔整理」),所以文件里最多约 1000 条(整理撞上别的进程追加而放弃时还会再多几条)。
 * - 形似密钥的行(sk-… / ghp_… / AKIA… / 私钥头)本会话仍可 ↑ 找回,但**不落盘**。
 * - 模块级单例而非组件 useRef:InputBox 在审批 / 选择器弹出时会被卸载,放组件里每次审批都会把历史清空。
 * - 写盘=O_APPEND 追加一行(appendFileSync):两个 tangu 同时开,各自的新行都是一次 append,谁也盖不掉谁。
 *   旧版「读 → 追加 → 原子替换整份」在两个进程同时读到同一份时,后 rename 的会吞掉先写的那行(Codex 评审 tui #3)。
 * - 截断改成「偶尔整理」:文件攒到 2×limit 条才重写成最近 limit 条(每 ~500 次输入一次)。重写前核对文件大小
 *   仍是刚读到的那么大,变了(别的进程刚追加)就这次不整理、照常追加。残余窗口只剩「核对 → rename」之间那一下,
 *   且只在整理那一次;要彻底消掉得上跨进程锁,为一个便利功能不值得在输入路径上阻塞等锁。
 * - 读时把相邻重复折叠掉(两个进程各记了同一条、或追加前的去重检查与别人的追加撞车,都只是多一行,读时收拾)。
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tanguHome } from '../core/tanguHome.js';

export const HISTORY_LIMIT = 500;

export const historyFile = (): string => join(tanguHome(), 'tui_history');

/** 会不会记进历史(内存 + 磁盘都看这一条)。 */
export function shouldRecord(line: string): boolean {
  return !!line.trim() && !/^\s/.test(line);
}

const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic 风格
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub token
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
export const looksSecret = (line: string): boolean => SECRET_RES.some((re) => re.test(line));

/** 追加一条(不可变):不记的行原样返回;与末条相同不重复;截到最近 limit 条。 */
export function pushHistory(entries: string[], line: string, limit = HISTORY_LIMIT): string[] {
  if (!shouldRecord(line)) return entries;
  if (entries[entries.length - 1] === line) return entries;
  const next = [...entries, line];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function parseHistory(raw: string): string[] {
  const out: string[] = [];
  const add = (v: string): void => {
    if (out[out.length - 1] !== v) out.push(v); // 相邻重复折叠(见文件头)
  };
  for (const ln of raw.split('\n')) {
    if (!ln) continue;
    try {
      const v = JSON.parse(ln);
      if (typeof v === 'string' && v) add(v);
    } catch {
      add(ln); // 手工编辑 / 旧格式:整行当一条(也包括追加撞车时被截半的行 —— 丢一条总比整份读不出来强)
    }
  }
  return out;
}

export const serializeHistory = (entries: string[]): string => entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');

export function loadHistory(file = historyFile(), limit = HISTORY_LIMIT): string[] {
  try {
    const all = parseHistory(readFileSync(file, 'utf8'));
    return all.length > limit ? all.slice(all.length - limit) : all;
  } catch {
    return [];
  }
}

/** 读盘上现状;size 按字节记(整理前据此判断读后有没有人追加过)。 */
const readRaw = (file: string): { raw: string; size: number } => {
  try {
    const buf = readFileSync(file);
    return { raw: buf.toString('utf8'), size: buf.length };
  } catch {
    return { raw: '', size: 0 };
  }
};

/**
 * 攒到 2×limit 条时重写成最近 limit 条(含本条)。返回是否已由整理写入本条;文件在读后被别人追加过 → 不整理(false)。
 */
function compactWith(file: string, readSize: number, all: string[], line: string, limit: number): boolean {
  if (all.length < limit * 2) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, serializeHistory(pushHistory(all.slice(-limit), line, limit)), { mode: 0o600 });
    // 读完之后有人追加过:这次不整理,别用旧快照把人家的新行盖掉。
    if (statSync(file).size !== readSize) throw new Error('changed');
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      unlinkSync(tmp); // 自己刚写的临时文件,不留残骸
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** 把一条落盘(不落盘的行直接跳过)。失败静默:历史是便利功能,不能因为磁盘问题打断输入。 */
export function persistHistoryLine(line: string, file = historyFile(), limit = HISTORY_LIMIT): void {
  if (!shouldRecord(line) || looksSecret(line)) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const { raw, size } = readRaw(file);
    const all = parseHistory(raw);
    if (all[all.length - 1] === line) return; // 与盘上末条相同:不重复记
    if (compactWith(file, size, all, line, limit)) return;
    // 输入可能含私密内容:新建时仅本人可读。整行一次 write,O_APPEND 保证与别的进程的追加不互相覆盖。
    // 手工编辑过、末尾没换行的文件:先补一个换行,别把新行粘到人家最后一行后面。
    const sep = raw && !raw.endsWith('\n') ? '\n' : '';
    appendFileSync(file, sep + serializeHistory([line]), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

export interface HistoryStore {
  /** 旧 → 新。 */
  list(): string[];
  add(line: string): void;
}

/** 启动时载入一次;本会话新增的行进内存(↑↓ 用)并同步落盘。 */
export function createHistoryStore(file = historyFile(), limit = HISTORY_LIMIT): HistoryStore {
  let entries = loadHistory(file, limit);
  return {
    list: () => entries,
    add(line: string) {
      entries = pushHistory(entries, line, limit);
      persistHistoryLine(line, file, limit);
    },
  };
}

let shared: HistoryStore | null = null;
/** 进程级单例(懒加载:tanguHome 可能在启动早期才由 .env 定下来)。 */
export function inputHistory(): HistoryStore {
  if (!shared) shared = createHistoryStore();
  return shared;
}
