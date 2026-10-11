/**
 * 引用卡:输入框上方可以挂多段引用(划选回复、笔记「问 Tangu」、旁聊「引用到对话」都往这里追加)。
 * 发出时每段是一个 Markdown 引用块、段与段之间空一行 —— 模型和历史看到的仍是纯文本;
 * 用户气泡再把正文开头那几段还原成卡片(只挂过一段的老消息同样认)。
 */

/** 追加一段;空的和已经挂着的不重复加。 */
export function addQuote(quotes: readonly string[], text: string): string[] {
  const quote = text.trim()
  return !quote || quotes.includes(quote) ? [...quotes] : [...quotes, quote]
}

/** 输入框上方挂着的引用,连同它们是在哪个会话里挂的(null = 还没建会话的新对话)。同一个 ChatView 会换会话:
 *  不记归属的话,A 会话里挂的引用会和 B 会话里新挂的一起发给 B。 */
export interface QuoteDraft { sid: string | null; list: string[] }
export const NO_QUOTE_DRAFT: QuoteDraft = { sid: null, list: [] }
const NONE: string[] = []
/** 当前会话该显示 / 该发出去的引用:只认在这个会话里挂的。 */
export const quotesFor = (draft: QuoteDraft, sid: string | null): string[] => (draft.sid === sid ? draft.list : NONE)
/** 在当前会话里追加一段;别的会话留下的那几段就此作废。 */
export const quoteAdded = (draft: QuoteDraft, sid: string | null, text: string): QuoteDraft => ({ sid, list: addQuote(quotesFor(draft, sid), text) })

/** 引用段 → 正文前缀(`> 行`,每段后空一行)。 */
export function composeQuotes(quotes: readonly string[]): string {
  return quotes.map((quote) => `${quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`).join('')
}

/** 正文开头连着的引用块 → 各段原文 + 剩下的正文;开头不是引用 → null。块 = 连续的引用行。
 *  只认 composeQuotes 写出来的样子(`> ` 开头,或单独一个 `>`):`>= 10`、`>> out.log` 这类正文不是引用。 */
export function splitLeadingQuotes(text: string): { quotes: string[]; body: string } | null {
  const lines = text.split('\n')
  const quotes: string[] = []
  let at = 0
  const quoted = (line: string | undefined): boolean => line !== undefined && /^>(?: |$)/.test(line)
  while (quoted(lines[at])) {
    const block: string[] = []
    for (; quoted(lines[at]); at++) block.push(lines[at].replace(/^> ?/, ''))
    quotes.push(block.join('\n'))
    while (lines[at] === '') at++ // 块后的空行:下一块或正文从这之后开始
  }
  return quotes.length ? { quotes, body: lines.slice(at).join('\n') } : null
}
