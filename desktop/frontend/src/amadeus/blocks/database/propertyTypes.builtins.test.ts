// @vitest-environment happy-dom
/** 内置 autonumber / created:初值(max+1 / 当前时刻串)、注册后经 newRowCells 盖章、Cell 只读展示 prefix。
 *  builtins 模块加载即自注册且 import 了 pageStore/图标 → 用 happy-dom + mock api(dbCellWikilink.test 先例)。
 *  ponytail: 用 createElement 而非 JSX,免为一个用例把 vitest include 扩到 .tsx。 */
import { describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { CellValue, DbColumn, DbFile } from '@amadeus-shared/db/schema'

vi.mock('../../api', () => ({ amadeus: {} }))
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const { createdStamp, nextAutoNumber } = await import('./propertyTypes.builtins')
const { getPropertyType, newRowCells, isStamped } = await import('./propertyTypes')

const rows = (...nums: (number | string | undefined)[]): DbFile['rows'] =>
  nums.map((n, i) => ({ id: `r${i}`, cells: (n === undefined ? {} : { n1: n }) as Record<string, CellValue> }))

describe('autonumber', () => {
  it('初值 = 已有编号最大值 + 1;非数字 cell 忽略;空表从 1 起', () => {
    expect(nextAutoNumber(rows(), 'n1')).toBe(1)
    expect(nextAutoNumber(rows(3, 7, 2), 'n1')).toBe(8)
    expect(nextAutoNumber(rows(3, 'PC-99', undefined), 'n1')).toBe(4) // 字符串不算数,别被 'PC-99' 带偏
    expect(nextAutoNumber(rows(7, 2), 'n1')).toBe(8) // 中间删过行也不回填(不是 rows.length+1)
  })

  it('注册在场:newRowCells 对 autonumber 列盖章,其它列不动', () => {
    const db: DbFile = {
      version: 1, name: 'T',
      columns: [{ id: 'c1', name: '名称', type: 'text' }, { id: 'n1', name: '编号', type: 'autonumber', prefix: 'PC-' }],
      rows: rows(4, 9),
    }
    expect(newRowCells(db)).toEqual({ n1: 10 })
  })

  it('Cell 只读展示 prefix + 数字;不传 column 就只有数字;空值显示「空」', async () => {
    const def = getPropertyType('autonumber')!
    const col: DbColumn = { id: 'n1', name: '编号', type: 'autonumber', prefix: 'PC-' }
    document.body.innerHTML = '<div id="host"></div>'
    const host = document.getElementById('host')!
    const root = createRoot(host)
    const onChange = vi.fn()
    await act(async () => { root.render(createElement(def.Cell, { value: 12, column: col, onChange })) })
    expect(host.textContent).toBe('PC-12')
    await act(async () => { root.render(createElement(def.Cell, { value: 12, onChange })) })
    expect(host.textContent).toBe('12')
    await act(async () => { root.render(createElement(def.Cell, { value: null, column: col, onChange })) })
    expect(host.textContent).toBe('空')
    expect(host.querySelector('input')).toBeNull() // 没有编辑入口
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
  })
})

describe('created', () => {
  it('初值形如 YYYY-MM-DDTHH:mm(与 calendarDate 单侧串同款,parseCalDate 直接认)', async () => {
    const { parseCalDate } = await import('@amadeus-shared/db/calDate')
    expect(createdStamp(new Date(2026, 8, 2, 9, 5))).toBe('2026-09-02T09:05')
    const v = newRowCells({ version: 1, name: 'T', columns: [{ id: 'd1', name: '创建时间', type: 'created' }], rows: [] }).d1
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(parseCalDate(v as string)?.allDay).toBe(false)
  })

  it('Cell 只读展示(T 换成空格),空值显示「空」', async () => {
    const def = getPropertyType('created')!
    document.body.innerHTML = '<div id="host"></div>'
    const host = document.getElementById('host')!
    const root = createRoot(host)
    await act(async () => { root.render(createElement(def.Cell, { value: '2026-09-02T09:05', onChange: () => {} })) })
    expect(host.textContent).toBe('2026-09-02 09:05')
    expect(host.querySelector('input')).toBeNull()
    await act(async () => { root.render(createElement(def.Cell, { value: null, onChange: () => {} })) })
    expect(host.textContent).toBe('空')
    await act(async () => { root.unmount() })
  })
})

// ── person:注册(baseType text)+ 候选集合纯函数 + Cell(输入 + 全库候选下拉,点选即 onChange) ──
describe('person', () => {
  const personDb = (name: string, ...names: (string | number | null | undefined)[]): DbFile => ({
    version: 1, name,
    columns: [{ id: 'c1', name: '名称', type: 'text' }, { id: 'p1', name: '负责人', type: 'person' }],
    rows: names.map((n, i) => ({ id: `r${i}`, cells: (n == null ? {} : { c1: '张三', p1: n }) as Record<string, CellValue> })),
  })

  it('注册在场:type=person、baseType=text(落盘/校验零改),isPersonCol 只认 person', async () => {
    const { isPersonCol } = await import('./PersonCell')
    const def = getPropertyType('person')!
    expect(def.baseType).toBe('text')
    expect(def.label).toBe('人员')
    expect(isPersonCol({ type: 'person' })).toBe(true)
    expect(isPersonCol({ type: 'text' })).toBe(false)
  })

  it('候选:跨库汇总 person 列、按次数降序同次按名、trim 去重、非字符串忽略、query 大小写无关子串、limit 截断', async () => {
    const { personCandidates } = await import('./PersonCell')
    const a = personDb('A', '李四', ' 王五 ', '李四', 42, null)
    const b = personDb('B', '王五', 'Alice', '')
    expect(personCandidates([a, b])).toEqual(['李四', '王五', 'Alice']) // 李四×2、王五×2(李<王 按名)、Alice×1
    expect(personCandidates([a, b], 'ali')).toEqual(['Alice'])
    expect(personCandidates([a, b], '', 2)).toEqual(['李四', '王五'])
    expect(personCandidates([], '')).toEqual([])
  })

  it('候选只数 person 列:同名的 text 列不算(c1 里全是「张三」也不该出现)', async () => {
    const { personCandidates } = await import('./PersonCell')
    expect(personCandidates([personDb('A', '李四')])).toEqual(['李四'])
    const textOnly: DbFile = { version: 1, name: 'T', columns: [{ id: 'c1', name: '名称', type: 'text' }], rows: [{ id: 'r1', cells: { c1: '张三' } }] }
    expect(personCandidates([textOnly])).toEqual([])
  })

  it('okDbs:同一 .db 多个 ref(嵌入原文 + vault 路径)按 path 去重,先到先得;不去重则当前表名字次数翻倍', async () => {
    const { okDbs, personCandidates } = await import('./PersonCell')
    const cur = personDb('A', '李四')                 // 当前表:李四×1,但 store 里以两个 ref 各占一条
    const other = personDb('B', '王五', '王五')        // 另一张表:王五×2
    const entries = {
      'A.db': { status: 'ok' as const, path: 'dbs/A.db', data: cur },
      'dbs/A.db': { status: 'ok' as const, path: 'dbs/A.db', data: personDb('A-stale', '李四') },
      'dbs/B.db': { status: 'ok' as const, path: 'dbs/B.db', data: other },
      'x.db': { status: 'missing' as const, path: null, data: null },
    }
    const dbs = okDbs(entries)
    expect(dbs.map((d) => d.name)).toEqual(['A', 'B']) // A-stale 被去掉,先到的 A 留下
    expect(personCandidates(dbs)).toEqual(['王五', '李四']) // 李四不翻倍(翻倍后 2:2 会按名排到王五前面)
  })

  it('Cell:聚焦弹全库候选(已填的名字不重复列),点选即 onChange;Esc 关;打字直接写值;↓+Enter 取选中', async () => {
    const { useDbStore } = await import('../../store/dbStore')
    const { usePageStore } = await import('../../store/pageStore')
    useDbStore.setState({ entries: { 'a.db': { status: 'ok', path: 'a.db', data: personDb('A', '李四', '王五') }, 'b.db': { status: 'missing', path: null, data: null } } })
    usePageStore.setState({ files: [] })
    const def = getPropertyType('person')!
    document.body.innerHTML = '<div id="host"></div>'
    const host = document.getElementById('host')!
    const root = createRoot(host)
    const onChange = vi.fn()
    // 受控壳:value 跟着 onChange 走(DatabaseEmbed 的 setCell → store → 重渲 同款),否则 query 永远是初值
    function Host(): React.ReactElement {
      const [v, setV] = React.useState<CellValue>('王五')
      return createElement(def.Cell, { value: v, onChange: (nv) => { onChange(nv); setV(nv ?? null) } })
    }
    await act(async () => { root.render(createElement(Host)) })
    const input = host.querySelector<HTMLInputElement>('input.amx-db-input')!
    expect(input.value).toBe('王五')
    expect(host.querySelector('.amx-db-pop')).toBeNull() // 没聚焦不弹
    await act(async () => { input.focus() })
    const opts = [...host.querySelectorAll<HTMLButtonElement>('.amx-db-pop .amx-db-opt')].map((b) => b.textContent)
    expect(opts).toEqual(['李四']) // 王五 = 当前值,不重复列
    await act(async () => { host.querySelector<HTMLButtonElement>('.amx-db-pop .amx-db-opt')!.click() })
    expect(onChange).toHaveBeenCalledWith('李四')
    expect(host.querySelector('.amx-db-pop')).toBeNull() // 选完即关
    // 选完焦点仍在输入框(option mousedown 阻了 blur),先离开再聚焦 → 重新弹;Esc 关
    await act(async () => { input.blur() })
    await act(async () => { input.focus() })
    expect([...host.querySelectorAll('.amx-db-pop .amx-db-opt')].map((b) => b.textContent)).toEqual(['王五']) // 现值李四,列出王五
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(host.querySelector('.amx-db-pop')).toBeNull()
    // 打字:受控 input 走原生 setter + input 事件;清空 → undefined(与 text 单元格同语义)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(input, '赵六'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(onChange).toHaveBeenLastCalledWith('赵六')
    expect(host.querySelector('.amx-db-pop')).toBeNull() // 打了字就按字过滤:没有含「赵六」的候选 → 隐去
    await act(async () => { setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    // 键盘:清空后 query='' → 全部候选(李四、王五)→ ↓ 高亮首项 → Enter 取它并关下拉
    const key = (k: string): Promise<void> => act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) })
    expect([...host.querySelectorAll('.amx-db-pop .amx-db-opt')].map((b) => b.textContent)).toEqual(['李四', '王五'])
    await key('ArrowDown')
    expect(host.querySelector('.amx-db-pop .amx-db-opt[data-active]')?.textContent).toBe('李四')
    await key('Enter')
    expect(onChange).toHaveBeenLastCalledWith('李四')
    expect(input.value).toBe('李四')
    expect(host.querySelector('.amx-db-pop')).toBeNull()
    await act(async () => { root.unmount() })
    useDbStore.setState({ entries: {} })
  })
})

describe('updated(修改时间)', () => {
  it('已注册:baseType text、建行初值同 created、列进 STAMPED_TYPES(setCell 守卫 / 表单域排除都靠它)', () => {
    const def = getPropertyType('updated')!
    expect(def.label).toBe('修改时间')
    expect(def.baseType).toBe('text')
    expect(isStamped('updated')).toBe(true)
    const v = newRowCells({ version: 1, name: 'T', columns: [{ id: 'u', name: '修改时间', type: 'updated' }], rows: [] }).u
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
  it('Cell 只读展示,不给编辑入口', async () => {
    const def = getPropertyType('updated')!
    document.body.innerHTML = '<div id="host"></div>'
    const host = document.getElementById('host')!
    const root = createRoot(host)
    const onChange = vi.fn()
    await act(async () => { root.render(createElement(def.Cell, { value: '2026-09-02T09:05', onChange })) })
    expect(host.textContent).toBe('2026-09-02 09:05')
    expect(host.querySelector('input')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
  })
})
