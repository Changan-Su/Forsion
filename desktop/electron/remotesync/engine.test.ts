/**
 * 双设备 e2e:两个"设备"目录 + 一个目录假远端(createDirRemote),真实跑 runSync。
 * 覆盖:首推/拉取、双侧不同文件、同文件冲突副本一轮收敛、删除传播、编辑赢删除、
 * 删除闸挂起+确认、忽略规则、首次合流。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runSync, shouldTripMassDelete, conflictCopyName } from './engine'
import { createDirRemote } from './fsLocal'
import type { RemoteFs } from './types'

let base: string
let rootA: string
let rootB: string
let remoteDir: string
let remote: RemoteFs

const stateA = (): string => path.join(base, 'state-a.json')
const stateB = (): string => path.join(base, 'state-b.json')
const FP = 'folder:test'

const syncA = (extra?: Partial<Parameters<typeof runSync>[0]>) =>
  runSync({ localRoot: rootA, remote, statePath: stateA(), fingerprint: FP, ...extra })
const syncB = (extra?: Partial<Parameters<typeof runSync>[0]>) =>
  runSync({ localRoot: rootB, remote, statePath: stateB(), fingerprint: FP, ...extra })

const write = (root: string, rel: string, content: string) =>
  fs
    .mkdir(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true })
    .then(() => fs.writeFile(path.join(root, ...rel.split('/')), content, 'utf8'))
const read = (root: string, rel: string) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8')
const exists = (root: string, rel: string) =>
  fs.access(path.join(root, ...rel.split('/'))).then(() => true, () => false)
const list = async (root: string): Promise<string[]> => {
  const out: string[] = []
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const it of await fs.readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${it.name}` : it.name
      if (it.isDirectory()) await walk(path.join(d, it.name), r)
      else out.push(r)
    }
  }
  await walk(root, '')
  return out.sort()
}

beforeEach(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), 'rsync-'))
  rootA = path.join(base, 'a')
  rootB = path.join(base, 'b')
  remoteDir = path.join(base, 'remote')
  await fs.mkdir(rootA, { recursive: true })
  await fs.mkdir(rootB, { recursive: true })
  await fs.mkdir(remoteDir, { recursive: true })
  remote = createDirRemote(remoteDir)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('remotesync engine 双设备', () => {
  it('首推 + 拉取 + 双侧不同文件收敛', async () => {
    await write(rootA, 'notes/one.md', 'one')
    await write(rootA, 'two.md', 'two')
    const r1 = await syncA()
    expect(r1.ok).toBe(true)
    expect(r1.pushed).toBe(2)

    const r2 = await syncB()
    expect(r2.pulled).toBe(2)
    expect(await read(rootB, 'notes/one.md')).toBe('one')

    // A、B 各改不同文件 → 三轮后全收敛,零冲突
    await write(rootA, 'notes/one.md', 'one-a')
    await write(rootB, 'two.md', 'two-b')
    const r3 = await syncA()
    const r4 = await syncB()
    const r5 = await syncA()
    expect(r3.conflicts + r4.conflicts + r5.conflicts).toBe(0)
    expect(await read(rootA, 'two.md')).toBe('two-b')
    expect(await read(rootB, 'notes/one.md')).toBe('one-a')
  })

  it('同文件双改 → 冲突副本,一轮收敛且两版都保住', async () => {
    await write(rootA, 'doc.md', 'base')
    await syncA()
    await syncB()

    await write(rootA, 'doc.md', 'from-a')
    await write(rootB, 'doc.md', 'from-b')
    await syncA() // A 先推
    const rb = await syncB() // B:冲突 → 本地版进副本,远端版落原路径
    expect(rb.conflicts).toBe(1)
    expect(await read(rootB, 'doc.md')).toBe('from-a')
    const bFiles = await list(rootB)
    const copy = bFiles.find((f) => f.includes('(conflict '))
    expect(copy).toBeTruthy()
    expect(await read(rootB, copy!)).toBe('from-b')

    await syncB() // 副本推上去
    await syncA() // A 拉副本
    expect(await list(rootA)).toEqual(bFiles)
    expect(await read(rootA, copy!)).toBe('from-b')
  })

  it('删除传播 + 编辑赢过删除', async () => {
    await write(rootA, 'x.md', 'x')
    await write(rootA, 'y.md', 'y')
    await syncA()
    await syncB()

    // 删除传播
    await fs.rm(path.join(rootA, 'x.md'))
    const ra = await syncA()
    expect(ra.deletedRemote).toBe(1)
    const rb = await syncB()
    expect(rb.deletedLocal).toBe(1)
    expect(await exists(rootB, 'x.md')).toBe(false)

    // 编辑赢过删除:A 删 y,B 改 y → y 以 B 版复活
    await fs.rm(path.join(rootA, 'y.md'))
    await write(rootB, 'y.md', 'y-edited')
    await syncA() // y 从远端删掉
    await syncB() // B:本地改 + 远端没了 → push 复活
    const ra2 = await syncA()
    expect(ra2.pulled).toBe(1)
    expect(await read(rootA, 'y.md')).toBe('y-edited')
  })

  it('删除闸:批量删除挂起,确认后放行', async () => {
    for (let i = 0; i < 6; i++) await write(rootA, `f${i}.md`, `${i}`)
    await syncA()
    for (let i = 0; i < 5; i++) await fs.rm(path.join(rootA, `f${i}.md`))

    const r1 = await syncA()
    expect(r1.pendingDeletions).toBe(5)
    expect(r1.deletedRemote).toBe(0)
    expect((await remote.walk()).length).toBe(6) // 远端毫发无损

    const r2 = await syncA({ allowMassDelete: true })
    expect(r2.deletedRemote).toBe(5)
    expect((await remote.walk()).length).toBe(1)
  })

  it('远端越权 key 被拒收,绝不写到根外', async () => {
    await write(rootA, 'ok.md', 'ok')
    const evil: RemoteFs = {
      kind: 'evil',
      walk: async () => [
        { key: '../evil.md', size: 4, mtimeMs: 1, id: 'x' },
        { key: 'sub/../../also.md', size: 4, mtimeMs: 1, id: 'y' },
      ],
      readFile: async () => Buffer.from('evil'),
      writeFile: async (key, data, mt) => ({ key, size: data.length, mtimeMs: mt, id: 'z' }),
      rm: async () => {},
      check: async () => ({ ok: true }),
    }
    const r = await runSync({ localRoot: rootA, remote: evil, statePath: stateA(), fingerprint: 'evil' })
    expect(r.errors.filter((e) => e.includes('unsafe remote key')).length).toBe(2)
    await expect(fs.access(path.join(base, 'evil.md'))).rejects.toThrow()
  })

  it('scan 后本地新建的文件不被 pull 静默覆盖', async () => {
    await write(rootA, 'x.md', 'v1')
    await syncA()
    const hooked: RemoteFs = {
      ...remote,
      readFile: async (key, signal) => {
        await write(rootB, 'x.md', 'local-late') // 竞态窗口:计划已定,执行前本地冒出新文件
        return remote.readFile(key, signal)
      },
    }
    const r = await runSync({ localRoot: rootB, remote: hooked, statePath: stateB(), fingerprint: FP })
    expect(r.conflicts).toBe(1)
    expect(await read(rootB, 'x.md')).toBe('v1')
    const copy = (await list(rootB)).find((f) => f.includes('(conflict '))
    expect(copy).toBeTruthy()
    expect(await read(rootB, copy!)).toBe('local-late')
  })

  it('远端整空 + 基线足量(≥5)→ 硬中止,确认也不放行', async () => {
    for (let i = 0; i < 6; i++) await write(rootA, `n${i}.md`, `${i}`)
    await syncA()
    await fs.rm(remoteDir, { recursive: true, force: true })
    await fs.mkdir(remoteDir, { recursive: true })
    const r = await syncA({ allowMassDelete: true })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('remote-empty-suspicious'))).toBe(true)
    for (let i = 0; i < 6; i++) expect(await read(rootA, `n${i}.md`)).toBe(`${i}`)
  })

  it('引擎向后端透传条件写身份(create=null / update=基线id / delete=基线id)', async () => {
    const seen: Array<{ op: string; expectedId: string | null | undefined }> = []
    const spy: RemoteFs = {
      ...remote,
      writeFile: async (key, data, mt, signal, expectedId) => {
        seen.push({ op: 'put', expectedId })
        return remote.writeFile(key, data, mt, signal)
      },
      rm: async (key, signal, expectedId) => {
        seen.push({ op: 'rm', expectedId })
        return remote.rm(key, signal)
      },
    }
    const run = () => runSync({ localRoot: rootA, remote: spy, statePath: stateA(), fingerprint: FP })
    await write(rootA, 'c.md', 'v1')
    await run() // create
    await write(rootA, 'c.md', 'v2')
    await run() // update
    await fs.rm(path.join(rootA, 'c.md'))
    await run() // delete
    expect(seen[0]).toEqual({ op: 'put', expectedId: null })
    expect(seen[1].op).toBe('put')
    expect(typeof seen[1].expectedId).toBe('string')
    expect(seen[2].op).toBe('rm')
    expect(typeof seen[2].expectedId).toBe('string') // = v2 推送后的基线身份
  })

  it('同步方式 push:仅上传,不拉取不传播删除,冲突以本地为准', async () => {
    await write(rootA, 'doc.md', 'base')
    await write(rootA, 'gone.md', 'g')
    await syncA()
    await syncB()
    await write(rootB, 'remote-new.md', 'rn')
    await write(rootB, 'doc.md', 'from-b')
    await syncB()

    await fs.rm(path.join(rootA, 'gone.md'))
    await write(rootA, 'doc.md', 'from-a')
    const r = await syncA({ direction: 'push' })
    expect(r.ok).toBe(true)
    expect(r.pulled).toBe(0)
    expect(r.deletedRemote).toBe(0)
    expect(r.deletedLocal).toBe(0)
    expect(await exists(rootA, 'remote-new.md')).toBe(false) // 不拉取
    const rw = await remote.walk()
    expect(rw.find((e) => e.key === 'gone.md')).toBeTruthy() // 本地删除不上传
    expect((await remote.readFile('doc.md')).toString()).toBe('from-a') // 冲突以本地为准
  })

  it('同步方式 pull:仅下载,不推送不传播删除,冲突出本地副本', async () => {
    await write(rootA, 'doc.md', 'base')
    await write(rootA, 'dead.md', 'd')
    await syncA()
    await syncB()

    await write(rootA, 'doc.md', 'from-a')
    await fs.rm(path.join(rootA, 'dead.md'))
    await syncA() // 远端:doc=from-a,dead 已删

    await write(rootB, 'doc.md', 'from-b')
    await write(rootB, 'b-local.md', 'bl')
    const r = await syncB({ direction: 'pull' })
    expect(r.ok).toBe(true)
    expect(r.pushed).toBe(0)
    expect(r.deletedLocal).toBe(0)
    expect(r.conflicts).toBe(1)
    expect(await read(rootB, 'doc.md')).toBe('from-a')
    expect(await exists(rootB, 'dead.md')).toBe(true) // 远端删除不落地
    expect((await remote.walk()).find((e) => e.key === 'b-local.md')).toBeUndefined() // 不推送
    const copy = (await list(rootB)).find((f) => f.includes('(conflict '))
    expect(copy).toBeTruthy()
    expect(await read(rootB, copy!)).toBe('from-b')
  })

  it('忽略规则 + 首次合流不同内容出副本', async () => {
    await write(rootA, '.DS_Store', 'junk')
    await write(rootA, 'keep.md', 'A')
    const r1 = await syncA()
    expect(r1.pushed).toBe(1) // .DS_Store 不上传

    // B 侧同名不同内容,无基线 → join:远端版落原路径,B 版进副本
    await write(rootB, 'keep.md', 'B')
    const r2 = await syncB()
    expect(r2.conflicts).toBe(1)
    expect(await read(rootB, 'keep.md')).toBe('A')
    const copy = (await list(rootB)).find((f) => f.includes('(conflict '))
    expect(copy).toBeTruthy()
    expect(await read(rootB, copy!)).toBe('B')
  })
})

describe('工具函数', () => {
  it('shouldTripMassDelete 阈值', () => {
    expect(shouldTripMassDelete(200, 0)).toBe(true)
    expect(shouldTripMassDelete(4, 100)).toBe(false)
    expect(shouldTripMassDelete(5, 10)).toBe(true)
    expect(shouldTripMassDelete(5, 1000)).toBe(false)
    expect(shouldTripMassDelete(500, 1000)).toBe(true)
    expect(shouldTripMassDelete(3, 4)).toBe(false) // tracked<5 不触发比例闸
  })

  it('conflictCopyName 组名', () => {
    const now = new Date(2026, 6, 20, 15, 30)
    expect(conflictCopyName('a/Note.md', now)).toBe('a/Note (conflict 2026-07-20 1530).md')
    expect(conflictCopyName('Note.md', now, 2)).toBe('Note (conflict 2026-07-20 1530-2).md')
    expect(conflictCopyName('noext', now)).toBe('noext (conflict 2026-07-20 1530)')
  })
})
