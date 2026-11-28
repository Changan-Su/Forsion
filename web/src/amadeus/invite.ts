import { CLOUD_CONTENT_CAPS } from './cloudScope'
import { fileAddress } from '../openTarget'

export interface InviteEndpoint {
  apiBase: string
  getToken(): string
  request(path: string, init?: RequestInit): Promise<Response>
  appBase: string
}

export interface InviteInfo {
  title: string; role: string; ownerName: string | null; needPassword: boolean
  joined?: boolean; owner?: boolean; vaultId?: string; path?: string
}

function inviteRequest(endpoint: InviteEndpoint, token: string, action: '' | '/accept', init?: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<Response> {
  return endpoint.request(`${endpoint.apiBase}/amadeus/invites/${encodeURIComponent(token)}${action}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${endpoint.getToken()}`,
      'X-Content-Caps': CLOUD_CONTENT_CAPS,
      ...init?.headers,
    },
  })
}

type InviteLookup =
  | { kind: 'gone' }
  | { kind: 'failed'; status: number }
  | { kind: 'found'; info: InviteInfo }

export function lookupInvite(endpoint: InviteEndpoint, token: string): Promise<InviteLookup> {
  return inviteRequest(endpoint, token, '').then(async (response) => {
    if (response.status === 404) return { kind: 'gone' }
    if (!response.ok) return { kind: 'failed', status: response.status }
    return { kind: 'found', info: await response.json() as InviteInfo }
  })
}

export function joinedInviteAddress(appBase: string, { vaultId, path }: InviteInfo): string | undefined {
  if (vaultId && path) return fileAddress(appBase, vaultId, path)
}

type InviteAcceptance =
  | { kind: 'accepted'; address: string }
  | { kind: 'password' | 'failed' }

export function acceptInvite(endpoint: InviteEndpoint, token: string, password?: string): Promise<InviteAcceptance> {
  return inviteRequest(endpoint, token, '/accept', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(password === undefined ? {} : { password }),
  }).then(async (response) => {
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { code?: string } | null
      return { kind: body?.code === 'PASSWORD' ? 'password' : 'failed' }
    }
    const { vaultId, path } = await response.json() as { vaultId: string; path: string }
    return { kind: 'accepted', address: fileAddress(endpoint.appBase, vaultId, path) }
  })
}
