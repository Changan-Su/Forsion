/**
 * 删除防线(2026-09-06 实翻):另一台设备的云镜像目录被清空后,它的引擎把「本地全没了」推成 50 条
 * 服务端删除(恰好 = 风暴闸上限),本机再照单把用户本地库里的真文件硬删。三条防线各钉一条:
 *  1. 增量扫描(SSE 重连/目录事件后的 scanJob)也要过计划级删除保护 —— 风暴闸只是 50/分钟限流;
 *  2. 目录读取失败(readdir 抛错)= 本轮放弃推断,不当成「文件都没了」;
 *  3. 远端删除落到本地 = 挪进 .sync-trash,不再 fs.rm。
 * 负对照(本地实跑过):把 scanJob 里的 shouldTripMassDelete 换成 false,第 1 条红(deleteFile 被调 3 次)。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

interface Entry { path: string; kind: 'page'; seq: number; hash: string; size: number }
const env = vi.hoisted(() => ({
  root: '',
  remote: [] as Entry[],
  deleted: [] as string[],
  sse: null as null | { onOpen: () => void; onChange: (d: unknown) => void },
  readdirFail: null as null | string,
  statFail: null as null | string,
  renameFail: false,
  watch: {} as Record<string, (p: string) => void>,
}))
vi.mock('electron', () => ({ app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() } }))
vi.mock('../../forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => env.root, defaultWorkspaceDir: () => env.root }))
vi.mock('../settings', () => ({
  readConfig: async () => ({ cloudSync: { vaultId: 'vault-a', deviceId: 'dev' }, cloudAccountId: 'account-a' }),
  writeConfig: vi.fn(), currentCloudAccountId: () => 'account-a', cloudAccountNamespace: () => 'account-a',
}))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: (ev: string, fn: (p: string) => void) => { env.watch[ev] = fn }, close: async () => {} }) } }))
vi.mock('./sseClient', () => ({
  startSse: (_cfg: unknown, h: { onOpen: () => void; onChange: (d: unknown) => void }) => { env.sse = h; return { stop: vi.fn() } },
}))
vi.mock('./cloudClient', () => {
  class CloudHttpError extends Error { constructor(readonly status: number, readonly body: unknown) { super(`http ${status}`) } }
  return {
    CloudHttpError,
    createCloudClient: () => ({
      clientId: 'dev',
      listVaults: async () => [{ id: 'vault-a' }],
      tree: async () => ({ entries: env.remote, folders: [], seq: 10 }),
      getFile: async (_v: string, p: string) => {
        const e = env.remote.find((x) => x.path === p)
        if (!e) throw new CloudHttpError(404, null)
        return { content: `content of ${p}`, seq: e.seq, hash: e.hash }
      },
      deleteFile: async (_v: string, p: string) => { env.deleted.push(p); env.remote = env.remote.filter((x) => x.path !== p) },
      putFile: async () => ({ seq: 1, hash: 'h' }),
      changes: async () => ({ changes: [], seq: 10 }),
    }),
  }
})

// readdir 注入:指定目录抛 EACCES(模拟权限/挂载点抖动),其余照常。
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    promises: {
      ...real.promises,
      readdir: async (dir: string, opts: unknown) => {
        if (env.readdirFail && String(dir) === env.readdirFail) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return (real.promises.readdir as (d: string, o: unknown) => Promise<unknown>)(dir, opts)
      },
      stat: async (p: string, opts?: unknown) => {
        if (env.statFail && String(p) === env.statFail) throw Object.assign(new Error('EIO'), { code: 'EIO' })
        return (real.promises.stat as (p: string, o?: unknown) => Promise<unknown>)(p, opts)
      },
      rename: async (a: string, b: string) => {
        if (env.renameFail && String(b).includes('.sync-trash')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return real.promises.rename(a, b)
      },
    },
  }
})

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60))
let stop: (() => unknown) | undefined

beforeEach(async () => {
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-massdel-'))
  env.remote = []
  env.deleted = []
  env.sse = null
  env.readdirFail = null
  env.statFail = null
  env.renameFail = false
  env.watch = {}
})
afterEach(async () => { await stop?.(); await fs.rm(env.root, { recursive: true, force: true }) })

/** 起一个 own 镜像引擎,让它把 remote 全拉下来(shadow 跟踪全部文件)。 */
async function bootMirror(files: string[]): Promise<{ engine: { stop: () => Promise<void>; restart: () => Promise<unknown>; getStatus: () => { pendingDeletions: number; state: string } }; mirror: string }> {
  const mirror = path.join(env.root, 'mirror')
  env.remote = files.map((p, i) => ({ path: p, kind: 'page', seq: i + 1, hash: sha(`content of ${p}`), size: 10 }))
  const { createSyncEngine } = await import('./engine')
  const engine = createSyncEngine({ loadCreds: () => ({ cloudUrl: 'https://cloud.example', token: 'a' }), onStatus: () => {} }, {
    localRoot: mirror, shadowName: 'mirror-shadow', vaultId: 'first', serverDir: '',
  })
  stop = () => engine.stop()
  await engine.restart()
  await settle()
  for (const p of files) expect(await fs.readFile(path.join(mirror, p), 'utf8')).toBe(`content of ${p}`)
  return { engine, mirror }
}

