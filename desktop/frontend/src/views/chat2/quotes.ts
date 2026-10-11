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

/** 引用段 → 正文前缀(`> 行`,每段后空一行)。 */
export function composeQuotes(quotes: readonly string[]): string {
  return quotes.map((quote) => `${quote.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`).join('')
}

/** 正文开头连着的引用块 → 各段原文 + 剩下的正文;开头不是引用 → null。块 = 连续以 `>` 开头的行。 */
export function splitLeadingQuotes(text: string): { quotes: string[]; body: string } | null {
  const lines = text.split('\n')
  const quotes: string[] = []
  let at = 0
  while (lines[at]?.startsWith('>')) {
    const block: string[] = []
    for (; lines[at]?.startsWith('>'); at++) block.push(lines[at].replace(/^> ?/, ''))
    quotes.push(block.join('\n'))
    while (lines[at] === '') at++ // 块后的空行:下一块或正文从这之后开始
  }
  return quotes.length ? { quotes, body: lines.slice(at).join('\n') } : null
}
