/**
 * 智库同步第 2 步 H 包:认领按库根(契约 §3.7、实现期修订 H-1 第 5 条)。
 * - readConfig 遮罩:有 syncOwnershipV2 只滤掉接手的根(符号链接、尾斜杠、大小写都认成同一个);老的全局认领 / 配置读不了 = 整份遮掉;
 * - ownership.set:human 没变不碰引擎;engine→content 先改引擎位并读回再落盘,content→engine 反过来;中途失败回滚;老引擎读不回就抛;
 * - syncOwnershipV2 落盘:读坏的配置不当成「没认领」,也不被这一写盖掉;别的账号、条目同步注册表原样留着。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ userData: '', account: 'https://cloud.test/api::alice' as string | null }))
vi.mock('electron', () => ({ app: { getPath: () => env.userData } }))
vi.mock('./forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => env.userData }))
vi.mock('./forsionAuth', () => ({ loadTanguCreds: () => ({ cloudUrl: 'https://cloud.test/api', token: '' }) }))
vi.mock('../shared/forsionAccount', () => ({ forsionAccountId: () => env.account }))
vi.mock('./amadeus/fs/vaultHandlers', () => ({ withTextWriteLock: async (_p: string, fn: () => Promise<void>) => fn() }))

import { canonRoot, contentSyncOwnedStrict, contentSyncOwnership, contentSyncOwnershipV2, maskAmadeusConfig, readMaskedAmadeusConfig, readOfflineContentOwns, setOfflineContentOwner, type OwnershipRead } from './contentSyncHost'
import { readConfig, readSyncOwnershipV2, writeConfig, writeSyncOwnershipV2, type SyncOwnershipV2 } from './amadeus/settings'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forsion-owner-')); env.userData = dir; env.account = 'https://cloud.test/api::alice' })
afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })

const entry = (vaultRoot: string) => ({ vaultRoot, cloudName: 'V', entries: [{ path: 'a.md', kind: 'page' as const }] })

describe('readConfig mask by root', () => {
  it('filters only the taken-over roots; symlinked, trailing-slash and differently-cased spellings are the same root', () => {
    const a = join(dir, 'VaultA'), b = join(dir, 'VaultB'), link = join(dir, 'link-to-A')
    mkdirSync(a); mkdirSync(b); symlinkSync(a, link)
    const cfg = { cloudSync: { enabled: true, vaultId: 'v1' }, entrySync: [entry(link + '/'), entry(b)] }
    const own: OwnershipRead = { kind: 'v2', value: { entryRoots: [a], mirror: 'keep', human: 'engine' } }
    const masked = maskAmadeusConfig(cfg, own, false)
    expect(masked.entrySync.map((v) => v.vaultRoot)).toEqual([b])
    expect(masked.cloudSync).toEqual({ enabled: true, vaultId: 'v1' }) // mirror keep = 照用户的开关
    expect(cfg.entrySync).toHaveLength(2) // 原配置不动
    if (process.platform === 'darwin') {
      const upper = maskAmadeusConfig({ ...cfg, entrySync: [entry(join(dir, 'vaulta'))] }, own, false)
      expect(upper.entrySync).toEqual([]) // mac 大小写不敏感:realpath.native 纠正成盘上的写法
    }
    expect(maskAmadeusConfig(cfg, { kind: 'v2', value: { entryRoots: [], mirror: 'off', human: 'engine' } }, false)).toEqual({ ...cfg, cloudSync: { enabled: false, vaultId: 'v1' } })
  })

  it('unknown ownership or the legacy global claim masks everything; no v2 and no claim leaves the config alone', () => {
    const cfg = { cloudSync: { enabled: true }, entrySync: [entry('/x/VaultA')] }
    expect(maskAmadeusConfig(cfg, { kind: 'unknown' }, false)).toEqual({ cloudSync: { enabled: false }, entrySync: [] })
    expect(maskAmadeusConfig(cfg, { kind: 'v2', value: { entryRoots: [], mirror: 'keep', human: 'engine' } }, true)).toEqual({ cloudSync: { enabled: false }, entrySync: [] })
    expect(maskAmadeusConfig(cfg, { kind: 'none' }, false)).toBe(cfg)
  })

  it('canonRoot keeps a filesystem root and strips trailing separators elsewhere', () => {
    expect(canonRoot('/')).toBe('/')
    expect(canonRoot(join(dir, 'missing') + '//')).toBe(join(dir, 'missing'))
  })
})

describe('syncOwnershipV2 persistence', () => {
  const v2: SyncOwnershipV2 = { entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine' }
  it('round-trips next to the entry registry and other accounts without touching them', async () => {
    await writeConfig({ entrySync: [entry('/x/VaultA')] })
    env.account = 'https://cloud.test/api::bob'
    await writeConfig({ entrySync: [entry('/x/VaultB')] })
    env.account = 'https://cloud.test/api::alice'
    await writeSyncOwnershipV2('https://cloud.test/api::alice', v2)
    expect(await readSyncOwnershipV2('https://cloud.test/api::alice')).toEqual(v2)
    expect(await readSyncOwnershipV2('https://cloud.test/api::bob')).toBeNull()
    expect((await readConfig()).entrySync).toEqual([entry('/x/VaultA')])
    await writeConfig({ entrySync: [entry('/x/VaultA'), entry('/x/VaultC')] }) // 普通的配置写不会把认领冲掉
    expect(await readSyncOwnershipV2('https://cloud.test/api::alice')).toEqual(v2)
    expect((await readConfig('https://cloud.test/api::bob')).entrySync).toEqual([entry('/x/VaultB')])
    await writeSyncOwnershipV2('https://cloud.test/api::alice', null)
    expect(await readSyncOwnershipV2('https://cloud.test/api::alice')).toBeNull()
  })

  it('an unreadable config is "unknown", not "no claim", and is never overwritten by an ownership write', async () => {
    const file = join(dir, 'amadeus-config.json')
    writeFileSync(file, '{"cloudAccounts":')
    await expect(readSyncOwnershipV2('https://cloud.test/api::alice')).rejects.toThrow()
    await expect(writeSyncOwnershipV2('https://cloud.test/api::alice', v2)).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{"cloudAccounts":')
  })
})

describe('ownership seam', () => {
  const A = 'https://cloud.test/api::alice'
  function fixture(opts: { v2?: SyncOwnershipV2 | null; legacy?: boolean; engine?: { human: boolean; agents: boolean } | 'old'; mode?: 'managed' | 'external' } = {}) {
    let stored: SyncOwnershipV2 | null = opts.v2 ?? null
    const engine = opts.engine === 'old' ? null : { ...(opts.engine ?? { human: false, agents: false }) }
    const log: string[] = []
    const host = {
      accountId: () => env.account,
      ensureBackend: vi.fn(async () => { log.push('ensureBackend') }),
      backendStatus: () => (opts.mode === 'external' ? { state: 'stopped', url: null } : { state: 'ready', url: 'http://127.0.0.1:9' }),
      engineToken: () => 't',
      loadConfig: async () => ({ mode: opts.mode ?? 'managed' }),
      dataDir: () => dir,
      stopSync: vi.fn(async () => {}),
      restartSync: vi.fn(async () => { log.push('restart') }),
      readV2: vi.fn(async () => stored),
      writeV2: vi.fn(async (_a: string, next: SyncOwnershipV2 | null) => { log.push(`v2:${next ? next.human : 'null'}`); stored = next }),
      entryRoots: async () => ['/x/VaultA', '/x/VaultB'],
      legacyOwned: () => opts.legacy === true,
      log: (m: string) => log.push(m),
    }
    const fetchFixture = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      if (url.includes('/content-touched')) { log.push('touched'); return engine ? new Response('{"ok":true}') : new Response('', { status: 404 }) }
      if (!engine) return new Response('', { status: 404 })
      if (init?.method === 'PUT') { const b = JSON.parse(String(init.body)); log.push(`engine:${b.human}`); if (typeof b.human === 'boolean') engine.human = b.human; return new Response('{}') }
      return new Response(JSON.stringify(engine))
    })
    vi.stubGlobal('fetch', fetchFixture)
    return { host, log, fetchFixture, engine, stored: () => stored, seam: contentSyncOwnershipV2(host) }
  }

  it('get without v2: legacy global claim reads as all roots / mirror off / human content; otherwise nothing is taken', async () => {
    expect(await fixture({ legacy: true }).seam.get(A)).toEqual({ entryRoots: ['/x/VaultA', '/x/VaultB'], mirror: 'off', human: 'content' })
    expect(await fixture().seam.get(A)).toEqual({ entryRoots: [], mirror: 'keep', human: 'engine' })
  })

  it('takes over an entry root without touching the engine when human does not change (path A at startup)', async () => {
    const f = fixture({ engine: 'old' })
    await f.seam.set({ entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine' }, A)
    expect(f.fetchFixture).not.toHaveBeenCalled()
    expect(f.host.ensureBackend).not.toHaveBeenCalled()
    expect(f.log).toEqual(['v2:engine', 'restart'])
    expect(f.stored()).toEqual({ entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine' })
  })

  it('engine -> content: revokes the engine first and reads it back, then persists; a failed persist rolls the engine bit back', async () => {
    const f = fixture()
    await f.seam.set({ entryRoots: [], mirror: 'off', human: 'content' }, A)
    expect(f.log.filter((x) => !x.startsWith('ensure'))).toEqual(['engine:true', 'v2:content', 'restart'])
    expect(f.engine).toEqual({ human: true, agents: false })
    const g = fixture()
    g.host.writeV2.mockImplementationOnce(async () => { throw new Error('disk full') })
    await expect(g.seam.set({ entryRoots: [], mirror: 'off', human: 'content' }, A)).rejects.toThrow('disk full')
    expect(g.engine).toEqual({ human: false, agents: false })
    expect(g.stored()).toBeNull()
    expect(g.host.restartSync).not.toHaveBeenCalled()
  })

  it('content -> engine: drops the v2 grant first, then gives human back to the engine; a failed engine write restores v2', async () => {
    const prev: SyncOwnershipV2 = { entryRoots: ['/x/VaultA'], mirror: 'off', human: 'content' }
    const f = fixture({ v2: prev, engine: { human: true, agents: true } })
    await f.seam.set({ entryRoots: ['/x/VaultA'], mirror: 'off', human: 'engine' }, A)
    expect(f.log.filter((x) => !x.startsWith('ensure'))).toEqual(['v2:engine', 'engine:false', 'restart'])
    expect(f.engine).toEqual({ human: false, agents: true }) // agents 那一位不动
    const g = fixture({ v2: prev, engine: { human: true, agents: true } })
    g.fetchFixture.mockImplementationOnce(async () => new Response('', { status: 500 }))
    await expect(g.seam.set({ entryRoots: ['/x/VaultA'], mirror: 'off', human: 'engine' }, A)).rejects.toThrow()
    expect(g.stored()).toEqual(prev)
  })

  it('an engine without the read-back endpoint makes a human change fail instead of guessing', async () => {
    const f = fixture({ engine: 'old' })
    await expect(f.seam.set({ entryRoots: [], mirror: 'off', human: 'content' }, A)).rejects.toThrow('engine_owner_unverifiable')
    expect(f.stored()).toBeNull()
  })

  it('a read-back that disagrees fails the handover', async () => {
    const f = fixture()
    f.fetchFixture.mockImplementation(async (input, init) => init?.method === 'PUT' ? new Response('{}') : new Response(JSON.stringify({ human: false, agents: false })))
    await expect(f.seam.set({ entryRoots: [], mirror: 'off', human: 'content' }, A)).rejects.toThrow('engine_owner_mismatch')
    expect(f.stored()).toBeNull()
  })

  it('external engine mode writes and reads the owner file directly, one bit at a time', async () => {
    const f = fixture({ mode: 'external' })
    await f.seam.set({ entryRoots: [], mirror: 'keep', human: 'content' }, A)
    expect(f.fetchFixture).not.toHaveBeenCalled()
    expect(readOfflineContentOwns(dir, A)).toEqual({ human: true, agents: false })
    setOfflineContentOwner(dir, A, true) // 老 claim:两位一起
    expect(readOfflineContentOwns(dir, A)).toEqual({ human: true, agents: true })
    await f.seam.set({ entryRoots: [], mirror: 'keep', human: 'engine' }, A)
    expect(readOfflineContentOwns(dir, A)).toEqual({ human: false, agents: true })
  })

  it('touched only notifies: no owner write, an old engine (404) is ignored, a stale account is refused', async () => {
    const f = fixture()
    await f.seam.touched(A)
    expect(f.log).toEqual(['touched'])
    expect(f.engine).toEqual({ human: false, agents: false })
    await fixture({ engine: 'old' }).seam.touched(A)
    env.account = 'https://cloud.test/api::bob'
    await expect(f.seam.touched(A)).rejects.toThrow('account_changed')
  })

  it('the legacy claim(bool) path is unchanged for old Extend builds', async () => {
    const restartSync = vi.fn(async () => {}), stopSync = vi.fn(async () => {})
    const legacy = contentSyncOwnership({ accountId: () => env.account, ensureBackend: async () => {}, backendStatus: () => ({ state: 'stopped', url: null as unknown as string }), engineToken: () => 't', loadConfig: async () => ({ mode: 'external' }), dataDir: () => dir, stopSync, restartSync })
    await legacy.claim(true, A)
    expect(readOfflineContentOwns(dir, A)).toEqual({ human: true, agents: true })
    expect(JSON.parse(readFileSync(join(dir, 'agents/.cloudsync-default.json'), 'utf8')).accounts).toMatchObject({}) // 文件照旧写在 agents/ 下
    expect(stopSync).toHaveBeenCalledOnce()
    await legacy.claim(false, A)
    expect(readOfflineContentOwns(dir, A)).toEqual({ human: false, agents: false })
    expect(restartSync).toHaveBeenCalledOnce()
  })

  it('content -> engine: an engine that saved the bit but answered 500 (its mirror step failed) is read back, not rolled back into two writers', async () => {
    const prev: SyncOwnershipV2 = { entryRoots: ['/x/VaultA'], mirror: 'off', human: 'content' }
    const f = fixture({ v2: prev, engine: { human: true, agents: true } })
    f.fetchFixture.mockImplementationOnce(async (_input, init) => { f.engine!.human = JSON.parse(String(init!.body)).human; return new Response('', { status: 500 }) })
    await f.seam.set({ ...prev, human: 'engine' }, A)
    expect(f.engine!.human).toBe(false)
    expect(f.stored()?.human).toBe('engine')
  })

  it('content -> engine: when the engine bit cannot be confirmed back, content stays stopped (v2 human stays engine) and the call fails', async () => {
    const prev: SyncOwnershipV2 = { entryRoots: ['/x/VaultA'], mirror: 'off', human: 'content' }
    const f = fixture({ v2: prev, engine: { human: true, agents: true } })
    // 引擎每次 PUT 都落了盘却回 500,GET 也读不回:宿主不知道引擎那一位是什么
    f.fetchFixture.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') f.engine!.human = JSON.parse(String(init.body)).human
      return new Response('', { status: 500 })
    })
    await expect(f.seam.set({ ...prev, human: 'engine' }, A)).rejects.toThrow()
    expect(f.stored()?.human).toBe('engine')
    expect(f.stored()?.entryRoots).toEqual(['/x/VaultA'])
    expect(f.host.restartSync).not.toHaveBeenCalled()
  })

  it('two set() calls in opposite directions run one after the other, so v2 and the engine bit always agree', async () => {
    const prev: SyncOwnershipV2 = { entryRoots: ['/x/VaultA'], mirror: 'off', human: 'content' }
    const f = fixture({ v2: prev, engine: { human: true, agents: true } })
    await Promise.all([
      f.seam.set({ ...prev, human: 'engine' }, A),
      f.seam.set({ entryRoots: ['/x/VaultA', '/x/VaultB'], mirror: 'off', human: 'content' }, A),
    ])
    expect(f.stored()?.human === 'content').toBe(f.engine!.human === true)
    expect(f.stored()).toEqual({ entryRoots: ['/x/VaultA', '/x/VaultB'], mirror: 'off', human: 'content' })
  })

  it('the legacy claim(bool) in external mode keeps the pre-step-2 file shape (owner only, never contentOwns)', () => {
    const file = join(dir, 'agents/.cloudsync-default.json')
    setOfflineContentOwner(dir, A, true)
    const on = Object.values(JSON.parse(readFileSync(file, 'utf8')).accounts)[0] as Record<string, unknown>
    expect(on).toMatchObject({ enabled: false, owner: 'content' })
    expect(on).not.toHaveProperty('contentOwns')
    setOfflineContentOwner(dir, A, false)
    const off = Object.values(JSON.parse(readFileSync(file, 'utf8')).accounts)[0] as Record<string, unknown>
    expect(off).not.toHaveProperty('owner')
    expect(off).not.toHaveProperty('contentOwns')
  })

  // ── 第 3 步 H3 定稿第 1 节:mirrorRetired(只停镜像)──
  const RETIRED: SyncOwnershipV2 = { entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine', mirrorRetired: true }
  const lastWrite = (f: ReturnType<typeof fixture>) => f.host.writeV2.mock.calls.at(-1)![1] as SyncOwnershipV2

  it('mirrorRetired: a set without the field keeps the value on disk (a rebuilt object cannot drop the retirement)', async () => {
    const f = fixture({ v2: RETIRED, engine: 'old' })
    await f.seam.set({ entryRoots: ['/x/VaultA', '/x/VaultB'], mirror: 'keep', human: 'engine' }, A)
    expect(lastWrite(f)).toEqual({ ...RETIRED, entryRoots: ['/x/VaultA', '/x/VaultB'] })
    expect(await f.seam.get(A)).toEqual({ ...RETIRED, entryRoots: ['/x/VaultA', '/x/VaultB'] })
    expect(f.host.restartSync).toHaveBeenCalledTimes(1)
  })

  it('mirrorRetired: true retires, false revokes and deletes the key; each change restarts the old engines like any set', async () => {
    const f = fixture({ v2: { entryRoots: [], mirror: 'keep', human: 'engine' }, engine: 'old' })
    await f.seam.set({ entryRoots: [], mirror: 'keep', human: 'engine', mirrorRetired: true }, A)
    expect(lastWrite(f)).toEqual({ entryRoots: [], mirror: 'keep', human: 'engine', mirrorRetired: true })
    expect((await f.seam.get(A)).mirrorRetired).toBe(true)
    await f.seam.set({ entryRoots: [], mirror: 'keep', human: 'engine', mirrorRetired: false }, A)
    expect(lastWrite(f)).not.toHaveProperty('mirrorRetired')
    expect(await f.seam.get(A)).not.toHaveProperty('mirrorRetired')
    expect(f.host.restartSync).toHaveBeenCalledTimes(2)
    expect(f.fetchFixture).not.toHaveBeenCalled() // 只动退役位不碰引擎
  })

  it('mirrorRetired: get carries it only when true on disk; a non-boolean in a set is refused', async () => {
    expect(await fixture({ v2: { entryRoots: [], mirror: 'keep', human: 'engine', mirrorRetired: false } }).seam.get(A)).not.toHaveProperty('mirrorRetired')
    expect(await fixture().seam.get(A)).not.toHaveProperty('mirrorRetired')
    expect(await fixture({ legacy: true }).seam.get(A)).not.toHaveProperty('mirrorRetired')
    const f = fixture({ v2: RETIRED })
    await expect(f.seam.set({ ...RETIRED, mirrorRetired: 'yes' as unknown as boolean }, A)).rejects.toThrow('invalid ownership')
    expect(f.host.writeV2).not.toHaveBeenCalled()
  })

  it('mirrorRetired survives the rollback when the engine bit cannot be confirmed back (content -> engine)', async () => {
    const prev: SyncOwnershipV2 = { entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'content', mirrorRetired: true }
    const f = fixture({ v2: prev, engine: { human: true, agents: true } })
    f.fetchFixture.mockImplementation(async (_input, init) => {
      if (init?.method === 'PUT') f.engine!.human = JSON.parse(String(init.body)).human
      return new Response('', { status: 500 })
    })
    await expect(f.seam.set({ entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine' }, A)).rejects.toThrow()
    expect(f.stored()).toEqual({ ...prev, human: 'engine' })
  })
})

describe('mirrorRetired: mask and persistence (H3 final interface §1)', () => {
  const A = 'https://cloud.test/api::alice'
  const cfg = { cloudSync: { enabled: true, vaultId: 'v1' }, entrySync: [entry('/x/VaultA'), entry('/x/VaultB')] }

  it('keep + mirrorRetired only adds cloudSync.mirror:false (enabled untouched); off still lands as enabled:false; unknown / legacy still mask everything', () => {
    const v2 = (over: Partial<SyncOwnershipV2>): OwnershipRead => ({ kind: 'v2', value: { entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine', ...over } })
    expect(maskAmadeusConfig(cfg, v2({}), false)).toEqual({ ...cfg, entrySync: [entry('/x/VaultB')] })
    expect(maskAmadeusConfig(cfg, v2({ mirrorRetired: true }), false)).toEqual({ cloudSync: { enabled: true, vaultId: 'v1', mirror: false }, entrySync: [entry('/x/VaultB')] })
    expect(maskAmadeusConfig(cfg, v2({ mirrorRetired: false }), false)).toEqual({ ...cfg, entrySync: [entry('/x/VaultB')] })
    expect(maskAmadeusConfig(cfg, v2({ mirror: 'off' }), false)).toEqual({ cloudSync: { enabled: false, vaultId: 'v1' }, entrySync: [entry('/x/VaultB')] })
    expect(maskAmadeusConfig(cfg, v2({ mirror: 'off', mirrorRetired: true }), false)).toEqual({ cloudSync: { enabled: false, vaultId: 'v1' }, entrySync: [entry('/x/VaultB')] })
    expect(maskAmadeusConfig(cfg, v2({ mirrorRetired: true }), true)).toEqual({ cloudSync: { enabled: false, vaultId: 'v1' }, entrySync: [] })
    expect(cfg.cloudSync).toEqual({ enabled: true, vaultId: 'v1' }) // 原配置不动
  })

  it('the strict read takes a claim with mirrorRetired (not "unknown"), refuses a non-boolean as malformed, and the write refuses it too', async () => {
    const ns = createHash('sha256').update(A).digest('hex')
    const file = join(dir, 'amadeus-config.json')
    const own = (v: unknown) => writeFileSync(file, JSON.stringify({ cloudAccounts: { [ns]: { syncOwnershipV2: { entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine', mirrorRetired: v } } } }))
    own(true)
    expect(await readSyncOwnershipV2(A)).toEqual({ entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine', mirrorRetired: true })
    own('true')
    await expect(readSyncOwnershipV2(A)).rejects.toThrow('syncOwnershipV2 is malformed')
    own(1)
    await expect(readSyncOwnershipV2(A)).rejects.toThrow('syncOwnershipV2 is malformed')
    await expect(writeSyncOwnershipV2(A, { entryRoots: [], mirror: 'keep', human: 'engine', mirrorRetired: 'yes' as unknown as boolean })).rejects.toThrow('invalid syncOwnershipV2')
    await writeSyncOwnershipV2(A, { entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine', mirrorRetired: true })
    expect(await readSyncOwnershipV2(A)).toEqual({ entryRoots: ['/x/VaultA'], mirror: 'keep', human: 'engine', mirrorRetired: true })
  })
})

describe('contentSyncOwnedStrict: the old global claim, read strictly (Codex 12b round 1, #3)', () => {
  const A = 'https://cloud.test/api::alice'
  const state = (text: string) => { mkdirSync(join(dir, 'content-sync'), { recursive: true }); writeFileSync(join(dir, 'content-sync', createHash('sha256').update(A).digest('hex') + '.json'), text) }
  it('no file = false; a boolean owned is taken as is; no owned key = false (the file Extend writes always has a boolean owned)', () => {
    expect(contentSyncOwnedStrict(A)).toBe(false)
    expect(contentSyncOwnedStrict(null)).toBe(false)
    state(JSON.stringify({ config: { revision: 1 }, owned: true, paused: false, files: {}, folders: {}, jobs: [] }))
    expect(contentSyncOwnedStrict(A)).toBe(true)
    state(JSON.stringify({ config: { revision: 1 }, owned: false, paused: false, files: {}, folders: {}, jobs: [] }))
    expect(contentSyncOwnedStrict(A)).toBe(false)
    state('{}')
    expect(contentSyncOwnedStrict(A)).toBe(false)
  })
  it('throws on an owned that is not a boolean, a top level that is not an object, or text that does not parse; the error carries no file text', () => {
    for (const text of ['{"owned":"true"}', '{"owned":1}', '{"owned":null}', 'null', '[]', '"owned"', '{"owned":tr', '{"/x/V": oops}']) {
      state(text)
      expect(() => contentSyncOwnedStrict(A), text).toThrow()
      try { contentSyncOwnedStrict(A) } catch (e) { expect(String((e as Error).message), text).not.toMatch(/owned|\/x\/V/) }
    }
  })
})

describe('readMaskedAmadeusConfig: every read the mask depends on, with fakes (H3 list item 6, Codex 12b round 1 #4)', () => {
  const cfg = { lastVault: '/x/VaultA', cloudAccountId: 'https://cloud.test/api::alice', cloudSync: { enabled: true, vaultId: 'v1' }, entrySync: [entry('/x/VaultA')] }
  const reads = (over: Partial<Parameters<typeof readMaskedAmadeusConfig>[0]> = {}) => ({
    readConfig: async () => structuredClone(cfg), looseReadFailed: () => false, readV2: async () => null, legacyOwned: () => false, ...over,
  })
  const STOPPED_KEEPING_LOCAL = { ...cfg, cloudSync: { enabled: false, vaultId: 'v1' }, entrySync: [] }

  it('nothing failed and nothing claimed: the config goes through', async () => {
    expect(await readMaskedAmadeusConfig(reads())).toEqual(cfg)
  })
  it('a config read that throws gives the stopped config instead of a rejection', async () => {
    await expect(readMaskedAmadeusConfig(reads({ readConfig: async () => { throw new Error('boom') } }))).resolves.toEqual({ cloudSync: { enabled: false }, entrySync: [] })
  })
  it('a loose read marked as failed masks everything even when the strict reads succeed', async () => {
    expect(await readMaskedAmadeusConfig(reads({ looseReadFailed: () => true }))).toEqual(STOPPED_KEEPING_LOCAL)
  })
  it('a v2 read or a legacy-claim read that throws masks everything', async () => {
    expect(await readMaskedAmadeusConfig(reads({ readV2: async () => { throw new Error('x') } }))).toEqual(STOPPED_KEEPING_LOCAL)
    expect(await readMaskedAmadeusConfig(reads({ legacyOwned: () => { throw new Error('x') } }))).toEqual(STOPPED_KEEPING_LOCAL)
  })
})
