/**
 * 引用卡:输入框上方可以挂多段引用(划选回复、笔记「问 Tangu」、旁聊「引用到对话」都往这里追加)。
 * 发出时每段是一个 Markdown 引用块、段与段之间空一行 —— 模型和历史看到的仍是纯文本;
 * 用户气泡再把正文开头那几段还原成卡片(只挂过一段的老消息同样认)。
 * 10-23 起每张卡可以带一句回应(划选「引用」弹出的就地回复框里写的,Claude 那样):紧跟在它的引用块后面、空一行。
 */

/** 追加一段;空的和已经挂着的不重复加。 */
export function addQuote(quotes: readonly string[], text: string): string[] {
  const quote = text.trim()
  return !quote || quotes.includes(quote) ? [...quotes] : [...quotes, quote]
}

/** 输入框上方挂着的引用,连同它们是在哪个会话里挂的(null = 还没建会话的新对话)。同一个 ChatView 会换会话:
 *  不记归属的话,A 会话里挂的引用会和 B 会话里新挂的一起发给 B。 */
export interface QuoteDraft { sid: string | null; list: string[]; /** 引用原文 → 对它的回应 */ notes?: Record<string, string> }
export const NO_QUOTE_DRAFT: QuoteDraft = { sid: null, list: [] }
const NONE: string[] = []
/** 当前会话该显示 / 该发出去的引用:只认在这个会话里挂的。 */
export const quotesFor = (draft: QuoteDraft, sid: string | null): string[] => (draft.sid === sid ? draft.list : NONE)
/** 在当前会话里追加一段;别的会话留下的那几段就此作废。 */
export const quoteAdded = (draft: QuoteDraft, sid: string | null, text: string, note?: string): QuoteDraft => {
  const notes = draft.sid === sid ? { ...draft.notes } : {}
  const quote = text.trim(), said = note?.trim()
  if (quote && said) notes[quote] = said
  return { sid, list: addQuote(quotesFor(draft, sid), text), notes }
}
const NO_NOTES: Record<string, string> = {}
/** 当前会话里每段引用的回应(别的会话留下的不算)。 */
export const notesFor = (draft: QuoteDraft, sid: string | null): Record<string, string> => (draft.sid === sid && draft.notes) || NO_NOTES
/** 改一段引用的回应(全文窗里编辑);空串 = 去掉回应。 */
export const quoteNoted = (draft: QuoteDraft, sid: string | null, quote: string, note: string): QuoteDraft => {
  const notes = { ...notesFor(draft, sid) }
  if (note.trim()) notes[quote] = note.trim(); else delete notes[quote]
  return { sid, list: quotesFor(draft, sid), notes }
}

/** 引用段 → 正文前缀(`> 行`,每段后空一行;有回应的,回应紧跟其后再空一行)。 */
export function composeQuotes(quotes: readonly string[], notes: Readonly<Record<string, string>> = NO_NOTES): string {
  return quotes.map((quote) => `${quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n${notes[quote] ? `${notes[quote]}\n\n` : ''}`).join('')
}

/** 正文开头的引用块 → 各段原文 + 各段的回应 + 剩下的正文;开头不是引用 → null。块 = 连续的引用行。
 *  两个引用块之间的文字算前一段的回应;最后一块后面的文字算正文(分不出是回应还是正文,一律当正文 —— 气泡里照样紧跟在卡后面)。
 *  只认 composeQuotes 写出来的样子(`> ` 开头,或单独一个 `>`):`>= 10`、`>> out.log` 这类正文不是引用;
 *  引用块只从空行之后开始,正文中间夹的一行 `> ` 不算。 */
export function splitLeadingQuotes(text: string): { quotes: string[]; notes: string[]; body: string } | null {
  const lines = text.split('\n')
  const quotes: string[] = []
  const notes: string[] = []
  let at = 0
  const quoted = (line: string | undefined): boolean => line !== undefined && /^>(?: |$)/.test(line)
  while (quoted(lines[at])) {
    const block: string[] = []
    for (; quoted(lines[at]); at++) block.push(lines[at].replace(/^> ?/, ''))
    quotes.push(block.join('\n'))
    while (lines[at] === '') at++ // 块后的空行:下一块、回应或正文从这之后开始
    // 往后找下一个引用块(前面是空行的引用行);找到 = 中间这段是回应,找不到 = 剩下的是正文
    let next = at
    while (next < lines.length && !(quoted(lines[next]) && lines[next - 1] === '')) next++
    if (next >= lines.length || next === at) { notes.push(''); continue }
    notes.push(lines.slice(at, next).join('\n').trim())
    at = next
  }
  return quotes.length ? { quotes, notes, body: lines.slice(at).join('\n') } : null
}
