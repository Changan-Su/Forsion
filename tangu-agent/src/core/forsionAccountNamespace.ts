import { createHash } from 'node:crypto'
import { forsionAccountId } from '../contracts/forsionAccount.js'

/** Match cloudAccountNamespace in the desktop host. */
export function forsionAccountNamespace(cloudUrl: string, token: string): string | null {
  const accountId = forsionAccountId(cloudUrl, token)
  return accountId ? createHash('sha256').update(accountId).digest('hex') : null
}
