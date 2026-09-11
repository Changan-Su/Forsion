// @vitest-environment happy-dom
/** DbTable 的「内存源 + 只读 + 开行接缝」(插件面板里的原生多维表)。
 *
 *  钉的都是**静默**那类坏法:
 *  - 内存源偷偷回到 dbStore(entries 里凭空多出条目 → 切库时 gen 一扫就整表变「文件缺失」);
 *  - 只读闸掉回 store 层(dbStore.mutate 对不存在的 entry 是静默 no-op —— 输入框看着能打字、松手值就没了);
 *  - 开行入口被动作按钮抢走 / 点动作按钮连带开行;
 *  - popHost 只搬浮层不搬遮罩(点面板外面关不掉菜单)。
 *
 *  **负对照(改坏了哪条会红)**:
 *  ① 把 `readOnly` 从 `localMode` 里摘掉(m 重新走 store)→ 「真文件只读挂载」那条的 `mutate` 调用数断言红;
 *  ② 去掉任何一处 hide(加行/加列/删行/新建/加视图/常驻 input)→ 「写入入口一个不剩」那条红;
 *  ③ setCell 的 `if (readOnly) return` 挪到活动日志之后 → 同上那条的 `.amx-db-input` 计数仍绿,但
 *     「不分发给可编辑 Cell」那条(首列是文本不是 input)红。
 *  ponytail: 用 createElement 而非 JSX,免为一个用例把 vitest include 扩到 .tsx。 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DbFile, DbRow } from '@amadeus-shared/db/schema'
import type { DbCellMeta } from './DatabaseEmbed'

vi.mock('../../api', () => ({ amadeus: {} }))
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const REF = '插件表.db'

const memDb = (): DbFile => ({
  version: 1,
  name: '模型',
  columns: [
    { id: 'name', name: '名称', type: 'text' },
    { id: 'cost', name: '单价', type: 'number' },
    { id: 'on', name: '启用', type: 'checkbox' },
    { id: 'at', name: '时间', type: 'date' },
    { id: 'site', name: '主页', type: 'url' },
    { id: '__actions', name: '', type: 'text' },
  ],
  rows: [
    { id: 'r1', cells: { name: '乙', cost: 3, on: true, at: '2026-09-01', site: 'https://a.example' } },
    { id: 'r2', cells: { name: '甲', cost: 12, on: false, at: '2026-08-02' } },
    { id: 'r3', cells: { name: '丙', cost: 7 } },
  ],
})

const meta = (): DbCellMeta => ({
  r1: {
    name: { sub: 'gpt-乙', tone: 'accent', dot: 'green', title: '第一行', attrs: { 'data-probe': 'n1' }, avatar: { src: null, letter: 'Y', attrs: { 'data-hook': 'fb-avatar' } } },
    at: { format: 'day' },
    __actions: { actions: [{ act: 'm-edit', label: '编辑', attrs: { 'data-id': 'r1' } }, { act: 'm-del', label: '删除', tone: 'red', disabled: true }] },
  },
  r2: { name: { mono: true }, __actions: { actions: [{ act: 'm-edit', label: '编辑', attrs: { 'data-id': 'r2' } }] } },
  r3: { cost: { text: '按量计费' } },
})

let root: Root | null = null
const host = (): HTMLElement => document.getElementById('host')!
const dataRows = (): HTMLElement[] => [...host().querySelectorAll<HTMLElement>('.amx-db-row:not(.amx-db-hrow):not(.amx-db-statsrow)')]
/** 只读表的首列是纯文本(不是 <input>),标题读 textContent。 */
const firstCol = (): string[] => dataRows().map((r) => r.querySelectorAll('.amx-db-cell')[0].textContent ?? '')
const headBtn = (name: string): HTMLElement => {
  const hit = [...host().querySelectorAll<HTMLElement>('.amx-db-hrow .amx-db-thbtn')].find((b) => b.querySelector('.amx-db-th-name')?.textContent === name)
  if (!hit) throw new Error(`没有表头:${name}`)
  return hit
}
const click = async (el: Element): Promise<void> => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

