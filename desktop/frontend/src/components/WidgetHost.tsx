// 小组件(对话里做出来的卡)的宿主:对话卡头第二行(版本 · 归属 · 三个去处)+ 卡片区 / 仪表盘 / 主页按 id 画同一份原件。
// 这一版只开原生文档型;网页型三个去处灰着,只在对话里用(卡内 WebRTC 外泄,要等隔离方案)。
// 界面状态(滑杆、勾选、按钮改过的值)按小组件 id 存本机一份,四处共用、换版本不清。
import { useState } from 'react'
import { Check, Ellipsis, House, LayoutDashboard, LayoutGrid, PanelRight } from 'lucide-react'
import { validateUIDocument, type UIDocument } from '../../../../tangu-agent/src/contracts/intelligentUi'
import type { ToolEvent } from '../../../../tangu-agent/src/contracts/clientTypes'
import { readTanguIntelligentUi } from '../amadeus/plugins/tanguSeam'
import { ContextMenu, type CtxMenu } from './RightPanel'
import { panelToast } from './PanelNotice'
import { registerMessages, useI18n } from '../i18n'
import { agentName } from '../agentName'
import { useApp } from '../stores/appStore'
import { currentPlatform } from '../services/platform'
import { projectOf, rememberWidgetProject, restoreWidget, savedWidgetOf, useWidget, type SavedWidget, type WidgetOriginal, type WidgetRecordRow, type WidgetState } from '../services/widgetClient'
import { placeOnBoard, placeOnDashboard, removeFromBoard, setRailScope, useBoardWidgets } from '../services/widgetPlaces'
import { isOnHome, placeOnHome, readHomeLayout, removeFromHome, saveHomeLayout, useHomeLayout } from '../views/homeWidgets'
import { usePageStore } from '../amadeus/store/pageStore'
import { isDashboardPath } from '@amadeus-shared/dashboard'
import './WidgetHost.css'

registerMessages({
  'widget.kind': { zh: '小组件', en: 'Widget' },
  'widget.toRail': { zh: '放进卡片区', en: 'Add to cards' },
  'widget.onRail': { zh: '已在卡片区', en: 'In cards' },
  'widget.toDash': { zh: '存到仪表盘', en: 'Save to dashboard' },
  'widget.onDash': { zh: '已在仪表盘', en: 'On dashboard' },
  'widget.toHome': { zh: '放到主页', en: 'Put on Home' },
  'widget.onHome': { zh: '已在主页', en: 'On Home' },
  'widget.tapRemove': { zh: '点一下拿掉', en: 'Click to remove' },
  'widget.more': { zh: '更多', en: 'More' },
  'widget.otherDash': { zh: '放到 {name}', en: 'Add to {name}' },
  'widget.noOtherDash': { zh: '还没有别的仪表盘', en: 'No other dashboards yet' },
  'widget.railAll': { zh: '卡片区：所有会话都显示', en: 'Cards: show in every chat' },
  'widget.htmlChatOnly': { zh: '网页型小组件这一版只能在对话里用', en: 'Web widgets stay in chat for now' },
  'widget.homeFull': { zh: '下排和右栏都满了', en: 'The row and side column are full' },
  'widget.placeFailed': { zh: '没放成：{msg}', en: "Couldn't place it: {msg}" },
  'widget.owner.user': { zh: '所有 Agent', en: 'All agents' },
  'widget.owner.project': { zh: '这个项目', en: 'This project' },
  'widget.deleted.title': { zh: '这张卡已删除', en: 'This widget was deleted' },
  'widget.deleted.body': { zh: '30 天内能恢复，记录还在。', en: 'You can restore it within 30 days. Its records are kept.' },
  'widget.restore': { zh: '恢复', en: 'Restore' },
  'widget.removeHere': { zh: '从这里拿掉', en: 'Remove from here' },
  'widget.unreadable.title': { zh: '这台设备还读不到它', en: "This device can't read it yet" },
  'widget.unreadable.body': { zh: '可能还没同步到。不会当成删了，也不会清掉这里的摆放。', en: "It may not have synced yet. It isn't treated as deleted and stays where you put it." },
  'widget.recordsUnreadable': { zh: '记录读不到，先只显示卡面。', en: "Records couldn't be read. Showing the card only." },
  'widget.old': { zh: '{title} 第 {rev} 版', en: '{title} v{rev}' },
  'widget.seeLatest': { zh: '看最新', en: 'See latest' },
})

