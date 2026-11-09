/**
 * 反馈入口与页内反馈通道(2026-11-09)。
 *
 * 入口有三个:Ribbon 下区的 rb-feedback、命令面板的 open-feedback、输入框的 /feedback。三个都认同一个开关:
 * `window.tangu.submitFeedback` 在不在。桌面上它是 Electron preload 给的(转 Forsion Extend 主进程半身的 feedback:submit),
 * 启动那一刻就在;网页主入口与手机没有主进程,通道由 Extend 的页内半身经 `ctx.app.provideFeedbackChannel` 交来 ——
 * 那时启动早跑完了,所以入口不能只在启动时判一次(此前就是这样,网页 / 手机一直没有反馈入口)。
 *
 * 交来的函数直接挂成 `window.tangu.submitFeedback`:反馈弹窗、/feedback(在 Tangu 界面包里,会热更新到老宿主上,
 * 只认这个键)都不用另学一条路。只挂这一个键 —— Extend 的 cloudFetch 等仍不外露(宿主看到 cloudFetch 会当成桌面)。
 *
 * 页内通道认不出账号(网页 / 手机的会话凭据不是 JWT),带 expectedAccountId 的发送一律回 account-changed;
 * 「附上这条原文」那个勾按「认得出账号」画(见 FeedbackReasons.canShareOriginal),所以在这两端照旧不出现。
 */
import { MessageSquare } from 'lucide-react'
import { addCommand, removeCommand, addRibbonIcon, useRibbonStore, moveTo } from '@lcl/engine'
import { useApp } from './stores/appStore'

export type SubmitFeedback = NonNullable<NonNullable<Window['tangu']>['submitFeedback']>

/** 通道装上 / 撤掉时在 window 上派发:输入框的斜杠表据此重算(它是 memo 过的)。 */
export const FEEDBACK_CHANNEL_EVENT = 'forsion:feedback-channel'

const MOVED_KEY = 'forsion_ribbon_feedback_above_market'
let icon = false
let command = false
/** 现在挂在 window.tangu 上的页内通道是谁交的;null = 没有(或桥上那个是宿主自己的)。 */
let provider: string | null = null
const app = (): ReturnType<typeof useApp.getState> => useApp.getState()

/**
 * Ribbon 下区的反馈图标。幂等。
 * 启动时注册(桌面):落在注册序里商店后面,老存档只挪一次。
 * late = 通道晚到(网页 / 手机):启动时的注册序早排完了,用 `after` 插回商店后面(11-07 默认「商店 → 反馈」);
 * 用户排过下区(bottomOrder 非空)而里面没有它时,同样插在商店后面,已有就尊重用户的位置。
 */
export function installFeedbackIcon(late = false): void {
  if (icon) return
  icon = true
  addRibbonIcon({ id: 'rb-feedback', side: 'bottom', icon: MessageSquare, tooltip: () => app().tr('feedback.title'), onClick: () => { app().openFeedback() }, ...(late ? { after: 'rb-market' } : {}) })
  const rb = useRibbonStore.getState()
  const folded = rb.folders.some((f) => f.items.includes('rb-feedback'))
  if (late) {
    const market = rb.bottomOrder.indexOf('rb-market')
    if (market >= 0 && !rb.bottomOrder.includes('rb-feedback') && !folded) rb.setZoneOrder('bottom', [...rb.bottomOrder.slice(0, market + 1), 'rb-feedback', ...rb.bottomOrder.slice(market + 1)])
    // 下面那条 08-31 的一次性迁移是给「反馈一直在」的桌面老存档的,这里位置已经定了,别再让它挪一遍
    try { localStorage.setItem(MOVED_KEY, '1') } catch { /* ignore */ }
    return
  }
  // 老存档(用户动过底部区)的 bottomOrder 里,rb-feedback 要么还停在 08-31 前的旧位(明暗与命令之间),要么缺席
  // (rankIds 排到区末尾)→ 只挪一次到商店之前,打标记后用户再拖到哪算哪。
  // ponytail: 只认「商店在持久顺序里、反馈不在收纳夹里」的形状,其余形状不动(注册序或用户自己的摆法)。
  if (!localStorage.getItem(MOVED_KEY)) {
    const at = rb.bottomOrder.filter((id) => id !== 'rb-feedback').indexOf('rb-market')
    if (at >= 0 && !folded) rb.setZoneOrder('bottom', moveTo(rb.bottomOrder, 'rb-feedback', at))
    try { localStorage.setItem(MOVED_KEY, '1') } catch { /* ignore */ }
  }
}

/** 命令面板的「反馈」。幂等。 */
export function installFeedbackCommand(): void {
  if (command) return
  command = true
  addCommand({ id: 'open-feedback', icon: MessageSquare, title: () => app().tr('feedback.title'), keywords: 'feedback bug report 反馈 问题 建议 报错', run: () => { app().openFeedback() } })
}

function removeFeedbackEntries(): void {
  icon = false
  command = false
  // ⚠️ 只摘掉在场的那一格,不走 removeRibbonIcon:它会连持久顺序和收纳夹成员一起抹掉(那是「这个图标真的没了」才该做的)。
  //    Extend 更新 / 重载就是一次撤回再交来,用户把反馈拖到哪、收进哪个夹,回来还得在原处。
  //    代价:Extend 真的不在了时,夹里会留一个不显示的成员;它是锁定的核心包,正常卸不掉。
  useRibbonStore.setState((s) => ({ items: s.items.filter((item) => item.id !== 'rb-feedback') }))
  removeCommand('open-feedback')
}

const announce = (): void => { try { window.dispatchEvent(new Event(FEEDBACK_CHANNEL_EVENT)) } catch { /* ignore */ } }

/**
 * 页内通道:插件(只有首方的 Forsion Extend,判定在 pluginStore)交来 submit,或交 null 撤回自己那一份。
 * 桥上已经有宿主自己的通道(桌面)→ 不接,回 false。后来的覆盖先来的;撤回只认交的那个人。
 */
export function provideFeedbackChannel(pluginId: string, submit: SubmitFeedback | null): boolean {
  const bridge = typeof window !== 'undefined' ? window.tangu : undefined
  if (!bridge) return false
  if (submit === null) {
    if (provider !== pluginId) return false
    provider = null
    try { delete (bridge as { submitFeedback?: SubmitFeedback }).submitFeedback } catch { return false }
    removeFeedbackEntries()
    useApp.getState().closeFeedback()
    announce()
    return true
  }
  if (typeof submit !== 'function') return false
  if (bridge.submitFeedback && provider === null) return false
  try { (bridge as { submitFeedback?: SubmitFeedback }).submitFeedback = submit } catch { return false }
  // 桥是冻住的(contextBridge)时赋值不抛也不生效:没挂上就不算
  if (bridge.submitFeedback !== submit) return false
  provider = pluginId
  installFeedbackIcon(true)
  installFeedbackCommand()
  announce()
  return true
}

/** 测试用:清掉模块状态。 */
export function resetFeedbackChannelForTest(): void { icon = false; command = false; provider = null }
