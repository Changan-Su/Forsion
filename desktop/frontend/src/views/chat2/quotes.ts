/**
 * 引用卡:输入框上方可以挂多段引用(划选回复、笔记「问 Tangu」、旁聊「引用到对话」都往这里追加)。
 * 发出时每段是一个 Markdown 引用块、段与段之间空一行 —— 模型和历史看到的仍是纯文本;
 * 用户气泡再把正文开头那几段还原成卡片(只挂过一段的老消息同样认)。
 * 10-23 起每张卡可以带一句回应(划选「引用」弹出的就地回复框里写的,Claude 那样):紧跟在它的引用块后面、空一行,写成一段 `↳ 回应`。
 * 带 `↳` 才认:正文里自己写的引用块、引用后面紧跟的正文都不会被当成回应(没有记号的话两者分不出来,Codex P2)。
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
/** 取一段引用的回应。只认自己的键:引用原文恰好是 `constructor` / `toString` 时别取到原型上的函数(Codex P2)。 */
export const noteOf = (notes: Readonly<Record<string, string>> | undefined, quote: string): string | undefined =>
  notes && Object.prototype.hasOwnProperty.call(notes, quote) ? notes[quote] : undefined
/** 回应 → 发出去的一段:`↳ ` 打头,中间的空行收成换行(一段话,读回来才分得清回应和正文)。 */
const noteLine = (note: string): string => `↳ ${note.trim().replace(/\n\s*\n+/g, '\n')}`
/** 当前会话里每段引用的回应(别的会话留下的不算)。 */
export const notesFor = (draft: QuoteDraft, sid: string | null): Record<string, string> => (draft.sid === sid && draft.notes) || NO_NOTES
/** 改一段引用的回应(全文窗里编辑);空串 = 去掉回应。 */
export const quoteNoted = (draft: QuoteDraft, sid: string | null, quote: string, note: string): QuoteDraft => {
  const notes = { ...notesFor(draft, sid) }
  if (note.trim()) notes[quote] = note; else delete notes[quote] // 原样存:编辑中别把空格 / 换行修掉(发出时才整理)
  return { sid, list: quotesFor(draft, sid), notes }
}

/** 引用段 → 正文前缀(`> 行`,每段后空一行;有回应的,`↳ 回应` 紧跟其后再空一行)。 */
export function composeQuotes(quotes: readonly string[], notes: Readonly<Record<string, string>> = NO_NOTES): string {
  return quotes.map((quote) => {
    const note = noteOf(notes, quote)?.trim()
    return `${quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n${note ? `${noteLine(note)}\n\n` : ''}`
  }).join('')
}

/** 正文开头的引用块 → 各段原文 + 各段的回应 + 剩下的正文;开头不是引用 → null。块 = 连续的引用行。
 *  引用块后面紧跟一段 `↳ ` 打头的 = 它的回应(到空行为止);再往后是引用块就接着拆,否则剩下的全是正文。
 *  只认 composeQuotes 写出来的样子(`> ` 开头,或单独一个 `>`):`>= 10`、`>> out.log` 这类正文不是引用。 */
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
    while (lines[at] === '') at++ // 块后的空行:回应、下一块或正文从这之后开始
    let note = ''
    if (lines[at]?.startsWith('↳ ')) {
      const said: string[] = []
      for (; at < lines.length && lines[at] !== ''; at++) said.push(lines[at])
      note = said.join('\n').slice(2)
      while (lines[at] === '') at++
    }
    notes.push(note)
  }
  return quotes.length ? { quotes, notes, body: lines.slice(at).join('\n') } : null
}

/** 长粘贴磁贴(借 Comma):纯文本粘贴到这么长才不进输入框、成一张磁贴(Comma 同值)。 */
export const PASTE_TILE_MIN = 5000

/** 磁贴标题 = 第一行有字的那一行。 */
export function pasteTitle(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim()
}

/** 发出的正文:你写的话在前,粘贴的内容按顺序接在后面,各自用代码块围住 —— 模型看到的仍是全文。
 *  围栏比内容里最长的一串反引号多一个,内容里自带 ``` 也围不断。 */
export function composePastes(text: string, pastes: string[]): string {
  const blocks = pastes.map((p) => {
    let longest = 2
    for (const run of p.matchAll(/`+/g)) longest = Math.max(longest, run[0].length) // 别 spread 进 Math.max:满屏反引号的粘贴会爆栈(Codex 评审)
    const fence = '`'.repeat(longest + 1)
    return `${fence}\n${p.replace(/\n+$/, '')}\n${fence}`
  })
  return [text, ...blocks].filter(Boolean).join('\n\n')
}
