/**
 * 跳过首启引导的人,之后在主页输入框下面再问一次电脑历史(首启引导第四轮,细节页 §2)。
 * 只认本机这一个记号,不从电脑历史的状态去猜:引导走完、团队屏上把它关着点「开始使用」的人,状态和「跳过的人」一模一样
 * (都没写过、dataGen 为 0),但他已经答过了,不该再问。
 * - 'pending':跳过了带团队屏的引导。走完引导会清掉它。
 * - 'dismissed':在主页那一行点了 ✕,永远不再出。
 */
import { useEffect, useState } from 'react'

export const CH_ASK_KEY = 'forsion_ch_ask'
const EVENT = 'forsion:ch-ask'
export type ChAskMark = 'pending' | 'dismissed' | null

export function readChAsk(): ChAskMark {
  try {
    const v = localStorage.getItem(CH_ASK_KEY)
    return v === 'pending' || v === 'dismissed' ? v : null
  } catch { return null }
}
function write(v: ChAskMark): void {
  try {
    if (v) localStorage.setItem(CH_ASK_KEY, v)
    else localStorage.removeItem(CH_ASK_KEY)
  } catch { /* 隐私窗口里可能写不了:那就不问 */ }
  window.dispatchEvent(new Event(EVENT))
}
/** 跳过了带团队屏的引导:点过 ✕ 的不再翻回来。 */
export function markChAskSkipped(): void { if (readChAsk() !== 'dismissed') write('pending') }
/** 走完引导:团队屏上已经看过电脑历史那张卡了。 */
export function clearChAskOnFinish(): void { if (readChAsk() === 'pending') write(null) }
export function dismissChAsk(): void { write('dismissed') }

/** 主页常驻,引导盖在它上面时跳过 → 记号就地变:跟着事件重读。 */
export function useChAsk(): ChAskMark {
  const [mark, setMark] = useState<ChAskMark>(readChAsk)
  useEffect(() => {
    const sync = (): void => setMark(readChAsk())
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return mark
}

/**
 * 电脑历史「从没动过」:没有关过的记号(userTurnedOff,随电脑历史加密那件加),且 dataGen 为 0
 * (关闭 / 清除 / 改排除表都会让它 +1,跨重启持久)。新装机的团队屏预开、主页那一行都只给这种人。
 */
export function historyUntouched(state: { dataGen?: number } & object): boolean {
  const turnedOff = (state as { userTurnedOff?: boolean }).userTurnedOff === true
  return !turnedOff && !((state.dataGen ?? 0) > 0)
}
