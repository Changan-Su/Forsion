// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mountInvitePage } from '../../../../web/src/invitePage'

vi.mock('../../../../web/src/webShim', () => ({ getApiBase: () => '/api', getToken: () => '' }))
afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('uses move-aware invitation lookup and acceptance and opens the returned wire location', async () => {
  const replace = vi.fn()
  vi.stubGlobal('location', { origin: 'https://cloud.test', href: 'https://cloud.test/', replace })
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const moves = new Headers(init?.headers).get('X-Content-Caps')?.includes('vault-moves')
    if (!moves) return Response.json({}, { status: 404 })
    if (path.endsWith('/accept')) return Response.json({ vaultId: 'split', path: 'report.md' })
    return Response.json({ title: 'Report', role: 'viewer', needPassword: false })
  })
  mountInvitePage('fixture', { apiBase: '/api', request, getToken: () => 'fixture', appBase: 'https://cloud.test/' })
  await vi.waitFor(() => expect(document.querySelector('button.inv-btn')).not.toBeNull())
  document.querySelector<HTMLButtonElement>('button.inv-btn')!.click()
  await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce())
  expect(request.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
    ['/api/amadeus/invites/fixture', 'GET'],
    ['/api/amadeus/invites/fixture/accept', 'POST'],
  ])
  const address = new URL(replace.mock.calls[0][0])
  expect(address.searchParams.get('vault')).toBe('split')
  expect(address.searchParams.get('note')).toBe('report.md')
})
