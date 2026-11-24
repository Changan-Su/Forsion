const TEXT_STYLES = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing',
  'textIndent', 'textAlign', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'direction', 'fontFeatureSettings', 'fontVariantNumeric', 'wordBreak',
] as const

export function copyTextareaTextStyles(styles: CSSStyleDeclaration, target: HTMLElement): void {
  for (const property of TEXT_STYLES) target.style[property] = styles[property]
}

export function isCaretOnEdgeLine(textarea: HTMLTextAreaElement, edge: 'first' | 'last'): boolean {
  const { selectionStart, selectionEnd, value } = textarea
  if (selectionStart !== selectionEnd) return false

  const first = edge === 'first'
  const edgeOffset = first ? 0 : value.length
  if (selectionStart === edgeOffset) return true
  const newline = first ? value.indexOf('\n') : value.lastIndexOf('\n')
  if (newline !== -1 && (first ? selectionStart > newline : selectionStart <= newline)) return false

  // A textarea exposes the caret offset, but no row geometry. Measure the full text so
  // the words after the caret still participate in wrapping.
  const doc = textarea.ownerDocument
  const mirror = doc.createElement('div')
  const styles = getComputedStyle(textarea)
  // Keep fractional widths, which can change where the browser wraps a line.
  // Use clientWidth only to measure the space taken by a classic scrollbar.
  const px = (property: string) => parseFloat(styles.getPropertyValue(property)) || 0
  const paddingBoxWidth = px('width') + (styles.boxSizing === 'border-box'
    ? -px('border-left-width') - px('border-right-width')
    : px('padding-left') + px('padding-right'))
  const scrollbarWidth = Math.max(0, Math.round(paddingBoxWidth) - textarea.clientWidth)
  copyTextareaTextStyles(styles, mirror)
  Object.assign(mirror.style, {
    position: 'fixed', left: '0', top: '0', visibility: 'hidden', boxSizing: 'border-box',
    width: `${paddingBoxWidth - scrollbarWidth}px`,
    zoom: (textarea.currentCSSZoom || 1) / (doc.body.currentCSSZoom || 1),
    whiteSpace: styles.whiteSpace, overflowWrap: styles.overflowWrap, unicodeBidi: styles.unicodeBidi,
  })
  const text = doc.createTextNode(value)
  mirror.append(text)
  doc.body.append(mirror)
  try {
    const range = doc.createRange()
    range.setStart(text, edgeOffset)
    range.collapse(true)
    const rowTop = range.getClientRects()[0]?.top
    range.setStart(text, selectionStart)
    range.collapse(true)
    const caretRects = Array.from(range.getClientRects())
    // At a wrap boundary the same offset can belong to either row. Give the native
    // arrow key priority if either position has another row in that direction.
    return rowTop !== undefined && caretRects.length > 0 && caretRects.every(rect => rect.top === rowTop)
  } finally {
    mirror.remove()
  }
}
