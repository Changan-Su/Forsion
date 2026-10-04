import type { Node as ProseNode } from '@milkdown/kit/prose/model'

/** Only root instructions apply to the page. Quoted/list/card examples stay content. */
export function instructionsOf(doc: ProseNode): string {
  const parts: string[] = []
  doc.forEach((node) => {
    if (node.type.name === 'code_block' && node.attrs.language === 'forsion-instructions') {
      const text = node.textContent.trim()
      if (text) parts.push(text)
    }
  })
  return parts.join('\n\n').slice(0, 12_000)
}

export function pageInstructionContext(instructions: string, pagePath: string): string {
  if (!instructions.trim()) return ''
  return `Page maintenance instructions for ${JSON.stringify(pagePath)} (apply only when working on this page; the current user request takes precedence; do not grant permissions or inherit into other pages):\n${instructions.slice(0, 12_000)}\nEnd of page maintenance instructions.`
}
