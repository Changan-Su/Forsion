/**
 * 智库同步第 2 步 H 包:认领按库根(契约 §3.7、实现期修订 H-1 第 5 条)。
 * - readConfig 遮罩:有 syncOwnershipV2 只滤掉接手的根(符号链接、尾斜杠、大小写都认成同一个);老的全局认领 / 配置读不了 = 整份遮掉;
 * - ownership.set:human 没变不碰引擎;engine→content 先改引擎位并读回再落盘,content→engine 反过来;中途失败回滚;老引擎读不回就抛;
 * - syncOwnershipV2 落盘:读坏的配置不当成「没认领」,也不被这一写盖掉;别的账号、条目同步注册表原样留着。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ userData: '', account: 'https://cloud.test/api::alice' as string | null }))
vi.mock('electron', () => ({ app: { getPath: () => env.userData } }))
vi.mock('./forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => env.userData }))
vi.mock('./forsionAuth', () => ({ loadTanguCreds: () => ({ cloudUrl: 'https://cloud.test/api', token: '' }) }))
vi.mock('../shared/forsionAccount', () => ({ forsionAccountId: () => env.account }))
vi.mock('./amadeus/fs/vaultHandlers', () => ({ withTextWriteLock: async (_p: string, fn: () => Promise<void>) => fn() }))

import { canonRoot, contentSyncOwnership, contentSyncOwnershipV2, maskAmadeusConfig, readOfflineContentOwns, setOfflineContentOwner, type OwnershipRead } from './contentSyncHost'
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
})
