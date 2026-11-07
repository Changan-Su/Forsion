/** 主页卡的种类(11-07 方案 A):近况卡以外,一张卡可以是宿主内置的四张(卜算子·建议 / 收件箱 / 最近笔记 / 最近对话)、
 *  插件卡(manifest `widgets` + `ctx.widgets.provide`,宿主照同一套行样式画)或 Agent 做的小组件(w_…,原生文档)。
 *  卡头(图标 / 标题 / 归属 / 点了去哪)与卡身按 id 前缀分派 —— 只有 w_… 才去问引擎要原件。 */
import { createContext, Fragment, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { CalendarDays, Check, FileText, Globe, Inbox, LayoutGrid, ListTodo, MessagesSquare, RefreshCw, Sparkles } from 'lucide-react'
import { launchSpace } from '../objects/space'
import { registerMessages, useI18n } from '../i18n'
import { WidgetHost, useWidgetTitle } from '../components/WidgetHost'
import { panelToast } from '../components/PanelNotice'
import { useApp } from '../stores/appStore'
import { useInbox, senderOf } from '../stores/inboxStore'
import { useAmadeusPrefs } from '../amadeusPrefs'
import { openNote } from '../amadeusNav'
import { openSession } from '../sessionNav'
import { displaySessionTitle } from '../sessionTitle'
import { agentName } from '../agentName'
import { formatListTime } from '../format/time'
import { pluginWanted, usePluginStore } from '../amadeus/plugins/pluginStore'
import { pluginDisplayName } from '../amadeus/plugins/display'
import { vocabIcon } from '../amadeus/plugins/pluginIcon'
import { usePluginWidgetData, type WidgetListRow } from '../amadeus/plugins/pluginWidgets'
import { readTanguMuseStarters, subscribeTanguMuseStarters } from '../amadeus/plugins/tanguSeam'
import type { MuseStarter } from '../types'
import { MUSE_CARD, SESSIONS_CARD, isBuiltinWidget, parsePluginWidgetId, type BuiltinWidget } from './homeWidgets'

registerMessages({
  'home.w.muse': { zh: '卜算子·建议', en: 'From Muse' },
  'home.w.inbox': { zh: '收件箱', en: 'Inbox' },
  'home.w.notes': { zh: '最近笔记', en: 'Recent notes' },
  'home.w.sessions': { zh: '最近对话', en: 'Recent chats' },
  'home.w.use': { zh: '用这句', en: 'Use this' },
  'home.w.next': { zh: '换一条', en: 'Next' },
  'home.w.museBusy': { zh: '输入框里还有没发的话，先发出去或清空再用这句', en: 'There is an unsent message in the input. Send or clear it first' },
  'home.w.museEmpty': { zh: '卜算子还没有建议', en: 'No suggestions from Muse yet' },
  'home.w.unread': { zh: '条未读', en: 'unread' },
  'home.w.notesEmpty': { zh: '还没打开过笔记', en: 'No notes opened yet' },
  'home.w.sessionsEmpty': { zh: '还没有对话', en: 'No chats yet' },
  'home.w.off': { zh: '{name} 已停用', en: '{name} is turned off' },
  'home.w.turnOn': { zh: '启用', en: 'Turn on' },
  'home.w.failed': { zh: '暂时读不到', en: "Couldn't load right now" },
  'home.w.empty': { zh: '暂时没有内容', en: 'Nothing here yet' },
  'home.w.missingTitle': { zh: '插件卡', en: 'Plugin card' },
  'home.w.missing': { zh: '来自插件 {name}。装上或更新它之后这张卡就回来；平时不显示。', en: 'From the {name} plugin. It comes back once the plugin is installed or updated. Hidden until then.' },
})

/** 主页把「打开输入框」交给卡(卜算子·建议点「用这句」:填进新对话草稿后要展开主页输入框)。 */
export const HomeWidgetEnv = createContext<{ openComposer: () => void }>({ openComposer: () => {} })

const NEW_CHAT_DRAFT = 'new' // 新对话草稿的键(和 Composer2 同一个;主页输入区恒是新对话)

export const BUILTIN_ICON: Record<BuiltinWidget, typeof Sparkles> = {
  'builtin:muse': Sparkles, 'builtin:inbox': Inbox, 'builtin:notes': FileText, 'builtin:sessions': MessagesSquare,
}
const BUILTIN_SPACE: Partial<Record<BuiltinWidget, string>> = { 'builtin:inbox': 'inbox', 'builtin:notes': 'amadeus', 'builtin:sessions': 'tangu' }
const builtinKey = (id: BuiltinWidget): string => `home.w.${id.slice('builtin:'.length)}`

// ── Muse 的开场建议(经 tanguSeam,Tangu 没激活 = 没有) ──
const NO_STARTERS: MuseStarter[] = []
export const useMuseStarterList = (): MuseStarter[] =>
  useSyncExternalStore(subscribeTanguMuseStarters, () => readTanguMuseStarters()?.list() ?? NO_STARTERS)

/** 默认摆放里的卜算子·建议:没有建议时这一格画最近对话(最近对话已经摆着就不替)。用户自己摆的也照此 —— 空卡不占栏。 */
export function useShownWidgetId(id: string, layoutHas: (id: string) => boolean): string {
  const empty = useMuseStarterList().length === 0
  // 拉建议的是这里而不是卜算子卡自己:没有建议时卡根本不挂,等它挂上再拉就永远拉不到
  const seam = useSyncExternalStore(subscribeTanguMuseStarters, () => !!readTanguMuseStarters())
  useEffect(() => { if (id === MUSE_CARD && seam) readTanguMuseStarters()?.refresh() }, [id, seam])
  return id === MUSE_CARD && empty && !layoutHas(SESSIONS_CARD) ? SESSIONS_CARD : id
}

export interface HomeWidgetHead {
  /** false = 画不出来(插件没装 / 没声明这张):栏里跳过,不占位。 */
  show: boolean
  title: string
  owner: string
  icon: React.ReactNode
  open?: () => void
}

/** 卡头的图标默认 13(卡头),收起成条用 16、收纳面板用 18。 */
export function useHomeWidgetHead(id: string, size = 13): HomeWidgetHead {
  const { t, locale } = useI18n()
  const plug = parsePluginWidgetId(id)
  const agent = useWidgetTitle(!plug && !isBuiltinWidget(id) ? id : '') // 只有 w_… 才问引擎
  const plugin = usePluginStore((s) => (plug ? s.plugins.find((p) => p.id === plug.pluginId) : undefined))
  if (isBuiltinWidget(id)) {
    const Icon = BUILTIN_ICON[id]
    const space = BUILTIN_SPACE[id]
    return { show: true, title: t(builtinKey(id)), owner: '', icon: <Icon size={size} />, open: space ? () => launchSpace(space) : undefined }
  }
  if (plug) {
    const spec = plugin?.widgets?.find((w) => w.id === plug.widgetId)
    // 编辑态里照样画(占位),好让用户看得见、拿得掉;平时不画(useShowableIds)
    if (!plugin || !spec || plugin.blocked) return { show: false, title: t('home.w.missingTitle'), owner: plugin ? pluginDisplayName(plugin, locale) : plug.pluginId, icon: <LayoutGrid size={size} /> }
    const space = spec.space
    const Vocab = vocabIcon(spec.icon)
    return {
      show: true,
      title: locale === 'en' && spec.titleEn ? spec.titleEn : spec.title,
      owner: pluginDisplayName(plugin, locale),
      icon: Vocab ? <Vocab size={size} /> : plugin.iconUrl ? <img className="hp-wcard-pic" src={plugin.iconUrl} alt="" style={{ width: size, height: size }} /> : <LayoutGrid size={size} />,
      open: space ? () => launchSpace(space) : undefined,
    }
  }
  return { show: true, title: agent.title, owner: agent.owner, icon: <LayoutGrid size={size} /> }
}

/** 一组 id 里画得出来的那些(栏的「有没有东西」、中间让位都按这个算)。 */
export function useShowableIds(ids: readonly string[]): string[] {
  const plugins = usePluginStore((s) => s.plugins)
  return ids.filter((id) => {
    const plug = parsePluginWidgetId(id)
    if (!plug) return true
    const p = plugins.find((x) => x.id === plug.pluginId)
    return !!p && !p.blocked && !!p.widgets?.some((w) => w.id === plug.widgetId)
  })
}

// ── 卡身 ──
export function HomeWidgetBody({ id, wide, onRemove }: { id: string; wide?: boolean; onRemove: () => void }): React.JSX.Element {
  if (id === 'builtin:muse') return <MuseBody wide={!!wide} />
  if (id === 'builtin:inbox') return <InboxBody />
  if (id === 'builtin:notes') return <NotesBody />
  if (id === 'builtin:sessions') return <SessionsBody />
  const plug = parsePluginWidgetId(id)
  if (plug) return <PluginBody pluginId={plug.pluginId} widgetId={plug.widgetId} />
  return <WidgetHost id={id} onRemove={onRemove} />
}

/** 列表卡的一行(内置卡与插件卡同一套样子:方案 A 的「今天 / 待办 / 最近笔记」)。 */
export interface HomeListRow extends Omit<WidgetListRow, 'id' | 'title'> {
  key: string
  title: React.ReactNode
  /** 左边的小图标 / 头像(没有 time、没有 done 时画)。 */
  lead?: React.ReactNode
  onClick?: () => void
}

export function HomeList({ rows, footer, empty }: { rows: HomeListRow[]; footer?: React.ReactNode; empty: string }): React.JSX.Element {
  if (!rows.length) return <div className="hp-wl-empty">{empty}</div>
  let group: string | undefined
  return (
    <div className="hp-wl">
      {rows.map((r) => {
        const head = r.group && r.group !== group ? r.group : null
        group = r.group
        const lead = r.done !== undefined
          ? <span className={`hp-wl-box${r.done ? ' on' : ''}`} aria-hidden>{r.done && <Check size={10} strokeWidth={3} />}</span>
          : r.time !== undefined ? <i className={`hp-wl-dot${r.now ? ' on' : ''}`} aria-hidden /> : r.lead
        return (
          <Fragment key={r.key}>
            {head && <div className="hp-wl-group">{head}</div>}
            <button type="button" className={`hp-wl-row${r.done ? ' done' : ''}${r.now ? ' now' : ''}`} onClick={r.onClick} disabled={!r.onClick}>
              {lead && <span className="hp-wl-lead">{lead}</span>}
              {r.time !== undefined && <span className="hp-wl-time">{r.time}</span>}
              <span className="hp-wl-title">{r.title}</span>
              {r.meta && <span className="hp-wl-meta" data-tone={r.tone}>{r.meta}</span>}
            </button>
          </Fragment>
        )
      })}
      {footer && <div className="hp-wl-foot">{footer}</div>}
    </div>
  )
}

const STARTER_ICON: Record<MuseStarter['source']['kind'], typeof Sparkles> = {
  calendar: CalendarDays, note: FileText, todo: ListTodo, session: MessagesSquare, web: Globe, muse: Sparkles,
}
/** 句子里所指的那段(引擎保证在句子里;万一不在,整句当正文)。 */
function splitStarter(s: MuseStarter): { pre: string; link: string; post: string } {
  const at = s.source.label ? s.text.indexOf(s.source.label) : -1
  return at < 0 ? { pre: s.text, link: '', post: '' } : { pre: s.text.slice(0, at), link: s.source.label, post: s.text.slice(at + s.source.label.length) }
}

/** 卜算子·建议:栏里 / 1 格是「一签」(一次一条,用这句 / 换一条),2 格是三行清单。点了 = 整句填进主页输入框(不发)。 */
function MuseBody({ wide }: { wide: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const env = useContext(HomeWidgetEnv)
  const list = useMuseStarterList()
  const [at, setAt] = useState(0)
  // 输入框里有自己写的字:不冲掉,打开输入框让人看到那份草稿,并说一句为什么没填
  const use = (s: MuseStarter): void => {
    const filled = readTanguMuseStarters()?.fill(NEW_CHAT_DRAFT, s.id)
    if (filled === false) panelToast(t('home.w.museBusy'))
    env.openComposer()
  }
  const open = (e: React.MouseEvent, s: MuseStarter): void => { e.stopPropagation(); readTanguMuseStarters()?.open(s.id) }
  if (!list.length) return <div className="hp-wl-empty">{t('home.w.museEmpty')}</div>
  const text = (s: MuseStarter): React.ReactNode => {
    const { pre, link, post } = splitStarter(s)
    return <>{pre}{link && <span className="hp-wsign-link" role="link" onClick={(e) => open(e, s)}>{link}</span>}{post}</>
  }
  if (wide) {
    return <HomeList empty="" rows={list.map((s) => { const Icon = STARTER_ICON[s.source.kind] || Sparkles; return { key: s.id, lead: <Icon size={13} />, title: text(s), onClick: () => use(s) } })} />
  }
  const i = Math.min(at, list.length - 1)
  const s = list[i]
  const Icon = STARTER_ICON[s.source.kind] || Sparkles
  return (
    <div className="hp-wsign">
      <div className="hp-wsign-src"><Icon size={12} /><span>{s.source.label}</span></div>
      <button type="button" className="hp-wsign-t" onClick={() => use(s)}>{text(s)}</button>
      <div className="hp-wl-foot">
        <button type="button" className="hp-wbtn" onClick={() => use(s)}>{t('home.w.use')}</button>
        {list.length > 1 && <button type="button" className="hp-wbtn ghost" onClick={() => setAt((i + 1) % list.length)}><RefreshCw size={12} />{t('home.w.next')}</button>}
        {list.length > 1 && <span className="hp-wdots" aria-hidden>{list.map((x, k) => <i key={x.id} className={k === i ? 'on' : undefined} />)}</span>}
      </div>
    </div>
  )
}

function InboxBody(): React.JSX.Element {
  const { t } = useI18n()
  const unread = useInbox((s) => s.unreadCount)
  const latest = useInbox((s) => s.messages.find((m) => !m.read_at) ?? s.messages[0])
  useEffect(() => {
    const st = useInbox.getState()
    void st.refreshUnread()
    if (!st.listLoaded) void st.refreshList()
  }, [])
  return (
    <button type="button" className="hp-wstat" onClick={() => launchSpace('inbox')}>
      <span className="hp-wbig"><b>{unread}</b><span>{t('home.w.unread')}</span></span>
      {latest && <span className="hp-wsub">{senderOf(latest)} · {latest.title}</span>}
    </button>
  )
}

const baseName = (p: string): string => (p.split('/').pop() ?? p).replace(/\.md$/i, '')
function NotesBody(): React.JSX.Element {
  const { t } = useI18n()
  const recents = useAmadeusPrefs((s) => s.recents)
  const rows: HomeListRow[] = recents.slice(0, 4).map((p) => {
    const dir = p.includes('/') ? p.split('/').slice(-2, -1)[0] : ''
    return { key: p, lead: <FileText size={13} />, title: baseName(p), meta: dir || undefined, onClick: () => void openNote(p) }
  })
  return <HomeList rows={rows} empty={t('home.w.notesEmpty')} />
}

function SessionsBody(): React.JSX.Element {
  const { t } = useI18n()
  const sessions = useApp((s) => s.sessions)
  const defs = useApp((s) => s.agentDefs)
  const fallback = useApp((s) => s.defaultAgentSlug)
  const rows: HomeListRow[] = sessions
    .filter((s) => !s.archived && !s.parent_session_id)
    .slice()
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, 4)
    .map((s) => {
      const name = agentName(defs.find((a) => a.slug === (s.agent_config?.agentSlug || fallback))) || ''
      const ini = s.emoji || (name ? Array.from(name)[0].toUpperCase() : '')
      return { key: s.id, lead: ini ? <span className="hp-wl-ini">{ini}</span> : <MessagesSquare size={13} />, title: displaySessionTitle(s.title, t), meta: s.updated_at ? formatListTime(s.updated_at) : undefined, onClick: () => openSession(s.id) }
    })
  return <HomeList rows={rows} empty={t('home.w.sessionsEmpty')} />
}

function PluginBody({ pluginId, widgetId }: { pluginId: string; widgetId: string }): React.JSX.Element {
  const { t, locale } = useI18n()
  const plugin = usePluginStore((s) => s.plugins.find((p) => p.id === pluginId))
  const wanted = usePluginStore((s) => (plugin ? pluginWanted(plugin, s.disabledIds) : false))
  const active = usePluginStore((s) => s.activeIds.includes(pluginId))
  const data = usePluginWidgetData(pluginId, widgetId)
  const spec = plugin?.widgets?.find((w) => w.id === widgetId)
  if (!plugin || !spec || plugin.blocked) return <div className="hp-wl-empty">{t('home.w.missing', { name: plugin ? pluginDisplayName(plugin, locale) : pluginId })}</div>
  if (!wanted) {
    return (
      <div className="hp-wl-empty">
        {t('home.w.off', { name: pluginDisplayName(plugin, locale) })}
        {!plugin.locked && <button type="button" className="hp-wbtn" onClick={() => usePluginStore.getState().enable(pluginId)}>{t('home.w.turnOn')}</button>}
      </div>
    )
  }
  // 插件还在装载 / 这次还没拿到:灰底占着高度,不闪「没有内容」
  if (data.status === 'none' ? !active : data.status === 'loading' && !data.list) return <div className="hp-wl-loading" aria-busy="true" />
  if (data.status === 'error' && !data.list) return <div className="hp-wl-empty" title={data.error}>{t('home.w.failed')}</div>
  const list = data.status === 'none' ? { rows: [] } : data.list ?? { rows: [] }
  const go = spec?.space ? () => launchSpace(spec.space!) : undefined
  return <HomeList rows={list.rows.map((r) => ({ ...r, key: r.id, onClick: go }))} footer={list.footer} empty={list.empty ?? t('home.w.empty')} />
}