it('镜像目录被清空后,SSE 重连触发的增量扫描不得分批删云端:过阈值全部记待确认', async () => {
  const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md']
  const { engine, mirror } = await bootMirror(files)
  for (const p of files) await fs.rm(path.join(mirror, p))
  env.sse!.onOpen() // 断线重连 → scanJob(以前:逐条 reconcileLocal → pushDelete,50 条以内全放行)
  await settle()
  expect(env.deleted).toEqual([])
  expect(engine.getStatus().pendingDeletions).toBe(files.length)
})

it('只删少数几个文件照常推删除(不误伤正常删除)', async () => {
  const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md', 'i.md', 'j.md']
  const { engine, mirror } = await bootMirror(files)
  await fs.rm(path.join(mirror, 'a.md'))
  await fs.rm(path.join(mirror, 'b.md'))
  env.sse!.onOpen()
  await settle()
  expect(env.deleted.sort()).toEqual(['a.md', 'b.md'])
  expect(engine.getStatus().pendingDeletions).toBe(0)
})

it('目录读取失败 = 本轮放弃推断,不把读不到的文件当成本地已删', async () => {
  const files = ['sub/x.md', 'sub/y.md', 'sub/z.md', 'top.md']
  const { engine, mirror } = await bootMirror(files)
  env.readdirFail = path.join(mirror, 'sub') // 子树读不到(小子树本来够不到计划级阈值)
  env.sse!.onOpen()
  await settle()
  expect(env.deleted).toEqual([])
  expect(engine.getStatus().state).toBe('error')
})

it('远端删除落到本地 = 挪进 .sync-trash 而不是硬删', async () => {
  const files = ['keep.md', 'gone.md']
  const { mirror } = await bootMirror(files)
  env.remote = env.remote.filter((e) => e.path !== 'gone.md')
  env.sse!.onChange({ seq: 11, type: 'page', op: 'delete', path: 'gone.md', newPath: null, fileSeq: 2, origin: { client: 'other', actor: 'user' } })
  await settle()
  await expect(fs.access(path.join(mirror, 'gone.md'))).rejects.toThrow()
  const day = new Date().toISOString().slice(0, 10)
  expect(await fs.readFile(path.join(mirror, '.sync-trash', day, 'gone.md'), 'utf8')).toBe('content of gone.md')
  expect(await fs.readFile(path.join(mirror, 'keep.md'), 'utf8')).toBe('content of keep.md')
})

