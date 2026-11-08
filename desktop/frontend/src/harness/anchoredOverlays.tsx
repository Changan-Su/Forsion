/** Instrument(check:anchoredoverlay):贴着元素开的浮层,锚点放在窗口最底下时也要整张留在窗口里、不盖住锚点。
 *  真组件 + 内存数据,不碰真库 / 后端。`?case=` 选场景:db-form / db-row / wiki / cal-agenda / cal-card / model / bg。 */
import './anchoredOverlaysSetup'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import '../styles/base.css'
import '../amadeus-host.css'
import '../theme/skins.css'
import '../views/chat2/chat2.css'
import { applyTheme } from '../theme/loader'
import { HostLocaleProvider, setLocaleGlobal } from '../i18n'
import { installTanguSlice } from '../stores/appStore'
import { TANGU_SLICE } from '@tangu/ui/tangu/store/tanguSlice'
import { usePageStore } from '../amadeus/store/pageStore'
import { useDbStore } from '../amadeus/store/dbStore'
import { useCalendarNav } from '../amadeus/store/calendarNavStore'
import { useCalendarConfig } from '../amadeus/store/calendarConfigStore'
import { DatabaseEmbed } from '../amadeus/blocks/database/DatabaseEmbed'
import { WikiHoverPreview } from '../amadeus/components/WikiHoverPreview'
import { CalendarView } from '../views/CalendarView'
import { ModelSelect } from '../components/ModelSelect'
import { BgStrip } from '../views/chat2/BackgroundProcs'
import { useProcesses } from '../views/chat2/processStore'
import type { DbFile } from '@amadeus-shared/db/schema'
import type { ModelInfo } from '../types'

installTanguSlice(TANGU_SLICE)
const q = new URLSearchParams(location.search)
const which = q.get('case') ?? 'model'
setLocaleGlobal(q.get('lang') === 'en' ? 'en' : 'zh')
applyTheme('lovable', 'cream', 'cream', q.get('dark') ? 'dark' : 'light')

/** 把被测控件压到窗口底部:上面一块撑满,锚点贴底。 */
const AtBottom = ({ children }: { children: ReactNode }) => (
  <main className="am-app tangu-lovable" style={{ height: 'calc(100dvh / var(--uiz, 1))', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '0 24px 6px', boxSizing: 'border-box' }}>
    <div style={{ width: 320 }}>{children}</div>
  </main>
)

const OPTIONS = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`)
const filler = Array.from({ length: 14 }, (_, i) => ({ id: `f${i}`, name: `Field ${i + 1}`, type: 'text' }))
const DB: DbFile = {
  version: 2,
  name: 'Tasks',
  columns: [{ id: 'name', name: 'Name', type: 'text' }, ...filler, { id: 'status', name: 'Status', type: 'select', options: OPTIONS }],
  rows: [{ id: 'r1', cells: { name: 'Row one' } }],
  views: [{ id: 'v1', name: 'Table', type: 'table' }, { id: 'v2', name: 'Form', type: 'form' }],
}

function Root(): ReactNode {
  if (which === 'db-form' || which === 'db-row') {
    return <main className="am-app tangu-lovable" style={{ height: 'calc(100dvh / var(--uiz, 1))', overflow: 'auto' }}><DatabaseEmbed db={DB} initialView={which === 'db-form' ? 'Form' : 'Table'} /></main>
  }
  if (which === 'wiki') {
    usePageStore.setState({ vaultRoot: '/anchored-overlays', pages: ['Linked note.md'], status: 'ready' } as never)
    return <AtBottom><p>See <span className="wikilink" data-wiki="Linked note">Linked note</span> for details.</p><WikiHoverPreview /></AtBottom>
  }
  if (which === 'cal-agenda' || which === 'cal-card') {
    const now = new Date(), pad = (n: number) => String(n).padStart(2, '0')
    // 本月最后一天:落在月视图最底下那一行
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    const day = `${last.getFullYear()}-${pad(last.getMonth() + 1)}-${pad(last.getDate())}`
    usePageStore.setState({ vaultRoot: '/anchored-overlays', files: ['Events.db'], status: 'ready' })
    useDbStore.setState({ entries: { 'Events.db': { status: 'ok', path: 'Events.db', data: { version: 1, name: 'Events', columns: [
      { id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' },
    ], rows: Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, cells: { name: `Event ${i + 1}`, date: `${day}T${pad(8 + i)}:00/${day}T${pad(8 + i)}:30` } })) } } } })
    useCalendarConfig.getState().migrate('/anchored-overlays', [{ dbPath: 'Events.db', dateCol: 'date' }])
    useCalendarNav.getState().setMode('month')
    return <main className="am-app tangu-lovable" style={{ height: 'calc(100dvh / var(--uiz, 1))' }}><CalendarView /></main>
  }
  if (which === 'bg') {
    const procs = Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, sessionId: 's1', command: `npm run task-${i + 1}`, status: 'running' as const, exitCode: null, startedAt: Date.now() - i * 1000, endedAt: null, origin: 'local' as const, url: null, last: '' }))
    useProcesses.setState({ bySession: { s1: procs } })
    return <AtBottom><BgStrip sessionId="s1" /></AtBottom>
  }
  const models = Array.from({ length: 24 }, (_, i) => ({ id: `m${i}`, name: `Model ${i + 1}`, provider: i < 12 ? 'openai' : 'anthropic', source: 'forsion' })) as unknown as ModelInfo[]
  return <AtBottom><ModelSelect models={models} value="m3" onChange={() => {}} /></AtBottom>
}

createRoot(document.getElementById('root')!).render(<HostLocaleProvider><Root /></HostLocaleProvider>)
