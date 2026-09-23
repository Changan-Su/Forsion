/**
 * 推送合并(schedulePush)。背景:编辑器每个 400ms 停顿就存一次盘,推送又是整份 PUT —— 生产 shadow 里一篇
 * 25KB 笔记的 seq 到了 3119(= 被整份重传 3119 次)。八条各钉一件事:
 *  1. 同一次存盘的两个入口(VaultManager 写钩子 + chokidar)与连续多次存盘 → 恰好 1 次 PUT,内容是最新的;
 *     静默期间对外**广播**「同步中 · 1 项」(状态栏是用户判断「传上去没」的唯一依据);
 *  2. 连续输入到不了静默窗口 → 最长等待兜底,中途也得推(纯尾沿防抖 = 打字十分钟零上传);
 *  3. 防抖中 stop():定时器丢弃、停后不偷跑;下次启动的全量对账把它补推上去(不丢稿的依据);
 *  4. 大文件窗口更长;
 *  5. 写事件等防抖的工夫文件没了 → 写触发的对账绝不自己发删除,交回扫描路径:5 个已跟踪文件被改写后整目录
 *     消失,一条 deleteFile 都不许发,5 条全进待确认(逐条 pushDelete 只受 50/分钟限流 —— 09-06 事故的洞);
 *  6. 推送在途时又存了一版、随后 stop:基线的 stat 必须属于**被推的那版**,重启后才会把后一版补推
 *     (Codex 评审钉出:原先推送返回后才 stat,记下「旧 hash + 新 stat」→ 快路径信了 stat → 后一版永不上云)。
 *  7. 拉取落地:current() 必须是 rename 前的最后一道闸 —— 引擎给临时文件取 stat 的工夫来了结构性移动,不许再覆盖目标
 *     (Codex 二轮钉出:我把取 stat 的 await 插在了 current() 与 rename 之间);
 *  8. 自愈:内容与基线一致、只是 stat 对不上(被 touch / 基线记的是不可信 stat)→ 对账顺手刷新,不再每轮重算 hash。
 *  9. 基线回声:别的设备把我们的基线**原样**重写(seq 动了、字节没动)而本机正在改 → 不出冲突副本、不盖本地,
 *     只把基线 seq 跟上、按新 seq 推本地(09-22 实报:另一台桌面端两次回写同一篇笔记,打字这台多出两份副本);
 * 10. 回声后的基线 stat 必须记成不可信:那次推送若没成(网络错)随后 stop,重启的全量对账不许信 stat 走快路径,
 *     得重算 hash 把本地这版补推上去(记成本地新字节的 stat 配基线 hash = 本地这版永不上云)。
 * 负对照(09-20/21 本地逐条实跑,改完用 cp 备份复原)见 docs/Log 同日条目。
 * 时序口径:真定时器(同目录其余台架同款)。QUIET 远大于相邻两步之间可能的卡顿,断言只依赖「定时器按到期先后触发」。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

interface Entry { path: string; kind: 'page'; seq: number; hash: string; size: number }
interface Status { state: string; pending: number; pendingDeletions: number }
const env = vi.hoisted(() => ({
  root: '',
  remote: [] as Entry[],
  puts: [] as Array<{ path: string; content: string }>,
  putsStarted: 0,
  putGate: null as null | Promise<void>, // 非空:putFile 卡在这里(模拟在途请求)
  putSeqs: [] as number[], // 每次 PUT 带的 baseSeq(CAS 语义:mock 与真服务端一样按它 409)
  putError: null as null | Error, // 非空:putFile 抛它(模拟网络错,直到清空)
  deleted: [] as string[],
  watch: {} as Record<string, (p: string) => void>,
  remoteContent: {} as Record<string, string>,
  sse: null as null | { onChange: (d: unknown) => void },
  onTmpStat: null as null | (() => void), // 引擎给 atomicWrite 的临时文件取 stat 的那一刻触发一次
  tmpStatHits: 0,
}))
vi.mock('electron', () => ({ app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() } }))
vi.mock('../../forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => env.root, defaultWorkspaceDir: () => env.root }))
vi.mock('../settings', () => ({
  readConfig: async () => ({ cloudSync: { vaultId: 'vault-a', deviceId: 'dev' }, cloudAccountId: 'account-a' }),
  writeConfig: vi.fn(), currentCloudAccountId: () => 'account-a', cloudAccountNamespace: () => 'account-a',
}))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: (ev: string, fn: (p: string) => void) => { env.watch[ev] = fn }, close: async () => {} }) } }))
vi.mock('./sseClient', () => ({ startSse: (_cfg: unknown, h: { onChange: (d: unknown) => void }) => { env.sse = h; return { stop: vi.fn() } } }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    promises: {
      ...real.promises,
      stat: async (p: string, opts?: unknown) => {
        if (String(p).includes('.tmp-')) {
          env.tmpStatHits++
          const hook = env.onTmpStat
          env.onTmpStat = null
          hook?.()
        }
        return (real.promises.stat as (p: string, o?: unknown) => Promise<unknown>)(p, opts)
      },
    },
  }
})
// 假服务端记住每次 PUT(tree 回填 seq/hash):重启后的全量对账才会判成「本地改了、远端没动 → push」,
// 而不是 remote=null 的「编辑胜删除」分支。
vi.mock('./cloudClient', async () => {
  const { createHash } = await import('node:crypto')
  class CloudHttpError extends Error { constructor(readonly status: number, readonly body: unknown) { super(`http ${status}`) } }
  return {
    CloudHttpError,
    createCloudClient: () => ({
      clientId: 'dev',
      listVaults: async () => [{ id: 'vault-a' }],
      tree: async () => ({ entries: env.remote, folders: [], seq: env.remote.length }),
      changes: async () => ({ changes: [], seq: 0 }),
      getFile: async (_v: string, p: string) => {
        const e = env.remote.find((x) => x.path === p)
        if (!e) throw new CloudHttpError(404, null)
        return { content: env.remoteContent[p] ?? '', seq: e.seq, hash: e.hash }
      },
      deleteFile: async (_v: string, p: string) => { env.deleted.push(p); env.remote = env.remote.filter((e) => e.path !== p) },
      putFile: async (_v: string, p: string, content: string, baseSeq: number) => {
        env.putsStarted++
        if (env.putGate) await env.putGate
        if (env.putError) throw env.putError
        // CAS 与真服务端同款(Codex 09-22 评审:mock 丢掉 baseSeq 的话,错用旧 seq 推也能绿)
        const cur = env.remote.find((e) => e.path === p)
        if (cur && baseSeq === 0) throw new CloudHttpError(409, { code: 'EXISTS', seq: cur.seq, content: env.remoteContent[p] ?? null })
        if (cur && baseSeq !== cur.seq) throw new CloudHttpError(409, { code: 'CONFLICT', seq: cur.seq, content: env.remoteContent[p] ?? null })
        if (!cur && baseSeq !== 0) throw new CloudHttpError(409, { code: 'CONFLICT', seq: 0, content: null })
        env.puts.push({ path: p, content })
        env.putSeqs.push(baseSeq)
        const seq = (cur?.seq ?? 0) + 1
        const hash = createHash('sha256').update(content).digest('hex')
        env.remote = [...env.remote.filter((e) => e.path !== p), { path: p, kind: 'page', seq, hash, size: Buffer.byteLength(content) }]
        env.remoteContent[p] = content
        return { seq, hash }
      },
    }),
  }
})

const QUIET = 150 // 注入的静默窗口;最长等待 = ×5,大文件 = ×5
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let stop: (() => unknown) | undefined

beforeEach(async () => {
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-pushdebounce-'))
  env.remote = []
  env.puts = []
  env.putsStarted = 0
  env.putGate = null
  env.putSeqs = []
  env.putError = null
  env.deleted = []
  env.watch = {}
  env.remoteContent = {}
  env.sse = null
  env.onTmpStat = null
  env.tmpStatHits = 0
})
afterEach(async () => { await stop?.(); await fs.rm(env.root, { recursive: true, force: true }) })

async function boot(quietMs = QUIET) {
  const mirror = path.join(env.root, 'mirror') // 与 shadow json(userData = env.root)分开,免得 shadow 被当库文件推
  await fs.mkdir(mirror, { recursive: true })
  const statuses: Status[] = []
  const { createSyncEngine } = await import('./engine')
  const engine = createSyncEngine({ loadCreds: () => ({ cloudUrl: 'https://cloud.example', token: 't' }), onStatus: (s: Status) => { statuses.push(s) } }, {
    localRoot: mirror, shadowName: 'push-shadow', vaultId: 'first', serverDir: '', pushQuietMs: quietMs,
  })
  stop = () => engine.stop()
  await engine.restart()
  await vi.waitFor(() => expect(engine.getStatus().state).toBe('idle'))
  return { engine, mirror, statuses }
}

/** 写一版并等它推完、基线落定。 */
async function pushed(engine: { notifyLocal: (rel: string, kind: 'write') => void; getStatus: () => Status }, file: string, rel: string, content: string): Promise<void> {
  const before = env.puts.length
  await fs.writeFile(file, content)
  engine.notifyLocal(rel, 'write')
  await vi.waitFor(() => expect(env.puts.length).toBe(before + 1), { timeout: 3000 })
  await vi.waitFor(() => expect(engine.getStatus().state).toBe('idle'))
}

