// @vitest-environment happy-dom
// 同步总开关(syncSetup):笔记库开的时候分不分第二台电脑、三个按钮各做什么、首登卡片该不该弹。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.fn()
vi.mock('./backendService', () => ({ request: (...a: unknown[]) => request(...a) }))
vi.mock('./engine/targets', () => ({ homeTarget: () => ({ key: 'home' }) }))
vi.mock('../amadeus/plugins/pluginStore', () => ({
  usePluginStore: Object.assign(() => null, { getState: () => ({ plugins: [{ id: 'a', syncData: true }, { id: 'b' }], disabledIds: [] }), subscribe: () => () => {} }),
  pluginWanted: () => true,
}))

type Cfg = { backend: string; penzor?: { vault?: string }; intervalMin?: number; syncOnStart?: boolean; direction?: string }
let cfg: Cfg
let plan: Array<{ key: string; kind: string; same?: true }>
let cloudVaults: Array<{ vault: string; files: number; bytes: number; device: string }>
const rs = {
  get: vi.fn(async () => ({ config: cfg, running: false, lastReport: null, progress: null, root: '/v/我的笔记', rootError: null, backends: ['penzor'] })),
  set: vi.fn(async (p: Partial<Cfg>) => { cfg = { ...cfg, ...p }; return cfg }),
  run: vi.fn(async (o?: { dryRun?: boolean }) => ({ ok: true, plan: o?.dryRun ? plan : undefined, errors: [], pushed: 0, pulled: 0, conflicts: 0, skippedLarge: [], finishedAt: 1 })),
  rootStats: vi.fn(async () => ({ files: 23, bytes: 412 * 1024 ** 2, name: '我的笔记' })),
  adoptRemote: vi.fn(async () => ({ ok: true, moved: 3, backupDir: '/v/我的笔记 同步前备份 2026-10-20' })),
  onStatus: vi.fn(() => () => {}),
}

async function fresh() {
  vi.resetModules()
  return import('./syncSetup')
}

beforeEach(() => {
  localStorage.clear()
  cfg = { backend: 'off', intervalMin: 0 }
  plan = []
  cloudVaults = []
  request.mockReset().mockResolvedValue({ enabled: null, agents: 2 })
  for (const f of Object.values(rs)) f.mockClear()
  ;(window as any).remoteSync = rs
  ;(window as any).tangu = {
    authStatus: async () => ({ loggedIn: true, accountId: 'https://c::u1', username: 'lin' }),
    onAuthChanged: () => () => {},
    cloudFetch: async ({ path }: { path: string }) => (path === '/remotesync/vaults' ? { status: 200, json: { vaults: cloudVaults, maxBytes: 2 * 1024 ** 3 } } : { status: 404 }),
    getConfig: async () => ({}),
    setConfig: vi.fn(async () => ({})),
  }
})

