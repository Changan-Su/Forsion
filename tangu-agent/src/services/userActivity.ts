/**
 * 用户活动日志(app 级,跨 agent)—— `~/.tangu/activity/<YYYY-MM-DD>.log`,一行一事件:
 *
 *   202607110216 chat.new s=a1b2c3 "帮我整理今天的任务清单,先把…"
 *   202607110209 note.edit f="Notes/xxx.md" l=8-9
 *
 * 写入口有两个,格式/消毒**必须同款**(改一处须同步另一处):
 *   ① 桌面 UI 行为:desktop/electron/activityLog.ts(renderer 埋点经 IPC 到 main 落盘);
 *   ② 引擎侧行为:本文件 appendActivityLine(v1 只接 agent 改文件,见 tools/registry.ts executeTool)。
 * 读端:read_activity 工具(默认仅 Muse)+ muse.ts kickoff 活动尾部注入。
 * 时间戳=本地时间 YYYYMMDDHHMM(与 muse.ts lastDates/inboxSend 同「设备本地时区」语义)。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { forsionSharedDir } from '../core/tanguHome.js';

// 共享域(desktop main 也直写此目录;home=…/tangu 时为其父目录,见 forsionSharedDir)
export const activityDir = (): string => join(forsionSharedDir(), 'activity');

const EVENT_RE = /^[a-z][a-z0-9:._-]*$/;
const LINE_CAP = 200;
const VALUE_CAP = 80;

function pad(x: number): string {
  return String(x).padStart(2, '0');
}

/** 本地时间戳 YYYYMMDDHHMM。 */
export function activityTs(at = new Date()): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}`;
}

function localDateStr(at = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** 值消毒:换行/连续空白折叠、双引号降级单引号、截断——用户内容进不了行结构(防伪造事件行)。 */
function cleanValue(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, VALUE_CAP);
}

/**
 * 拼一行(不含换行)。detail 的 `text` 键作尾部引号片段,其余按 `k=v` 输出(v 含空格则加引号)。
 * event 非法(不匹配 EVENT_RE)→ 返回 null(调用方丢弃)。
 */
export function formatActivityLine(event: string, detail?: Record<string, unknown>, at = new Date()): string | null {
  const ev = String(event || '').trim();
  if (!EVENT_RE.test(ev)) return null;
  let line = `${activityTs(at)} ${ev}`;
  const d = detail || {};
  for (const [k, raw] of Object.entries(d)) {
    if (k === 'text' || raw === undefined || raw === null || raw === '') continue;
    if (!/^[a-z][a-z0-9_]*$/i.test(k)) continue;
    const v = cleanValue(raw);
    if (!v) continue;
    line += /[\s"=]/.test(v) ? ` ${k}="${v}"` : ` ${k}=${v}`;
  }
  if (d.text !== undefined && d.text !== null && String(d.text).trim()) {
    line += ` "${cleanValue(d.text).slice(0, 40)}"`;
  }
  return line.slice(0, LINE_CAP);
}

/** 引擎侧写入口:fire-and-forget,懒建目录,绝不抛。 */
export function appendActivityLine(event: string, detail?: Record<string, unknown>): void {
  try {
    const line = formatActivityLine(event, detail);
    if (!line) return;
    const file = join(activityDir(), `${localDateStr()}.log`);
    void fs
      .appendFile(file, line + '\n', 'utf8')
      .catch(async () => {
        try {
          await fs.mkdir(activityDir(), { recursive: true });
          await fs.appendFile(file, line + '\n', 'utf8');
        } catch { /* 装饰性数据,失败即弃 */ }
      });
  } catch { /* 绝不拖累调用方 */ }
}

export interface ReadActivityOptions {
  /** 回看窗口(小时),默认 24,上限 720(30 天,与保留期一致)。 */
  hours?: number;
  /** 最多返回行数(取最新的尾部),默认 200,上限 1000。 */
  limit?: number;
  /** 可选子串过滤(对整行匹配)。 */
  query?: string;
  /** 测试注入用的"现在"。 */
  now?: Date;
}

const TOTAL_CHARS_CAP = 15_000;

/**
 * 读活动日志:按窗口选日期文件 → 时间戳过滤 → 子串过滤 → 尾部截断。
 * 无目录/无文件 → 空数组;格式不合法的行(如并发写入的残尾)直接丢弃。
 */
export async function readActivityLines(opts: ReadActivityOptions = {}): Promise<string[]> {
  const now = opts.now ?? new Date();
  const hours = Math.min(Math.max(1, Number(opts.hours) || 24), 720);
  const limit = Math.min(Math.max(1, Number(opts.limit) || 200), 1000);
  const query = String(opts.query || '');
  const cutoff = activityTs(new Date(now.getTime() - hours * 3600_000));
  const days = Math.ceil(hours / 24) + 1;
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    let raw: string;
    try {
      raw = await fs.readFile(join(activityDir(), `${localDateStr(d)}.log`), 'utf8');
    } catch {
      continue; // 当日无文件是常态
    }
    for (const line of raw.split('\n')) {
      if (!/^\d{12} \S/.test(line)) continue; // 残尾/垃圾行丢弃
      if (line.slice(0, 12) < cutoff) continue;
      if (query && !line.includes(query)) continue;
      out.push(line);
    }
  }
  let tail = out.slice(-limit);
  // 总字符帽:从旧往新丢,保住最新事件。
  let total = tail.reduce((n, l) => n + l.length + 1, 0);
  while (tail.length > 1 && total > TOTAL_CHARS_CAP) {
    total -= tail[0].length + 1;
    tail = tail.slice(1);
  }
  return tail;
}

/**
 * 这行是不是**用户**自己的动作:引擎后台(Muse 周期 / 自动化)写的行带 `o=<来源>`(registry.ts agent.edit、
 * runStore.ts run.done;用户自己会话的 run 不带)。先抹掉引号段再找 —— 值里的字面 ` o=` 不算(值已消毒,引号必成对)。
 */
export function isUserActivityLine(line: string): boolean {
  return !/\so=\S/.test(line.replace(/"[^"]*"/g, '""'));
}

/**
 * 最近 days 天(含今天)**用户**活动的时间戳(YYYYMMDDHHMM,本地时间,旧→新)。
 * 与 readActivityLines 不同:不截条数/字符 —— 作息统计要整段历史,只取每行前 12 个字符,体量无所谓。
 */
export async function readUserActivityStamps(days: number, now = new Date()): Promise<string[]> {
  const out: string[] = [];
  for (let i = Math.max(1, days) - 1; i >= 0; i--) {
    // 按本地日历日倒推(setDate),别减固定 24h:夏令时切换那天减 24h 会跳过或重复一个本地日期,那天的活动就漏读了
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 12);
    let raw: string;
    try {
      raw = await fs.readFile(join(activityDir(), `${localDateStr(day)}.log`), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (/^\d{12} \S/.test(line) && isUserActivityLine(line)) out.push(line.slice(0, 12));
    }
  }
  return out;
}

/**
 * 自 sinceMs 起活动日志里有没有**用户**动作(纯函数,单测钉)。日志是分钟精度:之后的分钟有行 → 有;
 * 与 sinceMs 同一分钟的行,只有多于基线 minuteLines(那一刻已经在的行数)才算 —— 不给基线就一律不算
 * (同分钟里分不清先后,宁可漏一次也不把睡下前的动作当成「回来了」)。
 */
export function activitySince(stamps: string[], sinceMs: number, minuteLines?: number): boolean {
  const since = activityTs(new Date(sinceMs));
  let same = 0;
  for (const t of stamps) {
    if (t > since) return true;
    if (t === since) same++;
  }
  return minuteLines !== undefined && same > minuteLines;
}

export interface ActivityRhythm {
  /** 每个本地小时(0..23)有用户活动的天数 */
  hourDays: number[];
  /** 有任何用户活动的天数 */
  activeDays: number;
  /** 最近一次用户活动(YYYYMMDDHHMM);没有 → null */
  last: string | null;
}

/** 作息统计(纯函数,单测钉):输入 readUserActivityStamps 的时间戳。 */
export function activityRhythm(stamps: string[]): ActivityRhythm {
  const byHour = Array.from({ length: 24 }, () => new Set<string>());
  const days = new Set<string>();
  let last: string | null = null;
  for (const s of stamps) {
    if (!/^\d{12}$/.test(s)) continue;
    const h = Number(s.slice(8, 10));
    if (h > 23) continue;
    byHour[h].add(s.slice(0, 8));
    days.add(s.slice(0, 8));
    if (!last || s > last) last = s;
  }
  return { hourDays: byHour.map((x) => x.size), activeDays: days.size, last };
}

/** YYYYMMDDHHMM(本地)→ Date。 */
export function parseActivityTs(s: string): Date {
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
}