it('一阵连续存盘(写钩子 + chokidar 双入口)只推 1 次,推的是最新内容;静默期间对外广播同步中', async () => {
  // 窗口取 600ms:状态广播自带 200ms 节流,要在静默期内看得到它。
  const { engine, mirror, statuses } = await boot(600)
  const file = path.join(mirror, 'A.md')
  // 先让开机那次(200ms 节流的)状态广播落地,再只看此后的新广播 —— 否则它恰好在写入之后才触发,
  // 替 schedulePush 把「同步中」报了出去:去掉 schedulePush 里的 emitStatus 本条照样绿(09-21 负对照实跑抓到的假绿)。
  await sleep(300)
  const seen = statuses.length
  for (const v of ['v1', 'v2', 'v3']) {
    await fs.writeFile(file, v)
    engine.notifyLocal('A.md', 'write') // VaultManager 写钩子
    env.watch.change?.(file) // chokidar:同一次存盘的第二个入口
  }
  await vi.waitFor(() => expect(statuses.slice(seen).at(-1)).toMatchObject({ state: 'syncing', pending: 1 }), { timeout: 500 })
  expect(env.puts).toEqual([]) // 广播出「同步中」的时候,一个字节都还没发
  await vi.waitFor(() => expect(env.puts).toEqual([{ path: 'A.md', content: 'v3' }]), { timeout: 3000 })
  await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ state: 'idle', pending: 0 }))
  await sleep(700)
  expect(env.puts).toHaveLength(1)
})