describe('notes vault switch', () => {
  it('first computer: turns on penzor/default with the schedule and starts a sync', async () => {
    const s = await fresh()
    await s.refreshSync()
    expect((await s.setSync('notes', true)).ok).toBe(true)
    expect(cfg).toMatchObject({ backend: 'penzor', penzor: { vault: 'default' }, intervalMin: 5, syncOnStart: true, direction: 'both' })
    expect(rs.run).toHaveBeenCalledWith()
    expect(s.getSync()?.notes.pending).toBeNull()
  })

  it('second computer with different files: stays off and asks', async () => {
    cloudVaults = [{ vault: 'default', files: 4812, bytes: 1_060_000_000, device: 'MacBook Pro' }]
    plan = [{ key: 'a.md', kind: 'push' }, { key: 'b.md', kind: 'conflict' }, { key: 'c.md', kind: 'pull' }]
    const s = await fresh()
    await s.refreshSync()
    await s.setSync('notes', true)
    expect(cfg.backend).toBe('off')
    expect(rs.run).not.toHaveBeenCalledWith()
    expect(s.getSync()?.notes.pending).toEqual({ cloudFiles: 4812, cloudBytes: 1_060_000_000, cloudDevice: 'MacBook Pro', localOnly: 1, conflicts: 1 })
  })

  it('new computer: same-name files count as different unless the content hash matched', async () => {
    cloudVaults = [{ vault: 'default', files: 3, bytes: 1, device: 'iMac' }]
    plan = [{ key: '欢迎.md', kind: 'join', same: true }, { key: 'a.md', kind: 'join' }]
    const s = await fresh()
    await s.refreshSync()
    await s.setSync('notes', true)
    expect(cfg.backend).toBe('off')
    expect(s.getSync()?.notes.pending).toMatchObject({ localOnly: 0, conflicts: 1 })
  })

  it('new computer whose only shared files are identical: just turns on', async () => {
    cloudVaults = [{ vault: 'default', files: 3, bytes: 1, device: 'iMac' }]
    plan = [{ key: '欢迎.md', kind: 'join', same: true }, { key: 'c.md', kind: 'pull' }]
    const s = await fresh()
    await s.refreshSync()
    await s.setSync('notes', true)
    expect(cfg.backend).toBe('penzor')
  })

  it('second computer with nothing different: just turns on', async () => {
    cloudVaults = [{ vault: 'default', files: 10, bytes: 1, device: 'iMac' }]
    plan = [{ key: 'c.md', kind: 'pull' }]
    const s = await fresh()
    await s.refreshSync()
    await s.setSync('notes', true)
    expect(cfg.backend).toBe('penzor')
    expect(s.getSync()?.notes.pending).toBeNull()
  })

  it('use cloud copy moves this computer\'s differing files first, then syncs', async () => {
    cloudVaults = [{ vault: 'default', files: 4812, bytes: 1, device: 'MacBook Pro' }]
    plan = [{ key: 'a.md', kind: 'push' }]
    const s = await fresh()
    await s.refreshSync()
    await s.setSync('notes', true)
    expect((await s.resolveNotes('cloud', 'Before sync backup')).ok).toBe(true)
    expect(rs.adoptRemote).toHaveBeenCalledWith('Before sync backup')
    expect(cfg).toMatchObject({ backend: 'penzor', intervalMin: 5 })
    expect(s.getSync()?.notes.pending).toBeNull()
  })

  it('a failed move leaves sync off and keeps asking', async () => {
    cloudVaults = [{ vault: 'default', files: 1, bytes: 1, device: 'x' }]
    plan = [{ key: 'a.md', kind: 'push' }]
    rs.adoptRemote.mockResolvedValueOnce({ ok: false, moved: 1, error: 'EACCES' } as never)
    const s = await fresh()
    await s.refreshSync()
    await s.setSync('notes', true)
    expect((await s.resolveNotes('cloud', 'b')).ok).toBe(false)
    expect(cfg.backend).toBe('off')
    expect(s.getSync()?.notes.pending).not.toBeNull()
  })

  it('skip clears the question and leaves the vault off', async () => {
    cloudVaults = [{ vault: 'default', files: 1, bytes: 1, device: 'x' }]
    plan = [{ key: 'a.md', kind: 'push' }]
    const s = await fresh()
    await s.refreshSync()
    await s.setSync('notes', true)
    await s.resolveNotes('skip', 'b')
    expect(cfg.backend).toBe('off')
    expect(s.getSync()?.notes.pending).toBeNull()
  })

  it('cloud list unreachable: stays off instead of guessing it is the first computer', async () => {
    ;(window as any).tangu.cloudFetch = async () => ({ status: 503 })
    const s = await fresh()
    await s.refreshSync()
    expect((await s.setSync('notes', true)).ok).toBe(false)
    expect(cfg.backend).toBe('off')
    expect(rs.run).not.toHaveBeenCalled()
  })

  it('without Forsion Extend the vault cannot be turned on', async () => {
    rs.get.mockResolvedValueOnce({ config: cfg, running: false, lastReport: null, progress: null, root: '/v', rootError: null, backends: [] } as never)
    const s = await fresh()
    await s.refreshSync()
    rs.get.mockResolvedValueOnce({ config: cfg, running: false, lastReport: null, progress: null, root: '/v', rootError: null, backends: [] } as never)
    expect((await s.setSync('notes', true)).ok).toBe(false)
    expect(cfg.backend).toBe('off')
  })
})

describe('agents and plugins', () => {
  it('agents writes the engine account switch and the old desktop flag', async () => {
    const s = await fresh()
    await s.setSync('agents', true)
    expect(request).toHaveBeenCalledWith({ key: 'home' }, '/agent/sync/default', { method: 'PUT', body: JSON.stringify({ enabled: true }) })
    expect((window as any).tangu.setConfig).toHaveBeenCalledWith(expect.objectContaining({ forsionSyncEnabled: true }))
  })

  it('plugins is one switch for all plugins on this device', async () => {
    const s = await fresh()
    await s.setSync('plugins', false)
    expect(localStorage.getItem('forsion.pluginSync.off')).toBe('1')
    expect(s.getSync()?.plugins).toEqual({ on: false, count: 1 })
    await s.setSync('plugins', true)
    expect(localStorage.getItem('forsion.pluginSync.off')).toBeNull()
  })
})

