/** 标注 / 折叠块的首行令牌(Obsidian callout):`[!type]`、`[!type|元数据]`,后面可带折叠符 `+` / `-`。
 *
 *  元数据位(Notion 对齐 A5,2026-11-18 用户定):Forsion 在这里存标注的**图标**和**底色**,和 Obsidian 互通 ——
 *    `> [!tip|🚀 blue] 标题`:Obsidian 照样是 tip 标注、元数据不显示(实测);旧版 Forsion 显示成普通引用、令牌原样留着。
 *  - 图标 = 一枚 emoji(不含 ASCII 字母数字、空白、`[]|`);底色 = 块颜色的语义名(九色、accent),同整块颜色(A1)。
 *  - 别的词(Obsidian 用户常在这里放 CSS 片段名,如 `wide`)一律原样保留、顺序不动,Forsion 不认也不删。
 *  - 读写同一套规则:parse → format 对认得的写法逐字不变(见 calloutToken.test.ts)。
 *  所有认标注令牌的地方都从这里取正则,别再各写一份(此前 9 处各写 `[\w-]+\]`,放宽一处漏一处)。 */

/** `[!type]` / `[!type|meta]`。分组:1 = 类型,2 = 元数据(可无)。不含折叠符。 */
export const CALLOUT_TOKEN_SRC = String.raw`\[!([\w-]+)(?:\|([^\]\n]*))?\]`
/** 行首令牌(不含折叠符)。 */
export const CALLOUT_HEAD_RE = new RegExp(`^${CALLOUT_TOKEN_SRC}`)
/** 行首令牌 + 折叠符。分组 3 = `+` / `-`。 */
export const CALLOUT_TOKEN_RE = new RegExp(`^${CALLOUT_TOKEN_SRC}([+-])?`)
/** 行首是不是折叠块(`[!fold]` / `[!fold|…]`,不分大小写)。 */
export const FOLD_HEAD_RE = /^\[!fold(?:\|[^\]\n]*)?\]/i

/** 底色能用的值:块颜色的九色语义名 + accent(跟随强调色)。和 blocks/markdown/blockColor 的 BLOCK_COLOR_NAMES 同一组。 */
export const CALLOUT_COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'magenta', 'grey', 'accent'] as const

export interface CalloutMeta {
  /** emoji 图标;'' = 按类型的缺省图标 */
  icon: string
  /** 底色语义名;'' = 按类型的缺省配色 */
  color: string
  /** 认不出的元数据词,原样、按原顺序保留 */
  rest: string[]
}

const isColor = (w: string): boolean => (CALLOUT_COLOR_NAMES as readonly string[]).includes(w)
/** 整个词正好是一枚 emoji:国旗(两枚区域指示符)/ 象形符号带变体选择符、肤色、标签序列,ZWJ 连起来的组合(👨‍👩‍👧、🏳️‍🌈)也算一枚。 */
const ONE_EMOJI_RE = /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|[\u{E0020}-\u{E007F}])*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*)*)$/u
/** 能当图标的词:整个词是一枚 emoji。混了文字(`🚀中文`)、两枚并排(`🚀🔥`)、ASCII 词(Obsidian 的 CSS 片段名)都不算,
 *  归进 rest 原样留着 —— 否则换图标时会把用户的词当旧图标删掉(Codex 评审 A5 #3)。 */
export function isCalloutIcon(w: string): boolean {
  return w.length > 0 && w.length <= 32 && ONE_EMOJI_RE.test(w)
}

/** 元数据串 → 图标 / 底色 / 其余。第一枚图标、第一个颜色名才算数,重复的进 rest(写回时位置不动,不丢)。 */
export function parseCalloutMeta(meta: string | undefined | null): CalloutMeta {
  const out: CalloutMeta = { icon: '', color: '', rest: [] }
  for (const w of (meta ?? '').split(/\s+/).filter(Boolean)) {
    if (!out.icon && isCalloutIcon(w)) out.icon = w
    else if (!out.color && isColor(w)) out.color = w
    else out.rest.push(w)
  }
  return out
}

/** 图标 / 底色 / 其余 → 元数据串(图标在前、颜色其次、其余照旧)。全空 → ''。 */
export function formatCalloutMeta(m: CalloutMeta): string {
  return [m.icon, m.color, ...m.rest].filter(Boolean).join(' ')
}

/** 写回令牌:元数据为空就是 `[!type]`(和没有 A5 时一样)。不含折叠符。 */
export function calloutHead(type: string, meta: CalloutMeta): string {
  const m = formatCalloutMeta(meta)
  return m ? `[!${type}|${m}]` : `[!${type}]`
}

/** 行首令牌解析:type、元数据、折叠符、令牌长度(head = 不含折叠符,token = 含)。不是令牌 → null。 */
export function readCalloutToken(text: string): { type: string; metaRaw: string | undefined; meta: CalloutMeta; marker: '+' | '-' | undefined; head: number; token: string } | null {
  const m = CALLOUT_TOKEN_RE.exec(text)
  if (!m) return null
  return {
    type: m[1],
    metaRaw: m[2],
    meta: parseCalloutMeta(m[2]),
    marker: m[3] as '+' | '-' | undefined,
    head: m[0].length - (m[3] ? 1 : 0),
    token: m[0],
  }
}

/** 改元数据后要不要动文字:认得的写法(图标 / 颜色 / 其余词按规范顺序、单空格)才能安全重写;
 *  手写的怪样子(多空格、颜色在图标前)也照样重写成规范形 —— 只动令牌,不动标题正文。 */
export function withCalloutMeta(text: string, patch: Partial<Pick<CalloutMeta, 'icon' | 'color'>>): { from: number; to: number; head: string } | null {
  const t = readCalloutToken(text)
  if (!t) return null
  const next: CalloutMeta = { ...t.meta, ...patch }
  const head = calloutHead(t.type, next)
  return head === text.slice(0, t.head) ? null : { from: 0, to: t.head, head }
}
