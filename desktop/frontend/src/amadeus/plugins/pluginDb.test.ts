/** ctx.app.mutateDb 的纯逻辑:比对交换、冲突重读重放、corrupt 不进 fn、null 不写、无 CAS 口拒绝、在途吊销。
 *  负对照(已实跑红):去掉「读后」那次 isLive → 「读之后被吊销」用例红(fn 被调、还写了盘);
 *  去掉「写前」那次 isLive → 「fn 跑完、写之前被吊销」用例红(f.writes 变 1)。 */
import { describe, it, expect, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
import { MUTATE_DB_RETRIES, mutateDbCas, type MutateDbApi } from './pluginDb'

const db = (rows: DbFile['rows']): DbFile => ({ version: 1, name: 'T', columns: [{ id: 'c1', name: '名称', type: 'text' }], rows })

/** 假桥:磁盘 + 版本票据;`interfere` 可在某次读之后偷偷改磁盘(模拟别人写入)。 */
function fakeApi(initial: DbFile, opts: { interfere?: (attempt: number, disk: DbFile) => DbFile | null; noCas?: boolean; corrupt?: boolean } = {}) {
  let disk = structuredClone(initial)
  let version = 'v0'
  let reads = 0
  const writes: DbFile[] = []
  const api: MutateDbApi = {
    readDatabase: vi.fn(async () => {
      if (opts.corrupt) return { status: 'corrupt' as const }
      const snap = { status: 'ok' as const, path: 'T.db', data: structuredClone(disk), version }
      const alt = opts.interfere?.(reads++, disk)
      if (alt) { disk = alt; version = `${version}+` } // 读完之后别人写了一版
      return snap
    }),
    ...(opts.noCas ? {} : {
      writeDatabaseCas: vi.fn(async (_p: string, data: DbFile, base: string) => {
        if (base !== version) return { ok: false, version }
        disk = structuredClone(data); version = `${version}w`
        writes.push(data)
        return { ok: true, version }
      }),
    }),
  }
  return { api, get disk() { return disk }, writes }
}
const addCol = (d: DbFile): DbFile => ({ ...d, columns: [...d.columns, { id: 'c2', name: '备注', type: 'text' }] })

describe('mutateDbCas', () => {
  it('正常路:读 → fn → CAS 写一次,rows 原样', async () => {
    const f = fakeApi(db([{ id: 'r1', cells: { c1: '甲' } }]))
    const r = await mutateDbCas(f.api, 'T.db', addCol)
    expect(r).toEqual({ ok: true })
    expect(f.writes).toHaveLength(1)
    expect(f.disk.columns.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(f.disk.rows).toEqual([{ id: 'r1', cells: { c1: '甲' } }])
  })

  it('读与写之间别人加了一行 → 第一次 CAS 撞版本 → 重读后重放 fn,那一行**不丢**', async () => {
    const f = fakeApi(db([{ id: 'r1', cells: { c1: '甲' } }]), {
      interfere: (attempt, disk) => (attempt === 0 ? { ...disk, rows: [...disk.rows, { id: 'r9', cells: { c1: '自动化加的' } }] } : null),
    })
    const r = await mutateDbCas(f.api, 'T.db', addCol)
    expect(r).toEqual({ ok: true })
    expect(f.api.readDatabase).toHaveBeenCalledTimes(2)
    expect(f.disk.rows.map((x) => x.id)).toEqual(['r1', 'r9']) // 整文件覆盖会把 r9 盖掉
    expect(f.disk.columns.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('重试耗尽仍撞 → conflict:true,最后磁盘是别人的版本、没有半截写入', async () => {
    const f = fakeApi(db([]), { interfere: () => ({ ...db([]), name: 'busy' }) })
    const r = await mutateDbCas(f.api, 'T.db', addCol, 2)
    expect(r.ok).toBe(false)
    expect(r.conflict).toBe(true)
    expect(f.writes).toHaveLength(0)
  })

  it('fn 返回 null → 不写(幂等升级「已是最新」)', async () => {
    const f = fakeApi(db([]))
    const r = await mutateDbCas(f.api, 'T.db', () => null)
    expect(r).toEqual({ ok: true })
    expect(f.writes).toHaveLength(0)
  })

  it('宿主认为 corrupt → fn 根本不被调用,corrupt:true', async () => {
    const f = fakeApi(db([]), { corrupt: true })
    const fn = vi.fn(addCol)
    const r = await mutateDbCas(f.api, 'T.db', fn)
    expect(r.ok).toBe(false)
    expect(r.corrupt).toBe(true)
    expect(fn).not.toHaveBeenCalled()
  })

  it('没有 CAS 写口(云端/移动端桥)→ 拒绝,绝不退化成无票据覆盖', async () => {
    const f = fakeApi(db([{ id: 'r1', cells: {} }]), { noCas: true })
    const r = await mutateDbCas(f.api, 'T.db', addCol)
    expect(r.ok).toBe(false)
    expect(f.disk.columns).toHaveLength(1)
  })

  it('非 .db 路径 / 桥缺席 → 拒绝', async () => {
    const f = fakeApi(db([]))
    expect((await mutateDbCas(f.api, 'a.md', addCol)).ok).toBe(false)
    expect((await mutateDbCas(undefined, 'T.db', addCol)).ok).toBe(false)
  })

  it('fn 拿到的是副本:改了入参对象也不影响磁盘(纯函数纪律)', async () => {
    const f = fakeApi(db([{ id: 'r1', cells: { c1: '甲' } }]))
    await mutateDbCas(f.api, 'T.db', (d) => { d.rows[0].cells.c1 = '改了'; return null })
    expect(f.disk.rows[0].cells.c1).toBe('甲')
  })
})

// ── 在途吊销(2026-09-02,codex 二轮 high):活性只在入口判一次挡不住「读 / 回调 / 等写这几拍里被禁用」。
describe('mutateDbCas 的在途吊销闸(isLive)', () => {
  const REVOKED = { ok: false, error: 'plugin disabled mid-flight' }

  it('读之后被吊销(读盘是异步的)→ fn 根本不被调用,一字未写', async () => {
    const f = fakeApi(db([{ id: 'r1', cells: { c1: '甲' } }]))
    let live = true
    const fn = vi.fn(addCol)
    const api: MutateDbApi = { ...f.api, readDatabase: async (a, b) => { const r = await f.api.readDatabase(a, b); live = false; return r } }
    expect(await mutateDbCas(api, 'T.db', fn, MUTATE_DB_RETRIES, () => live)).toEqual(REVOKED)
    expect(fn).not.toHaveBeenCalled()
    expect(f.writes).toHaveLength(0)
  })

  it('fn 跑完、写之前被吊销 → 不发起写(禁用后的插件改不动用户文件)', async () => {
    const f = fakeApi(db([{ id: 'r1', cells: { c1: '甲' } }]))
    let live = true
    const r = await mutateDbCas(f.api, 'T.db', (d) => { live = false; return addCol(d) }, MUTATE_DB_RETRIES, () => live)
    expect(r).toEqual(REVOKED)
    expect(f.writes).toHaveLength(0)
    expect(f.disk.columns.map((c) => c.id)).toEqual(['c1'])
  })

  it('CAS 冲突重读那一圈里被吊销 → 停在重读处,不再重放 fn', async () => {
    let live = true
    const f = fakeApi(db([]), { interfere: (attempt, disk) => (attempt === 0 ? { ...disk, name: 'busy' } : null) })
    const fn = vi.fn(addCol)
    expect(await mutateDbCas(f.api, 'T.db', fn, MUTATE_DB_RETRIES, () => { const v = live; live = false; return v })).toEqual(REVOKED)
    expect(fn).toHaveBeenCalledTimes(1) // 第一圈跑过(撞版本),第二圈读回来发现已吊销 → 不再调
    expect(f.writes).toHaveLength(0)
  })

  it('写已经提交之后才被吊销 → 仍 ok,落盘的那次**不回滚**(写后不许再补一次判活)', async () => {
    const f = fakeApi(db([{ id: 'r1', cells: { c1: '甲' } }]))
    let live = true
    const api: MutateDbApi = {
      ...f.api,
      writeDatabaseCas: async (path, data, base) => { const w = await f.api.writeDatabaseCas!(path, data, base); live = false; return w },
    }
    expect(await mutateDbCas(api, 'T.db', addCol, MUTATE_DB_RETRIES, () => live)).toEqual({ ok: true })
    expect(f.disk.columns.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('缺省(不传 isLive)恒活:非插件调用方 / 纯逻辑单测不受影响', async () => {
    const f = fakeApi(db([]))
    expect(await mutateDbCas(f.api, 'T.db', addCol)).toEqual({ ok: true })
    expect(f.writes).toHaveLength(1)
  })
})
