/**
 * 侧边拼接面板(App Dock)的渲染层:Mini 形态的一扇窗(?window=mini&dock=1),主进程把它贴在别的 App 窗口旁边。
 * 没贴之前列出屏上的窗口让用户挑;贴上之后就是一段新对话(原生 Chat View),每条消息默认带上这个 App 的引用
 * (`<forsion-app …/>`,电脑操作插件教模型把它当默认操作对象);用户点进面板那一刻读一次目标 App 的划线 / 选中项,挂成引用。
 * 跟随、挪窗口、读划线都在主进程(electron/appDock.ts),这里只管显示与交互。
 */
import { useEffect, useState } from 'react'
import { AppWindow, RefreshCw, X } from 'lucide-react'
import { MiniColumnHost, useWorkspace } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { useI18n, registerMessages } from '../i18n'
import { ensureAmadeusReady } from '../amadeusPlugins'
import { installFileDropGuard } from '../fileDropGuard'
import { setDirectMini } from '../MiniRoot'
import type { DockCandidate, DockSelection, DockWindow } from '../../../shared/appDock'
import './dock.css'

registerMessages({
  'dock.pickTitle': { zh: '贴到哪个窗口旁边', en: 'Dock beside a window' },
  'dock.pickHint': { zh: '选一个窗口，对话面板会贴在它旁边，一起移动和缩放。', en: 'Pick a window. The chat panel docks beside it and moves and resizes with it.' },
  'dock.loading': { zh: '正在查找窗口…', en: 'Looking for windows…' },
  'dock.empty': { zh: '屏幕上没有可以贴靠的窗口。', en: 'No windows on screen to dock beside.' },
  'dock.refresh': { zh: '刷新', en: 'Refresh' },
  'dock.close': { zh: '关闭', en: 'Close' },
  'dock.selectedIn': { zh: '在 {app} 里选中的：', en: 'Selected in {app}:' },
  'dock.err.helper_not_installed': { zh: '还没装好「电脑操作」的本机 helper。让 Agent 用一次电脑操作，它会自动装好。', en: 'The Computer Use helper is not installed yet. Ask the agent to use Computer Use once and it installs itself.' },
  'dock.err.helper_not_running': { zh: '「电脑操作」的本机 helper 没有启动。', en: 'The Computer Use helper is not running.' },
  'dock.err.unsupported_helper': { zh: '本机的「电脑操作」helper 是旧版，不支持侧边拼接。让 Agent 用一次电脑操作，它会自动更新。', en: 'The Computer Use helper is out of date and cannot dock. Ask the agent to use Computer Use once and it updates itself.' },
  'dock.err.window_gone': { zh: '这个窗口已经关了。', en: 'That window has been closed.' },
  'dock.err.generic': { zh: '没能贴过去（{code}）。', en: 'Could not dock ({code}).' },
})

const KNOWN_ERRORS = new Set(['helper_not_installed', 'helper_not_running', 'unsupported_helper', 'window_gone'])

/** 读到的划线 / 选中项 → 引用正文。没有可引用的 → ''。 */
export function selectionQuote(sel: DockSelection | null | undefined, app: string, t: (k: string, v?: Record<string, string>) => string): string {
  if (sel?.text) return sel.text
  if (sel?.items?.length) return [t('dock.selectedIn', { app }), ...sel.items.map((item) => `- ${item}`)].join('\n')
  return ''
}

