/**
 * 仪器:`.db` 的跨进程写锁(桌面 main 侧)。
 *
 * ⚠️ **A 组是跨进程契约的镜像断言** —— 引擎那半在 `tangu-agent/src/services/dbLock.test.ts`,
 * 两边必须算出**同一个**锁路径,否则各锁各的、静默失效(没有任何报错,只是竞态照旧)。
 * 单测跨不了包边界,所以只能两边各把约定逐字钉一遍:改这条约定必须同时改两个文件。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dbLockPath, withDbLock } from './dbLock'

let dir = ''
const dbAbs = (): string => path.join(dir, '任务.db')
const lockAbs = (): string => path.join(dir, '.任务.db.lock')

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dblock-')))
  await fs.writeFile(dbAbs(), '{}', 'utf8')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('A. 锁文件路径约定(与引擎侧逐字一致)', () => {
  it('= 同目录下的 `.<文件名>.lock`', async () => {
    expect(await dbLockPath(dbAbs())).toBe(lockAbs())
  })

  it('目录取 realpath —— 一侧的 vault 根走软链时,两个进程仍落在同一把锁上', async () => {
    const link = path.join(await fs.realpath(os.tmpdir()), `dblink-${process.pid}`)
    await fs.rm(link, { force: true })
    await fs.symlink(dir, link)
    try {
      expect(await dbLockPath(path.join(link, '任务.db'))).toBe(lockAbs())
    } finally {
      await fs.rm(link, { force: true })
    }
  })

  it('点开头 —— watcher 的 ignored 与同步的 isIgnoredName 靠这个滤掉它', async () => {
    expect(path.basename(await dbLockPath(dbAbs())).startsWith('.')).toBe(true)
  })
})

describe('B. 互斥与释放', () => {
  it('同一路径的两个调用者排队,临界区不重叠', async () => {
    const log: string[] = []
    const body = (tag: string) => async (): Promise<void> => {
      log.push(`in-${tag}`)
      await new Promise((r) => setTimeout(r, 60))
      log.push(`out-${tag}`)
    }
    await Promise.all([withDbLock(dbAbs(), body('a')), withDbLock(dbAbs(), body('b'))])
    expect(log).toHaveLength(4)
    expect(log[1]).toBe(`out-${log[0].slice(3)}`)
    expect(log[3]).toBe(`out-${log[2].slice(3)}`)
  })

  it('跑完 / 抛错都释放,不在 vault 里留垃圾', async () => {
    await withDbLock(dbAbs(), async () => {})
    await expect(withDbLock(dbAbs(), async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await fs.readdir(dir)).toEqual(['任务.db'])
  })

  it('陈旧锁(mtime 超过 10s)会被破除 —— 持锁进程崩了不能让这张表永久写不进去', async () => {
    await fs.writeFile(lockAbs(), '99999', 'utf8')
    const old = Date.now() / 1000 - 60
    await fs.utimes(lockAbs(), old, old)
    let ran = false
    await withDbLock(dbAbs(), async () => { ran = true })
    expect(ran).toBe(true)
  })
})
