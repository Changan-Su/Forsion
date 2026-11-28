import { afterEach, expect, it, vi } from 'vitest'
import { acceptInvite, joinedInviteAddress, lookupInvite } from '../../../../web/src/amadeus/invite'

const appBase = '/workspace/?view=notes#previous'
const invite = { title: 'Report', role: 'viewer', ownerName: null, needPassword: false }
const wireTarget = { vaultId: 'split', path: 'Work/report #1.md' }
const wireAddress = 'https://cloud.test/workspace/?view=notes&vault=split&note=Work%2Freport+%231.md'

function endpoint(request: (path: string, init?: RequestInit) => Promise<Response>) {
  return { apiBase: '/api', request, getToken: () => 'fixture', appBase }
}

afterEach(() => vi.unstubAllGlobals())

it('declares move support for lookup and opens the returned location after acceptance', async () => {
  vi.stubGlobal('location', { href: 'https://cloud.test/invite/fixture' })
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    const moves = new Headers(init?.headers).get('X-Content-Caps')?.split(',').includes('vault-moves')
    if (!moves) return Response.json({}, { status: 404 })
    return Response.json(path.endsWith('/accept') ? wireTarget : invite)
  })
  const account = endpoint(request)
  expect(await lookupInvite(account, 'fixture/token')).toEqual({ kind: 'found', info: invite })
  expect(joinedInviteAddress(appBase, invite)).toBeUndefined()
  expect(await acceptInvite(account, 'fixture/token')).toEqual({ kind: 'accepted', address: wireAddress })
  expect(request.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET'])).toEqual([
    ['/api/amadeus/invites/fixture%2Ftoken', 'GET'],
    ['/api/amadeus/invites/fixture%2Ftoken/accept', 'POST'],
  ])
  for (const [, init] of request.mock.calls) {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture')
  }
  const acceptInit = request.mock.calls[1][1]
  expect(new Headers(acceptInit?.headers).get('Content-Type')).toBe('application/json')
  expect(acceptInit?.body).toBe('{}')
})

it('uses the returned wire location when the lookup already has access', async () => {
  vi.stubGlobal('location', { href: 'https://cloud.test/invite/fixture' })
  const request = vi.fn(async (_path: string, init?: RequestInit) => {
    const moves = new Headers(init?.headers).get('X-Content-Caps')?.split(',').includes('vault-moves')
    return moves ? Response.json({ ...invite, ...wireTarget, joined: true }) : new Response(null, { status: 404 })
  })
  const result = await lookupInvite(endpoint(request), 'fixture')
  expect(result.kind).toBe('found')
  if (result.kind !== 'found') throw new Error('Expected an invitation with access')
  expect(joinedInviteAddress(appBase, result.info)).toBe(wireAddress)
  expect(request).toHaveBeenCalledOnce()
})

it.each([
  [404, { kind: 'gone' }],
  [503, { kind: 'failed', status: 503 }],
])('reports lookup status %i', async (status, expected) => {
  const account = endpoint(async () => new Response(null, { status }))
  expect(await lookupInvite(account, 'fixture')).toEqual(expected)
})

it('sends a supplied password and preserves the password error', async () => {
  const request = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ code: 'PASSWORD' }, { status: 403 }))
  expect(await acceptInvite(endpoint(request), 'fixture', 'fixture password')).toEqual({ kind: 'password' })
  expect(request.mock.calls[0][1]?.body).toBe(JSON.stringify({ password: 'fixture password' }))
})

it('reports acceptance failure when the error body is not JSON', async () => {
  const account = endpoint(async () => new Response('Unavailable', { status: 503 }))
  expect(await acceptInvite(account, 'fixture')).toEqual({ kind: 'failed' })
})
