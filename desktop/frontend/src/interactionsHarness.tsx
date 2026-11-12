/** Isolated real-component acceptance fixture; never loads user sessions. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LocaleProvider, setLocaleGlobal } from './i18n'
import './i18n.generated'
import './styles/base.css'
import './views/chat2/chat2.css'
import './tangu/store/standalone'
import { applyTheme } from './theme/loader'
import { SidebarPane } from './views/chat2/SidebarPane'
import type { SessionRecord } from '../../../tangu-agent/src/contracts/clientTypes'
const q = new URLSearchParams(location.search)
setLocaleGlobal(q.has('en') ? 'en' : 'zh')
applyTheme('genesis-glass', q.get('skin') || 'cream', 'cream', q.has('dark') ? 'dark' : 'light')
const make = (id: string, parent: string | null, title: string): SessionRecord => ({ id, parent_session_id: parent, title, project_path: '/fixture', created_at: '2026-11-12T10:00:00Z', updated_at: '2026-11-12T10:00:00Z' } as SessionRecord)
const seed = [make('root', null, '研究计划'), make('child', 'root', '数据检查'), make('grand', 'child', '验证采样误差'), make('deep', 'grand', '独立复核'), make('deep2', 'deep', '公式检查'), make('other', null, '其他研究')]
function Harness() {
  const [all, setAll] = useState(seed)
  const [active, setActive] = useState<string | null>('root')
  const [pins, setPins] = useState<Record<string, number>>({})
  const togglePin = (key: string): void => setPins((p) => { const n = { ...p }; if (n[key]) delete n[key]; else n[key] = Date.now(); return n })
  const [filtered, setFiltered] = useState(false)
  ;(window as unknown as { __interactions: unknown }).__interactions = {
    add: () => { setAll((s) => [...s, make('new', 'grand', '新分支')]); setActive('new') },
    pin: (id: string) => togglePin(`ses:${id}`),
    filter: (value: boolean) => setFiltered(value),
  }
  return <div className="t2sw" style={{ width: q.has('phone') ? '100%' : 360, height: '100dvh', background: 'var(--sidebar-bg)' }}>
    <SidebarPane collapsed={false} flat timeline={q.has('phone')} sessions={filtered ? all.filter((s) => s.id === 'grand') : all} allSessions={all} archivedSessions={[]}
      activeId={active} onSelect={setActive} activeSession={all.find((s) => s.id === active) ?? null}
      pinnedEntries={pins} onTogglePinned={togglePin} runningIds={new Set(['deep2'])} unreadIds={new Set()} cfg={{ backendUrl: '', token: '', modelId: '' }} modelId=""
      workspaces={[{ key: '/fixture', name: 'Research', path: '/fixture', kind: 'local' }]}
      onNewInWorkspace={() => {}} onAddWorkspace={() => {}} onRenameWorkspace={() => {}} onRemoveWorkspace={() => {}}
      onRename={() => {}} onArchive={() => {}} onDelete={() => {}} onOpenSettings={() => {}} onNewChat={() => {}} onOpenWorkspace={() => {}} />
  </div>
}
createRoot(document.getElementById('root')!).render(<LocaleProvider><Harness /></LocaleProvider>)
