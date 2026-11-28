/** 底部状态栏:内置项目 + 设置感知的 DesktopStatusBar 包装。
 *  每个项目自带 context 敏感性(不适用时返回 null 整项消失):同步项无同步源即隐藏、
 *  反链/字数只在 Amadeus 编辑器视图、收件箱/运行中只在计数 > 0 时出现。
 *  用户可在设置「通知与状态栏」隐藏/排序(prefs.ts);插件项见 pluginStatusBridge.tsx。 */
import { useEffect, useState } from 'react'
import { AlertCircle, Check, CloudOff, Inbox, Link2, RefreshCw } from 'lucide-react'
import {
  StatusBar, activeMainPanel, addStatusItem, useStatusStore, getActiveSpace, label,
  openCommandPalette, switchSpace, useSpaceStore, useWorkspace,
  effectiveHotkey, formatHotkey, isMacPlatform, useShortcuts,
} from '@lcl/engine'
import type { StatusItem } from '@lcl/engine'
import { registerMessages, useI18n } from '../i18n'
import '../shellMessages'
import { useApp } from '../stores/appStore'
import { useInbox } from '../stores/inboxStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { useNoteCount } from '@amadeus/lib/activeNote'
import { amadeus } from '@amadeus/api'
import { useSbPrefs } from './prefs'
import { ipcErrorText } from '../ipcError'
import { useVaultSync } from '../sync/vaultSyncStore'
import { syncNow } from '../sync/vaultSyncActions'
import { failureText, opText, vaultSyncTip, vaultSyncWords } from '../sync/vaultSyncText'
import { hasSyncBridges } from '../sync/VaultSyncChip'

/** 当前主区激活视图类型(同 WorkspaceView.useActiveMainType:订阅 mainTabs 驱动重算)。 */
function useActiveMainType(): string | null {
  useWorkspace((s) => s.mainTabs)
  const api = useWorkspace.getState().api
  const am = api ? activeMainPanel(api) : null
  return am ? (((am.params ?? {}) as { __type?: string }).__type ?? null) : null
}

/** 左:当前 Space(图标 + 名);点击开命令面板(切 Space/开视图都在里面)。
 *  可点项一律 <button>:原来是 span+onClick,键盘 Tab 不到、读屏也不知道能点。 */
