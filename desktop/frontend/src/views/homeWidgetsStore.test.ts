// @vitest-environment happy-dom
// 摆放存储的读写纪律(主页插件化 H2,2026-11-09 Codex 评审补):插件读核对存储原文、出参是拷贝、读不到时改的那份不盖真摆放
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../telemetrySend', () => ({ countTelemetry: vi.fn() }))

type Mod = typeof import('./homeWidgets')
let m: Mod
const real = { left: [], center: ['composer', 'row'], row: [], right: ['builtin:notes'] }
const other = { left: [], center: ['composer', 'row'], row: [], right: ['builtin:inbox'] }

beforeEach(async () => {
  vi.restoreAllMocks()
  localStorage.clear()
  vi.resetModules() // 模块里有缓存:每条从干净的模块状态起
  m = await import('./homeWidgets')
})

describe('home layout store', () => {
  it('插件读法每次核对存储原文:别的窗口刚存过、storage 事件还没到,也读到新的', () => {
    localStorage.setItem(m.HOME_WIDGETS_KEY, JSON.stringify(real))
    expect(m.readStoredHomeLayout()!.right).toEqual(['builtin:notes'])
    localStorage.setItem(m.HOME_WIDGETS_KEY, JSON.stringify(other)) // 同窗口 setItem 不发 storage 事件 = 别的窗口写了、事件没到
    expect(m.readStoredHomeLayout()!.right).toEqual(['builtin:inbox'])
    expect(m.readHomeLayout().right).toEqual(['builtin:inbox'])
  })

  it('交给插件的是拷贝:插件改它碰不到宿主缓存', () => {
    localStorage.setItem(m.HOME_WIDGETS_KEY, JSON.stringify(real))
    const r = m.readStoredHomeLayout()!
    r.right.push('builtin:inbox')
    r.row.push({ id: 'w_x', w: 2 })
    expect(m.readStoredHomeLayout()!.right).toEqual(['builtin:notes'])
    expect(m.readHomeLayout().row).toEqual([])
  })

  it('读不到时在缺省上改的那份,存储恢复后不写回、不盖真摆放', () => {
    localStorage.setItem(m.HOME_WIDGETS_KEY, JSON.stringify(real))
    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const shown = m.readHomeLayout()
    expect(shown).toEqual(m.DEFAULT_HOME_LAYOUT)
    expect(m.readStoredHomeLayoutState()).toEqual({ layout: null, failed: true })
    get.mockRestore() // 存储恢复
    m.saveHomeLayout({ ...shown, right: [] })
    expect(JSON.parse(localStorage.getItem(m.HOME_WIDGETS_KEY)!).right).toEqual(['builtin:notes'])
    expect(m.readHomeLayout().right).toEqual(['builtin:notes'])
  })

  it('一直读得到时照常写', () => {
    localStorage.setItem(m.HOME_WIDGETS_KEY, JSON.stringify(real))
    m.saveHomeLayout({ ...m.readHomeLayout(), right: ['builtin:sessions'] })
    expect(JSON.parse(localStorage.getItem(m.HOME_WIDGETS_KEY)!).right).toEqual(['builtin:sessions'])
    expect(m.readStoredHomeLayout()!.right).toEqual(['builtin:sessions'])
  })
})