const sseDelete = (p: string, seq: number): void => {
  env.remote = env.remote.filter((e) => e.path !== p)
  env.sse!.onChange({ seq, type: 'page', op: 'delete', path: p, newPath: null, fileSeq: 1, origin: { client: 'other', actor: 'user' } })
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── Codex 终审补的五条(2026-09-07)────────────────────────────────────────────

it('watcher 逐条 unlink(整目录被清空的真实路径)也过计划级阈值:一条都不推', async () => {
  const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md', 'i.md', 'j.md']
  const { engine, mirror } = await bootMirror(files)
  for (const p of files.slice(0, 6)) { await fs.rm(path.join(mirror, p)); env.watch.unlink!(path.join(mirror, p)) }
  await wait(2_800) // SCAN_DEBOUNCE_MS=2500:unlink 不再逐条 reconcileLocal,而是并进一次扫描
  expect(env.deleted).toEqual([])
  expect(engine.getStatus().pendingDeletions).toBe(6)
}, 10_000)

it('watcher 少量 unlink 照常推删除(改走扫描没有吞掉正常删除)', async () => {
  const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md', 'i.md', 'j.md']
  const { mirror } = await bootMirror(files)
  await fs.rm(path.join(mirror, 'a.md')); env.watch.unlink!(path.join(mirror, 'a.md'))
  await wait(2_800)
  expect(env.deleted).toEqual(['a.md'])
}, 10_000)

it('待确认是粘性的:放回 1 个后剩下的不因低于阈值被放行;全放回才解除,之后正常删除照常', async () => {
  const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md', 'i.md', 'j.md']
  const { engine, mirror } = await bootMirror(files)
  for (const p of files.slice(0, 6)) await fs.rm(path.join(mirror, p))
  env.sse!.onOpen(); await settle()
  expect(engine.getStatus().pendingDeletions).toBe(6)
  for (const p of ['a.md', 'b.md']) await fs.writeFile(path.join(mirror, p), `content of ${p}`)
  env.sse!.onOpen(); await settle()
  expect(env.deleted).toEqual([]) // 剩 4 个 < 阈值(10 的一半),以前这里会直接删云端
  expect(engine.getStatus().pendingDeletions).toBe(4)
  for (const p of ['c.md', 'd.md', 'e.md', 'f.md']) await fs.writeFile(path.join(mirror, p), `content of ${p}`)
  env.sse!.onOpen(); await settle()
  expect(engine.getStatus().pendingDeletions).toBe(0)
  await fs.rm(path.join(mirror, 'j.md'))
  env.sse!.onOpen(); await settle()
  expect(env.deleted).toEqual(['j.md']) // 闩已解除:单个删除正常传播
})

it('own 镜像根被挪走后重启:shadow 非空 → error 态,不造空根、不删云端', async () => {
  const files = ['a.md', 'b.md', 'c.md']
  const { engine, mirror } = await bootMirror(files)
  await engine.stop()
  await fs.rm(mirror, { recursive: true, force: true })
  await engine.restart(); await settle()
  expect(engine.getStatus().state).toBe('error')
  await expect(fs.access(mirror)).rejects.toThrow() // 以前 initialize 无条件 mkdir 空根
  expect(env.deleted).toEqual([])
})

it('软删归档失败(rename EACCES)不退化成硬删:本地文件与 shadow 都留着', async () => {
  const { engine, mirror } = await bootMirror(['keep.md', 'gone.md'])
  env.renameFail = true
  sseDelete('gone.md', 11); await settle()
  expect(await fs.readFile(path.join(mirror, 'gone.md'), 'utf8')).toBe('content of gone.md')
  expect(['error', 'offline']).toContain(engine.getStatus().state) // job 失败进重试态(错误归类走既有 isNetworkErr),绝不是 idle
  env.renameFail = false
  await engine.restart(); await settle() // shadow 还跟踪着它 → 重试时按远端删除归档,而不是当新文件重新上传
  await expect(fs.access(path.join(mirror, 'gone.md'))).rejects.toThrow()
  const day = new Date().toISOString().slice(0, 10)
  expect(await fs.readFile(path.join(mirror, '.sync-trash', day, 'gone.md'), 'utf8')).toBe('content of gone.md')
})

it('待确认名单跨重启粘性:restart 后低于阈值的残余照样等确认(shadow.pending)', async () => {
  const files = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md', 'i.md', 'j.md']
  const { engine, mirror } = await bootMirror(files)
  for (const p of files.slice(0, 6)) await fs.rm(path.join(mirror, p))
  env.sse!.onOpen(); await settle()
  for (const p of ['a.md', 'b.md']) await fs.writeFile(path.join(mirror, p), `content of ${p}`)
  env.sse!.onOpen(); await settle()
  expect(engine.getStatus().pendingDeletions).toBe(4)
  await engine.restart(); await settle() // 以前:initialize 清空名单 → 首轮全量对账 4 < 阈值 → 直接删云端
  expect(env.deleted).toEqual([])
  expect(engine.getStatus().pendingDeletions).toBe(4)
})

it('单文件 stat 出错(EIO)≠ 不存在:本轮不推断删除', async () => {
  const files = ['a.md', 'b.md', 'c.md']
  const { engine, mirror } = await bootMirror(files)
  env.statFail = path.join(mirror, 'a.md')
  env.sse!.onOpen(); await settle()
  expect(env.deleted).toEqual([])
  expect(engine.getStatus().state).toBe('error')
})

it('服务端路径含忽略段(.sync-trash/x.md)两向都不参与:不拉下来、也不反手删云端', async () => {
  const { engine, mirror } = await bootMirror(['a.md'])
  env.remote.push({ path: '.sync-trash/x.md', kind: 'page', seq: 9, hash: sha('content of .sync-trash/x.md'), size: 10 })
  await engine.restart(); await settle() // 全量对账
  await expect(fs.access(path.join(mirror, '.sync-trash', 'x.md'))).rejects.toThrow()
  env.sse!.onOpen(); await settle()
  expect(env.deleted).toEqual([])
  expect(env.remote.some((e) => e.path === '.sync-trash/x.md')).toBe(true)
})
