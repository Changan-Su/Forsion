import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  studio: { boards: {} as Record<string, any>, activeId: 'a', update: vi.fn(), queue: vi.fn() },
  app: { cfg: {}, desktopConfig: null, defaultAgentSlug: 'designer', adoptSession: vi.fn() },
  createSession: vi.fn(), openView: vi.fn(),
}))
vi.mock('../../stores/appStore', () => ({ useApp: { getState: () => state.app }, applyPreset: (c: unknown) => c, stickyDefaults: () => ({}) }))
vi.mock('../../stores/imageStudioStore', () => ({ useImageStudio: { getState: () => state.studio } }))
vi.mock('../../services/backendService', () => ({ createSession: state.createSession }))
vi.mock('@lcl/engine', () => ({ useWorkspace: { getState: () => ({ openView: state.openView }) } }))
import { ensureImageSession, promptImageStudio } from './session'
import { homeTarget } from '../../services/engine/targets'
beforeEach(() => {
  vi.clearAllMocks()
  state.studio.boards = { a: { id: 'a', name: 'A', sessionId: null }, b: { id: 'b', name: 'B', sessionId: 'session-b' } }
  state.studio.activeId = 'a'
  state.studio.update.mockImplementation((id, edit) => { state.studio.boards[id] = edit(state.studio.boards[id]) })
})
describe('Image Studio native session seam', () => {
  it('creates only one session for simultaneous composer requests', async () => {
    state.createSession.mockResolvedValue({ id: 'session-a' })
    expect(await Promise.all([ensureImageSession('a'), ensureImageSession('a')])).toEqual(['session-a', 'session-a'])
    expect(state.createSession).toHaveBeenCalledTimes(1)
    // P1-K6 S3:图片工作室的会话建在本端(home 类:homeTarget() 活目标,按对象身份比)
    const [target, init] = state.createSession.mock.calls[0]
    expect(target).toBe(homeTarget())
    expect(init).toEqual(expect.objectContaining({ title: 'A', projectless: true, agent_config: { execMode: 'sandbox', agentSlug: 'designer' } }))
    expect(state.studio.boards.a.sessionId).toBe('session-a')
  })
  it('keeps a late session result with the source project and never injects into a switched composer', async () => {
    let finish!: (session: unknown) => void
    state.createSession.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const task = promptImageStudio('a', 'A prompt')
    state.studio.activeId = 'b'; finish({ id: 'session-a' }); await task
    expect(state.studio.boards.a.sessionId).toBe('session-a')
    expect(state.studio.boards.b.sessionId).toBe('session-b')
    expect(state.studio.queue).not.toHaveBeenCalled()
    expect(state.openView).not.toHaveBeenCalled()
  })
  it('retries a failed connection without leaving a false session binding', async () => {
    state.createSession.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ id: 'session-a' })
    await expect(ensureImageSession('a')).rejects.toThrow('offline')
    expect(state.studio.boards.a.sessionId).toBeNull()
    expect(await ensureImageSession('a')).toBe('session-a')
  })
})
