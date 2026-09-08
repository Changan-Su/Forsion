import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { transform } from 'sucrase'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as auth from './forsionAuth'

const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('./amadeus/ipc.ts', import.meta.url), 'utf8')
const section = (source: string, from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)))
const barrierCode = section(main, '  const withPreparedAccount =', '  /**\n   * 登录态滑动续期:')
const watcherCode = section(main, '  let authWatchTimer:', '  try {\n    mkdirSync(forsionHomeDir()')
const stopCode = section(ipc, '  const stopAllSync =', '  const restartAllSync =')
const jwt = (userId: string) => `x.${Buffer.from(JSON.stringify({ userId })).toString('base64url')}.y`
const a = { cloudUrl: 'https://accounts.test', token: jwt('a') }
const b = { cloudUrl: 'https://accounts.test', token: jwt('b') }
const key = (c: auth.TanguCreds) => `${c.cloudUrl || ''}\u0000${c.token || ''}`
let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'forsion-external-auth-'))
  vi.stubEnv('TANGU_HOME', dir)
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const cloudRoot = path.join(dir, 'cloud-a'), localRoot = path.join(dir, 'local')
  mkdirSync(cloudRoot); mkdirSync(localRoot)
  writeFileSync(path.join(cloudRoot, 'Note.md'), 'Old saved content')
  auth.saveTanguCreds(a)
  let root = cloudRoot
  const transitions: Promise<unknown>[] = []
  const events: string[] = []
  const context: Record<string, any> = {
    ...auth, setTimeout, clearTimeout, path, fs,
    lastAuthKey: key(a), lastAuthCreds: a, authIntent: 0, whoProfileCache: null,
    currentAuthKey: () => key(auth.loadTanguCreds()),
    updateLastAuth: () => { context.lastAuthCreds = auth.loadTanguCreds(); context.lastAuthKey = key(context.lastAuthCreds) },
    runAuthTransition: (fn: () => Promise<unknown>) => { const task = fn(); transitions.push(task); return task },
    prepareAccountTransition: async () => {
      events.push('flush')
      // The production rendererRoots guard rejects a write after the active root moves.
      if (root !== cloudRoot) throw new Error('The active vault changed; reload the current account before editing')
      await fs.writeFile(path.join(root, 'Note.md'), 'Unsaved cloud draft')
    },
    restartAmadeusSync: vi.fn(async () => { events.push('restart') }),
    broadcast: vi.fn(), refreshUnitHost: vi.fn(),
    loadConfig: async () => ({ mode: 'external' }),
    console: { error: vi.fn() },
    syncEpoch: 0, syncReady: true,
    collabMain: { stop() {} }, sync: { stop: async () => { events.push('stop') } },
    sharedEngines: new Map(), entryEngines: new Map(), sharedPlans: [],
    entryMarkersEnsured: new Set(), presenceRoster: new Map(), pushRoster() {},
    pendingVaultWrites: new Set(), vault: { getRoot: () => root },
    isManagedCloudVault: (value: string) => value === cloudRoot,
    readConfig: async () => ({ localVault: localRoot }),
    writeConfig: async () => {}, activateRoot: async (value: string) => { root = value; events.push('move-root') },
    emitEntryChange() {},
  }
  const code = stopCode + '\nconst stopAmadeusSync = stopAllSync;\n' + barrierCode + watcherCode + '\nonAuthFileMaybeChanged'
  const changed = runInNewContext(transform(code, { transforms: ['typescript'] }).code, context) as () => void
  return { context, cloudRoot, localRoot, transitions, events, changed }
}

describe('external credential changes', () => {
  it('flushes an unsaved cloud note against its original root before stopping changes the vault', async () => {
    const h = harness()
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(b)) // An actual external writer bypasses desktop auth helpers.
    h.changed()
    await vi.advanceTimersByTimeAsync(301)
    await Promise.allSettled(h.transitions)
    expect(h.context.console.error).not.toHaveBeenCalled()
    expect(readFileSync(path.join(h.cloudRoot, 'Note.md'), 'utf8')).toBe('Unsaved cloud draft')
    expect(h.events.indexOf('flush')).toBeLessThan(h.events.indexOf('move-root'))
    expect(auth.forsionAccounts().some((account) => account.id === auth.forsionAccountId(a.cloudUrl, a.token))).toBe(true)
  })

  it('external sign-out removes only the former active credential from remembered accounts', async () => {
    const h = harness()
    auth.rememberForsionAccount(b)
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ cloudUrl: a.cloudUrl }))
    h.changed()
    await vi.advanceTimersByTimeAsync(301)
    await Promise.allSettled(h.transitions)
    expect(() => auth.savedForsionAccount(auth.forsionAccountId(a.cloudUrl, a.token)!)).toThrow()
    expect(auth.forsionAccounts()).toEqual([expect.objectContaining({ id: auth.forsionAccountId(b.cloudUrl, b.token), active: false })])
  })

  it('failed external sign-out preparation preserves the old cloud draft and does not restart or restore credentials', async () => {
    const h = harness()
    h.context.prepareAccountTransition = async () => { throw new Error('ENOSPC') }
    writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ cloudUrl: a.cloudUrl }))
    h.changed()
    await vi.advanceTimersByTimeAsync(301)
    await Promise.allSettled(h.transitions)
    expect(h.events).not.toContain('move-root')
    expect(h.context.restartAmadeusSync).not.toHaveBeenCalled()
    expect(auth.loadTanguCreds().token).toBeUndefined()
    expect(() => auth.savedForsionAccount(auth.forsionAccountId(a.cloudUrl, a.token)!)).toThrow()
    expect(readFileSync(path.join(h.cloudRoot, 'Note.md'), 'utf8')).toBe('Old saved content')
  })
})
