/**
 * TUI 输入历史:跨会话落盘到 <tanguHome>/tui_history(dev 形态 TANGU_HOME 已指向隔离家目录,这里不另判)。
 *
 * - 格式:每行一个 JSON 字符串(Alt+Enter 的多行输入原样保留,不会被行切碎);读到坏行按原文收下。
 * - 规则(同 shell 的 HISTCONTROL=ignoreboth):空白行不记;**以空格开头的行不记**(用户主动「别记这条」);
 *   与上一条相同不重复记;最多保留最近 500 条。
 * - 形似密钥的行(sk-… / ghp_… / AKIA… / 私钥头)本会话仍可 ↑ 找回,但**不落盘**。
 * - 模块级单例而非组件 useRef:InputBox 在审批 / 选择器弹出时会被卸载,放组件里每次审批都会把历史清空。
 * - 写盘=读盘上最新 → 追加 → 截断 → 原子替换:两个 tangu 同时开也不会互相整份覆盖掉对方的新行。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  for (const ln of raw.split('\n')) {
    if (!ln) continue;
    try {
      const v = JSON.parse(ln);
      if (typeof v === 'string' && v) out.push(v);
    } catch {
      out.push(ln); // 手工编辑 / 旧格式:整行当一条
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

/** 把一条落盘(不落盘的行直接跳过)。失败静默:历史是便利功能,不能因为磁盘问题打断输入。 */
export function persistHistoryLine(line: string, file = historyFile(), limit = HISTORY_LIMIT): void {
  if (!shouldRecord(line) || looksSecret(line)) return;
  try {
    const next = pushHistory(loadHistory(file, limit), line, limit);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeHistory(next), { mode: 0o600 }); // 输入可能含私密内容:仅本人可读
    renameSync(tmp, file);
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
