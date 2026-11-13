import type { InboxMessage, InboxFilter } from './backendService'

/** Account-owned official mail supplied by Forsion Extend. Native inbox messages
 * remain on their engine. No credentials or generic cloud transport cross this seam. */
export interface InboxChannel {
  list(filter: InboxFilter): Promise<InboxMessage[]>
  unreadCount(): Promise<{ count: number; latestId: string | null; revision?: string; latestCreatedAt?: string | null }>
  patch(id: string, patch: { read?: boolean; archived?: boolean }): Promise<unknown>
  /** Import owned desktop read/archive flags once; existing cloud state always wins. */
  importLegacy?(messages: InboxMessage[]): Promise<unknown>
  readAll(): Promise<unknown>
  remove(id: string): Promise<unknown>
  claim(id: string, client?: string): Promise<{ ok: boolean; alreadyClaimed: boolean }>
}
let provider: { owner: string; channel: InboxChannel } | null = null
const listeners = new Set<() => void>()
export const readInboxChannel = (): InboxChannel | null => provider?.channel ?? null
export const subscribeInboxChannel = (cb: () => void): (() => void) => { listeners.add(cb); return () => { listeners.delete(cb) } }
export function provideInboxChannel(owner: string, channel: InboxChannel | null): boolean {
  if (channel === null) {
    if (provider?.owner !== owner) return false
    provider = null
  } else {
    if (!['list', 'unreadCount', 'patch', 'readAll', 'remove', 'claim'].every((k) => typeof channel[k as keyof InboxChannel] === 'function')) return false
    provider = { owner, channel }
  }
  listeners.forEach((cb) => cb())
  return true
}
