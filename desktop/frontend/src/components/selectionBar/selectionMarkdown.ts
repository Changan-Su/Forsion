/** Read selected content, not KaTeX's duplicated MathML/visual layout. Never change the live selection. */
export function selectionMarkdown(selection: Selection, root: HTMLElement): { text: string; markdown: string } | null {
  if (!selection.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0).cloneRange()
  if (!root.contains(range.commonAncestorContainer)) return null
  const mathAt = (node: Node): Element | null => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest('.katex') ?? null
  // A fraction/ket is one semantic unit, even when the user starts inside a rendered numerator.
  const start = mathAt(range.startContainer)
  const end = mathAt(range.endContainer)
  const unit = (math: Element): Element => { const display = math.closest('.katex-display'); return display && root.contains(display) ? display : math }
  if (start && root.contains(start)) range.setStartBefore(unit(start))
  if (end && root.contains(end)) range.setEndAfter(unit(end))
  const fragment = range.cloneContents()
  const ancestor = range.commonAncestorContainer
  const insideCode = (ancestor.nodeType === Node.ELEMENT_NODE ? ancestor as Element : ancestor.parentElement)?.closest('code')
  let markdown = insideCode && root.contains(insideCode)
    ? code(fragment.textContent ?? '', !!insideCode.closest('pre'), insideCode.className.match(/language-([\w+-]+)/)?.[1] ?? '').trim()
    : serialize(fragment, true).trim()
  if (!insideCode) {
    // cloneContents omits an enclosing link/mark when both selection boundaries are inside its label.
    for (let el = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor as Element : ancestor.parentElement; el && root.contains(el); el = el.parentElement) {
      markdown = inline(el, markdown)
      if (el === root) break
    }
  }
  return markdown ? { text: serialize(fragment, false).trim(), markdown } : null
}

const escapeText = (s: string): string => s.replace(/[\\`*_$|\[\]]/g, '\\$&')
const code = (s: string, block: boolean, language = ''): string => {
  const width = Math.max(block ? 3 : 1, ...Array.from(s.matchAll(/`+/g), (m) => m[0].length + 1))
  const fence = '`'.repeat(width)
  return block ? `\n\n${fence}${language}\n${s.replace(/\n$/, '')}\n${fence}\n\n` : `${fence} ${s} ${fence}`
}

function inline(el: Element, content: string): string {
  const tag = el.tagName.toLowerCase()
  if (tag === 'a') {
    const wiki = el.getAttribute('data-wiki')
    if (wiki) return `[[${wiki}|${content}]]`
    const href = el.getAttribute('href')
    if (href) return `[${content}](<${href.replace(/>/g, '%3E')}>)`
  }
  if (tag === 'strong' || tag === 'b') return `**${content}**`
  if (tag === 'em' || tag === 'i') return `*${content}*`
  if (tag === 'del') return `~~${content}~~`
  return content
}

/** GFM splits a table at literal pipes even inside math/code. Use equivalent TeX commands inside table formulas. */
function tableMath(tex: string): string {
  let out = ''; let textNext = false
  const textModes = [false]
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i]
    if (c === '\\') {
      if (tex[i + 1] === '|') { out += '\\Vert '; i++; continue }
      const command = /^\\[A-Za-z]+/.exec(tex.slice(i))?.[0]
      if (command) { out += command; textNext = /^\\(?:text|textrm|textsf|texttt|textnormal|textbf|textit|mbox|hbox)$/.test(command); i += command.length - 1; continue }
      out += c + (tex[++i] ?? ''); continue
    }
    if (c === '{') { textModes.push(textNext || textModes.at(-1)!); textNext = false }
    else if (c === '}' && textModes.length > 1) textModes.pop()
    else if (!/\s/.test(c)) textNext = false
    out += c === '|' ? (textModes.at(-1) ? '\\textbar ' : '\\vert ') : c
  }
  return out
}

function serialize(node: Node, markdown: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return markdown ? escapeText(node.textContent ?? '') : node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return ''
  const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : null
  if (el?.matches('script, style, button, .katex-html, .katex-mathml')) return ''
  if (el?.matches('.katex, .katex-display')) {
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent
    if (tex != null) {
      const source = el.closest('td, th') ? tableMath(tex) : tex
      return el.matches('.katex-display') ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`
    }
    // A renderer without source metadata: keep its visible content once, without pretending to recover TeX.
    return el.querySelector('.katex-html')?.textContent ?? el.textContent ?? ''
  }
  const children = (): string => Array.from(node.childNodes, (child) => serialize(child, markdown)).join('')
  if (!el) return children()
  const tag = el.tagName.toLowerCase()
  if (tag === 'br') return '\n'
  if (tag === 'pre') return markdown ? code(el.textContent ?? '', true, el.querySelector('code')?.className.match(/language-([\w+-]+)/)?.[1] ?? '') : `\n\n${el.textContent}\n\n`
  if (tag === 'code') return markdown ? code(el.textContent ?? '', false) : el.textContent ?? ''
  if (tag === 'a') {
    return markdown ? inline(el, children()) : children()
  }
  if (tag === 'img') return markdown ? `![${escapeText(el.getAttribute('alt') ?? '')}](<${(el.getAttribute('src') ?? '').replace(/>/g, '%3E')}>)` : el.getAttribute('alt') ?? ''
  if (tag === 'strong' || tag === 'b') return markdown ? `**${children()}**` : children()
  if (tag === 'em' || tag === 'i') return markdown ? `*${children()}*` : children()
  if (tag === 'del') return markdown ? `~~${children()}~~` : children()
  if (tag === 'ul' || tag === 'ol') {
    let number = Number(el.getAttribute('start') || 1)
    const items = Array.from(el.children).map((item) => {
      const value = item.getAttribute('value')
      if (value) number = Number(value)
      const marker = tag === 'ol' ? `${number++}. ` : '- '
      const content = serialize(item, markdown).trim()
      return markdown ? marker + content.replace(/\n/g, '\n' + ' '.repeat(marker.length)) : content
    })
    return '\n\n' + items.join('\n') + '\n\n'
  }
  if (tag === 'li') return children()
  if (tag === 'tr') return `| ${Array.from(el.children, (cell) => serialize(cell, markdown).trim().replace(/(\\*)\|/g, (_m, slashes: string) => slashes.length % 2 ? slashes + '|' : slashes + '\\|')).join(' | ')} |\n`
  if (tag === 'thead') {
    const content = children()
    return content + (markdown ? `| ${Array.from(el.querySelectorAll('tr:first-child > th'), () => '---').join(' | ')} |\n` : '')
  }
  if (/^h[1-6]$/.test(tag)) return `\n\n${markdown ? '#'.repeat(Number(tag[1])) + ' ' : ''}${children()}\n\n`
  if (tag === 'blockquote') return `\n\n${children().trim().split('\n').map((line) => markdown ? `> ${line}` : line).join('\n')}\n\n`
  if (['p', 'div', 'table'].includes(tag)) return `\n\n${children().trim()}\n\n`
  return children()
}
