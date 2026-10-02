import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDocumentTaskIpc } from './documentTaskIpc'
import type { DocumentTaskClaimResult } from './documentTaskClaims'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type Sender = EventEmitter & { id: number; mainFrame: { url: string } }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const KEY = digest('page and block identity')
const SIGNATURE = digest('agent and prompt signature')
const makeSender = (id: number): Sender => Object.assign(new EventEmitter(), { id, mainFrame: { url: 'file:///app/renderer/index.html' } })
const makeEvent = (sender: Sender, frame: unknown = sender.mainFrame): IpcMainInvokeEvent =>
  ({ sender, senderFrame: frame }) as unknown as IpcMainInvokeEvent
const tokenOf = (result: unknown): string => {
  const claim = result as DocumentTaskClaimResult
  expect(claim.state).toBe('claimed')
  if (claim.state !== 'claimed') throw new Error('Expected an acquired task claim')
  return claim.token
}

let directory: string
let file: string
let handlers: Map<string, Handler>
let trustedOwners: Set<number>
let trust: ReturnType<typeof vi.fn<(event: IpcMainInvokeEvent) => boolean>>

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'forsion-document-task-ipc-'))
  file = join(directory, 'receipts.json')
  handlers = new Map()
  trustedOwners = new Set([1, 2, 3])
  // The real origin/top-frame policy is supplied by main.ts. This stub makes
  // accepted/rejected decisions explicit and proves every handler delegates to it.
  trust = vi.fn((event: IpcMainInvokeEvent) => trustedOwners.has(event.sender.id) && event.senderFrame === event.sender.mainFrame)
  registerDocumentTaskIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, file, trust)
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

function invoke(channel: 'claim' | 'complete' | 'release', sender: Sender, ...args: unknown[]): unknown {
  return handlers.get(`documentTasks:${channel}`)!(makeEvent(sender), ...args)
}

describe('document task IPC ownership and lifecycle', () => {
  it('registers only the three document task endpoints without reading disk at startup', () => {
    expect([...handlers.keys()].sort()).toEqual(['documentTasks:claim', 'documentTasks:complete', 'documentTasks:release'])
    expect(existsSync(file)).toBe(false)
    writeFileSync(file, '{broken')
    expect(() => registerDocumentTaskIpc({ handle: () => {} }, file, trust)).not.toThrow()
    expect(() => invoke('claim', makeSender(1), KEY, SIGNATURE)).toThrow('corrupt')
  })

  it.each(['claim', 'complete', 'release'] as const)('rejects an untrusted %s sender before reading state or adding listeners', (channel) => {
    const sender = makeSender(99)
    writeFileSync(file, '{broken')
    expect(() => invoke(channel, sender, KEY, SIGNATURE, 'session-1')).toThrow('forbidden')
    expect(trust).toHaveBeenCalledTimes(1)
    expect(trust.mock.calls[0][0].sender).toBe(sender)
    expect(sender.eventNames()).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })

  it.each(['claim', 'complete', 'release'] as const)('honors rejection of a child frame on %s even inside a trusted window', (channel) => {
    const sender = makeSender(1)
    const childFrame = { url: sender.mainFrame.url }
    const event = makeEvent(sender, childFrame)
    expect(() => handlers.get(`documentTasks:${channel}`)!(event, KEY, SIGNATURE, 'session-1')).toThrow('forbidden')
    expect(trust).toHaveBeenCalledWith(event)
    expect(sender.eventNames()).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('shares one coordinator across windows and never trusts a different owner holding a copied token', () => {
    const first = makeSender(1), second = makeSender(2)
    const token = tokenOf(invoke('claim', first, KEY, SIGNATURE))
    expect(invoke('claim', second, KEY, SIGNATURE)).toEqual({ state: 'busy' })
    expect(() => invoke('complete', second, KEY, token, 'session-wrong-owner')).toThrow('owner')
    invoke('release', second, KEY, token)
    expect(invoke('claim', second, KEY, SIGNATURE)).toEqual({ state: 'busy' })
    invoke('complete', first, KEY, token, 'session-1')
    expect(invoke('claim', second, KEY, SIGNATURE)).toEqual({ state: 'linked', sessionId: 'session-1' })
    expect(JSON.parse(readFileSync(file, 'utf8')).receipts[KEY]).toEqual({ signature: SIGNATURE, sessionId: 'session-1' })
  })

  it.each(['did-navigate', 'render-process-gone', 'destroyed'])('releases unfinished claims when the owner emits %s', (event) => {
    const first = makeSender(1), second = makeSender(2)
    const oldToken = tokenOf(invoke('claim', first, KEY, SIGNATURE))
    first.emit(event)
    const nextToken = tokenOf(invoke('claim', second, KEY, SIGNATURE))
    expect(nextToken).not.toBe(oldToken)
    expect(() => invoke('complete', first, KEY, oldToken, 'late-session')).toThrow('owner')
    invoke('complete', second, KEY, nextToken, 'current-session')
    expect(invoke('claim', makeSender(3), KEY, SIGNATURE)).toEqual({ state: 'linked', sessionId: 'current-session' })
  })

  it('keeps completed receipts through explicit release, navigation, renderer failure and destruction', () => {
    const first = makeSender(1), second = makeSender(2)
    const token = tokenOf(invoke('claim', first, KEY, SIGNATURE))
    invoke('complete', first, KEY, token, 'session-1')
    const saved = readFileSync(file, 'utf8')
    invoke('release', first, KEY, token)
    for (const event of ['did-navigate', 'render-process-gone', 'destroyed']) {
      first.emit(event)
      expect(invoke('claim', second, KEY, SIGNATURE)).toEqual({ state: 'linked', sessionId: 'session-1' })
      expect(readFileSync(file, 'utf8')).toBe(saved)
    }
  })

  it('attaches lifecycle listeners once per webContents despite repeated calls', () => {
    const sender = makeSender(1)
    const token = tokenOf(invoke('claim', sender, KEY, SIGNATURE))
    invoke('claim', sender, KEY, SIGNATURE)
    invoke('release', sender, KEY, 'wrong-token')
    invoke('complete', sender, KEY, token, 'session-1')
    invoke('claim', sender, KEY, SIGNATURE)
    expect(sender.listenerCount('destroyed')).toBe(1)
    expect(sender.listenerCount('did-navigate')).toBe(1)
    expect(sender.listenerCount('render-process-gone')).toBe(1)
    expect(trust).toHaveBeenCalledTimes(5)
  })

  it('removes destroyed owner tracking so a newly created owner can be watched again', () => {
    const oldSender = makeSender(1)
    tokenOf(invoke('claim', oldSender, KEY, SIGNATURE))
    oldSender.emit('destroyed')
    const newSender = makeSender(1)
    tokenOf(invoke('claim', newSender, KEY, SIGNATURE))
    expect(newSender.listenerCount('destroyed')).toBe(1)
    newSender.emit('did-navigate')
    tokenOf(invoke('claim', makeSender(2), KEY, SIGNATURE))
  })

  it('fails closed on corrupted persistent receipts for every trusted endpoint', () => {
    const sender = makeSender(1)
    writeFileSync(file, '{broken')
    for (const channel of ['claim', 'complete', 'release'] as const) {
      expect(() => invoke(channel, sender, KEY, SIGNATURE, 'session-1')).toThrow('corrupt')
    }
    expect(sender.eventNames()).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe('{broken')
  })
})
