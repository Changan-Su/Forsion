import { provideInboxChannel, type InboxChannel } from '@/services/inboxChannel'
import type { InboxMessage, InboxFilter } from '@/services/backendService'
import type { BrowserAccount } from './account'

/** Compatibility for the standalone Web distribution, which has no plugin loader.
 * Public Unit and native clients receive this channel from Forsion Extend. Both
 * paths use the same account database and existing claim ledger. */
export function installStandaloneWebInbox(account: BrowserAccount): void {
  const provide = () => {
    const generation = account.generation
    const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
      if (account.generation !== generation) throw new Error('Inbox account changed')
      const response = await account.request(path, { method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const data = await response.json()
      if (account.generation !== generation) throw new Error('Inbox account changed')
      if (!response.ok) throw Object.assign(new Error(data.detail || `Inbox ${response.status}`), { code: data.error })
      return data
    }
    const idOf = (id: string) => {
      if (!/^cloud:[0-9a-zA-Z-]{1,64}$/.test(id)) throw new Error('Invalid cloud message id')
      return encodeURIComponent(id.slice(6))
    }
    const channel: InboxChannel = {
      async list(filter: InboxFilter) {
        const messages: InboxMessage[] = [], seen = new Set<string>()
        let cursor: string | null = null
        do {
          const page: { messages: InboxMessage[]; nextCursor?: string | null } = await request(`/brain/inbox/messages?filter=${filter}${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`)
          messages.push(...page.messages)
          cursor = page.nextCursor ?? null
          if (cursor && seen.has(cursor)) throw new Error('Repeated inbox cursor')
          if (cursor) seen.add(cursor)
        } while (cursor)
        return messages
      },
      unreadCount: () => request('/brain/inbox/messages/unread-count'),
      patch: (id, patch) => request(`/brain/inbox/messages/${idOf(id)}`, 'PATCH', patch),
      readAll: () => request('/brain/inbox/messages/read-all', 'POST', {}),
      remove: (id) => request(`/brain/inbox/messages/${idOf(id)}`, 'DELETE'),
      async claim(id, client) {
        const r = await request<{ claimed: boolean; alreadyClaimed: boolean }>(`/brain/inbox/broadcasts/${idOf(id)}/claim`, 'POST', { client })
        return { ok: r.claimed, alreadyClaimed: r.alreadyClaimed }
      },
    }
    provideInboxChannel('standalone-web', channel)
  }
  provide()
  const off = account.subscribe(provide)
  window.addEventListener('pagehide', () => { off(); provideInboxChannel('standalone-web', null) }, { once: true })
}
