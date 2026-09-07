/** Project-scoped Coding Studio state. Project data lives on disk; UI preferences and briefs stay local. */
import { create } from 'zustand'
import { useApp } from './appStore'
import { isProjectRoot, joinProjectPath, normalizeDevUrl, normPath, projectRelative, type PreviewDevice } from '../views/coding/studioModel'
import { STUDIO_CAPABILITIES, type StudioBrief } from '../views/coding/projectBrief'

export type StudioMode = 'code' | 'preview' | 'split'
export interface StudioProjectPrefs {
  entry: string | null
  activeFile: string | null
  mode: StudioMode
  device: PreviewDevice
  devUrl: string
  autoRefresh: boolean
  brief?: StudioBrief
  checks: Record<string, boolean>
  openedAt: number
}
const PREF_KEY = 'coding.studio.projects.v2'
const defaults = (): StudioProjectPrefs => ({ entry: null, activeFile: null, mode: 'preview', device: 'desktop', devUrl: '', autoRefresh: true, checks: {}, openedAt: Date.now() })
function normalizePrefs(root: string, input: unknown): StudioProjectPrefs {
  const v = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const active = typeof v.activeFile === 'string' ? projectRelative(root, v.activeFile) : null
  const b = v.brief && typeof v.brief === 'object' ? v.brief as Record<string, unknown> : null
  const brief: StudioBrief | undefined = b && typeof b.idea === 'string' ? {
    idea: b.idea, audience: typeof b.audience === 'string' ? b.audience : '', constraints: typeof b.constraints === 'string' ? b.constraints : '',
    capabilities: STUDIO_CAPABILITIES.filter(id => Array.isArray(b.capabilities) && b.capabilities.includes(id)),
    locale: b.locale === 'zh' ? 'zh' : 'en', ...(typeof b.templateId === 'string' ? { templateId: b.templateId } : {}),
  } : undefined
  return {
    entry: typeof v.entry === 'string' ? projectRelative(root, v.entry) : null,
    activeFile: active ? joinProjectPath(root, active) : null,
    mode: v.mode === 'code' || v.mode === 'split' ? v.mode : 'preview',
    device: v.device === 'phone' || v.device === 'tablet' ? v.device : 'desktop',
    devUrl: typeof v.devUrl === 'string' ? normalizeDevUrl(v.devUrl) || '' : '',
    autoRefresh: typeof v.autoRefresh === 'boolean' ? v.autoRefresh : true,
    checks: v.checks && typeof v.checks === 'object' && !Array.isArray(v.checks) ? Object.fromEntries(Object.entries(v.checks).filter(([, checked]) => typeof checked === 'boolean')) : {},
    openedAt: typeof v.openedAt === 'number' && Number.isFinite(v.openedAt) ? v.openedAt : Date.now(),
    ...(brief ? { brief } : {}),
  }
}
function readPrefs(): Record<string, StudioProjectPrefs> {
  try {
    const value = JSON.parse(localStorage.getItem(PREF_KEY) || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([key]) => isProjectRoot(key)).map(([key, value]) => [normPath(key), normalizePrefs(normPath(key), value)]))
  } catch { return {} }
}
let promptSequence = 0
function persist(projects: Record<string, StudioProjectPrefs>): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(Object.fromEntries(Object.entries(projects).sort((a, b) => b[1].openedAt - a[1].openedAt).slice(0, 80)))) } catch { /* UI remains usable when storage is unavailable */ }
}
interface CodeStudioState {
  projectsRoot: string | null
  setProjectsRoot(path: string | null): void
  activeProject: string | null
  projects: Record<string, StudioProjectPrefs>
  openProject(path: string, name: string): void
  bindChatToProject(path: string, name: string): void
  prepareRun(): { sessionId: string | null } | null
  closeProject(): void
  idleChat(): void
  mode: StudioMode
  setMode(mode: StudioMode): void
  activeFile: string | null
  setActiveFile(path: string | null): void
  entry: string | null
  setEntry(path: string | null): void
  reloadNonce: number
  reload(): void
  openFile(path: string): void
  updateProject(patch: Partial<StudioProjectPrefs>): void
  pendingPrompt: { project: string; text: string; seq: number } | null
  queuePrompt(text: string): void
  consumePrompt(seq: number): boolean
}
export const useCodeStudio = create<CodeStudioState>((set, get) => ({
  projectsRoot: null,
  setProjectsRoot: (projectsRoot) => set({ projectsRoot }),
  activeProject: null,
  projects: readPrefs(),
  openProject: (path, name) => {
    if (!isProjectRoot(path)) return
    path = normPath(path)
    const prefs = normalizePrefs(path, { ...get().projects[path], openedAt: Date.now() })
    const projects = { ...get().projects, [path]: prefs }
    persist(projects)
    set({ activeProject: path, entry: prefs.entry, activeFile: prefs.activeFile, mode: prefs.mode, projects, pendingPrompt: null })
    useApp.getState().setActiveWorkspaceKey(path)
    get().bindChatToProject(path, name)
    get().reload()
  },
  bindChatToProject: (path, name) => {
    if (!isProjectRoot(path)) return
    path = normPath(path)
    const app = useApp.getState()
    const cur = app.sessions.find(s => s.id === app.activeId)
    if (cur && normPath(cur.project_path || '') === normPath(path)) return
    // A draft already bound to this project owns its agent/model preferences.
    // Studio shortcuts must not reset a choice the user made in the composer.
    if (!app.activeId && normPath(app.newChatWs?.path || '') === path) return
    const existing = app.sessions.filter(s => normPath(s.project_path || '') === normPath(path)).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0]
    if (existing) app.setActiveId(existing.id)
    else {
      app.selectNewChatAgent('coding')
      app.setNewChatWs({ key: path, name, kind: 'local', path })
      app.setActiveId(null)
    }
  },
  closeProject: () => { set({ activeProject: null, activeFile: null, entry: null, pendingPrompt: null }); get().idleChat() },
  prepareRun: () => {
    const root = get().activeProject
    if (!root) return null
    get().bindChatToProject(root, root.split('/').pop() || root)
    const app = useApp.getState()
    // Session metadata and stored execution config can disagree in older layouts.
    // Correct the actual run directory without resetting agent/model/plan preferences.
    if (app.activeId) app.setExecConfig({ cwd: root, execMode: 'host' }, app.activeId)
    return { sessionId: app.activeId }
  },
  idleChat: () => {
    const app = useApp.getState()
    if (!app.activeId && !app.newChatWs && app.newChatCfg.agentSlug === 'coding') return
    app.selectNewChatAgent('coding'); app.setNewChatWs(null); app.setActiveId(null)
  },
  mode: 'preview',
  setMode: mode => {
    if (!['code', 'preview', 'split'].includes(mode)) return
    if (get().activeProject) get().updateProject({ mode }); else set({ mode })
  },
  activeFile: null,
  setActiveFile: activeFile => {
    const root = get().activeProject
    if (!root) { if (activeFile === null) set({ activeFile }); return }
    if (activeFile !== null && !projectRelative(root, activeFile)) return
    get().updateProject({ activeFile })
  },
  entry: null,
  setEntry: entry => {
    const root = get().activeProject
    if (!root) { if (entry === null) set({ entry }); return }
    if (entry !== null && !projectRelative(root, entry)) return
    get().updateProject({ entry })
  },
  reloadNonce: 0,
  reload: () => set(s => ({ reloadNonce: s.reloadNonce + 1 })),
  openFile: path => { if (get().activeProject && projectRelative(get().activeProject!, path)) { get().setActiveFile(path); get().setMode('code') } },
  updateProject: patch => {
    const root = get().activeProject
    if (!root) return
    const safe = { ...patch }
    // Public callers and persisted data share one path contract. Invalid patches
    // must not clear the user's previously valid file/entry selection.
    for (const key of ['activeFile', 'entry'] as const) {
      if (key in safe && safe[key] !== null && (typeof safe[key] !== 'string' || !projectRelative(root, safe[key]!))) delete safe[key]
    }
    if ('devUrl' in safe && (typeof safe.devUrl !== 'string' || normalizeDevUrl(safe.devUrl) === null)) delete safe.devUrl
    const prefs = normalizePrefs(root, { ...defaults(), ...get().projects[root], ...safe })
    const projects = { ...get().projects, [root]: prefs }
    persist(projects); set({ projects, mode: prefs.mode, activeFile: prefs.activeFile, entry: prefs.entry })
  },
  pendingPrompt: null,
  queuePrompt: text => {
    const project = get().activeProject
    const pending = get().pendingPrompt
    if (project && text.trim()) set({ pendingPrompt: { project, text: pending?.project === project ? `${pending.text}\n\n${text}` : text, seq: ++promptSequence } })
  },
  consumePrompt: seq => {
    if (get().pendingPrompt?.seq !== seq || get().pendingPrompt?.project !== get().activeProject) return false
    set({ pendingPrompt: null }); return true
  },
}))
