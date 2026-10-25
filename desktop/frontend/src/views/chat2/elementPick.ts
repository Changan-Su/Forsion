/**
 * 内置浏览器点选的元素 → 输入框里的一张元素磁贴(借鉴 Comma 方案 2.4,仓根 docs/ToBeImproved/借鉴Comma方案_2026-10-21/rest.html)。
 *
 * 不另开消息通道,走已有的两条:
 *  - 文字:发送时接在正文后面一小段(同长粘贴磁贴 composePastes),模型读到 URL、选择器和元素里的字;
 *  - 截图:发送时并进这条消息的图片附件(同「引用窗口」的截图)—— 磁贴上只放图标,截图只给模型。
 * 落点:浏览器开在某个对话的 Agent Desk 里 → 那个对话的输入框;否则最近用过的那张可见输入框;都没有 → 打开右侧对话面板
 * (跟着当前会话 = 这个 Space 最近的那个对话),再没有就开新会话。
 */
import { useCommandStore } from '@lcl/engine'
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

export const ELEMENT_EVENT = 'forsion:element-add'
export const ELEMENT_TARGET_ATTR = 'data-element-target'
export const TILE_TITLE_MAX = 20

/** 地址 → 副行里的「域名」:网页取 host(带端口,本机服务分得清),file: 取文件名。 */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || '') || 'file'
    return u.host || u.protocol.replace(/:$/, '')
  } catch { return '' }
}

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

// ── 落点 ─────────────────────────────────────────────

/** 输入卡最近一次被用(获得焦点)的时刻:多张可见时挑最近用过的那张。 */
const lastUsed = new WeakMap<Element, number>()
export const markComposerUsed = (card: Element): void => { lastUsed.set(card, Date.now()) }

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[${ELEMENT_TARGET_ATTR}]`)]
const visible = (el: Element | null | undefined): el is HTMLElement => !!el && el.getClientRects().length > 0

/** 挑落点(不开新东西)。from = 点选按钮所在的浏览器视图。 */
export function pickTargetCard(from: Element | null): HTMLElement | undefined {
  // 浏览器开在某个对话的 Agent Desk 里:就是那个对话
  const desk = from?.closest('.agent-desk')
  const own = desk?.closest('.t2-chat-view')?.querySelector<HTMLElement>(`[${ELEMENT_TARGET_ATTR}]`)
  if (visible(own)) return own
  const shown = cards().filter(visible)
  if (!shown.length) return undefined
  return shown.reduce((a, b) => ((lastUsed.get(b) ?? 0) > (lastUsed.get(a) ?? 0) ? b : a))
}

let finding: Promise<HTMLElement | undefined> | null = null
async function openTarget(): Promise<HTMLElement | undefined> {
  const run = useCommandStore.getState().run
  for (let i = 0; i < 50; i++) {
    const hit = cards().find(visible)
    if (hit) return hit
    if (i === 0) run('show-chat-panel') // 右侧对话面板跟着当前会话走 = 这个 Space 最近的对话
    if (i === 25) run('new-chat') // 面板摆不出来(这个 Space 没有对话面板):开新会话
    await new Promise((r) => setTimeout(r, 100))
  }
  return undefined
}

/** 把点选结果送进输入框。返回是否找到了输入框。 */
export async function deliverElementPick(pick: ElementPick, from: Element | null): Promise<boolean> {
  const target = pickTargetCard(from) ?? await (finding ??= openTarget().finally(() => { finding = null }))
  if (!target) return false
  target.dispatchEvent(new CustomEvent<ElementPick>(ELEMENT_EVENT, { detail: pick }))
  return true
}
