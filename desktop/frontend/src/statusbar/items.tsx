/** 底部状态栏:内置项目 + 设置感知的 DesktopStatusBar 包装。
 *  每个项目自带 context 敏感性(不适用时返回 null 整项消失):同步项无同步源即隐藏、
 *  反链/字数只在 Amadeus 编辑器视图、收件箱/运行中只在计数 > 0 时出现。
 *  用户可在设置「通知与状态栏」隐藏/排序(prefs.ts);插件项见 pluginStatusBridge.tsx。 */
import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, CloudOff, Inbox, Link2, RefreshCw } from 'lucide-react'
import {
  StatusBar, activeMainPanel, addStatusItem, getActiveSpace, label,
  openCommandPalette, setActiveSpace, useSpaceStore, useWorkspace,
} from '@lcl/engine'
import { useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { useInbox } from '../stores/inboxStore'
import { ensureEntrySyncSubscribed, useEntrySync } from '../stores/entrySyncStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { amadeus } from '@amadeus/api'
import { useSbPrefs } from './prefs'
import type { AmadeusSyncStatus, RemoteSyncProgress, RemoteSyncReport } from '../types'

/** 当前主区激活视图类型(同 WorkspaceView.useActiveMainType:订阅 mainTabs 驱动重算)。 */
function useActiveMainType(): string | null {
  useWorkspace((s) => s.mainTabs)
  const api = useWorkspace.getState().api
  const am = api ? activeMainPanel(api) : null
  return am ? (((am.params ?? {}) as { __type?: string }).__type ?? null) : null
}

/** 左:当前 Space(图标 + 名);点击开命令面板(切 Space/开视图都在里面)。 */
function SpaceItem() {
  useSpaceStore((s) => s.activeSpaceId)
  const space = getActiveSpace()
  if (!space) return null
  const Icon = space.icon
  return (
    <span className="sb-click" onClick={() => openCommandPalette()}>
      {Icon && <Icon size={11} />}
      {label(space.name)}
    </span>
  )
}

/** 左:运行中的 agent 会话数(0 时隐藏)。 */
function AgentRunningItem() {
  const { t } = useI18n()
  const n = useApp((s) => Object.keys(s.runningBySession).length)
  if (!n) return null
  return (
    <span className="sb-plain">
      <RefreshCw size={11} className="spin" />
      {t('sb.agentRunning', { n })}
    </span>
  )
}

/** 报告是否算异常(失败 / 有错误行 / 有冲突)。 */
const badReport = (r: RemoteSyncReport | null): boolean => !!r && (!r.ok || r.errors.length > 0 || r.conflicts > 0)

/** 右:云同步聚合状态(镜像引擎 + 按条目引擎 + remotesync 三源)。无任何同步源时隐藏;
 *  点击手动同步(镜像 syncNow + remotesync run 各自触发,互不阻塞)。 */
function SyncItem() {
  const { t } = useI18n()
  const [mirror, setMirror] = useState<AmadeusSyncStatus | null>(null)
  const entry = useEntrySync((s) => s.status)
  const [remote, setRemote] = useState<{ running: boolean; bad: boolean; configured: boolean; progress: RemoteSyncProgress | null } | null>(null)
  useEffect(() => {
    ensureEntrySyncSubscribed()
    void window.amadeusSync?.get().then((s) => setMirror((prev) => prev ?? s)).catch(() => {})
    const off1 = window.amadeusSync?.onStatus?.((s) => {
      if (!(s as AmadeusSyncStatus).binding) setMirror(s as AmadeusSyncStatus)
    })
    // remotesync:configured 从 get() 读;onStatus 无 config,用「在跑/有过报告」佐证已配置。
    void window.remoteSync?.get()
      .then((s) => setRemote({ running: s.running, bad: badReport(s.lastReport), configured: s.config.backend !== 'off', progress: s.progress ?? null }))
      .catch(() => {})
    const off2 = window.remoteSync?.onStatus?.((s) =>
      setRemote((prev) => ({ running: s.running, bad: badReport(s.lastReport), configured: prev?.configured || s.running || !!s.lastReport, progress: s.progress ?? null })),
    )
    return () => {
      off1?.()
      off2?.()
    }
  }, [])
  const enabledEntries = Object.values(entry).filter((s) => s.enabled)
  const mirrorOn = !!mirror?.enabled
  if (!mirrorOn && !enabledEntries.length && !remote?.configured && !remote?.running) return null
  const all = [...(mirrorOn && mirror ? [mirror] : []), ...enabledEntries]
  const err = all.some((s) => s.state === 'error' || s.state === 'auth-required') || !!remote?.bad
  const syncing = !!remote?.running || all.some((s) => s.state === 'syncing' || s.state === 'starting')
  const offline = all.some((s) => s.state === 'offline')
  const pending = all.reduce((a, s) => a + (s.pending || 0), 0)
  const icon = err ? <AlertCircle size={11} style={{ color: 'var(--danger)' }} />
    : syncing ? <RefreshCw size={11} className="spin" />
    : offline ? <CloudOff size={11} />
    : <Check size={11} />
  // remotesync 执行阶段有 x/y 进度(remotely-save 式),优先展示
  const rp = remote?.running ? remote.progress : null
  const text = err ? t('sb.syncError')
    : rp?.total ? t('sb.syncProgress', { done: rp.done, total: rp.total })
    : syncing ? (pending > 0 ? t('sb.syncing', { n: pending }) : t('sb.syncingPlain'))
    : offline ? t('sb.syncOffline')
    : t('sb.synced')
  return (
    <span
      className="sb-click"
      title={(err && (mirror?.error || undefined)) || (rp?.key ? `${text} · ${rp.key}` : text)}
      onClick={() => {
        if (mirrorOn) void window.amadeusSync?.syncNow?.().catch(() => {})
        if (remote?.configured && !remote.running) void window.remoteSync?.run?.().catch(() => {})
      }}
    >
      {icon}
      {text}
    </span>
  )
}

/** 右:当前笔记反链数(仅 Amadeus 编辑器视图);点击打开反链视图。 */
function BacklinksItem() {
  const { t } = useI18n()
  const type = useActiveMainType()
  const activePage = usePageStore((s) => s.activePage)
  const ver = usePageStore((s) => s.linkGraphVersion)
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    if (!activePage) {
      setCount(null)
      return
    }
    let on = true
    amadeus.backlinks(activePage).then((r) => { if (on) setCount(r.length) }).catch(() => { if (on) setCount(null) })
    return () => { on = false }
  }, [activePage, ver])
  if (type !== 'amadeus-editor' || !activePage || count == null) return null
  return (
    <span className="sb-click" onClick={() => useWorkspace.getState().openView('amadeus-backlinks', {}, 'main')}>
      <Link2 size={11} />
      {t('sb.backlinks', { n: count })}
    </span>
  )
}

