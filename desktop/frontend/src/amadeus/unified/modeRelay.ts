/** 源码 ↔ 可视切换时的「接力」(评审 C-06):光标、滚动位置在两种视图间交接。
 *
 * v4 统一实例切源码时编辑器**不再卸载**(隐藏着留在原地,撤销栈与折叠跟着活着,见 UnifiedPage),这里只管两件事:
 *  1. 切换前的抓取点:store 的 setEditorMode 是所有入口(工具条 / 命令面板 / 移动端胶囊)的唯一咽喉,此刻两侧的 DOM
 *     都还在 —— 等 React 提交了新模式,textarea 已经没了,再想读它的光标就晚了(与 v3 modeCursor 同一条理由)。
 *     实例按 leaf 登记抓取函数,咽喉在翻模式之前调它。
 *  2. 位置换算的小工具:textarea 里某个字符偏移的屏幕纵坐标(镜像 div 量)、滚动容器、按锚文本校准偏移。
 * 滚动的口径是「光标在视口里的纵坐标不变」:切换前记下光标离滚动容器顶多远,切过去把新视图里的光标摆回同一高度 ——
 * 光标在屏外(用户滚走了)也照样成立,等于保住了相对滚动位置。 */

type Capture = (to: 'wysiwyg' | 'source') => void
const captures = new Map<string, Set<Capture>>()

/** 实例登记自己的切换前抓取(键 = leaf,与 editorModeOf 同一个键)。返回注销函数。 */
export function registerModeCapture(scope: string, fn: Capture): () => void {
  let set = captures.get(scope)
  if (!set) captures.set(scope, (set = new Set()))
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (!set!.size) captures.delete(scope)
  }
}

/** store 在翻模式之前调:让这个 leaf 上的实例把光标 / 滚动 / 最后几击抓下来。 */
export function runModeCapture(scope: string, to: 'wysiwyg' | 'source'): void {
  for (const fn of [...(captures.get(scope) ?? [])]) {
    try { fn(to) } catch (e) { console.error('[amadeus] mode capture failed', e) }
  }
}

/** 本实例的滚动容器:生产 / `&upane` 是 `.amx-pane`,独立挂载(默认台架)时是文档本身。 */
export function scrollHostOf(el: Element | null | undefined): HTMLElement {
  return el?.closest<HTMLElement>('.amx-pane') ?? (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/** 滚动容器可视区顶边的视口坐标(文档滚动时是 0)。 */
export function hostTop(host: HTMLElement): number {
  return host === document.scrollingElement || host === document.documentElement ? 0 : host.getBoundingClientRect().top
}

const MIRROR_PROPS = [
  'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'lineHeight',
  'textTransform', 'wordSpacing', 'tabSize', 'textIndent', 'whiteSpace', 'wordBreak', 'overflowWrap',
] as const

/** textarea 里第 offset 个字符处光标顶边的视口纵坐标(镜像 div 按同样的字体 / 宽度 / 换行排一遍再量)。 */
export function textareaCaretY(ta: HTMLTextAreaElement, offset: number): number {
  const cs = getComputedStyle(ta)
  const div = document.createElement('div')
  const st = div.style as unknown as Record<string, string>
  for (const p of MIRROR_PROPS) st[p] = (cs as unknown as Record<string, string>)[p]
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.top = '0'
  div.style.left = '-99999px'
  div.style.whiteSpace = 'pre-wrap'
  div.style.overflowWrap = 'break-word'
  div.textContent = ta.value.slice(0, offset)
  const mark = document.createElement('span')
  mark.textContent = ta.value.slice(offset, offset + 1) || '.'
  div.appendChild(mark)
  document.body.appendChild(div)
  const y = mark.offsetTop
  div.remove()
  return ta.getBoundingClientRect().top + y - ta.scrollTop
}

/** 用光标前的一小段原文把估算的偏移校准到最近的真实出现处(估算来自「前缀序列化 / 前缀解析」,行内标记会让它偏几个字符)。
 *  找不到就用估算值。 */
export function alignByAnchor(text: string, approx: number, anchor: string): number {
  const at = Math.max(0, Math.min(approx, text.length))
  if (!anchor) return at
  let best = -1
  let from = 0
  for (;;) {
    const i = text.indexOf(anchor, from)
    if (i < 0) break
    const end = i + anchor.length
    if (best < 0 || Math.abs(end - at) < Math.abs(best - at)) best = end
    from = i + 1
  }
  return best >= 0 && Math.abs(best - at) <= 400 ? best : at
}
