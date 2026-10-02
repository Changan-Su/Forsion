import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  create: vi.fn(), bind: vi.fn(), adopt: vi.fn(), send: vi.fn(),
  claim: vi.fn(), complete: vi.fn(), release: vi.fn(),
  connection: 'local', listener: undefined as (() => void) | undefined,
  cfg: { backendUrl: 'http://127.0.0.1:4100', token: 'first-token' },
  agents: [{ slug: 'writer', model: 'writer-model', thinkingLevel: 'high' }],
}))
vi.mock('../stores/appStore', () => ({
  useApp: { subscribe: (fn: () => void) => { mock.listener = fn; return () => { mock.listener = undefined } }, getState: () => ({ cfg: mock.cfg, authInfo: null, agentDefs: mock.agents, desktopConfig: { mode: 'managed' }, adoptSession: mock.adopt, send: mock.send }) },
  stickyDefaults: () => ({ approvalMode: 'ask' }),
  withAmadeusWorkspace: (value: unknown) => value,
}))
vi.mock('./backendService', () => ({ createSession: mock.create }))
vi.mock('./engine/targets', () => ({ homeTarget: () => ({ base: 'local' }), connectionKey: () => mock.connection, bindSession: mock.bind }))
import { submitDocumentTask } from './documentTasks'

let sequence = 0
const request = (extra = {}) => ({
  key: `task-${sequence++}`, agent: 'writer', prompt: 'Maintain the note', vaultRoot: '/vault', alive: () => true,
  onCreated: vi.fn(async () => {}), ...extra,
})
beforeEach(() => {
  vi.clearAllMocks()
  mock.connection = 'local'
  mock.cfg = { backendUrl: 'http://127.0.0.1:4100', token: 'first-token' }
  mock.listener = undefined
  mock.create.mockResolvedValue({ id: `session-${sequence}` })
  mock.send.mockResolvedValue(true)
  mock.claim.mockResolvedValue({ state: 'claimed', token: 'claim-token' })
  mock.complete.mockResolvedValue(undefined)
  mock.release.mockResolvedValue(undefined)
  vi.stubGlobal('window', { tangu: { documentTasks: { claim: mock.claim, complete: mock.complete, release: mock.release } } })
})