export const widgetStateKey = (id: string): string => JSON.stringify(['widget', id, 1])

/** 「小组件 · v3 · Xyra」里的归属。 */
export function useWidgetOwner(w: Pick<WidgetOriginal, 'scope' | 'agentSlug'> | null | undefined, fallbackSlug?: string): string {
  const { t } = useI18n()
  const defs = useApp((s) => s.agentDefs)
  if (!w) return ''
  if (w.scope === 'user') return t('widget.owner.user')
  if (w.scope === 'project') return t('widget.owner.project')
  const slug = w.agentSlug || fallbackSlug
  return agentName(defs.find((a) => a.slug === slug)) || slug || ''
}

const rowsOf = (w: WidgetOriginal): WidgetRecordRow[] => (w.records.status === 'ok' ? w.records.rows : [])

function docOf(w: WidgetOriginal): UIDocument | null {
  try { return validateUIDocument(JSON.parse(w.content)) } catch { return null }
}

// ── 对话卡头第二行 ──
function MetaButton({ on, icon, off, onLabel, disabled, onClick }: { on: boolean; icon: React.ReactNode; off: string; onLabel: string; disabled?: boolean; onClick: () => void }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <button type="button" className={`wgt-btn${on ? ' on' : ''}`} aria-pressed={on} aria-disabled={disabled || undefined} title={on ? t('widget.tapRemove') : undefined}
      onClick={() => { if (!disabled) onClick() }}>
      {on ? <Check size={13} /> : icon}{on ? onLabel : off}
    </button>
  )
}