it('连续输入到不了静默窗口:最长等待兜底,中途就得推;收尾再推一次最终内容', async () => {
  const { engine, mirror } = await boot()
  const file = path.join(mirror, 'A.md')
  let last = ''
  let saves = 0
  const until = Date.now() + QUIET * 9 // 最长等待 = QUIET×5,落在这阵输入的中段
  while (Date.now() < until) {
    last = `draft ${++saves}`
    await fs.writeFile(file, last)
    engine.notifyLocal('A.md', 'write')
    await sleep(QUIET / 5)
  }
  expect(env.puts.length).toBeGreaterThanOrEqual(1) // 纯尾沿防抖这里是 0
  await vi.waitFor(() => expect(env.puts.at(-1)).toEqual({ path: 'A.md', content: last }), { timeout: 3000 })
  expect(saves).toBeGreaterThan(15)
  expect(env.puts.length).toBeLessThan(saves / 3) // 而不是每次存盘一推
})

it('防抖中 stop():定时器丢弃、停后不偷跑;下次启动的全量对账补推', async () => {
  const { engine, mirror } = await boot()
  const file = path.join(mirror, 'A.md')
  await pushed(engine, file, 'A.md', 'v1')
  await fs.writeFile(file, 'v2 —— 退出前最后一笔')
  engine.notifyLocal('A.md', 'write')
  await engine.stop()
  expect(engine.getStatus().pending).toBe(0) // 定时器是真清了,不是靠 enqueue 的 accepting 闸兜着
  await sleep(QUIET * 3)
  expect(env.puts).toHaveLength(1)
  await engine.restart()
  await vi.waitFor(() => expect(env.puts).toEqual([{ path: 'A.md', content: 'v1' }, { path: 'A.md', content: 'v2 —— 退出前最后一笔' }]), { timeout: 3000 })
})

