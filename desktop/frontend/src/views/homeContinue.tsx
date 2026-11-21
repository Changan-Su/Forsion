/** 手机主页的「继续」(方向 E 第 1 步,2026-11-19):最近的三项,对话和笔记混排、按时间新的在前;点一行直接进那条对话 /
 *  那篇笔记(被带去它自己的 Space 的第二层),返回回主页(lcl listTrips 的 return trip)。一项都没有时整张卡不画。
 *  取数:
 *   - 对话 = 本机列表里的会话(没归档、不是子会话 / 分支),时刻 = updated_at(助手每回一条都会刷新);
 *   - 笔记 = 笔记列表「最近」那一份(amadeusViews:「最近使用」里带时刻的笔记 / 文件,再接这个库自己没时刻的最近打开),
 *     只认库里还在的;没时刻的排在最后。
 *  原来的四张近况卡片在手机上退场(横竖屏一样);卡片里放过的 Space 去了「应用」页第一排(lcl phoneDock.ts)。 */
import { FileText, MessageSquare, NotebookText } from 'lucide-react'
import { beginReturnTrip, getView, useNativeChromeExtras, useSpaceStore } from '@lcl/engine'
import { useQuickFind } from '../quickFind'
import { useApp } from '../stores/appStore'
import { useRecentViews, type RecentView } from '../recentViews'
import { useAmadeusPrefs } from '../amadeusPrefs'
import { usePageStore } from '@amadeus/store/pageStore'
import { useI18n, registerMessages } from '../i18n'
import { formatRelative } from '../format/time'
import { displaySessionTitle } from '../sessionTitle'
import { openRecent } from './openRecent'

registerMessages({
  'home.continue.title': { zh: '继续', en: 'Continue' },
  'home.continue.chat': { zh: '对话', en: 'Chat' },
  'home.continue.note': { zh: '笔记', en: 'Note' },
  'home.search': { zh: '搜索对话、笔记、文件', en: 'Search chats, notes, files' },
})

/** 手机主页右上只有一颗搜索(方案 E1):开的是 QuickFind —— 对话、笔记、文件按名字找,对话还按内容找(笔记正文不在内)。 */
export function useHomeSearch(on: boolean): void {
  const { t } = useI18n()
  useNativeChromeExtras(on ? { where: 'main', search: { label: t('home.search'), run: () => useQuickFind.getState().openPalette() } } : null)
}

type SessionRecord = ReturnType<typeof useApp.getState>['sessions'][number]
/** updated_at → ms(同 SidebarPane 的 sessionActivityAt;解析不了 = 0)。 */
const activityAt = (raw: string | null | undefined): number => {
  const v = String(raw || '').trim()
  if (!v) return 0
  const n = Date.parse(v.includes('T') ? v : v.replace(' ', 'T'))
  return Number.isFinite(n) ? n : 0
}

export const CONTINUE_MAX = 3
export interface ContinueRow {
  key: string
  kind: 'chat' | 'note' | 'file'
  id: string
  viewType?: string
  title: string
  /** 对话:摘要;笔记:所在文件夹('' = 库根)。 */
  sub: string
  /** ms;0 = 只知道先后、不知道时刻(排在最后,不写时间)。 */
  at: number
  emoji?: string
}

const baseName = (path: string): string => (path.split('/').pop() ?? path).replace(/\.excalidraw\.md$/i, '').replace(/\.md$/i, '')
const folderOf = (path: string): string => { const i = path.lastIndexOf('/'); return i > 0 ? path.slice(0, i) : '' }

/** 「继续」的几行(纯函数,测试见 homeContinue.test.ts)。 */
export function continueRows(src: {
  sessions: readonly SessionRecord[]
  recents: readonly RecentView[]
  prefsRecents: readonly string[]
  pages: readonly string[]
  files: readonly string[]
  sessionTitle: (s: SessionRecord) => string
}, max = CONTINUE_MAX): ContinueRow[] {
  const rows: ContinueRow[] = []
  for (const s of src.sessions) {
    if (s.archived || s.parent_session_id) continue
    rows.push({ key: `chat:${s.id}`, kind: 'chat', id: s.id, title: src.sessionTitle(s), sub: (s.summary ?? '').trim(), at: activityAt(s.updated_at), ...(s.emoji ? { emoji: s.emoji } : {}) })
  }
  const pages = new Set(src.pages)
  const exists = new Set([...src.pages, ...src.files])
  const seen = new Set<string>()
  const note = (path: string, at: number, viewType?: string): void => {
    if (!exists.has(path) || seen.has(path)) return
    seen.add(path)
    const kind = pages.has(path) ? 'note' : 'file'
    rows.push({ key: `${kind}:${path}`, kind, id: path, ...(kind === 'file' && viewType ? { viewType } : {}), title: baseName(path), sub: folderOf(path), at })
  }
  for (const v of src.recents) if (v.kind === 'note' || v.kind === 'file') note(v.id, v.ts, v.viewType)
  for (const path of src.prefsRecents) note(path, 0)
  // 稳定排序:同一时刻(多半是都没有时刻的那几篇)保持原来的先后
  return rows.map((r, i) => ({ r, i })).sort((a, b) => b.r.at - a.r.at || a.i - b.i).slice(0, max).map(({ r }) => r)
}

export function HomeContinue() {
  const { t } = useI18n()
  const sessions = useApp((s) => s.sessions)
  const recents = useRecentViews((s) => s.items)
  const prefsRecents = useAmadeusPrefs((s) => s.recents)
  const pages = usePageStore((s) => s.pages)
  const files = usePageStore((s) => s.files)
  const rows = continueRows({ sessions, recents, prefsRecents, pages, files, sessionTitle: (s) => displaySessionTitle(s.title, t) })
  if (!rows.length) return null
  const open = (row: ContinueRow): void => {
    // 记下「从主页来」:进了那一页之后,顶栏返回 / 系统返回都回主页,不经那个 Space 的列表
    beginReturnTrip(useSpaceStore.getState().activeSpaceId)
    openRecent({ kind: row.kind, id: row.id, viewType: row.viewType, title: row.title })
  }
  const lead = (row: ContinueRow) => {
    if (row.emoji) return <span className="hp-continue-emoji">{row.emoji}</span>
    if (row.kind === 'chat') return <MessageSquare />
    if (row.kind === 'note') return <NotebookText />
    const Icon = row.viewType ? getView(row.viewType)?.icon : undefined
    return Icon ? <Icon /> : <FileText />
  }
  return (
    <section className="hp-continue" aria-label={t('home.continue.title')}>
      <div className="hp-continue-title">{t('home.continue.title')}</div>
      {rows.map((row) => (
        <button key={row.key} type="button" className="hp-continue-row" data-continue={row.key} onClick={(event) => { event.stopPropagation(); open(row) }}>
          <span className="hp-continue-lead" aria-hidden>{lead(row)}</span>
          <span className="hp-continue-text">
            <span className="hp-continue-name">{row.title}</span>
            <span className="hp-continue-sub">{[t(row.kind === 'chat' ? 'home.continue.chat' : 'home.continue.note'), row.sub].filter(Boolean).join(' · ')}</span>
          </span>
          {row.at > 0 && <span className="hp-continue-when">{formatRelative(row.at)}</span>}
        </button>
      ))}
    </section>
  )
}
