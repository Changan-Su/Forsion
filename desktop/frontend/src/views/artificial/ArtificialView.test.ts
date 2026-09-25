// @vitest-environment happy-dom
/**
 * 造物栅格的两条**接线**闸(2026-09-21 对抗评审 #6 + 桥接口新增的兜底文件名)。
 *
 *  · **相对时间自己走**:基准时刻取自渲染期的 `Date.now()` 时,它只在栅格重渲染(装载 / 刷新 /
 *    窗口重新聚焦)时才动。这块栅格常被丢在副屏上开一整天 —— 一小时后它还写着「5 分钟前」,
 *    而且没有任何报错,只能靠这条断言钉住。
 *  · **落盘产物命名跟随界面语言**:`productsShortcut(id, fallbackName)` 的第二个参数是作品名
 *    清洗后为空时桌面上用的文件名。调用点不传,主进程就只能写死一个语言 —— 切了英文照样生出中文文件名。
 *
 * 引擎 / appStore / 工作室三个外部面打桩;i18n 用真的(要验的正是「文案是不是当前语言的」)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ProductSummary } from '../../../../shared/products'
import { translate } from '../../i18n'
import { relativeTime } from './productKinds'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const ws = vi.hoisted(() => ({ openView: vi.fn() }))
vi.mock('@lcl/engine', () => ({
  // 「⋯」菜单(CapabilityMenu)的浮层与首读骨架:这里只要能渲染出来,几何不归本测试管。
  OverlayAt: ({ children, innerRef, x: _x, y: _y, anchorTop: _top, ...rest }: Record<string, unknown> & { children?: unknown; innerRef?: (el: HTMLDivElement | null) => void }) =>
    createElement('div', { ...rest, ref: innerRef }, children as never),
  Skeleton: () => createElement('div', { 'data-skeleton': true }),
  getView: (type: string) => (type === 'code-studio' ? { type } : undefined),
  setActiveSpace: vi.fn(),
  useSpaceStore: (select: (s: { spaces: Array<{ id: string }> }) => unknown) => select({ spaces: [{ id: 'coding' }] }),
  useWorkspace: { getState: () => ({ openView: ws.openView }) },
}))
vi.mock('@amadeus/components/askString', () => ({ askString: vi.fn(async () => null) }))
const shell = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('../../stores/appStore', () => ({ useApp: { getState: () => ({ toast: shell.toast }) } }))
vi.mock('../../stores/codeStudioStore', () => ({ useCodeStudio: { getState: () => ({ openProject: vi.fn() }) } }))

const { ArtificialView } = await import('./ArtificialView')
const { resetProductsStore, useProducts } = await import('./productsStore')

const ID = 'p_0123456789ab'
/** 2026-09-21 12:00 UTC。固定基准,断言不看跑测机器当天日期的脸色。 */
const BASE = Date.UTC(2026, 8, 21, 12, 0, 0)

const productOf = (patch: Partial<ProductSummary> = {}): ProductSummary => ({
  id: ID, kind: 'web', name: 'Pocket timer', root: '/Projects/pocket-timer', entry: 'index.html',
  createdAt: BASE, updatedAt: BASE, published: false, ...patch,
})

let host: HTMLDivElement
let reactRoot: Root
let rows: ProductSummary[]
const productsList = vi.fn(async () => rows)
const productsShortcut = vi.fn(async () => ({ ok: true as const, path: '/Desktop/x.app' }))

beforeEach(() => {
  // Date 也要钉住(相对时间的基准);只假造这三样,别动 React 用来排程的那些。
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(BASE)
  rows = [productOf()]
  productsList.mockClear(); productsShortcut.mockClear(); shell.toast.mockClear()
  resetProductsStore() // 栅格数据住模块级缓存:每条用例从「没加载过」起步,不吃上一条的行
  window.tangu = { productsList, productsShortcut } as unknown as typeof window.tangu
  host = document.createElement('div'); document.body.append(host)
  reactRoot = createRoot(host)
})
afterEach(async () => {
  await act(async () => { reactRoot.unmount() })
  host.remove(); delete window.tangu
  vi.useRealTimers()
})

async function mount(): Promise<void> {
  await act(async () => { reactRoot.render(createElement(ArtificialView)) })
}
const stamp = (): string => host.querySelector('.art-card-meta span')?.textContent ?? ''

describe('造物栅格:相对时间', () => {
  it('⚠️栅格开着的时候「几分钟前」自己走,不会停在装载那一刻', async () => {
    rows = [productOf({ updatedAt: BASE - 60_000 })]
    await mount()
    expect(stamp()).toBe(relativeTime(BASE - 60_000, BASE, 'zh'))

    // 没有任何交互,纯粹是时间过去了 5 分钟(副屏上摊着的那块栅格)。
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })

    expect(stamp()).toBe(relativeTime(BASE - 60_000, BASE + 5 * 60_000, 'zh'))
    expect(stamp()).not.toBe(relativeTime(BASE - 60_000, BASE, 'zh'))
    // 自走的是时钟,不是重新扫盘:不许因此多打一遍主进程。
    expect(productsList).toHaveBeenCalledTimes(1)
  })

  it('卸载后不再有定时器在跑', async () => {
    await mount()
    await act(async () => { reactRoot.unmount() })
    expect(vi.getTimerCount()).toBe(0)
    // afterEach 会再 unmount 一次(幂等),这里先把根建回来免得它对着已卸载的根报错。
    host.remove(); host = document.createElement('div'); document.body.append(host)
    reactRoot = createRoot(host)
  })
})

