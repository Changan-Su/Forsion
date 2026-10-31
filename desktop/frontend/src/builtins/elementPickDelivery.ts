/**
 * 内置浏览器点选的元素 → 送进哪张输入卡(宿主一侧;磁贴、发出去的样子在 Tangu 的 views/chat2/elementPick.ts)。
 * 落点:浏览器开在某个对话的 Agent Desk 里 → 那个对话的输入框;否则最近用过的那张可见输入框;都没有 → 打开右侧对话面板
 * (跟着当前会话 = 这个 Space 最近的那个对话),再没有就开新会话。
 * 和输入卡之间只有 DOM 约定(事件名 + 两个属性),不 import Tangu 的运行时模块(check:tanguboundary);字面值两边相等由 elementPick.test.ts 钉住。
 */
import { getActiveSpace, useCommandStore } from '@lcl/engine'
import type { ElementPick } from '@tangu/ui/views/chat2/elementPick'

export const ELEMENT_EVENT = 'forsion:element-add'
export const ELEMENT_TARGET_ATTR = 'data-element-target'
export const ELEMENT_USED_ATTR = 'data-element-used-at'

/** 地址 → 副行里的「域名」:网页取 host(带端口,本机服务分得清),file: 取文件名。 */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || '') || 'file'
    return u.host || u.protocol.replace(/:$/, '')
  } catch { return '' }
}

const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[${ELEMENT_TARGET_ATTR}]`)]
const visible = (el: Element | null | undefined): el is HTMLElement => !!el && el.getClientRects().length > 0
const usedAt = (el: Element): number => Number(el.getAttribute(ELEMENT_USED_ATTR)) || 0

/** 挑落点(不开新东西)。from = 点选按钮所在的浏览器视图。 */
export function pickTargetCard(from: Element | null): HTMLElement | undefined {
  // 浏览器开在某个对话的 Agent Desk 里:就是那个对话
  const desk = from?.closest('.agent-desk')
  const own = desk?.closest('.t2-chat-view')?.querySelector<HTMLElement>(`[${ELEMENT_TARGET_ATTR}]`)
  if (visible(own)) return own
  const shown = cards().filter(visible)
  if (!shown.length) return undefined
  return shown.reduce((a, b) => (usedAt(b) > usedAt(a) ? b : a))
}

/** 屏上没有输入卡时:先开右侧对话面板(跟着当前会话 = 这个 Space 最近的对话),摆不出来再开新会话,最多等 5 秒。
 *  等的途中换了 Space、浏览器标签被关掉或调用方作废(signal) → 不送了:别让元素落进后来随便哪个冒出来的输入框(Codex P2)。 */
async function openTarget(from: Element | null, signal?: AbortSignal): Promise<HTMLElement | undefined> {
  const run = useCommandStore.getState().run
  const space = getActiveSpace()?.id
  const gone = (): boolean => !!signal?.aborted || getActiveSpace()?.id !== space || (!!from && !from.isConnected)
  for (let i = 0; i < 50; i++) {
    if (gone()) return undefined
    const hit = cards().find(visible)
    if (hit) return hit
    if (i === 0) run('show-chat-panel')
    if (i === 25) run('new-chat') // 这个 Space 没有对话面板
    await new Promise((r) => setTimeout(r, 100))
  }
  return undefined
}

/** 把点选结果送进输入框。返回是否送到了。 */
export async function deliverElementPick(pick: ElementPick, from: Element | null, signal?: AbortSignal): Promise<boolean> {
  const target = pickTargetCard(from) ?? await openTarget(from, signal)
  if (!target || signal?.aborted) return false
  target.dispatchEvent(new CustomEvent<ElementPick>(ELEMENT_EVENT, { detail: pick }))
  return true
}