export function DockRoot() {
  const { t } = useI18n()
  const [ready, setReady] = useState(false)
  const [target, setTarget] = useState<DockWindow | null>(null)
  useEffect(() => { useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined)) }, [t])
  useEffect(() => {
    // ponytail: 只在内存里切到 Work(本机执行),不写 localStorage —— 那是所有窗口共用的模式偏好。
    // Chat 模式的会话跑在沙箱里,电脑操作的工具不会出现,贴在 App 旁边就失去了意义。
    void useApp.getState().boot().finally(() => { useApp.setState({ sessionMode: 'work' }); setReady(true) })
    const off = window.tangu?.onAppDockState?.((s) => setTarget(s.target))
    void window.tangu?.appDockReady?.().then((s) => setTarget(s.target))
    return () => off?.()
  }, [])
  useEffect(() => { if (window.amadeus) ensureAmadeusReady() }, [])
  useEffect(() => installFileDropGuard(), [])

  // 贴上一个新目标 = 开一段新对话(activeId 清空 → 空白草稿,第一条消息才建会话)。
  useEffect(() => {
    if (!ready || !target) return
    const view = { type: 'chat', params: { miniSurface: true, appRef: target } }
    setDirectMini({ view, mainView: { type: 'chat' } })
    useApp.getState().setActiveId(null)
    useWorkspace.getState().openView('chat', view.params, 'main')
  }, [ready, target?.pid, target?.windowId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 用户点进面板那一刻读目标 App 的划线(App 失去前台后选区仍在)。同一段只挂一次:用户删掉引用后再点回来不会又冒出来。
  useEffect(() => {
    if (!target) return
    let last = ''
    const grab = async (): Promise<void> => {
      const quote = selectionQuote(await window.tangu?.appDockSelection?.(), target.app, t)
      if (!quote || quote === last) return
      last = quote
      useApp.getState().setPendingChatQuote('chat', quote)
    }
    window.addEventListener('focus', grab)
    return () => window.removeEventListener('focus', grab)
  }, [target, t])

  if (!target) return <DockPicker />
  return <MiniColumnHost buildDefault={() => {}} direct={{
    title: target.app,
    view: { type: 'chat', params: { miniSurface: true, appRef: target } },
    mainView: { type: 'chat' },
  }} />
}

function DockPicker() {
  const { t } = useI18n()
  const [list, setList] = useState<DockCandidate[] | null>(null)
  const [error, setError] = useState('')
  const load = async (): Promise<void> => {
    setList(null); setError('')
    const r = await window.tangu?.appDockCandidates?.()
    setList(r?.windows ?? [])
    if (r?.error) setError(r.error)
  }
  useEffect(() => { void load() }, [])
  const attach = async (c: DockCandidate): Promise<void> => {
    setError('')
    const r = await window.tangu?.appDockAttach?.({ pid: c.pid, windowId: c.windowId, app: c.app, bundleId: c.bundleId, title: c.title })
    if (r && !r.ok) setError(r.error || 'unavailable')
  }
  const errorText = error ? (KNOWN_ERRORS.has(error) ? t(`dock.err.${error}`) : t('dock.err.generic', { code: error })) : ''
  return (
    <div className="mini-card-shell" data-space="dock">
      <header className="mini-card-chrome">
        <div className="mini-card-drag-title dock-picker-title">{t('dock.pickTitle')}</div>
        <button className="mini-card-action" aria-label={t('dock.refresh')} title={t('dock.refresh')} onClick={() => void load()}><RefreshCw size={15} /></button>
        <button className="mini-card-action mini-card-close" aria-label={t('dock.close')} onClick={() => window.tangu?.closeSelf?.()}><X size={15} /></button>
      </header>
      <main className="mini-card-main dock-picker">
        <p className="dock-picker-hint">{t('dock.pickHint')}</p>
        {errorText && <p className="dock-picker-error" role="alert">{errorText}</p>}
        {list === null
          ? <div className="mini-panel-empty">{t('dock.loading')}</div>
          : list.length === 0
            ? (!errorText && <div className="mini-panel-empty">{t('dock.empty')}</div>)
            : <div className="dock-picker-list">{list.map((c) => (
              <button key={`${c.pid}:${c.windowId}`} className="mini-card-row dock-picker-row" data-window-id={c.windowId} onClick={() => void attach(c)}>
                <AppWindow size={15} />
                <span className="mini-card-row-label">
                  <span className="dock-picker-app">{c.app}</span>
                  {c.title && <span className="dock-picker-window">{c.title}</span>}
                </span>
              </button>
            ))}</div>}
      </main>
    </div>
  )
}
