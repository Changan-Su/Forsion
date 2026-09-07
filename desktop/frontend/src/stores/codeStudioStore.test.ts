import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { app } = vi.hoisted(() => ({ app: {
  activeId: null as string | null,
  sessions: [] as Array<{ id: string; project_path: string; updated_at?: string }>,
  newChatWs: null as null | { key: string; name: string; kind: string; path: string },
  newChatCfg: { agentSlug: 'custom', planMode: true, approvalMode: 'ask' },
  configBySession: {} as Record<string, Record<string, unknown>>,
  setExecConfig: vi.fn(),
  setActiveWorkspaceKey: vi.fn(), setActiveId: vi.fn(), selectNewChatAgent: vi.fn(), setNewChatWs: vi.fn(),
} }))
vi.mock('./appStore', () => ({ useApp: { getState: () => app } }))

let store: typeof import('./codeStudioStore').useCodeStudio
let data: Map<string, string>
const load = async () => { vi.resetModules(); store = (await import('./codeStudioStore')).useCodeStudio }

beforeEach(async () => {
  data = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } })
  app.activeId = null; app.sessions = []; app.newChatWs = null
  app.newChatCfg = { agentSlug: 'custom', planMode: true, approvalMode: 'ask' }
  app.configBySession = {}
  app.setExecConfig = vi.fn((patch: Record<string, unknown>, id: string) => { app.configBySession[id] = { ...app.configBySession[id], ...patch } })
  app.setActiveWorkspaceKey = vi.fn()
  app.setActiveId = vi.fn((id: string | null) => { app.activeId = id })
  app.selectNewChatAgent = vi.fn((agentSlug: string) => { app.newChatCfg = { ...app.newChatCfg, agentSlug } })
  app.setNewChatWs = vi.fn((workspace) => { app.newChatWs = workspace })
  await load()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Coding Studio project state', () => {
  it('restores each project mode, file, entry, and preview preferences independently', async () => {
    store.getState().openProject('/projects/a', 'A')
    store.getState().setMode('split'); store.getState().setEntry('index.html'); store.getState().setActiveFile('/projects/a/src/main.ts')
    store.getState().updateProject({ device: 'phone', devUrl: 'http://localhost:5173/', autoRefresh: false, checks: { main: true } })
    store.getState().openProject('/projects/b', 'B')
    expect(store.getState()).toMatchObject({ activeProject: '/projects/b', mode: 'preview', entry: null, activeFile: null })
    store.getState().setMode('code'); store.getState().setEntry('app.html')
    store.getState().openProject('/projects/a', 'A')
    expect(store.getState()).toMatchObject({ mode: 'split', entry: 'index.html', activeFile: '/projects/a/src/main.ts' })
    expect(store.getState().projects['/projects/a']).toMatchObject({ device: 'phone', autoRefresh: false, checks: { main: true } })
    await load(); store.getState().openProject('/projects/b', 'B')
    expect(store.getState()).toMatchObject({ mode: 'code', entry: 'app.html' })
  })

  it('opens the latest existing session for that project and preserves an already selected matching session', () => {
    app.activeId = 'other'
    app.sessions = [
      { id: 'old', project_path: '/projects/a', updated_at: '2026-01-01' },
      { id: 'recent', project_path: '/projects/a/', updated_at: '2026-01-03' },
      { id: 'other', project_path: '/projects/ab', updated_at: '2026-01-04' },
    ]
    store.getState().openProject('/projects/a', 'A')
    expect(app.setActiveId).toHaveBeenCalledWith('recent')
    app.activeId = 'old'; app.setActiveId.mockClear()
    store.getState().bindChatToProject('/projects/a', 'A')
    expect(app.setActiveId).not.toHaveBeenCalled()
  })

  it('binds a new coding draft once without resetting custom plan and approval preferences', () => {
    store.getState().openProject('C:\\projects\\a\\', 'A')
    expect(app.newChatWs).toMatchObject({ key: 'C:/projects/a', path: 'C:/projects/a', name: 'A' })
    expect(app.newChatCfg).toEqual({ agentSlug: 'coding', planMode: true, approvalMode: 'ask' })
    app.newChatCfg = { agentSlug: 'custom', planMode: false, approvalMode: 'ask' }
    app.selectNewChatAgent.mockClear(); app.setNewChatWs.mockClear(); app.setActiveId.mockClear()
    store.getState().bindChatToProject('C:/projects/a', 'A')
    expect(app.selectNewChatAgent).not.toHaveBeenCalled()
    expect(app.setNewChatWs).not.toHaveBeenCalled()
    expect(app.setActiveId).not.toHaveBeenCalled()
    expect(app.newChatCfg).toEqual({ agentSlug: 'custom', planMode: false, approvalMode: 'ask' })
  })

  it('clears project selection and queued prompts on close but retains saved project preferences', () => {
    store.getState().openProject('/projects/a', 'A'); store.getState().setMode('split'); store.getState().queuePrompt('build this')
    store.getState().closeProject()
    expect(store.getState()).toMatchObject({ activeProject: null, activeFile: null, entry: null, pendingPrompt: null })
    expect(app.activeId).toBeNull(); expect(app.newChatWs).toBeNull()
    expect(store.getState().projects['/projects/a'].mode).toBe('split')
  })

  it('rejects outside and traversal paths and canonicalizes relative files to absolute editor paths', () => {
    store.getState().openProject('/projects/a', 'A'); store.getState().setEntry('index.html')
    store.getState().setEntry('../secret.html')
    expect(store.getState().entry).toBe('index.html')
    store.getState().setActiveFile('src/main.ts')
    expect(store.getState().activeFile).toBe('/projects/a/src/main.ts')
    store.getState().openFile('/projects/ab/outside.ts')
    expect(store.getState().activeFile).toBe('/projects/a/src/main.ts')
    store.getState().setActiveFile('/projects/a/../outside.ts')
    expect(store.getState().activeFile).toBe('/projects/a/src/main.ts')
    store.getState().openProject('../elsewhere', 'Outside')
    expect(store.getState().activeProject).toBe('/projects/a')
  })

  it('sanitizes persisted preferences so malformed data cannot crash opening a project or escape its root', async () => {
    data.set('coding.studio.projects.v2', JSON.stringify({
      '/projects/a': { activeFile: 42, entry: '../outside.html', mode: 'unknown', device: 'watch', devUrl: 'https://outside.test', autoRefresh: 'false', checks: [true], brief: { idea: 'valid idea', audience: 12, capabilities: ['invented'], locale: 'xx' } },
      '../invalid': { entry: 'index.html' },
    }))
    await load()
    expect(() => store.getState().openProject('/projects/a', 'A')).not.toThrow()
    expect(store.getState()).toMatchObject({ activeFile: null, entry: null, mode: 'preview' })
    expect(store.getState().projects['/projects/a']).toMatchObject({ device: 'desktop', devUrl: '', autoRefresh: true, checks: {}, brief: { idea: 'valid idea', audience: '', capabilities: [], locale: 'en' } })
    expect(store.getState().projects['../invalid']).toBeUndefined()
  })

  it('guards project preference patches and keeps mirrored UI state in sync', () => {
    store.getState().openProject('/projects/a', 'A')
    store.getState().updateProject({ mode: 'split', activeFile: '/projects/a/src/main.ts', entry: './index.html' })
    expect(store.getState()).toMatchObject({ mode: 'split', activeFile: '/projects/a/src/main.ts', entry: 'index.html' })
    store.getState().updateProject({ activeFile: '/outside.ts', entry: '../outside.html' })
    expect(store.getState()).toMatchObject({ activeFile: '/projects/a/src/main.ts', entry: 'index.html' })
  })
})

