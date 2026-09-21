/**
 * 面板自己的操作结果提示条(设置页用;形态与样式照抄市场那条 —— class 就是 base.css 末尾的 .mk-notice 那组,
 * 市场 hunk 落地后再统一改名)。
 *
 * 为什么不在浮窗里挂 NotificationHost:浮窗 = 独立渲染进程,它自己的 boot()/connect() 与 Amadeus 插件启动
 * 也往本窗的通知 store 发 app 级通知(会话列表加载失败、插件 notify…),挂上就与主窗重复一份;而那些与面板动作
 * 走的是同一个 toast 垫片,事后分不出来。所以反过来:面板动作**显式**调 panelToast —— 本窗挂着提示条就画在面板里,
 * 没挂(主窗 / 面板已关)就回落全局通知。不会重复,也不会静默。
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { AlertCircle, Check, X } from 'lucide-react'
import { useApp } from '../stores/appStore'
import { useI18n } from '../i18n'

const useNotice = create<{ notice: { text: string; error: boolean } | null }>(() => ({ notice: null }))
let hosts = 0

// 后到的覆盖先到的(错误也一样):设置里的动作是一次一个,「最近一次操作的结果」最不误导;
// 市场那条「成功不顶掉错误」是为并发安装定的,放这里会让上一条旧错误吞掉下一次操作的成功提示。
export function panelToast(text: string, error = false): void {
  if (!hosts) { useApp.getState().toast(text, error); return }
  useNotice.setState({ notice: { text, error } })
}

export function PanelNotice() {
  const { t } = useI18n()
  const notice = useNotice((s) => s.notice)
  useEffect(() => { hosts++; return () => { if (!--hosts) useNotice.setState({ notice: null }) } }, [])
  useEffect(() => {
    if (!notice || notice.error) return // 错误常驻到手动关 / 被下一条顶掉
    // 只收自己这一条:新提示的 setState 与 effect 清理之间,旧定时器可能先到期,不比对就会误删新来的错误(Codex 评审)。
    const timer = setTimeout(() => { if (useNotice.getState().notice === notice) useNotice.setState({ notice: null }) }, 4000)
    return () => clearTimeout(timer)
  }, [notice])
  if (!notice) return null
  return (
    <div className={`mk-notice${notice.error ? ' is-error' : ''}`} role={notice.error ? 'alert' : 'status'} data-panel-notice>
      {notice.error ? <AlertCircle size={15} /> : <Check size={15} />}
      <div className="mk-notice-body"><span>{notice.text}</span></div>
      <button className="mk-notice-close" onClick={() => useNotice.setState({ notice: null })} aria-label={t('common.close')}><X size={13} /></button>
    </div>
  )
}
