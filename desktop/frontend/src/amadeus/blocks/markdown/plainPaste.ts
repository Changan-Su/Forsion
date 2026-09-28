// 纯文本多行粘贴(D-10,拍板 #12):从微信 / 终端 / 纯文本邮件复制的地址、清单,剪贴板里只有 text/plain,
// 每行一个 `\n`。原先直接走 CommonMark 解析 —— 单个 `\n` 是软换行,v4 按 Obsidian 立场显示成空格
// (softBreak.ts 的设计立场,不动),于是三行地址塌成一行,磁盘上 `\n` 却还在,看着像丢了换行。
//
// 口径(只改粘贴,不改显示):
//  · 只在剪贴板**只有** text/plain、且内容**不像 markdown** 时,把单个 `\n` 升成段落分隔(`\n\n`),
//    然后照旧交给同一条 markdown 粘贴管线 —— 行内语法、裸 URL、`[[ ]]` 的处理与原来逐字一致,只多了「一行一段」。
//  · 像 markdown 的(列表 / 标题 / 引用 / 围栏 / 表格 / 分割线,或带行内标记)照旧走 CommonMark:
//    紧凑列表 `- a\n- b` 若被加倍换行,会变成 loose list、落盘多出空行 —— 那是格式变更,不是显示变更。
//  · 代码块内粘贴不经过这里(调用方判)。
// ⚠️ 不做「严格换行」显示开关:连续行显示为一行是 v4 的设计立场(评审附录 A D-10)。

/** 行首块级语法:标题、列表(含待办)、引用、围栏、表格行、分割线、脚注定义。缩进 ≤3 格(同 CommonMark)。 */
const BLOCK_RE = /^ {0,3}(?:#{1,6}(?:\s|$)|[-*+]\s|\d{1,9}[.)]\s|>|```|~~~|\|.*\||(?:[-*_][ \t]*){3,}$|\[\^[^\]]+\]:)/
/** 行内标记:加粗 / 删除线 / 行内代码 / 链接与图片 / 双链与嵌入 / 数学块。只看成对出现的,单个 `*` `_` 不算。 */
const INLINE_RE = /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|!?\[[^\]\n]*\]\([^)\n]*\)|\[\[[^\]\n]+\]\]|\$\$/

/** 这段纯文本像不像 markdown(像 → 保留 CommonMark 的软换行语义)。 */
export function looksLikeMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.some((l) => BLOCK_RE.test(l))) return true
  return INLINE_RE.test(text)
}

/** 单个 `\n` → `\n\n`(一行一段);已有的空行(连续 `\n`)原样保留;CRLF / CR 先归一。 */
export function plainLinesToParagraphs(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/(?<!\n)\n(?!\n)/g, '\n\n')
}

/** 该不该按「一行一段」处理这次粘贴:含**单个** `\n`(已是一行一段的不再处理 —— 调用方转换后重入就停在这)、且不像 markdown。 */
export function isPlainMultiline(text: string): boolean {
  return /(?<!\n)\n(?!\n)/.test(text.replace(/\r\n?/g, '\n').trim()) && !looksLikeMarkdown(text)
}
