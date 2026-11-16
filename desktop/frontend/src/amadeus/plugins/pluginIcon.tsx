/**
 * 插件图标(走查续八 8.17):一张词表(components/icons 的 PLUGIN_ICONS),三种用法 ——
 *  - `vocabIcon(name)`:lucide 调用形(size / className)的组件,给 EmptyState、Space、看法胶囊这类收组件的地方;
 *  - `pluginIconElement(name, size)`:`ctx.ui.icon` 返回给插件的 `<svg>` 元素(每个名字只真渲染一次,之后克隆;
 *    第一次先给空壳、微任务里补字形 —— 不在插件的调用栈里 flushSync,见 render);
 *  - `checkPluginIcon(pluginId, name, where)`:词表外的名字在控制台警告一次(插件 id + 名字一组),照样回落,不抛错。
 */
import type { ComponentType, SVGProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { PLUGIN_ICONS } from '../components/icons'

export type VocabIcon = ComponentType<{ size?: number | string; className?: string; strokeWidth?: number | string }>

export const hasPluginIcon = (name: unknown): name is string => typeof name === 'string' && Object.prototype.hasOwnProperty.call(PLUGIN_ICONS, name)

const comps = new Map<string, VocabIcon>()
export function vocabIcon(name: unknown): VocabIcon | undefined {
  if (!hasPluginIcon(name)) return undefined
  let c = comps.get(name)
  if (!c) {
    const Glyph = PLUGIN_ICONS[name] as ComponentType<SVGProps<SVGSVGElement>>
    c = ({ size = '1em', className, strokeWidth }) => <Glyph width={size} height={size} className={className} {...(strokeWidth != null ? { strokeWidth } : {})} aria-hidden />
    comps.set(name, c)
  }
  return c
}

const warned = new Set<string>()
function nearest(name: string): string | undefined {
  const keys = Object.keys(PLUGIN_ICONS)
  const pre = keys.find((k) => k.startsWith(name) || name.startsWith(k + '-') || k + 's' === name || name + 's' === k)
  if (pre) return pre
  const dist = (a: string, b: string): number => {
    const d = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]; d[0] = i
      for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t }
    }
    return d[b.length]
  }
  let best: string | undefined, bd = 3
  for (const k of keys) { const x = dist(name, k); if (x < bd) { bd = x; best = k } }
  return best
}

/** 名字在词表里 → true。不在(且像个名字,不是 emoji / 字形)→ 每个「插件 + 名字」警告一次,返回 false。 */
export function checkPluginIcon(pluginId: string, name: unknown, where = 'icon'): boolean {
  if (hasPluginIcon(name)) return true
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) return false
  const key = `${pluginId}\u0000${name}`
  if (!warned.has(key)) {
    warned.add(key)
    const hint = nearest(name)
    console.warn(`[${pluginId}] unknown icon "${name}" (${where})${hint ? ` (did you mean ${hint}?)` : ''} — see the icon vocabulary in the plugin docs`)
  }
  return false
}

const markup = new Map<string, string>()
const SVG_NS = 'http://www.w3.org/2000/svg'
/** 渲染一枚词表图标拿 svg 的 HTML。只许从下面的 drain(微任务 / 定时器)里调:flushSync 会把**所有根**上挂着的同步更新
 *  一起提交,放在插件的调用栈里,宿主排着的「换视图」就会在插件 draw() 的半中间把它卸掉(见 pluginIconReentry.test)。
 *  React 正在提交时 flushSync 不落地 → 返回 ''(微任务里本不会遇到,留着兜底)。 */
function render(name: string): string {
  const host = document.createElement('div')
  const root = createRoot(host)
  const Glyph = PLUGIN_ICONS[name] as ComponentType<SVGProps<SVGSVGElement>>
  try { flushSync(() => root.render(<Glyph />)) } catch { /* 见上 */ }
  const html = host.querySelector('svg')?.outerHTML ?? ''
  root.unmount()
  if (html) markup.set(name, html)
  return html
}
/** 把渲染好的那枚抄进(调用方已拿到的)svg:属性(尺寸、类名除外)和子节点。 */
function fill(svg: SVGSVGElement, html: string): void {
  const t = document.createElement('template')
  t.innerHTML = html
  const src = t.content.firstElementChild
  if (!src) return
  for (const a of Array.from(src.attributes)) if (!['width', 'height', 'class', 'aria-hidden'].includes(a.name)) svg.setAttribute(a.name, a.value)
  svg.replaceChildren(...Array.from(src.childNodes))
}
/** 第一次用到、还没渲染过的名字 → 等着补字形的空壳。 */
const later = new Map<string, SVGSVGElement[]>()
let drainQueued = false
/** 把等着的空壳补齐。头一趟在微任务里:调用方(插件的 draw 等)已经整段跑完,浏览器还没绘制,所以不重入也不闪;
 *  万一渲染没落地(返回 ''),下一拍再试一次,还不行就留空壳(尺寸本来就对)。 */
function drain(retry: boolean): void {
  for (const [name, list] of Array.from(later)) {
    const html = markup.get(name) ?? render(name)
    if (!html && retry) continue
    later.delete(name)
    if (html) for (const el of list) fill(el, html)
  }
  if (later.size) window.setTimeout(() => drain(false), 0)
}
/** 词表图标 → 一枚新的 `<svg>`(跟 currentColor,width/height = size)。查不到 → null。
 *  某个名字第一次用时先给一枚尺寸已对的空壳,字形在本轮微任务里补上(元素身份不变,插件已经 append 的照样生效;
 *  绘制前就补齐,不闪)。第二次起直接带字形。 */
export function pluginIconElement(name: string, size = 16): SVGSVGElement | null {
  if (!hasPluginIcon(name)) return null
  const html = markup.get(name)
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement
  svg.setAttribute('viewBox', '0 0 24 24')
  if (html) fill(svg, html)
  else {
    const q = later.get(name)
    if (q) q.push(svg)
    else later.set(name, [svg])
    if (!drainQueued) {
      drainQueued = true
      queueMicrotask(() => { drainQueued = false; drain(true) })
    }
  }
  const px = Number.isFinite(size) && size > 0 ? Math.min(size, 128) : 16
  svg.setAttribute('width', String(px))
  svg.setAttribute('height', String(px))
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('plugin-icon')
  return svg
}
