/**
 * 按条标适用范围(2026-11-06,Agent 跨设备第二波,方案页 Agent设备隔离方案_2026-11-04/round3.html「设备名写在内容里」):
 * 行首(或标题前)一个方括号 —— `[设备名]` = 只在这台电脑,`[macOS]` / `[Windows]` / `[Linux]` = 只在这个系统,不标 = 所有设备。
 * 适用于 Agent 的 MEMORY.md、指令(config.toml developer_instructions)、SOUL.md、HARNESS.md;读的时候只把本机适用的拼进提示词,
 * 别台的折成一行英文提示。
 *
 * 认得的才算标签:系统名、本机名、账号里登记过的别台的名字(Extend 写的 content-sync-devices.json)。认不得的方括号原样当正文
 * —— 宁可多给模型一行,也不悄悄藏掉用户自己写的字(`[Note] …`、Markdown 勾选框 / 链接都不会被当成标签)。
 *
 * 契约:纯函数,不引 node 内置,也不碰磁盘(引擎、桌面宿主、前端都引)。
 */

export type DeviceOs = 'macOS' | 'Windows' | 'Linux';
export const DEVICE_OSES: readonly DeviceOs[] = ['macOS', 'Windows', 'Linux'];

export interface DeviceTagContext {
  /** 本机名(同步页上这台的名字;没起过名 = 主机名的缺省写法)。null = 这次不在任何一台电脑上(云端 run):标了的一律折起来。 */
  self: string | null;
  os: DeviceOs | null;
  /** 账号里登记过的别的设备的名字(不含本机)。 */
  others: readonly string[];
}
export type DeviceTag =
  | { kind: 'os'; label: string; os: DeviceOs }
  | { kind: 'device'; label: string; self: boolean };
/** 一处不适用本机、被折起来的内容:标签原文 + 是系统还是设备。 */
export interface SkippedTag { label: string; kind: 'os' | 'device'; }

/** 新写一条时选的适用范围(remember 的 appliesTo、界面的菜单)。 */
export type AppliesTo = 'all' | 'this-computer' | 'this-os';
export const APPLIES_TO: readonly AppliesTo[] = ['all', 'this-computer', 'this-os'];

export function osOfPlatform(platform: string | null | undefined): DeviceOs | null {
  return platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : null;
}
const OS_KEYS: Record<string, DeviceOs> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };

/** 名字比较口径:去头尾空白、连续空白当一个、不分大小写(同一账号里不许两台同名也按这个判)。 */
export function deviceNameKey(name: string): string {
  return String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}
export function sameDeviceName(a: string, b: string): boolean { return !!deviceNameKey(a) && deviceNameKey(a) === deviceNameKey(b); }
/** 设备名不能和系统名撞(`[Windows]` 只能是系统)。 */
export function isReservedDeviceName(name: string): boolean { return deviceNameKey(name) in OS_KEYS; }
/** 能当标签的名字:非空、不超 64、不含控制字符和方括号(方括号会把标签截断)。 */
export function validTagName(name: string): boolean {
  const n = String(name ?? '').trim();
  return !!n && n.length <= 64 && !/[\u0000-\u001f\u007f\[\]]/.test(n);
}

export function classifyTag(label: string, ctx: DeviceTagContext): DeviceTag | null {
  const key = deviceNameKey(label);
  if (!key) return null;
  const os = OS_KEYS[key];
  if (os) return { kind: 'os', label: label.trim(), os };
  if (ctx.self && deviceNameKey(ctx.self) === key) return { kind: 'device', label: label.trim(), self: true };
  if (ctx.others.some((o) => deviceNameKey(o) === key)) return { kind: 'device', label: label.trim(), self: false };
  return null;
}
export function appliesHere(tag: DeviceTag, ctx: DeviceTagContext): boolean {
  return tag.kind === 'os' ? ctx.os === tag.os : tag.self;
}