function SpaceItem() {
  const { t } = useI18n()
  useSpaceStore((s) => s.activeSpaceId)
  useShortcuts((s) => s.overrides)
  const space = getActiveSpace()
  if (!space) return null
  const Icon = space.icon
  // 快捷键与 installHotkeys 同源(command-palette 缺省 mod+k,用户可改键 / 解绑)
  const hk = effectiveHotkey({ id: 'command-palette', hotkey: 'mod+k' })
  const title = hk ? t('lcl.withHotkey', { label: t('sb.switchSpace'), key: formatHotkey(hk, isMacPlatform()) }) : t('sb.switchSpace')
  return (
    <button type="button" className="sb-click" title={title} onClick={() => openCommandPalette()}>
      {Icon && <Icon size={11} />}
      {label(space.name)}
    </button>
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

/** 右:当前库的同步状态(智库同步第 1 步起读状态源 —— 和左栏「智库」那行、同步面板、通知同一份字)。
 *  这个库没在同步、别处也没事要看时隐藏;点它立即同步(这个库的每一路各踢一次)。 */
function useActiveVaultSync() {
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const side = usePageStore((s) => s.vaultSide)
  return useVaultSync(side === 'cloud' ? { root: null, side: 'cloud' } : { root: vaultRoot, side: 'local' })
}

/** 同步要你看一眼(状态栏总开关关着时据此单独露出同步项):这个库出错 / 等你定,或别的库有出错 / 等你定。
 *  ⚠️ 刻意不含没登录:没登录 / 没开云端的人会一直是这个态,算进来等于状态栏永远在。 */
function useSyncAlert(): boolean {
  const view = useActiveVaultSync()
  return view.state === 'error' || view.state === 'review' || view.elsewhere.errors > 0 || view.elsewhere.review > 0
}

function SyncItem() {
  const { t } = useI18n()
  const view = useActiveVaultSync()
  const elsewhere = view.elsewhere.errors + view.elsewhere.review
  if (!hasSyncBridges() || (view.state === 'off' && !elsewhere)) return null
  const words = vaultSyncWords(view, view.now, t)
  const icon = view.state === 'error' ? <AlertCircle size={11} style={{ color: 'var(--danger)' }} />
    : view.state === 'syncing' || view.state === 'checking' ? <RefreshCw size={11} className="spin" />
    : view.state === 'review' ? <AlertCircle size={11} style={{ color: 'var(--warning)' }} />
    : view.state === 'offline' || view.state === 'signed-out' ? <CloudOff size={11} />
    : view.state === 'off' ? <AlertCircle size={11} style={{ color: 'var(--warning)' }} />
    : view.state === 'on' ? <RefreshCw size={11} />
    : <Check size={11} />
  const text = view.state === 'off' ? t('vsync.panel.elsewhere', { n: elsewhere }) : words.text
  const cur = view.progress?.current
  const detail = cur ? opText(cur.op, cur.path, t) : view.failures[0] ? `${view.failures[0].path} · ${failureText(view.failures[0], view.target, t)}` : view.error ? ipcErrorText(view.error) : null
  const tip = [view.state === 'off' ? text : vaultSyncTip(view, words, t), detail, elsewhere && view.state !== 'off' ? t('vsync.panel.elsewhere', { n: elsewhere }) : null].filter(Boolean).join(' · ')
  // 点了真会触发一轮同步时才说「点击立即同步」(没登录、正在跑时点它什么也不做)
  const canSync = view.feeds.some((f) => f.canSyncNow)
  return (
    <button
      type="button"
      className="sb-click"
      data-sync-state={view.state}
      title={canSync ? `${tip} · ${t('sb.clickToSync')}` : tip}
      onClick={() => { if (canSync) void syncNow(view.feeds) }}
    >
      {icon}
      {text}
    </button>
  )
}

/** 右:当前笔记反链数(仅 Amadeus 编辑器视图);点击打开反链视图。 */
function BacklinksItem() {
  const { t } = useI18n()
  const type = useActiveMainType()
  const activePage = usePageStore((s) => s.activePage ?? s.activeNotePath) // v4 不设 activePage
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
    <button type="button" className="sb-click" title={t('sb.openBacklinks')} onClick={() => useWorkspace.getState().openView('amadeus-backlinks', {}, 'main')}>
      <Link2 size={11} />
      {t('sb.backlinks', { n: count })}
    </button>
  )
}

registerMessages({
  'sb.count': { zh: '{words} 词 · {chars} 字', en: '{words} words · {chars} chars' },
  'sb.countSel': { zh: '已选 {words} 词 · {chars} 字', en: 'Selected {words} words · {chars} chars' },
})

/** 右:当前笔记词数 / 字数,有选区时换成选区的(仅 Amadeus 编辑器视图;从编辑器工具条迁入,原 word-count 插件状态项)。
 *  v4 数可见文字、选区一变就跟上(评审 C-22,见 lib/activeNote.useNoteCount)。 */
function WordCountItem() {
  const { t } = useI18n()
  const type = useActiveMainType()
  const count = useNoteCount() // v3 读 blocks,v4 问 unified 实例(正文不进 store)
  if (type !== 'amadeus-editor' || count == null) return null
  const c = count.sel ?? count.all
  return <span className="sb-plain" data-count={count.sel ? 'sel' : 'all'}>{t(count.sel ? 'sb.countSel' : 'sb.count', { words: c.words, chars: c.chars })}</span>
}

/** 右:收件箱未读数(0 时隐藏);点击进 Inbox Space。只显示一个数字 → 名字与含义放进可访问名 / 悬停说明
 *  (与 Ribbon 收件箱角标同一句 ribbon.spaceUnread)。新用户缺省隐藏(与 Ribbon 角标重复,见 prefs.ts)。 */
function InboxItem() {
  const { t } = useI18n()
  const n = useInbox((s) => s.unreadCount)
  const inbox = useSpaceStore((s) => s.spaces.find((x) => x.id === 'inbox'))
  if (!n) return null
  const desc = t('ribbon.spaceUnread', { name: inbox ? label(inbox.name) : t('sb.item.inbox'), n })
  return (
    <button type="button" className="sb-click" title={desc} aria-label={desc} onClick={() => switchSpace('inbox')}>
      <Inbox size={11} />
      {n}
    </button>
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

/** 设置感知的状态栏(Shell footer):总开关关闭即整条不渲染 —— 唯一例外是**同步出错**:那时只露同步一项,
 *  恢复即收(10-02 用户拍板「框架收声」,缺省关,见 prefs.ts)。hidden/order 透传引擎 StatusBar。
 *  显示时置 --sb-h 给 main/right 视图让位(见 engine.css .wb-view--main/--right);隐藏/卸载即清 →
 *  工作区满高(detached/mini 窗不渲染本组件 → 无 --sb-h → 视图不缩,零副作用)。 */
export function DesktopStatusBar() {
  const { t } = useI18n()
  const enabled = useSbPrefs((s) => s.enabled)
  const hidden = useSbPrefs((s) => s.hidden)
  const order = useSbPrefs((s) => s.order)
  const alert = useSyncAlert()
  const items = useStatusStore((s) => s.items)
  const shown = enabled || alert
  useEffect(() => {
    if (!shown) return
    document.documentElement.style.setProperty('--sb-h', '18px')
    return () => { document.documentElement.style.removeProperty('--sb-h') }
  }, [shown])
  if (!shown) return null
  if (!enabled) return <StatusBar hidden={items.map((i) => i.id).filter((id) => id !== 'sync.status')} trailing={isPluginItem} label={t('sb.label')} />
  return <StatusBar hidden={hidden} order={order} trailing={isPluginItem} label={t('sb.label')} />
}

/** 插件项(pluginStatusBridge 的 id 命名空间):无自定义顺序时归到所在侧的末尾,与内置项之间画分隔。 */
const isPluginItem = (i: StatusItem): boolean => i.id.startsWith('plugin:')
