/**
 * 提示头的分段指纹(A2 `cache_probe` 事件)与工作目录清单格式化(B2)。
 * 纯函数、无 I/O:agentLoop 负责取材,这里只负责「同样的输入永远得到同样的字节」。
 */
import { createHash } from 'node:crypto';

/** 16 位十六进制:够判「变没变」,不作防碰撞用途(探针是诊断,不是签名)。 */
export const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

export interface ProbeSegment { name: string; hash: string; bytes: number }
export interface ProbeInput { name: string; text: string }
export interface Probe { segments: ProbeSegment[]; headHash: string; changedSegments: string[] }

/** headHash 只覆盖系统侧 + 工具定义:会话历史必然不同,带上它跨会话就没法比。 */
const isHeadSegment = (name: string): boolean => name.startsWith('system:') || name === 'tools';

/**
 * 按「渲染顺序」的段落表算指纹。previous 缺省 = 本 run 第一帧,changedSegments 恒为空
 * (probeSeq=0 就是基线,别把空数组读成「什么都没变」)。
 */
export function buildProbe(inputs: ProbeInput[], previous?: ProbeSegment[]): Probe {
  const segments: ProbeSegment[] = inputs.map(({ name, text }) => ({
    name, hash: hashOf(text), bytes: Buffer.byteLength(text, 'utf8'),
  }));
  // 无歧义编码「段名 + UTF-8 字节数 + 正文」:直接拼接(旧做法)会把「同一个字符跨段挪了位置」
  // 哈成同一值(["ab","c"] 与 ["a","bc"] 同串),headHashSameAsAgentModel 于是报「头没变」的假阳性。
  // 长度前置 → 正文含换行也解析得开。ponytail:段名假定不含换行(本仓的段名是 segAt 的常量表)。
  const headHash = hashOf(inputs.filter((s) => isHeadSegment(s.name))
    .map((s) => `${s.name}\n${Buffer.byteLength(s.text, 'utf8')}\n${s.text}`).join('\n'));
  const changedSegments: string[] = [];
  if (previous) {
    const before = new Map(previous.map((s) => [s.name, s.hash]));
    for (const s of segments) if (before.get(s.name) !== s.hash) changedSegments.push(s.name);
    // 整段消失(如记忆块换了落点)同样是前缀变更,不能不报。
    const now = new Set(segments.map((s) => s.name));
    for (const s of previous) if (!now.has(s.name)) changedSegments.push(s.name);
  }
  return { segments, headHash, changedSegments };
}

/** `[dir]  x/` / `[file] x (123 bytes)` 里的名字;两种前缀都是 7 字符。 */
const listingNameOf = (line: string): string => line.slice(7);

/**
 * B2:去字节数 + 按名排序 + 封顶。字节数与 readdir 的无序合起来 =「保存一个文件就换一次系统提示前缀」,
 * 这是清单唯一的易变来源。排序刻意用码点序而非 localeCompare:后者随 ICU/区域变,跨机器就不是同一串。
 * ponytail:只处理 listFilesLocal 的两种行形状;list_files 工具那条链路原样不动(它要字节数)。
 */
export function formatCwdListing(listing: string, cap = 20): string {
  const lines = listing.split('\n')
    .map((line) => line.replace(/ \(\d+ bytes\)$/, ''))
    .sort((a, b) => { const x = listingNameOf(a); const y = listingNameOf(b); return x < y ? -1 : x > y ? 1 : 0; });
  return lines.slice(0, cap).join('\n') + (lines.length > cap ? `\n… (+${lines.length - cap} more)` : '');
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LOCALE_NAMES: Record<string, string> = { zh: 'Chinese', en: 'English' };

/** 进程所在时区名(IANA);取不到时返回 undefined,调用方回落到「local timezone」。 */
export function processTimeZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
}

/**
 * 系统提示里的「当前日期 + 界面语言」两段(借鉴 chat-demo ③)。
 * 只到「天」粒度、刻意不含时刻 —— 同一天内字节恒定,护前缀缓存;精确时刻仍走 get_datetime。
 * 时区名 + UTC 偏移与日期、get_datetime 同一个口径(引擎进程的本地时钟);偏移只在夏令时切换那天变一次。
 * 只有 host run(引擎和用户在同一台机器上)才传时区名;云端 / 沙箱的钟是服务器的(同 amadeus.ts pastStartNote 的口径)。
 * 界面语言来自渲染端 ui_settings 快照的 locale(zh / en);渠道会话等没有快照的 run 不写这段。
 */
export function currentDateSection(now: Date, opts: { timeZone?: string; uiLocale?: string } = {}): string {
  const weekday = WEEKDAYS[now.getDay()];
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const off = -now.getTimezoneOffset();
  const utc = `UTC${off < 0 ? '-' : '+'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  // 没给时区名(非 host run:进程的钟是服务器的,不代表用户)→ 原样保留旧措辞,不把服务器时区当成用户的写进提示。
  const zone = opts.timeZone ? `time zone ${opts.timeZone}, ${utc}` : 'local timezone';
  let out = `## Current Date\nToday is ${weekday}, ${ymd} (${zone}). For the precise current time, call get_datetime.`;
  const lang = opts.uiLocale ? LOCALE_NAMES[opts.uiLocale] : undefined;
  if (lang) {
    out += `\n\n## Interface Language\nThe user's app interface is set to ${lang}. Reply in the language the user writes in; when a message gives no clear signal (only a link, code, or a file), reply in ${lang}.`;
  }
  return out;
}
