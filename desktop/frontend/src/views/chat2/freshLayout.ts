// 空对话居中 → 首发落底(10-25 用户选,方案页 docs/ToBeImproved/Muse预制提示词方案_2026-10-25/glide.html):
// 对话列里一条消息都没有时,「空状态 + 输入区整簇(含 Muse 的开场建议)」整块垂直居中;按下发送那一刻输入区落回底部,
// 和发送动效(sendFlight.ts)同一条曲线、同一时长、同时起 —— 气泡的起点本来就是「按发送时输入框那一行」,于是从中间升起。
// 测量与动画在 EmptyState2 里(它本来就量这一列);这里只放纯算术和「按下发送 / 没发出去」两个广播。

/** 与 sendFlight 的 DURATION / EASE 同值:两段必须同起同停。 */
export const DROP_MS = 420
export const DROP_EASE = 'cubic-bezier(0.2, 0.8, 0.3, 1)' // = --ease-spring
/** 居中时空状态与输入区之间的空隙、整块离列顶的最小距离(局部 px)。 */
export const FRESH_GAP = 28
export const FRESH_MIN_TOP = 24

/**
 * 居中那一块怎么摆(纯函数,单测钉)。输入都是局部 px(offset / client 尺寸,不受端级 zoom 影响):
 *   colH = 列高;emptyH = 空状态高(放不下而藏起时传 0);anchorTop / anchorH = 输入区在流里的原位(贴底)与高度。
 * 返回空状态的 top 与输入区要往上抬多少(lift ≥ 0;0 = 不动)。放不下时整块顶到 FRESH_MIN_TOP 为止,不往下压。
 */
export function freshPlacement(colH: number, emptyH: number, anchorTop: number, anchorH: number): { emptyTop: number; lift: number } {
  const stack = (emptyH ? emptyH + FRESH_GAP : 0) + anchorH
  const top = Math.max(FRESH_MIN_TOP, Math.round((colH - stack) / 2))
  const anchorAt = top + (emptyH ? emptyH + FRESH_GAP : 0)
  return { emptyTop: top, lift: Math.max(0, Math.round(anchorTop - anchorAt)) }
}

/** press = 按下发送;drop = 没发出去;sent = 引擎受理了(这句真的成了一条对话)。 */
export type SendPhase = 'press' | 'drop' | 'sent'
const EVENT = 't2-fresh-send'
export interface FreshSendDetail { phase: SendPhase; key: string; ta: HTMLTextAreaElement | null }

/** Composer2 在按下发送(noteSend 旁)、没发出去(dropSend 旁)、受理之后调。只广播:听的人按 ta 所在的列 / 草稿 key 认领。 */
export function announceSend(phase: SendPhase, key: string, ta: HTMLTextAreaElement | null): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<FreshSendDetail>(EVENT, { detail: { phase, key, ta } }))
}

export function onSend(fn: (d: FreshSendDetail) => void): () => void {
  const h = (e: Event): void => fn((e as CustomEvent<FreshSendDetail>).detail)
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
