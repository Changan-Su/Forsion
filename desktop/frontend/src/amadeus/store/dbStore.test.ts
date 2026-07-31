/**
 * 阶段二前置的仪器:`.db` 写入的比对交换 + 冲突重放。
 *
 * 盯的是那条真实竞态 —— 渲染端握着 500ms 防抖窗口里的旧快照落盘,而这期间引擎的自动化动作
 * 往同一张表加了一行。不做 CAS 的话结果是双向丢数据:要么把自动化加的行抹掉,要么反过来。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'

/** 假磁盘:一份 DbFile + 一个随内容变的票据。 */
let disk: DbFile
let version = 'v0'
const bump = (): void => { version = `v${Number(version.slice(1)) + 1}` }

const readDatabase = vi.fn(async () => ({ status: 'ok' as const, path: 'T.db', data: structuredClone(disk), version }))
const writeDatabase = vi.fn(async (_p: string, d: DbFile) => { disk = structuredClone(d); bump() })
const writeDatabaseCas = vi.fn(async (_p: string, d: DbFile, base: string) => {
  if (base !== version) return { ok: false, version }
  disk = structuredClone(d)
  bump()
  return { ok: true, version }
})

vi.mock('../api', () => ({
  amadeus: {
    get readDatabase() { return readDatabase },
    get writeDatabase() { return writeDatabase },
    get writeDatabaseCas() { return writeDatabaseCas },
    onDbExternalChange: undefined,
  },
}))
vi.mock('./automationKick', () => ({ kickAutomation: () => {}, setAutomationKick: () => {} }))

const { useDbStore } = await import('./dbStore')

const row = (id: string, v: string): DbFile['rows'][number] => ({ id, cells: { c1: v } })
const base = (): DbFile => ({ version: 1, name: 'T', columns: [{ id: 'c1', name: '名称', type: 'text' }], rows: [row('r1', '甲')] })

describe('dbStore 写回', () => {
  beforeEach(async () => {
    disk = base()
    version = 'v0'
    vi.clearAllMocks()
    useDbStore.setState({ entries: {} })
    await useDbStore.getState().reload('T.db', 'T.db')
  })

  it('无冲突:CAS 写通过,票据前进', async () => {
    useDbStore.getState().mutate('T.db', (d) => ({ ...d, rows: [...d.rows, row('r2', '乙')] }))
    await useDbStore.getState().flushAll()
    expect(disk.rows.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(useDbStore.getState().entries['T.db'].version).toBe(version)
  })

  it('冲突:重读磁盘 + 重放本地改动 —— 两边的行都在,谁也没被抹掉', async () => {
    // 用户在防抖窗口里改了一格
    useDbStore.getState().mutate('T.db', (d) => ({ ...d, rows: [...d.rows, row('r2', '用户加的')] }))
    // 与此同时引擎的自动化往同一张表加了一行(直接改「磁盘」,票据前进)
    disk = { ...disk, rows: [...disk.rows, row('r9', '自动化加的')] }
    bump()
    await useDbStore.getState().flushAll()
    const ids = disk.rows.map((r) => r.id)
    expect(ids).toContain('r9') // 自动化的行没被旧快照盖掉 ← 修的就是这条
    expect(ids).toContain('r2') // 用户的改动也没丢
    expect(writeDatabaseCas).toHaveBeenCalledTimes(2) // 第一次撞、重放后第二次成功
  })

  it('宿主没有 CAS(云端/移动端桥)→ 退回无条件写,行为与从前一致', async () => {
    const real = writeDatabaseCas.getMockImplementation()
    const api = (await import('../api')).amadeus as any
    Object.defineProperty(api, 'writeDatabaseCas', { get: () => undefined, configurable: true })
    useDbStore.getState().mutate('T.db', (d) => ({ ...d, rows: [...d.rows, row('r3', '丙')] }))
    await useDbStore.getState().flushAll()
    expect(writeDatabase).toHaveBeenCalledTimes(1)
    Object.defineProperty(api, 'writeDatabaseCas', { get: () => writeDatabaseCas, configurable: true })
    expect(real).toBeTruthy()
  })

  it('CAS 在飞的时候用户又改了 → 那条改动不能被一起 ack 掉(整队列 delete 会丢它)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    writeDatabaseCas.mockImplementationOnce(async (_p, d: DbFile, base: string) => {
      await gate // 卡住第一次提交,模拟 IPC 往返期间用户继续打字
      if (base !== version) return { ok: false, version }
      disk = structuredClone(d)
      bump()
      return { ok: true, version }
    })
    useDbStore.getState().mutate('T.db', (d) => ({ ...d, rows: [...d.rows, row('r2', '第一批')] }))
    const flying = useDbStore.getState().flushAll()
    useDbStore.getState().mutate('T.db', (d) => ({ ...d, rows: [...d.rows, row('r3', '飞行中加的')] }))
    release()
    await flying
    await useDbStore.getState().flushAll()
    expect(disk.rows.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']) // 两批都落盘,r3 没被 ack 吞掉
  })

  it('外部改动热重载时,防抖窗口里未落盘的本地改动要被重放回去', async () => {
    useDbStore.getState().mutate('T.db', (d) => ({ ...d, rows: [...d.rows, row('r2', '正在敲')] }))
    disk = { ...disk, rows: [...disk.rows, row('r9', '外部')] }
    bump()
    await useDbStore.getState().reloadByPath('T.db')
    const ids = useDbStore.getState().entries['T.db'].data!.rows.map((r) => r.id)
    expect(ids).toContain('r9')
    expect(ids).toContain('r2') // 重读没把用户此刻的输入冲掉
  })
})