/** 右:当前笔记字数(仅 Amadeus 编辑器视图;从编辑器工具条迁入,原 word-count 插件状态项)。 */
function WordCountItem() {
  const { t } = useI18n()
  const type = useActiveMainType()
  const activePage = usePageStore((s) => s.activePage)
  const blocks = usePageStore((s) => s.blocks)
  const chars = useMemo(() => {
    const text = Object.values(blocks).map((b) => b.content).join(' ')
    return text.replace(/\s/g, '').length
  }, [blocks])
  if (type !== 'amadeus-editor' || !activePage) return null
  return <span className="sb-plain">{t('sb.chars', { n: chars })}</span>
}

/** 右:收件箱未读数(0 时隐藏);点击进 Inbox Space。 */
function InboxItem() {
  const n = useInbox((s) => s.unreadCount)
  if (!n) return null
  return (
    <span className="sb-click" onClick={() => setActiveSpace('inbox')}>
      <Inbox size={11} />
      {n}
    </span>
  )
}

/** 内置项元数据(设置页列表用;id 与注册一致)。 */
export const BUILTIN_STATUS_ITEMS: Array<{ id: string; labelKey: string; side: 'left' | 'right' }> = [
  { id: 'core.space', labelKey: 'sb.item.space', side: 'left' },
  { id: 'agent.running', labelKey: 'sb.item.agentRunning', side: 'left' },
  { id: 'sync.status', labelKey: 'sb.item.sync', side: 'right' },
  { id: 'note.backlinks', labelKey: 'sb.item.backlinks', side: 'right' },
  { id: 'editor.wordCount', labelKey: 'sb.item.wordCount', side: 'right' },
  { id: 'inbox.unread', labelKey: 'sb.item.inbox', side: 'right' },
]

let installed = false
/** 注册全部内置项(幂等;Root 挂载时调一次)。 */
export function installStatusBarItems(): void {
  if (installed) return
  installed = true
  addStatusItem({ id: 'core.space', side: 'left', component: SpaceItem })
  addStatusItem({ id: 'agent.running', side: 'left', component: AgentRunningItem })
  addStatusItem({ id: 'sync.status', side: 'right', component: SyncItem })
  addStatusItem({ id: 'note.backlinks', side: 'right', component: BacklinksItem })
  addStatusItem({ id: 'editor.wordCount', side: 'right', component: WordCountItem })
  addStatusItem({ id: 'inbox.unread', side: 'right', component: InboxItem })
}

/** 设置感知的状态栏(Shell footer):总开关关闭即整条不渲染;hidden/order 透传引擎 StatusBar。
 *  显示时置 --sb-h 给 main/right 视图让位(见 engine.css .wb-view--main/--right);隐藏/卸载即清 →
 *  工作区满高(detached/mini 窗不渲染本组件 → 无 --sb-h → 视图不缩,零副作用)。 */
export function DesktopStatusBar() {
  const enabled = useSbPrefs((s) => s.enabled)
  const hidden = useSbPrefs((s) => s.hidden)
  const order = useSbPrefs((s) => s.order)
  useEffect(() => {
    if (!enabled) return
    document.documentElement.style.setProperty('--sb-h', '18px')
    return () => { document.documentElement.style.removeProperty('--sb-h') }
  }, [enabled])
  if (!enabled) return null
  return <StatusBar hidden={hidden} order={order} />
}
