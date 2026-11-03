import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundVaultRoot, createConfigStore, createCredentialStore, readJson, watchResume } from '../../unit/cloudHost'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'unit-cloud-host-')) })
afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }) })

describe('Unit cloud files: a read failure is unknown, never empty', () => {
  it('tells a missing file from an unreadable one', async () => {
    const file = join(dir, 'x.json')
    expect(readJson(file)).toEqual({ state: 'ok', value: null })
    for (const bad of ['', '{"a":', '[]', '"text"']) {
      await writeFile(file, bad)
      expect(readJson(file)).toEqual({ state: 'unknown' })
    }
    await writeFile(file, '{"a":1}')
    expect(readJson(file)).toEqual({ state: 'ok', value: { a: 1 } })
  })

  it('keeps the last good credentials and refuses every write until the owner repairs auth.json', async () => {
    const store = createCredentialStore(dir, () => {})
    store.save({ cloudUrl: 'http://cloud', token: 't1', model: 'm' })
    expect(statSync(join(dir, 'auth.json')).mode & 0o077).toBe(0)
    await writeFile(join(dir, 'auth.json'), '')
    expect(store.load()).toEqual({ cloudUrl: 'http://cloud', token: 't1', model: 'm' })
    expect(store.readable()).toBe(false)
    expect(() => store.save({ cloudUrl: 'http://cloud', token: 't2' })).toThrow(/unreadable/)
    expect(() => store.assertWritable()).toThrow(/unreadable/)
    expect(await readFile(join(dir, 'auth.json'), 'utf8')).toBe('')
    await rm(join(dir, 'auth.json'))
    expect(store.load()).toEqual({})
    store.save({ cloudUrl: 'http://cloud', token: 't3' })
    expect(store.load().token).toBe('t3')
  })

  it('treats a mistyped auth.json as unknown too', async () => {
    await writeFile(join(dir, 'auth.json'), '{"token":42}')
    const store = createCredentialStore(dir, () => {})
    expect(store.readable()).toBe(false)
    expect(store.load()).toEqual({})
    expect(() => store.save({ token: 't' })).toThrow(/unreadable/)
  })

  it('stores cloud bindings per account and leaves a damaged config untouched', async () => {
    let account: string | null = 'a'
    const config = createConfigStore(dir, () => account)
    await config.write({ cloudSync: { deviceId: 'device-a' } })
    await config.update((c) => { c.cloudSync = { ...c.cloudSync, vaultId: 'v' } })
    expect((await config.read()).cloudSync).toEqual({ deviceId: 'device-a', vaultId: 'v' })
    account = 'b'
    expect((await config.read()).cloudSync).toBeUndefined()
    expect((await config.read('a')).cloudSync?.deviceId).toBe('device-a')
    await writeFile(join(dir, 'amadeus-config.json'), '{"cloudAccounts":')
    await expect(config.read()).rejects.toThrow(/unreadable/)
    await expect(config.write({ cloudSync: { deviceId: 'x' } })).rejects.toThrow(/unreadable/)
    await expect(config.update(() => {})).rejects.toThrow(/unreadable/)
    expect(await readFile(join(dir, 'amadeus-config.json'), 'utf8')).toBe('{"cloudAccounts":')
  })
})

describe('Unit vault as a cloud mirror', () => {
  const marker = () => join(dir, 'vault-account.json')
  const vault = () => join(dir, 'vault')
  beforeEach(async () => { await mkdir(vault()) })

  it('binds an empty vault to the first account, and only that account', () => {
    expect(boundVaultRoot(marker(), vault(), 'a', false)).toBe(true)
    expect(boundVaultRoot(marker(), vault(), 'a', false)).toBe(true)
    expect(boundVaultRoot(marker(), vault(), 'b', false)).toBe(false)
    expect(boundVaultRoot(marker(), vault(), 'b', true)).toBe(false)
  })

  it('does not follow the binding to another folder', async () => {
    expect(boundVaultRoot(marker(), vault(), 'a', false)).toBe(true)
    const other = join(dir, 'other')
    await mkdir(other)
    await writeFile(join(other, 'Private.md'), 'mine')
    expect(boundVaultRoot(marker(), other, 'a', false)).toBe(false)
    expect(boundVaultRoot(marker(), other, 'a', true)).toBe(false)
    expect(boundVaultRoot(marker(), vault(), 'a', false)).toBe(true)
  })

  it('never publishes existing notes unless the owner opted in', async () => {
    await writeFile(join(vault(), 'Private.md'), 'mine')
    expect(boundVaultRoot(marker(), vault(), 'a', false)).toBe(false)
    expect(readJson(marker())).toEqual({ state: 'ok', value: null })
    expect(boundVaultRoot(marker(), vault(), 'a', true)).toBe(true)
  })

  it('counts hidden notes as content, because the sync engine uploads them', async () => {
    await writeFile(join(vault(), '.secret.md'), 'private')
    expect(boundVaultRoot(marker(), vault(), 'a', false)).toBe(false)
  })

  it('ignores the Finder marker when judging empty, and refuses when ownership is unknown', async () => {
    await writeFile(join(vault(), '.DS_Store'), '')
    await writeFile(marker(), '{"account":')
    expect(boundVaultRoot(marker(), vault(), 'a', true)).toBe(false)
    expect(await readFile(marker(), 'utf8')).toBe('{"account":')
    await rm(marker())
    expect(boundVaultRoot(marker(), vault(), 'a', false)).toBe(true)
  })
})

describe('Unit resume watch', () => {
  it('wakes on a late timer, a changed address and SIGCONT, and stays quiet otherwise', () => {
    vi.useFakeTimers()
    const reasons: string[] = []
    let address = '10.0.0.1'
    const stop = watchResume((reason) => reasons.push(reason), 1000, () => address)
    vi.advanceTimersByTime(3000)
    expect(reasons).toEqual([])
    address = '10.0.0.2'
    vi.advanceTimersByTime(1000)
    expect(reasons).toEqual(['network'])
    vi.setSystemTime(Date.now() + 60_000)
    vi.advanceTimersByTime(1000)
    expect(reasons).toEqual(['network', 'resume'])
    process.emit('SIGCONT')
    expect(reasons).toEqual(['network', 'resume', 'resume'])
    stop()
    process.emit('SIGCONT')
    vi.advanceTimersByTime(5000)
    expect(reasons).toHaveLength(3)
  })
})