describe('first sign-in card', () => {
  it('choices are applied and remembered per account; an unchecked row is turned off', async () => {
    const s = await fresh()
    await s.applySyncChoices({ notes: true, agents: false, plugins: true })
    expect(cfg.backend).toBe('penzor')
    expect(request).toHaveBeenCalledWith({ key: 'home' }, '/agent/sync/default', { method: 'PUT', body: JSON.stringify({ enabled: false }) })
    expect(localStorage.getItem('forsion.sync.decided.https://c::u1')).toBe('1')
    expect(s.getSync()?.decided).toBe(true)
  })

  it('unchecking notes turns Penzor sync off but leaves a self-configured backend alone', async () => {
    cfg = { backend: 'penzor', penzor: { vault: 'default' }, intervalMin: 5 }
    let s = await fresh()
    await s.applySyncChoices({ notes: false, agents: true, plugins: true })
    expect(cfg.backend).toBe('off')
    cfg = { backend: 'webdav', intervalMin: 5 }
    s = await fresh()
    await s.applySyncChoices({ notes: false, agents: true, plugins: true })
    expect(cfg.backend).toBe('webdav')
  })

  it('stops when the account changes partway and does not mark the new account decided', async () => {
    const s = await fresh()
    await s.refreshSync()
    let n = 0
    ;(window as any).tangu.authStatus = async () => (n++ ? { loggedIn: true, accountId: 'https://c::u2' } : { loggedIn: true, accountId: 'https://c::u1' })
    const out = await s.applySyncChoices({ notes: true, agents: true, plugins: true })
    expect(out.at(-1)).toEqual({ ok: false, error: 'account-changed' })
    expect(cfg.backend).toBe('off')
    expect(localStorage.getItem('forsion.sync.decided.https://c::u2')).toBeNull()
  })

  it('an account switch while the notes step waits on the cloud leaves sync off', async () => {
    const s = await fresh()
    await s.refreshSync()
    const realFetch = (window as any).tangu.cloudFetch
    ;(window as any).tangu.cloudFetch = async (o: { path: string }) => {
      // 只在智库那步(已经配上 penzor、正等云端列表)时换号,前两步的刷新照常
      if (cfg.backend === 'penzor') (window as any).tangu.authStatus = async () => ({ loggedIn: true, accountId: 'https://c::u2' })
      return realFetch(o)
    }
    const out = await s.applySyncChoices({ notes: true, agents: false, plugins: true })
    expect(out.at(-1)).toEqual({ ok: false, error: 'account-changed' })
    expect(cfg.backend).toBe('off')
    expect(rs.run).not.toHaveBeenCalledWith()
  })

  it('shows only for a signed-in, undecided account after onboarding, unless everything is already on', async () => {
    const s = await fresh()
    const { wantsSyncCard } = s
    await s.refreshSync()
    const snap = s.getSync()!
    expect(wantsSyncCard(snap, true)).toBe(true)
    expect(wantsSyncCard(snap, false)).toBe(false)
    expect(wantsSyncCard({ ...snap, decided: true }, true)).toBe(false)
    expect(wantsSyncCard({ ...snap, signedIn: false }, true)).toBe(false)
    expect(wantsSyncCard({ ...snap, notes: { ...snap.notes, on: true }, agents: { on: true, count: 2 }, plugins: { on: true, count: 1 } }, true)).toBe(false)
  })
})

it('unified storage is notice-only, cached per account, and never blocks starting sync', async () => {
  const fetch = (window as any).tangu.cloudFetch
  const cloud = vi.fn(async (o: { path: string }) => o.path === '/storage/ledger' ? { status: 200, json: {
    schemaVersion: 1, complete: true, usage: { usedBytes: 100 }, quota: { limitBytes: 1 }, asOf: '2026-10-21T00:00:00Z',
  } } : fetch(o))
  ;(window as any).tangu.cloudFetch = cloud
  const s = await fresh(); await s.refreshSync(); await s.refreshSync()
  expect(s.getSync()?.storage).toMatchObject({ usedBytes: 100, limitBytes: 1, complete: true })
  expect(cloud.mock.calls.filter(c => c[0].path === '/storage/ledger')).toHaveLength(1)
  expect((await s.setSync('notes', true)).ok).toBe(true)
  ;(window as any).tangu.authStatus = async () => ({ loggedIn: true, accountId: 'other' })
  await s.refreshSync()
  expect(cloud.mock.calls.filter(c => c[0].path === '/storage/ledger')).toHaveLength(2)
})

it('enforced unified storage is displayed but does not turn off download-capable sync', async () => {
 const fetch=(window as any).tangu.cloudFetch;
 (window as any).tangu.cloudFetch=async(o:{path:string})=>o.path==='/storage/ledger'?{status:200,json:{schemaVersion:1,complete:true,enforcement:true,usage:{usedBytes:200},quota:{limitBytes:100},asOf:'2026-10-21T00:00:00Z'}}:fetch(o);
 const s=await fresh();await s.refreshSync();expect(s.getSync()?.storage?.enforcement).toBe(true);
 expect((await s.setSync('notes',true)).ok).toBe(true);
});
