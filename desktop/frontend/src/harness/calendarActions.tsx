/** Instrument: real Calendar/RecordFields/stores, isolated in-memory vault; no production data or model. */
import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import '../amadeus-host.css'
import '../theme/skins.css'
import { applyTheme } from '../theme/loader'
import { CalendarView } from '../views/CalendarView'
import { HostLocaleProvider, setLocaleGlobal } from '../i18n'
import { usePageStore } from '../amadeus/store/pageStore'
import { useDbStore } from '../amadeus/store/dbStore'
import { useCalendarNav } from '../amadeus/store/calendarNavStore'
import { useCalendarConfig } from '../amadeus/store/calendarConfigStore'
import { installNativeChromeHost, setNativeChromeShell } from '@lcl/engine'
import { installTanguSlice } from '../stores/appStore'
import { TANGU_SLICE } from '@tangu/ui/tangu/store/tanguSlice'

// 不走 installEngine:自己装 Tangu 的 store 半身(界面热更新 3c)
installTanguSlice(TANGU_SLICE)
const q = new URLSearchParams(location.search)
setLocaleGlobal(q.get('lang') === 'en' ? 'en' : 'zh')
applyTheme('lovable', 'cream', 'cream', q.get('dark') ? 'dark' : 'light')
const now = new Date(), pad = (n: number) => String(n).padStart(2, '0')
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
usePageStore.setState({ vaultRoot: '/calendar-actions-harness', files: ['Events.db'], status: 'ready' })
useDbStore.setState({ entries: { 'Events.db': { status: 'ok', path: 'Events.db', data: { version: 1, name: 'Events', columns: [
  { id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' },
], rows: [
  { id: 'long', body: '# Keep the body', cells: { name: 'Design review', date: `${day}T09:30/${day}T11:00` } },
  { id: 'short', cells: { name: 'Stand-up', date: `${day}T11:30/${day}T11:45` } },
  { id: 'all', cells: { name: 'Release', date: day } },
] } } } })
useCalendarConfig.getState().migrate('/calendar-actions-harness', [{ dbPath: 'Events.db', dateCol: 'date' }])
useCalendarNav.getState().setMode(q.get('ui') === 'mobile' ? '3day' : 'week')
useCalendarNav.getState().setHourPx(56)
if (q.get('ui') === 'mobile') {
  installNativeChromeHost({ spaces: true, render: (state) => {
    document.documentElement.dataset.chrome = state.mode
    document.documentElement.dataset.dock = state.mode === 'shell' ? 'visible' : 'hidden'
  } })
  setNativeChromeShell({ title: 'Calendar', left: false, right: false, tabCount: 1, labels: { left: 'Left', right: 'Right', tabs: 'Tabs', more: 'More' }, spaces: [{ id: 'calendar', label: 'Calendar', active: true }, { id: 'home', label: 'Home', active: false }] })
}
Object.assign(window, { __calTest: { nav: useCalendarNav, db: useDbStore, day } })
createRoot(document.getElementById('root')!).render(<HostLocaleProvider><main className="am-app tangu-lovable" style={{ height: 'calc(100dvh / var(--uiz, 1))' }}><CalendarView /></main></HostLocaleProvider>)
