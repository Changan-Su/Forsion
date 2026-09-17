import { chmodSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSerialQueue, lockedUpdateJson, writePrivateJson } from './configWrite'

const fsFault = vi.hoisted(() => ({ writeSyncENOSPC: false }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    writeSync: ((...args: Parameters<typeof real.writeSync>) => {
      if (fsFault.writeSyncENOSPC) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      return real.writeSync(...args)
    }) as typeof real.writeSync,
  }
})

let dir = ''
afterEach(async () => { vi.useRealTimers(); if (dir) await rm(dir, { recursive: true, force: true }) })
const fresh = async (): Promise<string> => (dir = await mkdtemp(join(tmpdir(), 'config-write-')))
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'))

describe('configWrite', () => {
  it('saveConfig 形状的读改写:不排队丢一个键,排队两个都落盘', async () => {
    const file = join(await fresh(), 'tangu-desktop-config.json')
    await writeFile(file, JSON.stringify({ mode: 'managed' }))
    let running = 0
    let peak = 0
    // afterRead = 读与写之间的 await(真代码里是另一份配置文件的读写)
    const patch = (p: Record<string, unknown>, afterRead: () => Promise<unknown>) => async (): Promise<void> => {
      peak = Math.max(peak, ++running)
      const cur = await readJson(file)
      await afterRead()
      await writePrivateJson(file, { ...cur, ...p })
      running--
    }
    // 负对照:两边都读完才放行写(不靠调度碰运气)→ 后写者拿旧读数盖掉前者
    let release!: () => void
    const bothRead = new Promise<void>((r) => { release = r })
    let reads = 0
    const gate = (): Promise<void> => { if (++reads === 2) release(); return bothRead }
    await Promise.all([patch({ a: 1 }, gate)(), patch({ b: 2 }, gate)()])
    const raced = await readJson(file)
    expect(('a' in raced) !== ('b' in raced)).toBe(true)

    peak = 0
    const queue = createSerialQueue()
    const tick = () => new Promise((r) => setTimeout(r, 20))
    await Promise.all([queue(patch({ c: 3 }, tick)), queue(patch({ d: 4 }, tick))])
    expect(peak).toBe(1) // 同一时刻只有一个读改写在跑
    expect(await readJson(file)).toMatchObject({ mode: 'managed', c: 3, d: 4 })
  })

  it('并发整份写同一文件:结果总是其中一份完整 JSON,不留临时文件,权限 0600', async () => {
    const file = join(await fresh(), 'sub', 'config.json')
    const payloads = Array.from({ length: 12 }, (_, i) => ({ i, pad: 'x'.repeat((12 - i) * 40) }))
    await Promise.all(payloads.map((p) => writePrivateJson(file, p)))
    expect(payloads).toContainEqual(await readJson(file))
    expect(await readdir(join(dir, 'sub'))).toEqual(['config.json'])
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('任务失败只抛给自己的调用方,后面的照跑', async () => {
    const queue = createSerialQueue()
    const failed = queue(async () => { throw new Error('bad config.json') })
    const next = queue(async () => 'saved')
    await expect(failed).rejects.toThrow('bad config.json')
    await expect(next).resolves.toBe('saved')
  })
})

describe('lockedUpdateJson(跨进程写锁)', () => {
  const setup = async () => {
    const file = join(await fresh(), 'config.json')
    await writeFile(file, JSON.stringify({ cloud: { url: 'u' } }))
    return { file, lock: `${file}.lock`, leftovers: async () => (await readdir(dir)).filter((f) => f !== 'config.json') }
  }

  it('别的进程占着锁 → 等它放锁,在它写完的内容上合并;不留锁与临时文件,0600', async () => {
    const { file, lock, leftovers } = await setup()
    await writeFile(lock, '')
    setTimeout(() => {
      void (async () => { // 「引擎」持锁期间写了 channels 段再放锁
        await writeFile(file, JSON.stringify({ ...(await readJson(file)), channels: { tg: 1 } }))
        await rm(lock)
      })()
    }, 200)
    const t0 = Date.now()
    await lockedUpdateJson(file, (c) => ({ ...c, approval: { base: 'ask' } }))
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
    expect(await readJson(file)).toEqual({ cloud: { url: 'u' }, channels: { tg: 1 }, approval: { base: 'ask' } })
    expect(await leftovers()).toEqual([])
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('陈旧锁(持锁进程死在临界区,mtime 超 5s)→ 偷锁照写,不留锁与残渣', async () => {
    const { file, lock, leftovers } = await setup()
    await writeFile(lock, '')
    const old = new Date(Date.now() - 20_000)
    utimesSync(lock, old, old)
    await lockedUpdateJson(file, (c) => ({ ...c, mine: 1 }))
    expect(await readJson(file)).toEqual({ cloud: { url: 'u' }, mine: 1 })
    expect(await leftovers()).toEqual([])
  })

  it('锁一直被占 → 等满上限抛错,mutate 不执行、文件一个字节不动(绝不硬写)', async () => {
    const { file, lock } = await setup()
    await writeFile(lock, '')
    const future = new Date(Date.now() + 3600_000) // 锁永远「新鲜」,不会被当陈旧锁偷走
    utimesSync(lock, future, future)
    const before = await readFile(file, 'utf8')
    const mutate = vi.fn((c: Record<string, any>) => ({ ...c, mine: 1 }))
    vi.useFakeTimers()
    const settled = expect(lockedUpdateJson(file, mutate)).rejects.toThrow('写锁被占')
    await vi.advanceTimersByTimeAsync(10_100)
    await settled
    expect(mutate).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('持锁期间锁被当陈旧锁回收、别人建了新锁(ABA / 挂起超 5s)→ 提交前核 token 抛错不落盘,也不删别人的锁', async () => {
    const { file, lock, leftovers } = await setup()
    const before = await readFile(file, 'utf8')
    await expect(lockedUpdateJson(file, (c) => {
      rmSync(lock) // 临界区里:锁被偷锁者挪走,第三个进程抢到新锁
      writeFileSync(lock, 'other-token')
      return { ...c, mine: 1 }
    })).rejects.toThrow('被当作陈旧锁回收')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(readFileSync(lock, 'utf8')).toBe('other-token')
    expect(await leftovers()).toEqual(['config.json.lock'])
  })

  it.skipIf(process.platform === 'win32')('POSIX 上建锁报 EACCES = 真权限错误 → 立刻抛,不当「被占」空等 10s', async () => {
    const { file } = await setup()
    chmodSync(dir, 0o500)
    try {
      const t0 = performance.now()
      await expect(lockedUpdateJson(file, (c) => ({ ...c, mine: 1 }))).rejects.toMatchObject({ code: 'EACCES' })
      expect(performance.now() - t0).toBeLessThan(1000)
    } finally { chmodSync(dir, 0o700) }
  })

  it('锁建出来了但 token 写不进去(磁盘满)→ 抛原始错误,顺手删掉这把空锁(不让所有写者干等 5s)', async () => {
    const { file, lock } = await setup()
    fsFault.writeSyncENOSPC = true
    try {
      await expect(lockedUpdateJson(file, (c) => ({ ...c, mine: 1 }))).rejects.toMatchObject({ code: 'ENOSPC' })
    } finally { fsFault.writeSyncENOSPC = false }
    await expect(stat(lock)).rejects.toThrow()
    await lockedUpdateJson(file, (c) => ({ ...c, mine: 1 })) // 紧接着的写入不用等
    expect(await readJson(file)).toMatchObject({ mine: 1 })
  })

  it('mutate 抛错 → 错误抛给调用方、放锁、文件不动;坏 JSON 同样拒写', async () => {
    const { file, lock } = await setup()
    await expect(lockedUpdateJson(file, () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(stat(lock)).rejects.toThrow()
    await writeFile(file, '{ 坏掉的 json,,,')
    await expect(lockedUpdateJson(file, (c) => ({ ...c, mine: 1 }))).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{ 坏掉的 json,,,')
    await expect(stat(lock)).rejects.toThrow()
  })
})
