/**
 * 内置浏览器点选的元素 → 输入框里的一张元素磁贴(借鉴 Comma 方案 2.4,仓根 docs/ToBeImproved/借鉴Comma方案_2026-10-21/rest.html)。
 *
 * 不另开消息通道,走已有的两条:
 *  - 文字:发送时接在正文后面一小段(同长粘贴磁贴 composePastes),模型读到 URL、选择器和元素里的字;
 *  - 截图:发送时并进这条消息的图片附件(同「引用窗口」的截图)—— 磁贴上只放图标,截图只给模型。
 * 找落点、送事件的那一半在宿主:builtins/elementPickDelivery.ts。
 */
import type { Attachment } from '../../../../../tangu-agent/src/contracts/clientTypes'

export interface ElementPick {
  /** 草稿里认这张磁贴用(删 / React key) */
  id: string
  url: string
  host: string
  title: string
  selector: string
  tag: string
  text: string
  /** 元素截图;截不到就只发文字 */
  image: Attachment | null
}

/** 宿主(内置浏览器)→ 输入卡的事件与输入卡身上的标记。宿主侧 builtins/elementPickDelivery.ts 写同样的字面值
 *  (宿主只许经入口用 Tangu 模块,check:tanguboundary),两边相等由 elementPick.test.ts 钉住。 */
export const ELEMENT_EVENT = 'forsion:element-add'
export const ELEMENT_TARGET_ATTR = 'data-element-target'
export const TILE_TITLE_MAX = 20

/** 磁贴标题里那段字:元素文字前 20 字;没有字 → null(调用方退回标签名)。按码点截,别把表情劈成半个。 */
export function tileExcerpt(text: string): string | null {
  const s = text.replace(/\s+/g, ' ').trim()
  if (!s) return null
  const chars = Array.from(s)
  return chars.length > TILE_TITLE_MAX ? chars.slice(0, TILE_TITLE_MAX).join('') + '…' : s
}

/** 副行里的选择器:只放最后一节(`section.hero > a.btn:nth-of-type(2)` → `a.btn:nth-of-type(2)`),整条在悬停提示和发出去的文字里。 */
export function selectorTail(selector: string): string {
  const parts = selector.split(/\s*>\s*|\s+/).filter(Boolean)
  return parts[parts.length - 1] || selector
}

/** 模型读的那一段(英文,同其它给模型读的文字)。 */
export function formatElementBlock(pick: Pick<ElementPick, 'url' | 'selector' | 'text' | 'image' | 'title'>): string {
  const lines = ['[Web element picked in the built-in browser]', `URL: ${pick.url}`]
  if (pick.title) lines.push(`Page title: ${pick.title}`)
  lines.push(`Selector: ${pick.selector}`)
  lines.push(pick.text ? `Text: ${JSON.stringify(pick.text)}` : 'Text: (none)')
  if (pick.image) lines.push('Screenshot of the element is attached.')
  return lines.join('\n')
}

/** 发出的正文:你写的(含粘贴块)在前,每个元素一段接在后面。 */
export function composeElements(body: string, elements: readonly ElementPick[]): string {
  return [body, ...elements.map(formatElementBlock)].filter(Boolean).join('\n\n')
}

/** 随这条消息发的元素截图(按挂上的顺序)。 */
export function elementImages(elements: readonly ElementPick[]): Attachment[] {
  return elements.flatMap((e) => (e.image ? [e.image] : []))
}

/** 输入卡获得焦点时盖上的时刻(毫秒):屏上同时有几张时,宿主那边挑最近用过的那张(builtins/elementPickDelivery.ts)。 */
export const ELEMENT_USED_ATTR = 'data-element-used-at'
export const markComposerUsed = (card: Element): void => { card.setAttribute(ELEMENT_USED_ATTR, String(Date.now())) }