describe('造物栅格:添加到桌面', () => {
  it('⚠️把**本地化的**兜底文件名一起交给主进程(作品名清洗后可能什么都不剩)', async () => {
    rows = [productOf({ name: '★' })]
    await mount()
    // 次要动作都收进了「⋯」(U-13):先开菜单,再点菜单项(菜单 portal 到 body)。
    await act(async () => { host.querySelector<HTMLButtonElement>('.art-card-more')!.click() })
    const item = document.body.querySelector<HTMLButtonElement>(`[role="menuitem"][aria-label="${translate('artificial.action.shortcut')}"]`)
    expect(item, '「添加到桌面」应在「⋯」菜单里').toBeTruthy()
    await act(async () => { item!.click() })

    expect(productsShortcut).toHaveBeenCalledWith(ID, translate('artificial.shortcut.fallbackName'))
    // 钉住它确实是**文案**而不是键:少了 en 词条时 i18nCoverage 会红,这里钉当前语言那一侧。
    expect(translate('artificial.shortcut.fallbackName')).toBe('Forsion 应用')
    expect(shell.toast).toHaveBeenCalledWith(translate('artificial.toast.shortcutOk'), false)
  })
})

describe('打开作品', () => {
  it('⚠️走**新标签页**:主区 openView 默认就地导航,会把栅格这一页换成作品 —— 重启后回不到栅格', async () => {
    ws.openView.mockClear()
    await mount()
    await act(async () => { (host.querySelector('[data-action="open"]') as HTMLButtonElement).click() })
    expect(ws.openView).toHaveBeenCalledWith('product', { id: ID }, 'main', { newTab: true })
  })
})

describe('卡片层级(U-13)', () => {
  it('卡面只剩主动作 + 「⋯」;移到废纸篓在菜单最后且标 danger', async () => {
    window.tangu = { productsList, productsShortcut, productsTrash: vi.fn(), productsUpdate: vi.fn(), revealHostPath: vi.fn() } as unknown as typeof window.tangu
    await mount()
    const card = host.querySelector('[data-artificial-card]')!
    expect([...card.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action'))).toEqual(['open'])
    await act(async () => { card.querySelector<HTMLButtonElement>('.art-card-more')!.click() })
    const items = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(items.at(-1)!.getAttribute('aria-label')).toBe(translate('artificial.action.trash'))
    expect(items.at(-1)!.classList.contains('danger')).toBe(true)
    expect(items.slice(0, -1).some((b) => b.classList.contains('danger'))).toBe(false)
  })
})

describe('再次进入不闪(U-39)', () => {
  it('有旧栅格时先画旧的、后台重扫,不回到加载态', async () => {
    await mount()
    expect(useProducts.getState().status).toBe('ready')
    await act(async () => { reactRoot.unmount() })
    host.remove(); host = document.createElement('div'); document.body.append(host)
    reactRoot = createRoot(host)
    let release: (rows: ProductSummary[]) => void = () => {}
    productsList.mockImplementationOnce(() => new Promise<ProductSummary[]>((resolve) => { release = resolve }))
    await act(async () => { reactRoot.render(createElement(ArtificialView)) })
    // 重扫还没回来:栅格已经在,没有加载态
    expect(host.querySelector('[data-artificial-card]')).toBeTruthy()
    expect(host.querySelector('[data-state="loading"]')).toBeNull()
    await act(async () => { release([productOf({ name: 'Renamed' })]) })
    expect(host.querySelector('.art-card-name')?.textContent).toBe('Renamed')
  })

  it('已有栅格时后台重扫失败不清屏', async () => {
    await mount()
    productsList.mockImplementationOnce(async () => { throw new Error('disk gone') })
    await act(async () => { await useProducts.getState().load() })
    expect(useProducts.getState().status).toBe('ready')
    expect(host.querySelector('[data-artificial-card]')).toBeTruthy()
  })

  it('第一次进入没有数据时:骨架 + 读屏状态句,不是转圈', async () => {
    productsList.mockImplementationOnce(() => new Promise<ProductSummary[]>(() => {}))
    await mount()
    const loading = host.querySelector('[data-state="loading"]')!
    expect(loading.querySelector('[data-skeleton]')).toBeTruthy()
    expect(loading.querySelector('[role="status"]')?.textContent).toBe(translate('artificial.loading'))
    expect(host.querySelector('.spin')).toBeNull()
  })
})