export function WidgetMeta({ saved, html, deleted, sessionSlug }: { saved: SavedWidget; html: boolean; deleted: boolean; sessionSlug?: string }): React.JSX.Element {
  const { t } = useI18n()
  const owner = useWidgetOwner(saved, sessionSlug)
  const rail = useBoardWidgets('rail')
  const today = useBoardWidgets('today')
  const home = useHomeLayout()
  const pages = usePageStore((s) => s.pages)
  const [menu, setMenu] = useState<CtxMenu>(null)
  const railItem = rail.status === 'ok' ? rail.items.find((w) => w.ref.id === saved.id) : undefined
  const onDash = today.status === 'ok' && today.items.some((w) => w.ref.id === saved.id)
  const onHome = isOnHome(home, saved.id)
  const off = html || deleted
  const fail = (e: unknown): void => panelToast(t('widget.placeFailed', { msg: e instanceof Error ? e.message : String(e) }), true)
  const toggleHome = (): void => {
    const cur = readHomeLayout()
    if (isOnHome(cur, saved.id)) { saveHomeLayout(removeFromHome(cur, saved.id)); return }
    const next = placeOnHome(cur, saved.id)
    if (!next) { panelToast(t('widget.homeFull'), true); return }
    saveHomeLayout(next)
  }
  const boardPaths = new Set([rail, today].flatMap((s) => (s.status === 'ok' ? [s.path] : [])))
  const others = pages.filter((p) => isDashboardPath(p) && !boardPaths.has(p)).slice(0, 8)
  return (
    <div className="wgt-meta">
      <LayoutGrid size={12} /><span>{t('widget.kind')}</span><span className="wgt-dot">·</span><span>v{saved.rev}</span>
      {owner && <><span className="wgt-dot">·</span><span>{owner}</span></>}
      {html && <span className="wgt-note">{t('widget.htmlChatOnly')}</span>}
      <span className="wgt-acts">
        <MetaButton on={!!railItem} disabled={off} icon={<PanelRight size={13} />} off={t('widget.toRail')} onLabel={t('widget.onRail')}
          onClick={() => void (railItem ? removeFromBoard('rail', saved.id) : placeOnBoard('rail', { id: saved.id })).catch(fail)} />
        <MetaButton on={onDash} disabled={off} icon={<LayoutDashboard size={13} />} off={t('widget.toDash')} onLabel={t('widget.onDash')}
          onClick={() => void (onDash ? removeFromBoard('today', saved.id) : placeOnBoard('today', { id: saved.id })).catch(fail)} />
        <MetaButton on={onHome} disabled={off} icon={<House size={13} />} off={t('widget.toHome')} onLabel={t('widget.onHome')} onClick={toggleHome} />
        <button type="button" className="wgt-btn wgt-more" aria-label={t('widget.more')} aria-disabled={off || undefined}
          onClick={(e) => {
            if (off) return
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({
              x: r.right, y: r.bottom + 4, anchorTop: r.top,
              items: [
                ...(others.length
                  ? others.map((p) => ({ label: t('widget.otherDash', { name: p.split('/').pop()!.replace(/\.dashboard\.md$/i, '') }), icon: <LayoutDashboard size={14} />, run: () => void placeOnDashboard(p, { id: saved.id }).catch(fail) }))
                  : [{ label: t('widget.noOtherDash'), disabled: true, run: () => {} }]),
                { label: t('widget.railAll'), icon: <PanelRight size={14} />, separatorBefore: true, disabled: !railItem, checked: railItem?.ref.scope === 'all',
                  run: () => void setRailScope(saved.id, railItem?.ref.scope === 'all' ? undefined : 'all').catch(fail) },
              ],
            })
          }}><Ellipsis size={14} /></button>
      </span>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** 对话里的 intelligent_ui 调用:存成了小组件的,标题下多一行卡头;同一张改过几版,只有最新那次是活的,之前的压成一行。 */
export function ChatIntelligentUi({ event, live, stateScope, onAsk, sessionId }: { event: ToolEvent; live: boolean; stateScope?: string; onAsk?: (text: string) => void; sessionId?: string }): React.JSX.Element {
  const saved = event.done && !event.isError ? savedWidgetOf(event.result) : null
  const desktop = currentPlatform() === 'desktop'
  const ui = readTanguIntelligentUi()
  if (!ui) return <></> // 只在 Tangu 的对话里用到,Tangu 激活时已交出渲染件
  const { IntelligentUi } = ui
  if (!saved || !desktop) return <IntelligentUi event={event} live={live} stateScope={stateScope} onAsk={onAsk} />
  return <ChatWidgetCall event={event} live={live} onAsk={onAsk} saved={saved} sessionId={sessionId} />
}

function ChatWidgetCall({ event, live, onAsk, saved, sessionId }: { event: ToolEvent; live: boolean; onAsk?: (text: string) => void; saved: SavedWidget; sessionId?: string }): React.JSX.Element {
  const { t } = useI18n()
  const st = useWidget(saved.id)
  const [peek, setPeek] = useState(false)
  const projectPath = useApp((s) => (sessionId ? [...s.sessions, ...s.archivedSessions].find((x) => x.id === sessionId)?.project_path : undefined))
  const sessionSlug = useSessionAgentSlug(sessionId)
  if (saved.scope === 'project') rememberWidgetProject(saved.id, projectPath)
  const latest = st.status === 'ok' ? st.widget : null
  if (latest && latest.rev > saved.rev) {
    const jump = (): void => {
      const live = [...document.querySelectorAll<HTMLElement>(`[data-widget-id="${saved.id}"][data-widget-live]`)].at(-1)
      if (live) live.scrollIntoView({ block: 'center', behavior: 'smooth' }); else setPeek((v) => !v)
    }
    return (
      <div className="wgt-old" data-widget-id={saved.id}>
        <div className="wgt-old-line"><LayoutGrid size={13} /><span>{t('widget.old', { title: latest.title || saved.name, rev: saved.rev })}</span><span className="wgt-dot">·</span>
          <button type="button" className="wgt-link" onClick={jump}>{t('widget.seeLatest')}</button></div>
        {peek && <div className="wgt-peek"><WidgetHost id={saved.id} /></div>}
      </div>
    )
  }
  const records = latest && latest.rev === saved.rev ? rowsOf(latest) : undefined
  const IntelligentUi = readTanguIntelligentUi()?.IntelligentUi
  if (!IntelligentUi) return <></>
  return (
    <div data-widget-id={saved.id} data-widget-live="">
      <IntelligentUi event={event} live={live} onAsk={onAsk} records={records} stateKey={widgetStateKey(saved.id)}
        head={<WidgetMeta saved={saved} html={false} deleted={!!latest?.deletedAt} sessionSlug={sessionSlug} />} />
    </div>
  )
}

// ── 三处的卡身 ──
export function WidgetPlaceholder({ kind, id, onRemove }: { kind: 'deleted' | 'unreadable'; id: string; onRemove?: () => void }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="wgt-ph">
      <b>{t(`widget.${kind}.title`)}</b><span>{t(`widget.${kind}.body`)}</span>
      {kind === 'deleted' && (
        <span className="wgt-ph-acts">
          <button type="button" className="wgt-btn wgt-solid" onClick={() => void restoreWidget(id).catch((e) => panelToast(String(e), true))}>{t('widget.restore')}</button>
          {onRemove && <button type="button" className="wgt-btn wgt-solid" onClick={onRemove}>{t('widget.removeHere')}</button>}
        </span>
      )}
    </div>
  )
}

/** 卡片区 / 仪表盘 / 主页里的一张小组件:不画标题(各处卡头自己画),正文 = 原生文档。 */
export function WidgetHost({ id, onRemove, titled }: { id: string; onRemove?: () => void; titled?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const st = useWidget(id)
  if (st.status === 'loading') return <div className="wgt-host wgt-loading" aria-busy="true" />
  if (st.status !== 'ok') return <WidgetPlaceholder kind="unreadable" id={id} />
  const w = st.widget
  if (w.deletedAt) return <WidgetPlaceholder kind="deleted" id={id} onRemove={onRemove} />
  if (w.entry !== 'widget.json') return <div className="wgt-ph"><span>{t('widget.htmlChatOnly')}</span></div>
  const doc = docOf(w)
  const NativeDocument = readTanguIntelligentUi()?.NativeDocument
  if (!doc || !NativeDocument) return <WidgetPlaceholder kind="unreadable" id={id} />
  return (
    <div className={`wgt-host${titled ? ' wgt-titled' : ''}`} data-widget-id={id}>
      <NativeDocument key={`${id}:${w.rev}`} doc={doc} complete live={false} stateKey={widgetStateKey(id)} records={rowsOf(w)} />
      {w.records.status === 'error' && <div className="wgt-note">{t('widget.recordsUnreadable')}</div>}
    </div>
  )
}

/** 各处卡头用的标题与归属(读同一份缓存)。 */
export function useWidgetTitle(id: string): { title: string; owner: string; widget: WidgetOriginal | null } {
  const st = useWidget(id)
  const widget = st.status === 'ok' ? st.widget : null
  const owner = useWidgetOwner(widget)
  return { title: widget ? widget.title || widget.name : '', owner, widget }
}

/** 会话的 Agent:会话配置里的,缺了是缺省 Agent。 */
export function useSessionAgentSlug(sessionId: string | null | undefined): string | undefined {
  return useApp((s) => {
    if (!sessionId) return undefined
    const cfg = s.configBySession[sessionId] || [...s.sessions, ...s.archivedSessions].find((x) => x.id === sessionId)?.agent_config
    return cfg?.agentSlug || s.defaultAgentSlug || undefined
  })
}

/** 卡片区显示范围:缺省只在归属者的会话(这个 Agent / 这个项目;用户级 = 所有 Agent 都算);`scope: all` 到处显示。
 *  还没读到的先不画;读不到的只在「所有会话」那几张上画占位(不知道是谁的,不往每个会话里塞)。 */
export function railShows(ref: { scope?: 'all' }, st: WidgetState, sessionSlug: string | undefined, projectPath: string | null | undefined): boolean {
  if (st.status === 'loading') return false
  if (st.status !== 'ok') return ref.scope === 'all'
  if (ref.scope === 'all' || st.widget.scope === 'user') return true
  if (st.widget.scope === 'agent') return !!sessionSlug && st.widget.agentSlug === sessionSlug
  return !!projectPath && projectOf(st.widget.id) === projectPath
}