it('大文件(基线体积 > 256KB)静默窗口更长:每推一次都是整份', async () => {
  const { engine, mirror } = await boot()
  const file = path.join(mirror, 'big.md')
  await pushed(engine, file, 'big.md', 'x'.repeat(300 * 1024)) // 首推:基线里还没有体积 → 普通窗口
  await fs.writeFile(file, 'y'.repeat(300 * 1024 + 1))
  engine.notifyLocal('big.md', 'write')
  await sleep(QUIET * 2.5) // 普通窗口早该推了
  expect(env.puts).toHaveLength(1)
  await vi.waitFor(() => expect(env.puts).toHaveLength(2), { timeout: 3000 })
})

it('改写后整目录消失:写触发的对账一条删除都不发,交回扫描路径 → 全部进待确认', async () => {
  const { engine, mirror } = await boot()
  const dir = path.join(mirror, 'notes')
  await fs.mkdir(dir)
  const names = ['a', 'b', 'c', 'd', 'e'].map((n) => `notes/${n}.md`)
  for (const rel of names) await pushed(engine, path.join(mirror, rel), rel, `body of ${rel}`)
  for (const rel of names) {
    await fs.writeFile(path.join(mirror, rel), `edited ${rel}`)
    engine.notifyLocal(rel, 'write')
  }
  await fs.rm(dir, { recursive: true }) // 窗口内整目录没了,没有任何 remove 通知(watcher 的 unlink 走的同样是 scanLater)
  await sleep(QUIET * 4) // 5 个写定时器早已触发
  expect(env.deleted).toEqual([]) // 逐条 pushDelete 的话这里已经删光了(5 < 50,风暴限流拦不住)
  await vi.waitFor(() => expect(engine.getStatus().pendingDeletions).toBe(5), { timeout: 6000 }) // 扫描路径(SCAN_DEBOUNCE_MS = 2.5s)整体过计划级阈值
  expect(env.deleted).toEqual([])
  expect(env.puts).toHaveLength(5)
}, 15_000)

it('推送在途时又存了一版、随后 stop:重启后的全量对账必须把后一版补推', async () => {
  const { engine, mirror } = await boot()
  const file = path.join(mirror, 'A.md')
  let release!: () => void
  env.putGate = new Promise<void>((r) => { release = r })
  await fs.writeFile(file, 'draft one')
  engine.notifyLocal('A.md', 'write')
  await vi.waitFor(() => expect(env.putsStarted).toBe(1), { timeout: 3000 }) // 「draft one」的 PUT 在途
  await fs.writeFile(file, 'draft two!!') // 编辑器又存了一版(体积不同:不指望 mtime 粒度)→ 新定时器
  engine.notifyLocal('A.md', 'write')
  const stopping = Promise.resolve(engine.stop()) // 定时器被清;drain 等在途的那次 PUT
  release()
  await stopping
  env.putGate = null
  expect(env.puts).toEqual([{ path: 'A.md', content: 'draft one' }])
  await engine.restart()
  await vi.waitFor(() => expect(env.puts.at(-1)).toEqual({ path: 'A.md', content: 'draft two!!' }), { timeout: 3000 })
})


it('拉取落地:给临时文件取 stat 的工夫来了结构性移动 → 不许再 rename 覆盖目标', async () => {
  const { engine, mirror } = await boot()
  const file = path.join(mirror, 'A.md')
  await pushed(engine, file, 'A.md', 'local v1')
  // 另一台设备把 A.md 改成了 v2
  env.remoteContent['A.md'] = 'remote v2'
  env.remote = [{ path: 'A.md', kind: 'page', seq: 2, hash: createHash('sha256').update('remote v2').digest('hex'), size: 9 }]
  let releaseHold: (() => void) | undefined
  env.onTmpStat = () => { releaseHold = engine.holdLocalMove('A.md', 'B.md') } // 用户此刻在树上把 A 拖去 B:structuralRevision++
  env.sse!.onChange({ seq: 50, type: 'page', op: 'write', path: 'A.md', newPath: null, fileSeq: 2, origin: { client: 'other-device', actor: 'user' } })
  await vi.waitFor(() => expect(env.tmpStatHits).toBe(1), { timeout: 3000 }) // 确实走到了 atomicWrite(不是空过)
  await sleep(100)
  expect(await fs.readFile(file, 'utf8')).toBe('local v1') // 没被盖
  expect((await fs.readdir(mirror)).filter((n) => n.includes('.tmp-'))).toEqual([]) // 临时文件也收走了
  releaseHold?.()
})