describe('document task submission', () => {
  it('saves the exact session before submitting and retains user approval settings', async () => {
    let release!: () => void
    const saved = new Promise<void>((resolve) => { release = resolve })
    const o = request({ onCreated: vi.fn(() => saved) })
    const result = submitDocumentTask(o, 'default-model')
    await vi.waitFor(() => expect(o.onCreated).toHaveBeenCalled())
    expect(mock.send).not.toHaveBeenCalled()
    release()
    const r = await result
    expect(r.ok).toBe(true)
    expect(mock.send.mock.calls[0][5]).toBe(r.sessionId)
    expect(mock.complete).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/), 'claim-token', r.sessionId)
    expect(mock.complete.mock.invocationCallOrder[0]).toBeLessThan(mock.send.mock.invocationCallOrder[0])
    expect(mock.create.mock.calls[0][1]).toMatchObject({ model_id: 'writer-model', agent_config: { approvalMode: 'ask', agentSlug: 'writer', execMode: 'host', cwd: '/vault' } })
  })
  it('joins rapid submissions and never re-sends a bound task', async () => {
    const o = request()
    const [a, b] = await Promise.all([submitDocumentTask(o, 'model'), submitDocumentTask(o, 'model')])
    expect(a.sessionId).toBe(b.sessionId)
    await submitDocumentTask(o, 'model')
    expect(mock.create).toHaveBeenCalledTimes(1)
    expect(mock.send).toHaveBeenCalledTimes(1)
  })
  it('rejects copied IDs with different task content instead of linking the wrong session', async () => {
    const o = request()
    await submitDocumentTask(o, 'model')
    const next = await submitDocumentTask({ ...o, prompt: 'A different task' }, 'model')
    expect(next.ok).toBe(false)
    expect(mock.create).toHaveBeenCalledTimes(1)
    expect(mock.send).toHaveBeenCalledTimes(1)
  })
  it('does not send if strict saving fails', async () => {
    const r = await submitDocumentTask(request({ onCreated: async () => { throw new Error('disk full') } }), 'model')
    expect(r).toMatchObject({ ok: false, error: 'disk full' })
    expect(mock.send).not.toHaveBeenCalled()
  })
  it('does not send after a page disappears during session creation', async () => {
    let alive = true
    mock.create.mockImplementation(async () => { alive = false; return { id: 'unused-session' } })
    const o = request({ alive: () => alive })
    const r = await submitDocumentTask(o, 'model')
    expect(r.ok).toBe(false)
    expect(o.onCreated).not.toHaveBeenCalled()
    expect(mock.send).not.toHaveBeenCalled()
  })
  it('does not adopt or send an old account session after switching away and back', async () => {
    mock.create.mockImplementation(async () => {
      mock.connection = 'other'; mock.listener?.()
      mock.connection = 'local'; mock.listener?.()
      return { id: 'old-account-session' }
    })
    const result = await submitDocumentTask(request(), 'model')
    expect(result.ok).toBe(false)
    expect(mock.adopt).not.toHaveBeenCalled()
    expect(mock.send).not.toHaveBeenCalled()
  })
  it('retains the link after an ambiguous send failure instead of retrying automatically', async () => {
    mock.send.mockRejectedValue(new Error('connection interrupted'))
    const o = request()
    const r = await submitDocumentTask(o, 'model')
    expect(r.ok).toBe(false)
    expect(r.sessionId).toBeTruthy()
    await submitDocumentTask(o, 'model')
    expect(mock.send).toHaveBeenCalledTimes(1)
  })
  it('rejects stale agents and invalid roots before creating a session', async () => {
    expect((await submitDocumentTask(request({ agent: 'removed' }), 'model')).ok).toBe(false)
    expect((await submitDocumentTask(request({ vaultRoot: '../elsewhere' }), 'model')).ok).toBe(false)
    expect(mock.create).not.toHaveBeenCalled()
  })
  it('refuses another window pending claim without creating or sending', async () => {
    mock.claim.mockResolvedValue({ state: 'busy' })
    expect((await submitDocumentTask(request(), 'model')).ok).toBe(false)
    expect(mock.create).not.toHaveBeenCalled()
    expect(mock.send).not.toHaveBeenCalled()
  })
  it('rebinds a host receipt from another renderer without re-sending', async () => {
    mock.claim.mockResolvedValue({ state: 'linked', sessionId: 'other-window-session' })
    const o = request()
    expect(await submitDocumentTask(o, 'model')).toEqual({ ok: true, sessionId: 'other-window-session' })
    expect(o.onCreated).toHaveBeenCalledWith('other-window-session')
    expect(mock.create).not.toHaveBeenCalled()
    expect(mock.send).not.toHaveBeenCalled()
  })
  it('never sends when the durable host receipt cannot be saved', async () => {
    mock.complete.mockRejectedValue(new Error('receipt disk full'))
    const r = await submitDocumentTask(request(), 'model')
    expect(r).toMatchObject({ ok: false, error: 'receipt disk full' })
    expect(r.sessionId).toBeTruthy()
    expect(mock.send).not.toHaveBeenCalled()
  })
  it('keeps receipt identity when a restarted managed engine rotates its connection', async () => {
    const o = request()
    const first = await submitDocumentTask(o, 'model')
    const firstKey = mock.claim.mock.calls[0][0]
    mock.connection = 'new-local-token-and-port'
    mock.cfg = { backendUrl: 'http://127.0.0.1:4900', token: 'new-token' }
    mock.claim.mockResolvedValue({ state: 'linked', sessionId: first.sessionId })
    const second = await submitDocumentTask(o, 'model')
    expect(mock.claim.mock.calls[1][0]).toBe(firstKey)
    expect(second.sessionId).toBe(first.sessionId)
    expect(mock.create).toHaveBeenCalledTimes(1)
    expect(mock.send).toHaveBeenCalledTimes(1)
  })
})
