// @vitest-environment happy-dom
/**
 * `product` 视图的三条**行为**闸(2026-09-21 对抗评审 #4 / #5 / #7)。纯逻辑那半在 productKinds.test.ts,
 * 这里量的是接线 —— 每一条都只有真把组件挂起来才看得见:
 *
 *  · **面板激活**:guest 被 StudioGuestSurface 传送到壳上,落在 Dockview 的焦点捕获容器**之外**。
 *    不把 onActivate 接回 activateLeaf,就会出现「左聊天右作品,点了右边跑着的网页,
 *    活动标签还停在左边」—— 关标签、标签命令全打到别的面板上。
 *  · **序号闸**:productsServe 是异步的,连点重载会有两个应答同时在飞,而**先落地的不一定是后发的**;
 *    卸载之后回来的那一个更不许再动 state(它还会顺手去取一次档案)。
 *  · **永久性拒绝**:主进程的 `product has no web entry` 是这一类作品的定性,不是一次失败。
 *    给「继续编辑」,不给一颗永远点不出结果的重试。
 *
 * 引擎 / 工作室 / guest 三个外部面都打桩:这里要验的是本视图**怎么用**它们,不是它们自己。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ProductSummary } from '../../../../shared/products'
import { translate } from '../../i18n'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const engine = vi.hoisted(() => ({
  activateLeaf: vi.fn(),
  setActiveSpace: vi.fn(),
  spaces: [{ id: 'coding' }],
}))
vi.mock('@lcl/engine', () => ({
  getView: (type: string) => (type === 'code-studio' ? { type } : undefined),
  setActiveSpace: (id: string) => engine.setActiveSpace(id),
  useSpaceStore: (select: (s: { spaces: Array<{ id: string }> }) => unknown) => select({ spaces: engine.spaces }),
  useWorkspace: { getState: () => ({ activateLeaf: engine.activateLeaf }) },
}))

/** guest 的承载靠传送 + RAF 几何跟随,单测里没有意义 —— 只把 props 截下来,子树照常渲染。 */
const surface = vi.hoisted(() => ({ props: null as null | { onActivate?: () => void } }))
vi.mock('../coding/StudioGuestSurface', () => ({
  StudioGuestSurface: (props: { onActivate?: () => void; children?: ReactNode }) => {
    surface.props = props
    return createElement('div', { 'data-guest-surface': true }, props.children)
  },
}))

const studio = vi.hoisted(() => ({ openProject: vi.fn() }))
vi.mock('../../stores/codeStudioStore', () => ({
  useCodeStudio: { getState: () => ({ openProject: studio.openProject }) },
}))

const { ProductView } = await import('./ProductView')

const ID = 'p_0123456789ab'
type ServeResult = { origin: string; url: string; product: ProductSummary }
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const productOf = (name: string): ProductSummary => ({
  id: ID, kind: 'web', name, root: `/Projects/${name}`, entry: 'index.html',
  createdAt: 0, updatedAt: 0, published: false,
})
const served = (url: string, name: string): ServeResult => ({ origin: 'http://host', url, product: productOf(name) })

let host: HTMLDivElement
let reactRoot: Root
let mounted = false
let serves: Array<Deferred<ServeResult>>
const setTitle = vi.fn()
const productsServe = vi.fn(() => {
  const pending = deferred<ServeResult>()
  serves.push(pending)
  return pending.promise
})
const productsGet = vi.fn(async () => productOf('Pocket plugin'))

beforeEach(() => {
  serves = []
  engine.activateLeaf.mockClear(); engine.setActiveSpace.mockClear(); studio.openProject.mockClear()
  setTitle.mockClear(); productsServe.mockClear(); productsGet.mockClear()
  surface.props = null
  window.tangu = { productsServe, productsGet } as unknown as typeof window.tangu
  host = document.createElement('div'); document.body.append(host)
  reactRoot = createRoot(host); mounted = true
})
afterEach(async () => {
  if (mounted) await act(async () => { reactRoot.unmount() })
  mounted = false
  host.remove(); delete window.tangu
})