it('自愈:内容没变只是 mtime 变了(touch)→ 对账顺手刷新基线的 stat,不重推', async () => {
  const { engine, mirror } = await boot()
  const file = path.join(mirror, 'A.md')
  await pushed(engine, file, 'A.md', 'v1')
  const later = new Date(Date.now() + 60_000)
  await fs.utimes(file, later, later)
  engine.notifyLocal('A.md', 'write')
  await sleep(QUIET * 3)
  await engine.stop() // shadow 落盘
  const shadow = JSON.parse(await fs.readFile(path.join(env.root, 'push-shadow.json'), 'utf8'))
  expect(shadow.files['A.md'].mtimeMs).toBe(Math.floor((await fs.stat(file)).mtimeMs))
  expect(env.puts).toHaveLength(1)
})

it('基线回声:远端 seq 动了但字节仍是基线、本地正在改 → 不另存冲突副本、不盖本地,按新 seq 推本地', async () => {
  const { engine, mirror } = await boot()
  const file = path.join(mirror, 'A.md')
  await pushed(engine, file, 'A.md', 'v1')
  await fs.writeFile(file, 'v1 + 本机新打的字') // 本地改了、还没推(没进防抖)
  // 另一台设备把 v1 原样又写了一遍:seq 2,hash 与我们的基线相同
  env.remoteContent['A.md'] = 'v1'
  env.remote = [{ path: 'A.md', kind: 'page', seq: 2, hash: createHash('sha256').update('v1').digest('hex'), size: 2 }]
  env.sse!.onChange({ seq: 50, type: 'page', op: 'write', path: 'A.md', newPath: null, fileSeq: 2, origin: { client: 'other-device', actor: 'user' } })
  await vi.waitFor(() => expect(env.puts.at(-1)).toEqual({ path: 'A.md', content: 'v1 + 本机新打的字' }), { timeout: 3000 })
  expect(await fs.readFile(file, 'utf8')).toBe('v1 + 本机新打的字') // 没被 v1 盖掉
  expect((await fs.readdir(mirror)).filter((n) => n.includes('(conflict'))).toEqual([]) // 老逻辑:另存副本再用 v1 覆盖
  expect(env.puts).toHaveLength(2)
  expect(env.putSeqs).toEqual([0, 2]) // 第二次 PUT 带的是回声后的新 seq,不是旧基线 1(mock 按 CAS 409,带 1 推不上去)
})

it('回声后基线的 stat 不可信:推送网络失败 + stop,重启的全量对账重算 hash 把本地这版补推', async () => {
  const { engine, mirror } = await boot()
  const file = path.join(mirror, 'A.md')
  await pushed(engine, file, 'A.md', 'v1')
  await fs.writeFile(file, 'v1 + 本机新打的字')
  env.remoteContent['A.md'] = 'v1'
  env.remote = [{ path: 'A.md', kind: 'page', seq: 2, hash: createHash('sha256').update('v1').digest('hex'), size: 2 }]
  env.putError = new Error('fetch failed') // 回声触发的那次推送撞网络错
  env.sse!.onChange({ seq: 50, type: 'page', op: 'write', path: 'A.md', newPath: null, fileSeq: 2, origin: { client: 'other-device', actor: 'user' } })
  await vi.waitFor(() => expect(env.putsStarted).toBe(2), { timeout: 3000 }) // 确实试推过一次(被网络错打回)
  await engine.stop()
  expect(env.puts).toHaveLength(1)
  env.putError = null
  await engine.restart()
  await vi.waitFor(() => expect(env.puts.at(-1)).toEqual({ path: 'A.md', content: 'v1 + 本机新打的字' }), { timeout: 3000 })
  expect(env.putSeqs.at(-1)).toBe(2)
})
