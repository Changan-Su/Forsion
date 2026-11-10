/** 记忆条目行尾的记号(11-09 记忆分层第二步):谁写的、钉没钉、详情主题的键,写在这一行自己身上,跟着同步走。
 *  例:`- 你在学钢琴。 <!--tg pin by=import from=2026-11-09-->`、`## 学业与研究 <!--tg topic=study-->`。
 *  记号不是事实的一部分:条目身份(normalizeMemoryFact → 墓碑指纹、画像条目号、去重)一律先去掉它;给模型看的、界面上画的也去掉。
 *  纯函数,不碰 node:*(桌面宿主、渲染层都引)。方案页 docs/ToBeImproved/记忆分层与Agent分身方案_2026-11-09 第三节「条目身份与跨设备同步」。 */

// 「导入的」写成反引号:宿主的边界仪器(check:tanguboundary)按正则认 import 语句,单引号写法会被当成一条 import 语句
export type EntryAuthor = 'user' | 'agent' | `import`;
export interface EntryMeta {
  /** 钉住:永远常驻,整理不碰。 */
  pin?: boolean;
  by?: EntryAuthor;
  /** 从哪来:Agent 的 slug,或导入的日期(YYYY-MM-DD)。 */
  from?: string;
  /** 只在标题行上:这一节是哪个详情主题(英文短词;archive = 归档)。 */
  topic?: string;
}

/** 行尾的 `<!--tg …-->`(前后空白一起吃掉)。别的 HTML 注释不认。 */
const MARK = /[ \t]*<!--[ \t]*tg(?:[ \t]+([^<>]*?))?[ \t]*-->[ \t]*$/;
export const TOPIC_KEY = /^[a-z][a-z0-9-]{0,31}$/;
export const ARCHIVE_TOPIC = 'archive';
const FROM = /^[A-Za-z0-9._-]{1,40}$/;

/** 拆开:正文 + 记号。认不得的词丢掉(不报错:记号坏了 = 当没有,条目照常在)。 */
export function splitMark(line: string): { body: string; meta: EntryMeta; marked: boolean } {
  const m = line.match(MARK);
  if (!m) return { body: line, meta: {}, marked: false };
  const meta: EntryMeta = {};
  for (const word of (m[1] || '').split(/\s+/).filter(Boolean)) {
    const [k, v] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, ''];
    if (k === 'pin' && !v) meta.pin = true;
    else if (k === 'by' && (v === 'user' || v === 'agent' || v === `import`)) meta.by = v;
    else if (k === 'from' && FROM.test(v)) meta.from = v;
    else if (k === 'topic' && TOPIC_KEY.test(v)) meta.topic = v;
  }
  return { body: line.slice(0, m.index), meta, marked: true };
}
/** 接上记号(词序固定,同一份元数据永远同一串字节,两台设备不会因为词序来回推)。没有可写的就不加。 */
export function withMark(body: string, meta: EntryMeta): string {
  const words = [meta.pin ? 'pin' : '', meta.by ? `by=${meta.by}` : '', meta.from && FROM.test(meta.from) ? `from=${meta.from}` : '', meta.topic && TOPIC_KEY.test(meta.topic) ? `topic=${meta.topic}` : ''].filter(Boolean);
  const clean = splitMark(body).body.replace(/\s+$/, '');
  return words.length ? `${clean} <!--tg ${words.join(' ')}-->` : clean;
}
export const stripMark = (line: string): string => splitMark(line).body;
/** 整段文字去掉每行的记号(给模型看的、渲染的)。 */
export const stripMarks = (text: string): string => text.split('\n').map(stripMark).join('\n');

/** 事实行的身份:去掉记号、列表符号、压空白、小写。记忆仓库的指纹 = sha256(这个),引擎和宿主同一份。 */
export function normalizeMemoryFact(fact: string): string {
  return stripMark(fact).trim().replace(/^[-*+]\s+/, '').replace(/\s+/g, ' ').toLowerCase();
}