type Props = Record<string, unknown>
async function mount(props: Props): Promise<void> {
  const { DatabaseEmbed } = await import('./DatabaseEmbed')
  document.body.innerHTML = '<div id="host"></div>'
  root = createRoot(host())
  await act(async () => { root!.render(createElement(DatabaseEmbed, props)) })
}
async function rerender(props: Props): Promise<void> {
  const { DatabaseEmbed } = await import('./DatabaseEmbed')
  await act(async () => { root!.render(createElement(DatabaseEmbed, props)) })
}
afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  document.body.innerHTML = ''
  const { useDbStore } = await import('../../store/dbStore')
  useDbStore.setState({ entries: {} })
})

describe('内存源 / 只读 / 开行接缝', () => {
  it('内存源渲染行列,且**一个字节都不进 dbStore**(entries 恒空 —— 否则切库 gen 一扫就变「文件缺失」)', async () => {
    const { useDbStore } = await import('../../store/dbStore')
    useDbStore.setState({ entries: {} })
    await mount({ db: memDb(), readOnly: true })
    expect(dataRows()).toHaveLength(3)
    expect(firstCol()).toEqual(['乙', '甲', '丙'])
    expect(Object.keys(useDbStore.getState().entries)).toEqual([])
  })

  it('只读:写入入口一个不剩(加行/加列/删行/新建/加视图 + 常驻输入控件)', async () => {
    await mount({ db: memDb(), readOnly: true })
    const h = host()
    expect(h.querySelectorAll('.amx-db-addrow')).toHaveLength(0)
    expect(h.querySelectorAll('.amx-db-addcol')).toHaveLength(0)
    expect(h.querySelectorAll('.amx-db-rowdel')).toHaveLength(0)
    expect(h.querySelectorAll('.amx-db-rowdrag')).toHaveLength(0)
    expect(h.querySelectorAll('.amx-db-newbtn')).toHaveLength(0)
    expect(h.querySelectorAll('.amx-db-viewadd')).toHaveLength(0)
    // 常驻受控 input 是可编辑表的形态(text/number/date/default 全是),只读表一个都不该有
    expect(h.querySelectorAll('.amx-db-input')).toHaveLength(0)
    expect(h.querySelectorAll('input[type="checkbox"]:not([disabled])')).toHaveLength(0)
    expect(h.querySelectorAll('input[type="checkbox"][disabled]')).toHaveLength(3)
  })

  it('只读:行首 28px 槽位仍恰好一格(表头/统计行与数据行的网格轨道靠它对齐,check:erp E9)', async () => {
    await mount({ db: memDb(), readOnly: true })
    const gutters = dataRows()[0].querySelectorAll('.amx-db-rowgutter')
    expect(gutters).toHaveLength(1)
    expect(gutters[0].children).toHaveLength(0) // 拖柄/删除都撤了,格子本身留着
    // 每行的直接子元素数 = 1(槽位) + 列数 + 1(末位占位),与表头行逐格对齐
    const cols = host().querySelectorAll('.amx-db-hrow .amx-db-th').length
    expect(dataRows()[0].children).toHaveLength(cols + 2)
    expect(host().querySelector('.amx-db-hrow')!.children).toHaveLength(cols + 2)
  })

  it('只读:不分发给可编辑 Cell,cellMeta 的装饰(双行/色调/状态点/等宽/头像/attrs/text 覆盖)全部落到 DOM', async () => {
    await mount({ db: memDb(), readOnly: true, cellMeta: meta() })
    const c = (r: number, i: number): HTMLElement => dataRows()[r].querySelectorAll<HTMLElement>('.amx-db-cell')[i]
    const n1 = c(0, 0)
    expect(n1.querySelector('.amx-db-rocell')).toBeTruthy()
    expect(n1.getAttribute('data-probe')).toBe('n1') // meta.attrs 落在格子上
    expect(n1.querySelector('.amx-db-rosub')?.textContent).toBe('gpt-乙')
    expect(n1.querySelector('.amx-db-tone-accent')).toBeTruthy()
    expect(n1.querySelector('.amx-db-dot--green')).toBeTruthy()
    expect(n1.querySelector('.amx-db-rocell')?.getAttribute('title')).toBe('第一行')
    // 头像:src 缺失 → img 隐、字母面出;hook 成对(宿主的探针两侧都查得到)
    expect(n1.querySelector('img[data-hook="fb-avatar"]')?.hasAttribute('hidden')).toBe(true)
    const fb = n1.querySelector<HTMLElement>('[data-hook="fb-avatar-fb"]')!
    expect(fb.hasAttribute('hidden')).toBe(false)
    expect(fb.textContent).toBe('Y')
    expect(c(1, 0).querySelector('.amx-db-romono')).toBeTruthy()
    // meta.text 压过一切(复合格:cells 里放的是排序键,屏幕上另有其字)
    expect(c(2, 1).textContent).toContain('按量计费')
    // 没有 meta 的数字列仍走 formatNumber
    expect(c(0, 1).textContent).toBe('3')
    // url 列渲成真链接,不是编辑框
    expect(c(0, 4).querySelector('a.amx-db-url')?.getAttribute('href')).toBe('https://a.example')
  })

  it('动作列渲原生 <button data-act>(宿主的委托监听要收得到),disabled 照传', async () => {
    await mount({ db: memDb(), readOnly: true, cellMeta: meta() })
    const btns = dataRows()[0].querySelectorAll<HTMLButtonElement>('.amx-db-actbtn')
    expect([...btns].map((b) => b.dataset.act)).toEqual(['m-edit', 'm-del'])
    expect(btns[0].tagName).toBe('BUTTON')
    expect(btns[0].dataset.id).toBe('r1')
    expect(btns[1].disabled).toBe(true)
    expect(btns[1].dataset.tone).toBe('red')
  })

  it('表头点击就地排序并回调 onSort;`db` prop 换新数据后排序还在(视图态本地、行列来自 props)', async () => {
    const sorted: unknown[] = []
    const onSort = (s: unknown): void => { sorted.push(s) }
    const p = { db: memDb(), readOnly: true, onSort }
    await mount(p)
    expect(firstCol()).toEqual(['乙', '甲', '丙'])
    await click(headBtn('单价'))
    expect(firstCol()).toEqual(['乙', '丙', '甲']) // 3 / 7 / 12
    expect(sorted).toEqual([{ colId: 'cost', dir: 'asc' }])
    await click(headBtn('单价'))
    expect(firstCol()).toEqual(['甲', '丙', '乙'])
    expect(sorted[1]).toEqual({ colId: 'cost', dir: 'desc' })
    // REST 轮询回来一份新数据(新对象身份):行变了、排序不能丢
    const next = memDb()
    next.rows = [...next.rows, { id: 'r4', cells: { name: '丁', cost: 1 } }]
    await rerender({ ...p, db: next })
    expect(firstCol()).toEqual(['甲', '丙', '乙', '丁'])
  })

  it('initialSort 挂载即生效', async () => {
    await mount({ db: memDb(), readOnly: true, initialSort: { colId: 'name', dir: 'asc' } })
    expect(firstCol()).toEqual(['丙', '甲', '乙'])
  })

  it('onRowOpen:点行开一次;点动作按钮不开行;rowAttrs 落在行上;selectedRowId 上高亮类', async () => {
    const opened: string[] = []
    await mount({
      db: memDb(),
      readOnly: true,
      cellMeta: meta(),
      selectedRowId: 'r2',
      rowAttrs: (r: DbRow) => ({ 'data-act': 'open-model', 'data-name': String(r.cells.name ?? '') }),
      onRowOpen: (r: DbRow) => { opened.push(r.id) },
    })
    const rows = dataRows()
    expect(rows[0].getAttribute('data-act')).toBe('open-model')
    expect(rows[0].getAttribute('data-name')).toBe('乙')
    expect(rows[1].className).toContain('amx-db-row--selected')
    expect(rows[0].className).not.toContain('amx-db-row--selected')

    await click(rows[0].querySelectorAll('.amx-db-cell')[0])
    expect(opened).toEqual(['r1']) // 恰好一次

    await click(rows[0].querySelector('.amx-db-actbtn')!)
    expect(opened).toEqual(['r1']) // 点按钮不连带开行

    await act(async () => { rows[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(opened).toEqual(['r1', 'r2'])
  })

  it('popHost:遮罩与浮层一起 portal 出去(只搬浮层就点不掉);点弹层里面不关、点外面才关', async () => {
    const popHost = document.createElement('div')
    document.body.appendChild(popHost)
    await mount({ db: memDb(), readOnly: true, popHost })
    // 只读表的列菜单退到右键
    await act(async () => { headBtn('单价').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })) })
    expect(popHost.querySelector('.amx-db-pop')).toBeTruthy()
    expect(popHost.querySelector('.amx-db-popwrap')).toBeTruthy() // 遮罩也搬过来了
    expect(host().querySelector('.amx-db-pop')).toBeFalsy()

    await act(async () => { popHost.querySelector('.amx-db-pop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(popHost.querySelector('.amx-db-pop')).toBeTruthy() // 点里面不关

    await act(async () => { popHost.querySelector('.amx-db-popwrap')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(popHost.querySelector('.amx-db-pop')).toBeFalsy() // 点外面才关
    popHost.remove()
  })

  it('hideHead:标题行 + 「以页面打开」不渲染,筛选/搜索/视图菜单照留(那才是用原生表的理由)', async () => {
    await mount({ db: memDb(), readOnly: true, hideHead: true })
    const h = host()
    expect(h.querySelectorAll('.amx-db-head')).toHaveLength(0)
    expect(h.querySelectorAll('.amx-db-name')).toHaveLength(0)
    expect(h.querySelectorAll('[aria-label="open as page"]')).toHaveLength(0)
    expect(h.querySelectorAll('.amx-db-viewtab')).toHaveLength(0) // 只有一个视图,tab 条不占行
    expect(h.querySelectorAll('.amx-db-filterbtn')).toHaveLength(3) // 分组 + 筛选 + 默认开启的自适应列宽
    expect(h.querySelector('.amx-db-autosize')?.getAttribute('aria-pressed')).toBe('true')
    expect(h.querySelectorAll('.amx-db-search')).toHaveLength(1)
    expect(h.querySelectorAll('[aria-label="view settings"]')).toHaveLength(1)
  })

  it('**真文件**只读挂载:表头排序照常可用,但 dbStore.mutate 一次都不许被调(视图态只落本地)', async () => {
    const { useDbStore } = await import('../../store/dbStore')
    const { usePageStore } = await import('../../store/pageStore')
    const mutate = vi.fn()
    // ⚠️ 不能 vi.spyOn(getState(), 'mutate'):后面任何 setState 都会换掉那个 state 对象,spy 就落空了。
    useDbStore.setState({ entries: { [REF]: { status: 'ok', path: REF, data: memDb() } }, mutate })
    usePageStore.setState({ pages: [], files: [REF] })
    await mount({ target: REF, pagePath: 'n.md', readOnly: true })
    expect(dataRows()).toHaveLength(3)
    await click(headBtn('单价'))
    expect(firstCol()).toEqual(['乙', '丙', '甲']) // 就地重排了
    expect(mutate).toHaveBeenCalledTimes(0) // 但一个字节都没往文件那边写
    expect(host().querySelectorAll('.amx-db-addrow')).toHaveLength(0)
  })
})

describe('只读格渲染(评审 09-05 补钉)', () => {
  const db = (): DbFile => ({
    version: 1,
    name: 't',
    columns: [
      { id: 'name', name: '名称', type: 'text' },
      { id: 'n', name: '数量', type: 'number' },
      { id: 'at', name: '时间', type: 'date' },
      { id: 'st', name: '状态', type: 'select', options: ['ok', 'bad'] },
    ],
    rows: [
      { id: 'a', cells: { name: 'A', n: 1234567, at: '2026-09-05T02:00:00.000Z', st: 'ok' } },
      { id: 'b', cells: { name: 'B', n: 7, at: '2026-08-01T00:00:00.000Z', st: 'bad' } },
    ],
  })
  const cellMeta = (): DbCellMeta => ({
    a: {
      name: { avatar: { src: null, letter: 'A', attrs: { 'data-hook': 'fb-avatar', 'data-avatar': 'u-a' } } },
      at: { format: 'datetime' },
      st: { text: '成功', tone: 'green' },
    },
    b: {
      name: { avatar: { src: 'data:image/png;base64,iVBORw0KGgo=', letter: 'B', attrs: { 'data-hook': 'fb-avatar', 'data-avatar': 'u-b' } } },
      at: { format: 'datetime' },
      st: { text: '失败', tone: 'red' },
    },
  })
  const cell = (rowIdx: number, colIdx: number): HTMLElement => dataRows()[rowIdx].querySelectorAll<HTMLElement>('.amx-db-cell')[colIdx]

  it('懒加载头像的 attrs 落在恒可见的外壳上(不是 hidden 的 img),img / 字母面按 src 互为 hidden', async () => {
    await mount({ db: db(), readOnly: true, cellMeta: cellMeta() })
    const probes = host().querySelectorAll<HTMLElement>('[data-avatar]')
    expect(probes).toHaveLength(2)
    for (const p of probes) {
      expect(p.classList.contains('amx-db-avatar')).toBe(true) // 外壳,IntersectionObserver 观察它才会相交
      expect(p.hasAttribute('hidden')).toBe(false)
    }
    const a = cell(0, 0), b = cell(1, 0)
    expect(a.querySelector('img[data-hook="fb-avatar"]')?.hasAttribute('hidden')).toBe(true)
    expect(a.querySelector('[data-hook="fb-avatar-fb"]')?.hasAttribute('hidden')).toBe(false)
    expect(b.querySelector('img[data-hook="fb-avatar"]')?.hasAttribute('hidden')).toBe(false)
    expect(b.querySelector('[data-hook="fb-avatar-fb"]')?.hasAttribute('hidden')).toBe(true)
  })

  it('数字按千分位、日期按 meta.format 格式化(不许裸 ISO 上屏)、select 按 tone 取语义色芯片', async () => {
    await mount({ db: db(), readOnly: true, cellMeta: cellMeta() })
    expect(cell(0, 1).textContent).toContain((1234567).toLocaleString())
    expect(cell(0, 2).textContent).not.toContain('T02:00:00')
    expect(cell(0, 2).textContent?.trim()).not.toBe('')
    expect(cell(0, 3).querySelector('.amx-db-chip--green')?.textContent).toBe('成功')
    expect(cell(1, 3).querySelector('.amx-db-chip--red')?.textContent).toBe('失败')
    expect(cell(0, 3).querySelector('[class*="amx-chip-c"]')).toBeNull() // 有 tone 就不按 label 哈希取色
  })

  it('没给 onRowOpen 的只读行不是 role=button(不给用户空承诺的手型与 tab 停靠点)', async () => {
    await mount({ db: db(), readOnly: true, cellMeta: cellMeta() })
    for (const r of dataRows()) expect(r.getAttribute('role')).toBeNull()
  })
})

describe('hideTools(分页数据 partial)', () => {
  it('整条工具栏(视图条 / 筛选 / 搜索 / 导出 / 视图设置)不渲,表体照常', async () => {
    const db: DbFile = { version: 1, name: 't', columns: [{ id: 'name', name: '名称', type: 'text' }], rows: [{ id: 'a', cells: { name: 'A' } }] }
    await mount({ db, readOnly: true, hideHead: true, hideTools: true })
    expect(host().querySelectorAll('.amx-db-viewbar, .amx-db-filterbtn, .amx-db-search')).toHaveLength(0)
    expect(dataRows()).toHaveLength(1)
  })
})

describe('自适应列宽', () => {
  it('旧表默认开启并忽略既有坏宽；关闭时保留当前观感，按钮状态可再开启', async () => {
    const db: DbFile = {
      version: 1,
      name: '用户',
      columns: [
        { id: 'user', name: '用户', type: 'text', width: 800 },
        { id: 'role', name: '角色', type: 'select', width: 800 },
      ],
      rows: [{ id: 'u1', cells: { user: 'someone_1788504658526', role: 'USER' } }],
    }
    const cellMeta: DbCellMeta = { u1: { user: { sub: '副内容'.repeat(500) } } }
    await mount({ db, readOnly: true, cellMeta })

    const button = host().querySelector<HTMLButtonElement>('.amx-db-autosize')!
    const header = host().querySelector<HTMLElement>('.amx-db-hrow')!
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(header.style.gridTemplateColumns).not.toContain('800px')
    const autoGrid = header.style.gridTemplateColumns
    const widths = autoGrid.match(/\d+px/g)?.map((value) => Number.parseInt(value, 10)) ?? []
    expect(widths[1]).toBeGreaterThan(widths[2]) // user 主内容长，role=USER 收到 100px
    expect(widths[2]).toBe(100)

    await click(button)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(header.style.gridTemplateColumns).toBe(autoGrid) // 关掉时先复制当前宽，不跳回旧的 800px
    await click(button)
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })
})
