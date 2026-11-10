/** 人的文件夹注入提示词时按整条截(11-09 记忆分层第一步):引擎 renderAboutHuman 和桌面「我」页画的那条线用同一个函数,
 *  不在前端另算一份会漂的。纯函数,不碰 node:*(桌面渲染层直接 import)。
 *  方案页 docs/ToBeImproved/记忆分层与Agent分身方案_2026-11-09 第二节「按整条截,画出那条线」。 */

/** 方案页 ⑨(10-19):画像 ≤2000、人自己的笔记 ≤2000;AGENT.md 用 store 的上限。 */
export const ABOUT_HUMAN_LIMITS = { 'AGENT.md': 12000, 'MEMORY.md': 2000, 'SOUL.md': 2000 } as const;

export interface PromptClip {
  /** 进提示词的那段:去首尾空白,从头按整行 / 整条截,顺序不变。 */
  kept: string;
  /** 线外那段(去首尾空白);空串 = 全都读得到。 */
  rest: string;
  /** 全文(去首尾空白后)多少字。 */
  chars: number;
  limit: number;
  /** 原文(没去空白的那份)里从哪个下标起 Agent 读不到;null = 全都读得到。桌面按它把正文分成线内 / 线外两段。 */
  cutAt: number | null;
  /** 线外有几条(列表项连同它缩进的续行算一条,其余每个非空、非标题的行算一条)。 */
  outside: number;
}

const ENTRY = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s/;
const SENTENCE_END = /[。！？!?.;；]\s*/g;

/** 一「条」= 列表项行 + 它后面缩进的续行(中间隔着空行的缩进段落也算,Markdown 里它们属于同一个列表项);其余每一行自成一条。
 *  返回每条在 text 里的 [start, end)(end 不含换行)。 */
function blocks(text: string): Array<{ start: number; end: number; heading: boolean; blank: boolean }> {
  const out: Array<{ start: number; end: number; heading: boolean; blank: boolean }> = [];
  let pos = 0; let entry = -1; // 当前列表项在 out 里的下标;-1 = 不在列表项里
  const held: Array<{ start: number; end: number }> = []; // 列表项后面的空行:下一行是缩进续行就并进这一条,否则各算一个空行
  for (const line of text.split('\n')) {
    const start = pos, end = pos + line.length; pos = end + 1;
    if (entry >= 0 && !line.trim()) { held.push({ start, end }); continue; }
    if (entry >= 0 && /^\s+\S/.test(line) && !ENTRY.test(line)) { out[entry].end = end; held.length = 0; continue; }
    for (const b of held.splice(0)) out.push({ ...b, heading: false, blank: true });
    out.push({ start, end, heading: HEADING.test(line), blank: !line.trim() });
    entry = ENTRY.test(line) ? out.length - 1 : -1;
  }
  for (const b of held) out.push({ ...b, heading: false, blank: true });
  return out;
}

/** 从头取到放得下的最后一整条;线内末尾的空行和标题挪到线外(标题下面的条目都在线外,标题留在线内只是白占字数)。
 *  第一条本身就超过上限(一整段不换行的长文)时,退回按句末切,再不行才按字数切 —— 不给模型空的。 */
export function clipWholeLines(raw: string, limit: number): PromptClip {
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  if (text.length <= limit) return { kept: text, rest: '', chars: text.length, limit, cutAt: null, outside: 0 };
  const list = blocks(text);
  let take = 0;
  while (take < list.length && list[take].end <= limit) take++;
  while (take > 0 && (list[take - 1].blank || list[take - 1].heading)) take--;
  let cut: number;
  if (take > 0) cut = list[take - 1].end;
  else {
    const head = text.slice(0, limit);
    let at = -1; for (const m of head.matchAll(SENTENCE_END)) at = m.index! + m[0].length;
    cut = at > 0 ? at : limit;
  }
  const kept = text.slice(0, cut).trimEnd();
  const rest = text.slice(cut).trim();
  const outside = blocks(rest).filter((b) => !b.blank && !b.heading).length || (rest ? 1 : 0);
  return { kept, rest, chars: text.length, limit, cutAt: lead + cut, outside };
}

/** 给提示词的那份:超了从头按整条截(不切半句),线外还有就留一行说明,让模型知道后面还有。 */
export const clipForPrompt = (s: string, limit: number): string => { const c = clipWholeLines(s, limit); return c.rest ? `${c.kept}\n…(truncated)` : c.kept; };
