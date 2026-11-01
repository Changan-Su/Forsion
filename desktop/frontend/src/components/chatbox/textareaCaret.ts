// textarea 不像 ProseMirror 有 coordsAtPos:用一份排版相同的隐藏副本量光标在哪。
const MIRRORED = [
  'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize',
] as const

/** 第 caret 个字符处的视口坐标(left / 行顶 / 行底),可直接给 OverlayAt。UI 缩放下 getBoundingClientRect 是缩放后的,
 *  副本里量出来的是缩放前的,这里按实测比例换算。 */
export function textareaCaretRect(el: HTMLTextAreaElement, caret: number): { left: number; top: number; bottom: number } {
  const style = getComputedStyle(el)
  const mirror = document.createElement('div')
  for (const key of MIRRORED) mirror.style[key] = style[key]
  Object.assign(mirror.style, { position: 'absolute', top: '0', left: '-9999px', visibility: 'hidden', overflow: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', height: 'auto' })
  mirror.textContent = el.value.slice(0, caret)
  const mark = document.createElement('span')
  mark.textContent = '​'
  mirror.append(mark)
  document.body.append(mirror)
  const box = el.getBoundingClientRect()
  const scale = el.offsetWidth ? box.width / el.offsetWidth : 1
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
  const left = box.left + (mark.offsetLeft - el.scrollLeft) * scale
  const top = box.top + (mark.offsetTop - el.scrollTop) * scale
  mirror.remove()
  return { left, top, bottom: top + lineHeight * scale }
}
