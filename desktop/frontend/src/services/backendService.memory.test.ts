// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authFetch } from './http'
import { getAgentMemory, getAgentLog, putAgentMemory, putAgentLog, mutateAgentMemoryEntry, startAgentMemoryDream } from './backendService'

vi.mock('./http', () => ({ authFetch: vi.fn() }))
const cfg = { backendUrl: 'http://local-engine', token: 'test-account' } as any
beforeEach(() => { vi.mocked(authFetch).mockReset().mockResolvedValue(new Response(JSON.stringify({ content: 'text', status: { state: 'running', running: true } }))) })
describe('memory API contract', () => {
  it('carries expected versions and URL-encoded Agent identities for every mutation', async () => {
    const responses = () => Promise.resolve(new Response('{}'))
    vi.mocked(authFetch).mockImplementation(responses)
    await putAgentMemory(cfg, 'agent/name', 'new text', 'version-1')
    await putAgentLog(cfg, 'alpha', '2026-09-08', 'log draft', 'log-version')
    await mutateAgentMemoryEntry(cfg, 'beta', { action: 'forget', id: 'entry', expectedVersion: 'version-2' })
    const calls = vi.mocked(authFetch).mock.calls
    expect(calls[0][0]).toBe('http://local-engine/agent/agents/agent%2Fname/memory')
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ content: 'new text', expectedVersion: 'version-1' })
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ content: 'log draft', expectedVersion: 'log-version' })
    expect(JSON.parse(String(calls[2][1]?.body))).toEqual({ action: 'forget', id: 'entry', expectedVersion: 'version-2' })
  })
  it('failed memory/log reads reject instead of supplying an empty document', async () => {
    vi.mocked(authFetch).mockImplementation(async () => new Response(JSON.stringify({ detail: 'EIO disk failure' }), { status: 500 }))
    await expect(getAgentMemory(cfg, 'alpha')).rejects.toThrow('EIO disk failure')
    await expect(getAgentLog(cfg, 'alpha', '2026-09-08')).rejects.toThrow('EIO disk failure')
  })
  it('unwraps asynchronous Dream status without waiting for the job to complete', async () => {
    expect(await startAgentMemoryDream(cfg, 'alpha')).toEqual({ state: 'running', running: true })
    expect(vi.mocked(authFetch).mock.calls[0][1]?.method).toBe('POST')
  })
})
