import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

export type DocumentTaskClaimResult =
  | { state: 'claimed'; token: string }
  | { state: 'busy' }
  | { state: 'linked'; sessionId: string }
  | { state: 'conflict' }

export interface DocumentTaskClaims {
  claim(owner: number, keySHA256: string, signatureSHA256: string): DocumentTaskClaimResult
  complete(owner: number, keySHA256: string, token: string, sessionId: string): void
  release(owner: number, keySHA256: string, token: string): void
  releaseOwner(owner: number): void
}

interface Receipt { signature: string; sessionId: string }
interface Pending { owner: number; signature: string; token: string }

function hash(value: string, name: string): string {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) throw new Error(`Invalid document task ${name}`)
  return value.toLowerCase()
}

function assertOwner(owner: number): void {
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Invalid document task owner')
}

function assertSession(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256 || /[\s\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error('Invalid document task session')
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readReceipts(file: string): Map<string, Receipt> {
  let raw: string
  try { raw = readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw new Error('Cannot read document task receipts', { cause: error })
  }
  try {
    const data: unknown = JSON.parse(raw)
    if (!record(data) || data.v !== 1 || !record(data.receipts) || Object.keys(data).some((key) => key !== 'v' && key !== 'receipts')) {
      throw new Error('Invalid document task receipts format')
    }
    const receipts = new Map<string, Receipt>()
    for (const [rawKey, receipt] of Object.entries(data.receipts)) {
      const key = hash(rawKey, 'key')
      if (!record(receipt) || Object.keys(receipt).some((field) => field !== 'signature' && field !== 'sessionId')) {
        throw new Error('Invalid document task receipt')
      }
      const signature = hash(receipt.signature as string, 'signature')
      assertSession(receipt.sessionId as string)
      if (receipts.has(key)) throw new Error('Duplicate document task receipt')
      receipts.set(key, { signature, sessionId: receipt.sessionId as string })
    }
    return receipts
  } catch (error) {
    throw new Error('Document task receipts are corrupt', { cause: error })
  }
}

/**
 * Instantiate once in the main process. All renderer owners share this synchronous
 * coordinator; no await can split checking a key from reserving it. Only completed
 * receipts survive restart, never prompts, renderer ownership or claim tokens.
 */
export function createDocumentTaskClaims(file: string): DocumentTaskClaims {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Document task receipts require an absolute path')
  const receipts = readReceipts(file)
  const pending = new Map<string, Pending>()
  let persistenceFailure: Error | null = null

  const assertHealthy = (): void => {
    if (persistenceFailure) throw persistenceFailure
  }

  const persist = (key: string, receipt: Receipt): void => {
    const next = Object.fromEntries(receipts)
    next[key] = receipt
    const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`)
    let fd: number | undefined
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({ v: 1, receipts: next }) + '\n', 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, file)
    } catch (error) {
      // Keep the process closed to all new claims after uncertain persistence.
      // Recreating the coordinator rereads the actual receipt before any retry.
      persistenceFailure = new Error('Cannot persist document task receipt', { cause: error })
      throw persistenceFailure
    } finally {
      if (fd !== undefined) { try { closeSync(fd) } catch { /* Keep the original persistence error. */ } }
      try { unlinkSync(temporary) } catch { /* Renamed successfully or already absent. */ }
    }
  }

  return {
    claim(owner, keySHA256, signatureSHA256) {
      assertHealthy()
      assertOwner(owner)
      const key = hash(keySHA256, 'key'), signature = hash(signatureSHA256, 'signature')
      const linked = receipts.get(key)
      if (linked) return linked.signature === signature ? { state: 'linked', sessionId: linked.sessionId } : { state: 'conflict' }
      const existing = pending.get(key)
      if (existing) return existing.signature === signature ? { state: 'busy' } : { state: 'conflict' }
      const token = randomUUID()
      pending.set(key, { owner, signature, token })
      return { state: 'claimed', token }
    },
    complete(owner, keySHA256, token, sessionId) {
      assertHealthy()
      assertOwner(owner)
      const key = hash(keySHA256, 'key')
      assertSession(sessionId)
      const claim = pending.get(key)
      if (!claim || claim.owner !== owner || typeof token !== 'string' || claim.token !== token) throw new Error('Document task claim does not belong to this owner')
      const receipt = { signature: claim.signature, sessionId }
      // The caller may send only after this returns. A failed write never links.
      persist(key, receipt)
      receipts.set(key, receipt)
      pending.delete(key)
    },
    release(owner, keySHA256, token) {
      assertOwner(owner)
      const key = hash(keySHA256, 'key')
      const claim = pending.get(key)
      if (claim?.owner === owner && typeof token === 'string' && claim.token === token) pending.delete(key)
    },
    releaseOwner(owner) {
      assertOwner(owner)
      for (const [key, claim] of pending) if (claim.owner === owner) pending.delete(key)
    },
  }
}