async function mount(params: Record<string, unknown> = { id: ID }): Promise<void> {
  const leaf = { id: 'leaf-1', setTitle } as unknown as Parameters<typeof ProductView>[0]['leaf']
  await act(async () => { reactRoot.render(createElement(ProductView, { leaf, params })) })
}
const q = <T extends Element>(selector: string): T | null => host.querySelector<T>(selector)
const status = (): string | null => q('[data-product-view]')?.getAttribute('data-status') ?? null
const click = async (selector: string): Promise<void> => {
  await act(async () => { q<HTMLButtonElement>(selector)!.click() })
}

describe('造物 / 产物视图:面板激活', () => {
  it('作品跑起来后,点进 guest 要能激活自己这块面板(onActivate → activateLeaf)', async () => {
    await mount()
    await act(async () => { serves[0].resolve(served('http://host/index.html', 'Pocket timer')) })

    expect(status()).toBe('ready')
    expect(q('[data-guest-surface]')).toBeTruthy()
    // 传下去的必须是个稳定回调,而且指向**本 leaf**(传错就等于激活别人的面板)。
    expect(typeof surface.props?.onActivate).toBe('function')
    surface.props!.onActivate!()
    expect(engine.activateLeaf).toHaveBeenCalledWith('leaf-1')
  })
})

describe('造物 / 产物视图:productsServe 的序号闸', () => {
  it('⚠️连点重载:先发后到的应答不许盖掉后发的', async () => {
    await mount()                       // serve #1(在飞)
    await click('[data-action="reload"]') // status 还不是 ready → 再发一次,serve #2
    expect(productsServe).toHaveBeenCalledTimes(2)

    await act(async () => { serves[1].resolve(served('http://host/later.html', 'Later')) })
    await act(async () => { serves[0].resolve(served('http://host/earlier.html', 'Earlier')) })

    expect(q('webview')?.getAttribute('src')).toBe('http://host/later.html')
    expect(q('.art-bar-name')?.textContent).toBe('Later')
  })

  it('⚠️卸载之后回来的应答一律作废(不再取档案、也不落 state)', async () => {
    await mount()
    await act(async () => { reactRoot.unmount() })
    mounted = false

    // 这一条落地会走 unservable 分支 → 再去 productsGet 取档案。序号在卸载时被推进一格,
    // 应答认不出自己就该在 catch 的第一行返回 —— productsGet 一次都不该被调用。
    await act(async () => { serves[0].reject(new Error('product has no web entry')) })
    expect(productsGet).not.toHaveBeenCalled()
  })
})

describe('造物 / 产物视图:永久性拒绝 vs 可重试失败', () => {
  it('没有网页入口 → 专属状态 + 「继续编辑」,不给重试', async () => {
    await mount()
    await act(async () => { serves[0].reject(new Error('product has no web entry')) })

    expect(status()).toBe('unservable')
    expect(q('[data-state="unservable"] .art-state-title')?.textContent).toBe(translate('artificial.product.unservable'))
    expect(q('[data-state="unservable"] p')?.textContent).toBe(translate('artificial.product.unservableBody'))
    // 重试在这里是谎言:主按钮没有,工具条上的重载也按不动。
    expect(q('[data-action="retry"]')).toBeNull()
    expect(q<HTMLButtonElement>('[data-action="reload"]')!.disabled).toBe(true)

    // serve 没给回 product,「继续编辑」的项目根另取一次档案(否则这颗按钮无处可去)。
    expect(productsGet).toHaveBeenCalledWith(ID)
    await click('[data-action="edit-instead"]')
    expect(engine.setActiveSpace).toHaveBeenCalledWith('coding')
  })

  it('瞬时失败仍然是可重试的 error(别把两类混成一句)', async () => {
    await mount()
    await act(async () => { serves[0].reject(new Error('listen EADDRINUSE: address already in use')) })

    expect(status()).toBe('error')
    expect(q('[data-action="retry"]')).toBeTruthy()
    expect(q<HTMLButtonElement>('[data-action="reload"]')!.disabled).toBe(false)
    expect(productsGet).not.toHaveBeenCalled()

    await click('[data-action="retry"]')
    expect(productsServe).toHaveBeenCalledTimes(2)
  })
})