/** 行首:缩进 + 可选的列表记号 / 标题记号,然后 `[标签]` + 空白 + 正文。`](` 链接、`]:` 引用定义、空勾选框都不匹配。 */
const TAG_LINE = /^(\s*(?:[-*+]\s+|\d{1,3}[.)]\s+|#{1,6}\s+)?)\[([^\[\]\n]{1,64})\][ \t]+(?=\S)/;

export interface LineTag { tag: DeviceTag; /** 标签前面的部分(缩进 / `- ` / `## `) */ lead: string; /** 标签后面的正文 */ body: string; }
export function lineTag(line: string, ctx: DeviceTagContext): LineTag | null {
  const m = TAG_LINE.exec(line);
  if (!m) return null;
  const tag = classifyTag(m[2], ctx);
  return tag ? { tag, lead: m[1], body: line.slice(m[0].length) } : null;
}

/** 给一句话换上标签(引擎写入时用;Agent 不自己拼名字):已经带认得的标签的先剥掉再加,不叠两层;前导(缩进 / `- ` / `## `)保留。
 *  label = null → 去掉标签(= 所有设备)。改一条而没说范围时别调它:用 appliesToOf 取回原标签再写,否则改个措辞就把范围改没了。 */
export function withTag(fact: string, label: string | null, ctx: DeviceTagContext): string {
  const t = lineTag(fact, ctx);
  const lead = t ? t.lead : (/^(\s*(?:[-*+]\s+|\d{1,3}[.)]\s+|#{1,6}\s+)?)/.exec(fact)?.[1] ?? '');
  const body = t ? t.body : fact.slice(lead.length);
  return label ? `${lead}[${label.trim()}] ${body.trimStart()}` : `${lead}${body}`;
}
/** 一句话行首认得的标签原文(没有 → null)。 */
export function tagOf(line: string, ctx: DeviceTagContext): string | null { return lineTag(line, ctx)?.tag.label ?? null; }
/** 适用范围 → 写进内容的标签。本机名 / 系统未知(云端)时返回 null:写不了带本机条件的内容。 */
export function labelFor(appliesTo: AppliesTo, ctx: DeviceTagContext): string | null {
  if (appliesTo === 'this-computer') return ctx.self && validTagName(ctx.self) ? ctx.self.trim() : null;
  if (appliesTo === 'this-os') return ctx.os;
  return null;
}
/** 已有一句话的适用范围(界面上回显、改一条时保留原范围用)。 */
export function appliesToOf(line: string, ctx: DeviceTagContext): { appliesTo: AppliesTo | 'other'; tag: DeviceTag | null } {
  const t = lineTag(line, ctx)?.tag ?? null;
  if (!t) return { appliesTo: 'all', tag: null };
  if (t.kind === 'os') return { appliesTo: ctx.os === t.os ? 'this-os' : 'other', tag: t };
  return { appliesTo: t.self ? 'this-computer' : 'other', tag: t };
}

/** 一组条目(记忆的事实行、工作笔记条目)按本机挑:不标的 + 适用本机的留下,其余记进 skipped。 */
export function filterTaggedEntries<T>(entries: readonly T[], text: (e: T) => string, ctx: DeviceTagContext): { kept: T[]; skipped: SkippedTag[] } {
  const kept: T[] = [], skipped: SkippedTag[] = [];
  for (const e of entries) {
    const t = lineTag(text(e), ctx)?.tag;
    if (!t || appliesHere(t, ctx)) kept.push(e);
    else skipped.push({ label: t.label, kind: t.kind });
  }
  return { kept, skipped };
}

const indentOf = (line: string): number => (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * 一份自由格式的 Markdown(SOUL.md、指令)按本机挑:
 * - 标题前带标签(`## [Windows] 求解`)= 整节,到下一个同级或更高级标题为止;
 * - 列表项 / 普通行带标签 = 这一行,连同它下面缩进更深的续行(子项);
 * - 代码块里不认标签。
 * 删掉的每一节 / 每一行在 skipped 里记一笔。
 */
export function filterTaggedText(text: string, ctx: DeviceTagContext): { text: string; skipped: SkippedTag[] } {
  const lines = String(text ?? '').split('\n');
  const out: string[] = [], skipped: SkippedTag[] = [];
  let fence: string | null = null;
  let dropHeading = 0; // >0:正在丢一节,值是那个标题的级别
  let dropIndent = -1; // >=0:正在丢一个列表项的续行,值是那一项的缩进
  for (const line of lines) {
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; if (!dropHeading && dropIndent < 0) out.push(line); continue; }
    const heading = /^(#{1,6})\s/.exec(line);
    if (dropHeading) {
      if (!heading || heading[1].length > dropHeading) { if (f) fence = f[1]; continue; }
      dropHeading = 0;
    }
    if (dropIndent >= 0) {
      if (line.trim() && indentOf(line) > dropIndent) { if (f) fence = f[1]; continue; }
      dropIndent = -1;
    }
    if (f) { fence = f[1]; out.push(line); continue; }
    const t = lineTag(line, ctx);
    if (t && !appliesHere(t.tag, ctx)) {
      skipped.push({ label: t.tag.label, kind: t.tag.kind });
      if (heading) dropHeading = heading[1].length; else dropIndent = indentOf(line);
      continue;
    }
    out.push(line);
  }
  return { text: out.join('\n'), skipped };
}

/**
 * 折起来的那一行(给模型读 → 英文)。`(2 more entries apply only to other computers: 1 on "Windows desktop", 1 on Windows)`。
 * 没有折起来的返回 ''。noun = 'entry'(记忆 / 工作笔记条目)或 'part'(指令、人格里的段落)。
 */
export function foldNote(skipped: readonly SkippedTag[], noun: 'entry' | 'part' = 'entry'): string {
  if (!skipped.length) return '';
  const groups = new Map<string, { label: string; kind: 'os' | 'device'; n: number }>();
  for (const s of skipped) {
    const k = `${s.kind}:${deviceNameKey(s.label)}`;
    const g = groups.get(k);
    if (g) g.n++; else groups.set(k, { label: s.label, kind: s.kind, n: 1 });
  }
  const where = [...groups.values()].map((g) => `${g.n} on ${g.kind === 'os' ? g.label : JSON.stringify(g.label)}`).join(', ');
  const n = skipped.length;
  const what = noun === 'entry' ? (n === 1 ? 'entry applies' : 'entries apply') : (n === 1 ? 'part applies' : 'parts apply');
  return `(${n} more ${what} only to other computers: ${where})`;
}

/** 一句话说明标签怎么读(有标了的内容进提示词时放在那段前面一次;英文)。 */
export function tagLegend(ctx: DeviceTagContext): string {
  if (!ctx.self) return 'Lines starting with [name] apply only to that computer or operating system; this run is not on any of the user’s computers.';
  return `Lines starting with [name] apply only to that computer or operating system; this computer is ${JSON.stringify(ctx.self)}${ctx.os ? ` (${ctx.os})` : ''}.`;
}

const HARNESS_HEADING = /^#{2}\s+\[[^\[\]\n]{1,64}\]\s+(?=\[)/;
/** 改名:把行首的 `[旧名]` 换成 `[新名]`(只换标签位置上的,正文里提到的名字不动)。没变就原样返回同一个字符串。 */
export function renameDeviceTag(text: string, from: string, to: string): string {
  if (!validTagName(to) || sameDeviceName(from, to) && from.trim() === to.trim()) return text;
  const ctx: DeviceTagContext = { self: from, os: null, others: [] };
  let changed = false;
  const out = String(text ?? '').split('\n').map((line) => {
    // 工作笔记的条目标题是 `## [id] [标签] 标题 (kind)`:标签在 id 后面
    const id = HARNESS_HEADING.exec(line);
    const t = lineTag(id ? line.slice(id[0].length) : line, ctx);
    if (!t || t.tag.kind !== 'device') return line;
    changed = true;
    return `${id ? id[0] : ''}${t.lead}[${to.trim()}] ${t.body}`;
  });
  return changed ? out.join('\n') : text;
}
