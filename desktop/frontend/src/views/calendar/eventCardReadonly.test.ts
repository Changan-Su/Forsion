// @vitest-environment happy-dom
/** 日历事件卡的属性行:rowlink / lookup / formula / file 一律只读文本 —— 旧 default 分支会把它们渲成
 *  可编辑 <input>,rowlink 的数组一敲键就被写成 "id1, id2" 字符串(关联不可逆丢失)。
 *  ponytail: 用 createElement 而非 JSX,免为一个用例把 vitest include 扩到 .tsx。 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DbFile } from '@amadeus-shared/db/schema'

vi.mock('../../amadeus/api', () => ({ amadeus: {} }))
vi.mock('../../amadeusNav', () => ({ openDb: () => {} }))
vi.mock('../../amadeusPlugins', () => ({ ensureAmadeusReady: () => {} }))
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const PARTS = '配件.db'
const partsDb = (): DbFile => ({
  version: 1, name: '配件',
  columns: [{ id: 'n', name: '名称', type: 'text' }],
  rows: [{ id: 'p1', cells: { n: 'CPU' } }, { id: 'p2', cells: { n: '显卡' } }],
})

let root: Root | null = null
afterEach(async () => { if (root) await act(async () => { root!.unmount() }); root = null })

describe('EventCard 属性行只读面', () => {
  it('rowlink 显示目标行标题(不是 id、不是输入框);lookup/formula/file 也只读;普通 text 仍是输入框', async () => {
    const { EventCard } = await import('./EventCard')
    const { useDbStore } = await import('../../amadeus/store/dbStore')
    useDbStore.setState({ entries: { [PARTS]: { status: 'ok', path: PARTS, data: partsDb() } } })
    const db = {
      path: '任务.db', name: '任务', isNoteView: false,
      columns: [
        { id: 'c1', name: '任务', type: 'text' },
        { id: 'd1', name: '日期', type: 'calendarDate' },
        { id: 'rel', name: '配件', type: 'rowlink', refDb: PARTS, multiple: true },
        { id: 'lk', name: '单价', type: 'lookup', lookupRel: 'rel', lookupCol: 'n' },
        { id: 'f', name: '公式', type: 'formula', formula: '1+1' },
        { id: 'a', name: '附件', type: 'file' },
        { id: 'memo', name: '备注', type: 'text' },
        { id: 'no', name: '编号', type: 'autonumber', prefix: 'E-' },
      ],
      rows: [{ rowId: 'r1', name: '装机', cells: { c1: '装机', d1: '2026-09-02', rel: ['p1', 'p2', 'gone'], lk: 100, f: 2, a: 'x.png', memo: '备', no: 3 } }],
    }
    const ev = { db, row: db.rows[0], colId: 'd1', title: '装机', raw: '2026-09-02' }
    document.body.innerHTML = '<div id="host"></div>'
    const host = document.getElementById('host')!
    root = createRoot(host)
    await act(async () => { root!.render(createElement(EventCard, { ev: ev as never, at: { left: 0, top: 0, right: 10, bottom: 10 }, onClose: () => {} })) })
    const fieldOf = (name: string): HTMLElement => [...host.querySelectorAll<HTMLElement>('.amx-cal-card-prop')].find((e) => e.textContent?.includes(name))!
    const rel = fieldOf('配件')
    expect(rel.querySelector('input')).toBeNull()
    expect(rel.querySelector('.amx-cal-card-val')?.textContent).toBe('CPU, 显卡, 已失联')
    for (const n of ['单价', '公式', '附件']) expect(fieldOf(n).querySelector('input')).toBeNull()
    expect(fieldOf('备注').querySelector('input')).toBeTruthy()
    // 注册表 Cell 拿得到列(column={col}):日历卡里的自动编号也带前缀,不是光秃秃的 3
    expect(fieldOf('编号').textContent).toContain('E-3')
    expect(fieldOf('编号').querySelector('input')).toBeNull()
  })
})