describe('Coding Studio queued composer prompts', () => {
  it('never prepares a run without a selected project', () => {
    expect(store.getState().prepareRun()).toBeNull()
    expect(app.setExecConfig).not.toHaveBeenCalled()
  })

  it.each([{}, { cwd: '/projects/b', execMode: 'sandbox', agentSlug: 'custom', planMode: true }])('pins an existing session execution directory even when its config is stale: %j', config => {
    app.sessions = [{ id: 'session-a', project_path: '/projects/a' }]
    app.configBySession['session-a'] = config
    store.getState().openProject('/projects/a', 'A')
    expect(store.getState().prepareRun()).toEqual({ sessionId: 'session-a' })
    expect(app.configBySession['session-a']).toEqual({ ...config, cwd: '/projects/a', execMode: 'host' })
  })

  it('preserves a same-project custom agent draft when preparing a new run', () => {
    store.getState().openProject('/projects/a', 'A')
    app.newChatCfg = { agentSlug: 'custom', planMode: true, approvalMode: 'ask' }
    expect(store.getState().prepareRun()).toEqual({ sessionId: null })
    expect(app.newChatWs?.path).toBe('/projects/a')
    expect(app.newChatCfg).toEqual({ agentSlug: 'custom', planMode: true, approvalMode: 'ask' })
    expect(app.setExecConfig).not.toHaveBeenCalled()
  })

  it('can only claim once and drops an old project request on project switch', () => {
    store.getState().queuePrompt('no project')
    expect(store.getState().pendingPrompt).toBeNull()
    store.getState().openProject('/projects/a', 'A'); store.getState().queuePrompt('hello')
    const first = store.getState().pendingPrompt!
    expect(store.getState().consumePrompt(first.seq + 1)).toBe(false)
    expect(store.getState().consumePrompt(first.seq)).toBe(true)
    expect(store.getState().consumePrompt(first.seq)).toBe(false)
    store.getState().queuePrompt('from A'); const old = store.getState().pendingPrompt!.seq
    store.getState().openProject('/projects/b', 'B')
    expect(store.getState().consumePrompt(old)).toBe(false)
    expect(store.getState().pendingPrompt).toBeNull()
  })

  it('preserves multiple queued requests before the composer can claim them, with distinct sequence IDs', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1); vi.spyOn(Math, 'random').mockReturnValue(0)
    store.getState().openProject('/projects/a', 'A'); store.getState().queuePrompt('first')
    const old = store.getState().pendingPrompt!.seq
    store.getState().queuePrompt('second')
    const next = store.getState().pendingPrompt!
    expect(next.seq).not.toBe(old)
    expect(next.text).toBe('first\n\nsecond')
    expect(store.getState().consumePrompt(old)).toBe(false)
    expect(store.getState().consumePrompt(next.seq)).toBe(true)
  })
})
