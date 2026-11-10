import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'
import {
  applySettingOps, diffVaultCfg, docToVaultCfg, emptySettingsDoc, isPortableSource, mergeContribution, parseSettingKey,
  projectShared, rowIdOf, settingKey, vaultCfgEntries, type VaultCfg,
} from './calendarSettingsDoc'

const vc = (o: Partial<VaultCfg> = {}): VaultCfg => ({ colors: {}, hidden: [], defaultDbPath: null, members: {}, ...o })

describe('行 id 与 k', () => {
  it('行 id = s + sha1(k) 前 16 位,和 Node crypto 一致(含中文路径)', () => {
    for (const k of ['sync|color|任务.db', 'sync|hidden|human://CALENDAR.db', 'sync|default|']) {
      expect(rowIdOf(k)).toBe(`s${createHash('sha1').update(k, 'utf8').digest('hex').slice(0, 16)}`)
    }
  })
  it('k 只按前两个 | 切,文件名里的 | 留在来源键里', () => {
    expect(parseSettingKey('sync|color|a|b.db')).toEqual({ lib: 'sync', field: 'color', src: 'a|b.db' })
    expect(parseSettingKey('sync|default|')).toEqual({ lib: 'sync', field: 'default', src: '' })
    expect(parseSettingKey('nonsense')).toBeNull()
  })
  it('能跨设备的来源键:库内相对路径、human:// agent:// mdnote://;otherside: ics:// 绝对路径 反斜杠 一律不行', () => {
    for (const p of ['任务.db', 'a/b.db', 'human://CALENDAR.db', 'agent://main/x', 'mdnote://日程.md']) expect(isPortableSource(p)).toBe(true)
    for (const p of ['otherside:/Users/x/Vault/a.db', 'otherside:D:\\V/a.db', 'ics://1699999', '/abs/a.db', 'a\\b.db', 'C:/x.db', 'webcal://x', ''])
      expect(isPortableSource(p)).toBe(false)
  })
})

describe('互转', () => {
  const full = vc({
    colors: { 'a.db': '#111111', 'ics://s1': '#222222', 'otherside:/V/b.db': '#333333' },
    autoColors: { 'a.db': '#6d8fd6', 'human://CALENDAR.db': '#e0925f', 'ics://s1': '#5aa98b' },
    hidden: ['a.db', 'ics://s1'],
    defaultDbPath: 'a.db',
    members: { 'a.db': { dateCol: 'd', checkboxCol: 'c' }, 'b.db': { dateCol: 'd2' }, 'otherside:/V/c.db': { dateCol: 'x' } },
    migrated: true,
  })
  it('不可移植的键不进共享文件', () => {
    const ks = [...vaultCfgEntries(full).keys()]
    expect(ks.some((k) => k.includes('ics://') || k.includes('otherside:'))).toBe(false)
    expect(ks).toContain(settingKey('seeded'))
    expect(ks).toContain(settingKey('migrated'))
  })
  it('设置 → 文档 → 设置 往返(只剩可移植项)', () => {
    const doc = applySettingOps(emptySettingsDoc(), mergeContribution(full))
    expect(docToVaultCfg(doc)).toEqual({
      colors: { 'a.db': '#111111' },
      autoColors: { 'a.db': '#6d8fd6', 'human://CALENDAR.db': '#e0925f' },
      hidden: ['a.db'], defaultDbPath: 'a.db',
      members: { 'a.db': { dateCol: 'd', checkboxCol: 'c' }, 'b.db': { dateCol: 'd2' } },
      migrated: true,
    })
    for (const r of doc.rows) expect(r.id).toBe(rowIdOf(r.cells.k as string))
  })
  it('认不出的行、行里别的格子、文档别的顶层字段原样保留', () => {
    const doc = {
      ...emptySettingsDoc(),
      futureField: { x: 1 },
      rows: [
        { id: 'zzz', cells: { k: 'other|thing|x', v: '1' } },
        { id: rowIdOf('sync|color|a.db'), cells: { k: 'sync|color|a.db', v: '#000000', note: 'keep' } },
        { id: 'w', cells: { k: 'sync|futurefield|a.db', v: 'whatever' } },
      ],
    } as unknown as DbFile
    const out = applySettingOps(doc, [{ t: 'set', k: 'sync|color|a.db', v: '#ffffff' }, { t: 'set', k: 'sync|hidden|a.db', v: 'true' }])
    expect((out as unknown as { futureField: unknown }).futureField).toEqual({ x: 1 })
    expect(out.rows[0]).toEqual(doc.rows[0])
    expect(out.rows[1].cells).toEqual({ k: 'sync|color|a.db', v: '#ffffff', note: 'keep' })
    expect(out.rows[2]).toEqual(doc.rows[2])
    expect(docToVaultCfg(out).colors).toEqual({ 'a.db': '#ffffff' })
  })
  it('三种改动:set 覆盖、setIfAbsent 已有不动、del 删行', () => {
    let d = applySettingOps(emptySettingsDoc(), [{ t: 'setIfAbsent', k: 'sync|auto|a.db', v: '#1' }])
    d = applySettingOps(d, [{ t: 'setIfAbsent', k: 'sync|auto|a.db', v: '#2' }])
    expect(docToVaultCfg(d).autoColors).toEqual({ 'a.db': '#1' })
    d = applySettingOps(d, [{ t: 'set', k: 'sync|auto|a.db', v: '#3' }])
    expect(docToVaultCfg(d).autoColors).toEqual({ 'a.db': '#3' })
    d = applySettingOps(d, [{ t: 'del', k: 'sync|auto|a.db' }])
    expect(d.rows).toEqual([])
  })
  it('diff:手势 set/del,自动的只补不删', () => {
    const a = vc({ hidden: ['x.db'], colors: { 'y.db': '#1' } })
    const b = vc({ hidden: [], colors: { 'y.db': '#2' } })
    expect(diffVaultCfg(a, b, false)).toEqual([{ t: 'set', k: 'sync|color|y.db', v: '#2' }, { t: 'del', k: 'sync|hidden|x.db' }])
    expect(diffVaultCfg(a, b, true)).toEqual([{ t: 'setIfAbsent', k: 'sync|color|y.db', v: '#2' }])
    expect(diffVaultCfg(vc(), vc({ colors: { 'ics://1': '#1' } }), false)).toEqual([])
  })
  it('投到内存:可移植的取共享,本机独有的(otherside / ics)叠回,带账号标记', () => {
    const shared = vc({ colors: { 'a.db': '#aaaaaa' }, hidden: ['a.db'], members: { 'a.db': { dateCol: 'd' } } })
    const out = projectShared(shared, full, 'acct1')
    expect(out.colors).toEqual({ 'a.db': '#aaaaaa', 'ics://s1': '#222222', 'otherside:/V/b.db': '#333333' })
    expect(out.hidden).toEqual(['a.db', 'ics://s1'])
    expect(out.members).toEqual({ 'a.db': { dateCol: 'd' }, 'otherside:/V/c.db': { dateCol: 'x' } })
    expect(out.autoColors).toEqual({ 'ics://s1': '#5aa98b' })
    expect(out.owner).toBe('acct1')
    expect(out.migrated).toBeUndefined()
  })
})
