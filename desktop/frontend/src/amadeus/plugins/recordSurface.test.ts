// @vitest-environment happy-dom
/** ctx.ui.mountRecord(2026-10-17):宿主行编辑字段挂进插件容器 —— 标题 / 时间 / 属性画出来,改了走 setAggName / setAggCell
 *  (和打开着的表格同一份 store),行被删就什么都不画,readOnly 没有输入框,dispose 把 el 还回去;只有声明 'databases' 才有,
 *  路径不是库里的表当场抛。
 *  负对照(10-17 实跑红):pluginStore 里 mountRecord 改成恒注入 → 闸那条红;不校验 path → 「当场抛」红;
 *  RecordFields 忽略 lock → readOnly 那条红;dateCol 不查列类型 → 「不是日期类列」红。 */
import { act } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DbFile } from '@amadeus-shared/db/schema'

let disk: DbFile
const readDatabase = vi.fn(async (p: string) => (p === 'T.db'
  ? { status: 'ok' as const, path: 'T.db', data: structuredClone(disk), version: 'v0' }
  : { status: 'missing' as const }))
vi.mock('../api', () => ({
  amadeus: {
    get readDatabase() { return readDatabase },
    writeDatabaseCas: async (_p: string, d: DbFile) => { disk = structuredClone(d); return { ok: true, version: 'v1' } },
    writeDatabase: async () => {},
    listMarks: async () => [],
    onDbExternalChange: undefined,
  },
}))
vi.mock('../store/automationKick', () => ({ kickAutomation: () => {}, setAutomationKick: () => {} }))
vi.mock('../../amadeusPlugins', () => ({ ensureAmadeusReady: () => {} }))

const { useDbStore } = await import('../store/dbStore')
const { usePageStore } = await import('../store/pageStore')
const { mountPluginRecord } = await import('./recordSurface')
const { usePluginStore } = await import('./pluginStore')
const { setLocaleGlobal } = await import('../../i18n')
type Ctx = import('./types').PluginContext

let el: HTMLDivElement
let handle: { update(p: object): void; dispose(): void } | null = null
const rows = (): DbFile['rows'] => (useDbStore.getState().entries['T.db'].data as DbFile).rows

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setLocaleGlobal('zh')
  disk = {
    version: 1, name: 'T',
    columns: [
      { id: 'c1', name: '名称', type: 'text' },
      { id: 'd1', name: '日期', type: 'calendarDate' },
      { id: 'k1', name: '完成', type: 'checkbox' },
      { id: 'n1', name: '备注', type: 'text' },
    ],
    rows: [{ id: 'r1', cells: { c1: '周会', d1: '2026-10-20T09:00/2026-10-20T10:00', n1: '带材料' } }],
  }
  useDbStore.setState({ entries: {} })
  usePageStore.setState({ vaultRoot: '/V', vaultSide: 'local', files: ['T.db'], filesPendingFor: null })
  await useDbStore.getState().reload('T.db', 'T.db')
  el = document.createElement('div')
  document.body.append(el)
})
afterEach(async () => {
  await act(async () => { handle?.dispose() })
  handle = null
  el.remove()
  await useDbStore.getState().flushAll()
  vi.unstubAllGlobals()
})

const mount = async (opts: { readOnly?: boolean } = {}): Promise<void> => {
  await act(async () => { handle = mountPluginRecord(el, { path: 'T.db', rowId: 'r1', dateCol: 'd1', ...opts }) })
}

describe('ctx.ui.mountRecord 的画面', () => {
  it('标题、时间摘要、其余属性都在;改标题 / 改属性写进同一份 store', async () => {
    await mount()
    const title = el.querySelector<HTMLInputElement>('.amx-cal-card-title')!
    expect(title.value).toBe('周会')
    expect(el.querySelector('.amx-cal-card-timebtn')).toBeTruthy()
    const keys = [...el.querySelectorAll('.amx-cal-card-keyt')].map((n) => n.textContent)
    expect(keys).toEqual(['完成', '备注']) // 日期列当时间行,不再重复列一遍
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      const note = el.querySelector<HTMLInputElement>('input[aria-label="备注"]')!
      setter.call(note, '改过的')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rows()[0].cells.n1).toBe('改过的')
    await act(async () => { el.querySelector<HTMLInputElement>('input[aria-label="完成"]')!.click() })
    expect(rows()[0].cells.k1).toBe(true)
  })

  it('dateCol 不是日期类列:不当时间行(不出日期编辑器),那一列照常列在属性里', async () => {
    await act(async () => { handle = mountPluginRecord(el, { path: 'T.db', rowId: 'r1', dateCol: 'n1' }) })
    const keys = [...el.querySelectorAll('.amx-cal-card-keyt')].map((n) => n.textContent)
    expect(keys).toContain('备注')
    expect(el.querySelector('.amx-cal-card-timerow')).toBeNull()
    expect(rows()[0].cells.n1).toBe('带材料')
  })

  it('readOnly:只显示值,没有输入框', async () => {
    await mount({ readOnly: true })
    expect(el.querySelectorAll('input, select').length).toBe(0)
    expect(el.textContent).toContain('带材料')
  })

  it('行被删了:什么都不画;dispose 之后 el 还回来', async () => {
    await mount()
    await act(async () => { useDbStore.setState((s) => ({ entries: { ...s.entries, 'T.db': { ...s.entries['T.db'], data: { ...(s.entries['T.db'].data as DbFile), rows: [] } } } })) })
    expect(el.querySelector('.amx-cal-card-title')).toBeNull()
    await act(async () => { handle!.dispose() })
    handle = null
    expect(el.childNodes.length).toBe(0)
  })
})

describe('ctx.ui.mountRecord 的闸', () => {
  const ctxWith = (caps?: string[]): Ctx => {
    let ref: Ctx | null = null
    usePluginStore.setState({ initialized: false, plugins: [], activeIds: [], disabledIds: [], disposers: {} })
    usePluginStore.getState().init([{ id: 'rec', name: 'rec', version: '0', ...(caps ? { capabilities: caps as never } : {}), setup: (c) => { ref = c } }])
    return ref!
  }
  it("只有声明 'databases' 才有;路径不是库里的表 / 没有 rowId 当场抛", () => {
    expect(ctxWith().ui?.mountRecord).toBeUndefined()
    expect(ctxWith(['calendar']).ui?.mountRecord).toBeUndefined()
    const ui = ctxWith(['databases']).ui!
    expect(typeof ui.mountRecord).toBe('function')
    expect(() => ui.mountRecord!(el, { path: '不在库里.db', rowId: 'r1' })).toThrow(TypeError)
    expect(() => ui.mountRecord!(el, { path: 'T.db' } as never)).toThrow(TypeError)
    const h = ui.mountRecord!(el, { path: 'T.db', rowId: 'r1' })
    h.dispose()
  })
})
