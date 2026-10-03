import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDocumentTaskClaims, type DocumentTaskClaimResult } from './documentTaskClaims'

let directory: string
let file: string
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const KEY = digest('document identity')
const SIGNATURE = digest('requested task content')
const changedSignature = digest('changed task content')
const claimedToken = (claim: DocumentTaskClaimResult): string => {
  expect(claim.state).toBe('claimed')
  if (claim.state !== 'claimed') throw new Error('Expected a new claim')
  return claim.token
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'forsion-document-claims-'))
  file = join(directory, 'claims.json')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('main-process document task claims', () => {
  it('atomically permits one renderer owner and gives later callers busy', () => {
    const coordinator = createDocumentTaskClaims(file)
    const token = claimedToken(coordinator.claim(1, KEY, SIGNATURE))
    expect(token).toMatch(/^[a-f\d-]{36}$/)
    expect(coordinator.claim(2, KEY, SIGNATURE)).toEqual({ state: 'busy' })
    expect(coordinator.claim(1, KEY, SIGNATURE)).toEqual({ state: 'busy' })
    expect(existsSync(file)).toBe(false)
  })

  it('rejects a changed signature for pending and completed identities', () => {
    const coordinator = createDocumentTaskClaims(file)
    const token = claimedToken(coordinator.claim(1, KEY, SIGNATURE))
    expect(coordinator.claim(2, KEY, changedSignature)).toEqual({ state: 'conflict' })
    coordinator.complete(1, KEY, token, 'session-1')
    expect(coordinator.claim(2, KEY, changedSignature)).toEqual({ state: 'conflict' })
    expect(coordinator.claim(2, KEY, SIGNATURE)).toEqual({ state: 'linked', sessionId: 'session-1' })
  })

  it('requires the original owner and token before persisting any receipt', () => {
    const coordinator = createDocumentTaskClaims(file)
    const token = claimedToken(coordinator.claim(1, KEY, SIGNATURE))
    expect(() => coordinator.complete(2, KEY, token, 'session-1')).toThrow('owner')
    expect(() => coordinator.complete(1, KEY, 'wrong-token', 'session-1')).toThrow('owner')
    expect(existsSync(file)).toBe(false)
    coordinator.release(2, KEY, token)
    coordinator.release(1, KEY, 'wrong-token')
    expect(coordinator.claim(2, KEY, SIGNATURE)).toEqual({ state: 'busy' })
    coordinator.complete(1, KEY, token, 'session-1')
    expect(() => coordinator.complete(1, KEY, token, 'session-2')).toThrow('owner')
  })

  it('persists only private receipts and links after a process restart without claiming again', () => {
    const coordinator = createDocumentTaskClaims(file)
    const token = claimedToken(coordinator.claim(1, KEY, SIGNATURE))
    coordinator.complete(1, KEY, token, 'session-1')
    const raw = readFileSync(file, 'utf8')
    expect(JSON.parse(raw)).toEqual({ v: 1, receipts: { [KEY]: { signature: SIGNATURE, sessionId: 'session-1' } } })
    expect(raw).not.toContain(token)
    expect(raw).not.toContain('requested task content')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(directory)).toEqual(['claims.json'])
    const restarted = createDocumentTaskClaims(file)
    expect(restarted.claim(99, KEY, SIGNATURE)).toEqual({ state: 'linked', sessionId: 'session-1' })
    restarted.releaseOwner(1)
    restarted.release(1, KEY, token)
    expect(restarted.claim(1, KEY, SIGNATURE)).toEqual({ state: 'linked', sessionId: 'session-1' })
  })

  it('releases only unfinished claims belonging to a destroyed renderer owner', () => {
    const coordinator = createDocumentTaskClaims(file)
    const second = digest('second task'), third = digest('third task')
    claimedToken(coordinator.claim(1, KEY, SIGNATURE))
    const completed = claimedToken(coordinator.claim(1, second, SIGNATURE))
    coordinator.complete(1, second, completed, 'session-2')
    claimedToken(coordinator.claim(2, third, SIGNATURE))
    coordinator.releaseOwner(1)
    claimedToken(coordinator.claim(3, KEY, SIGNATURE))
    expect(coordinator.claim(3, second, SIGNATURE)).toEqual({ state: 'linked', sessionId: 'session-2' })
    expect(coordinator.claim(3, third, SIGNATURE)).toEqual({ state: 'busy' })
  })

  it('releases an unfinished claim with its own token and issues a new token', () => {
    const coordinator = createDocumentTaskClaims(file)
    const token = claimedToken(coordinator.claim(1, KEY, SIGNATURE))
    coordinator.release(1, KEY, token)
    const next = claimedToken(coordinator.claim(2, KEY, SIGNATURE))
    expect(next).not.toBe(token)
  })

  it('fails closed after a write error, even if the claim is subsequently released', () => {
    const coordinator = createDocumentTaskClaims(file)
    const token = claimedToken(coordinator.claim(1, KEY, SIGNATURE))
    mkdirSync(file) // Atomic rename cannot replace a directory with a file.
    expect(() => coordinator.complete(1, KEY, token, 'session-1')).toThrow('persist')
    coordinator.release(1, KEY, token)
    coordinator.releaseOwner(1)
    expect(() => coordinator.claim(2, KEY, SIGNATURE)).toThrow('persist')
    expect(() => coordinator.claim(2, digest('other task'), SIGNATURE)).toThrow('persist')
    expect(() => coordinator.complete(1, KEY, token, 'session-1')).toThrow('persist')
    expect(readdirSync(directory)).toEqual(['claims.json'])
  })

  it.each(['', '{', '[]', 'null', '{}', '{"v":2,"receipts":{}}', '{"v":1,"receipts":{"bad":{}}}', '{"v":1,"receipts":{},"prompt":"unexpected"}'])('fails closed when a receipt file is corrupt: %s', (raw) => {
    writeFileSync(file, raw)
    expect(() => createDocumentTaskClaims(file)).toThrow('corrupt')
    expect(readFileSync(file, 'utf8')).toBe(raw)
  })

  it('does not treat read errors other than ENOENT as an empty store', () => {
    mkdirSync(file)
    expect(() => createDocumentTaskClaims(file)).toThrow('read')
  })

  it('canonicalizes uppercase hash input and rejects duplicate canonical persisted keys', () => {
    const coordinator = createDocumentTaskClaims(file)
    claimedToken(coordinator.claim(1, KEY.toUpperCase(), SIGNATURE.toUpperCase()))
    expect(coordinator.claim(2, KEY, SIGNATURE)).toEqual({ state: 'busy' })
    writeFileSync(file, JSON.stringify({ v: 1, receipts: { [KEY]: { signature: SIGNATURE, sessionId: 'one' }, [KEY.toUpperCase()]: { signature: SIGNATURE, sessionId: 'two' } } }))
    expect(() => createDocumentTaskClaims(file)).toThrow('corrupt')
  })

  it('validates owners, digests and session ids before changing state', () => {
    const coordinator = createDocumentTaskClaims(file)
    for (const owner of [0, -1, 1.1, NaN, Infinity]) expect(() => coordinator.claim(owner, KEY, SIGNATURE)).toThrow('owner')
    for (const bad of ['', 'f'.repeat(63), 'g'.repeat(64), 'f'.repeat(65)]) {
      expect(() => coordinator.claim(1, bad, SIGNATURE)).toThrow('key')
      expect(() => coordinator.claim(1, KEY, bad)).toThrow('signature')
    }
    const token = claimedToken(coordinator.claim(1, KEY, SIGNATURE))
    for (const session of ['', 'x'.repeat(257), 'with space', 'line\nbreak', '\u0000']) expect(() => coordinator.complete(1, KEY, token, session)).toThrow('session')
    expect(existsSync(file)).toBe(false)
    coordinator.complete(1, KEY, token, 'x'.repeat(256))
    expect(createDocumentTaskClaims(file).claim(2, KEY, SIGNATURE)).toEqual({ state: 'linked', sessionId: 'x'.repeat(256) })
  })

  it('preserves existing completed receipts while atomically adding another one', () => {
    const coordinator = createDocumentTaskClaims(file)
    const second = digest('second')
    coordinator.complete(1, KEY, claimedToken(coordinator.claim(1, KEY, SIGNATURE)), 'session-1')
    coordinator.complete(2, second, claimedToken(coordinator.claim(2, second, changedSignature)), 'session-2')
    const restarted = createDocumentTaskClaims(file)
    expect(restarted.claim(3, KEY, SIGNATURE)).toEqual({ state: 'linked', sessionId: 'session-1' })
    expect(restarted.claim(3, second, changedSignature)).toEqual({ state: 'linked', sessionId: 'session-2' })
  })
})
