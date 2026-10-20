// @vitest-environment happy-dom
/** 协议更新提示(TermsUpdateDialog):状态解析、两档按钮、同意 / 不同意各自走哪条路。
 *  负对照(2026-10-19 实跑):① fetchTermsStatus 不看 required → 「不用弹」那条红;② notice 也画「不同意」→ 按钮数那条红;
 *  ③ 409 当成失败 → 「版本又变了就重拉」那条红;④ 不同意时提前关卡 → 「退出前不关」那条红。
 *  Codex 评审后补的四条(同日实跑):⑤ 去掉宿主的账号核对 → 「A 迟到的成功不关 B 的卡」红;⑥ 去掉 15 秒超时 → 超时那条红;
 *  ⑦ notice 记账失败也留卡 → 「notice 照样关」红;⑧ 409 重拉失败当成「不用再确认」→ 「重拉没成功留着卡」红。
 *  ponytail: 用 createElement 而非 JSX(vitest include 只收 .ts)。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// 用一份真 zustand store 顶替 appStore(只要 authInfo):宿主按账号查 / 收卡那条要能换号
vi.mock('../stores/appStore', async () => {
  const { create } = await import('zustand')
  return { useApp: create<{ authInfo: unknown }>(() => ({ authInfo: null })) }
})
const { TermsUpdateDialog, TermsUpdateHost, agreeTerms, fetchTermsStatus, loadTermsStatus } = await import('./TermsUpdateDialog')
const { useApp } = (await import('../stores/appStore')) as unknown as { useApp: { setState(s: unknown): void } }
const { usePopupQueue } = await import('../stores/popupQueue')
type Res = { status: number; json?: any }
const res = (status: number, json: any = {}): Res => ({ status, json })
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

type Bridge = NonNullable<Window['tangu']>
const setBridge = (b: Partial<Bridge> | undefined): void => { (window as unknown as { tangu?: Partial<Bridge> }).tangu = b }

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null; host = null
  setBridge(undefined)
})

const mount = (el: React.ReactElement): HTMLElement => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host
}
const render = (props: Parameters<typeof TermsUpdateDialog>[0]): HTMLElement => mount(createElement(TermsUpdateDialog, props))
const buttons = (el: HTMLElement): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('.terms-foot button')]
const flush = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const STATUS = { latest: '2026-10-19', required: true as const, changes: { zh: '写清数据存放位置', en: 'Where data is stored' } }

describe('fetchTermsStatus / agreeTerms', () => {
  it('required 才弹;404 / 断网 / 不用弹 = null;网页版的专用通道优先于 cloudFetch', async () => {
    const cloudFetch = vi.fn(async (_req: unknown): Promise<Res> => res(200, { latest: 'v2', required: true, mode: 'consent', changes: null }))
    setBridge({ cloudFetch })
    expect(await fetchTermsStatus()).toEqual({ latest: 'v2', required: true, mode: 'consent', changes: null })
    expect(cloudFetch).toHaveBeenCalledWith({ path: '/auth/terms', method: 'GET' })

    cloudFetch.mockResolvedValueOnce({ status: 200, json: { latest: 'v2', required: false, mode: 'notice', changes: null } })
    expect(await fetchTermsStatus()).toBe(null)
    cloudFetch.mockResolvedValueOnce(res(404, null))
    expect(await fetchTermsStatus()).toBe(null)
    cloudFetch.mockRejectedValueOnce(new Error('offline'))
    expect(await fetchTermsStatus()).toBe(null)

    const termsStatus = vi.fn(async (): Promise<Res> => res(200, { latest: 'v3', required: true, mode: 'weird', changes: { zh: 1 } }))
    setBridge({ cloudFetch, termsStatus })
    expect(await fetchTermsStatus()).toEqual({ latest: 'v3', required: true, mode: 'notice', changes: null })
    expect(cloudFetch).toHaveBeenCalledTimes(4)

    setBridge(undefined)
    expect(await fetchTermsStatus()).toBe(null)
  })

  it('loadTermsStatus 区分「不用弹」和「没查成」:404 = none,0 / 5xx / 超时 = error', async () => {
    const cloudFetch = vi.fn(async (_req: unknown): Promise<Res> => res(404, null))
    setBridge({ cloudFetch })
    expect(await loadTermsStatus()).toBe('none')
    cloudFetch.mockResolvedValueOnce(res(500, null))
    expect(await loadTermsStatus()).toBe('error')
    cloudFetch.mockResolvedValueOnce(res(0, null))
    expect(await loadTermsStatus()).toBe('error')
    vi.useFakeTimers()
    try {
      cloudFetch.mockImplementationOnce(() => new Promise<Res>(() => {})) // 一直挂着
      const p = agreeTerms('v2')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await p).toBe('failed')
    } finally { vi.useRealTimers() }
  })

  it('同意:200 ok / 409 stale / 其它 failed,带上版本号', async () => {
    const cloudFetch = vi.fn(async (_req: unknown): Promise<Res> => res(200))
    setBridge({ cloudFetch })
    expect(await agreeTerms('v2')).toBe('ok')
    expect(cloudFetch).toHaveBeenCalledWith({ path: '/auth/terms/agree', method: 'POST', body: { version: 'v2' } })
    cloudFetch.mockResolvedValueOnce({ status: 409, json: {} })
    expect(await agreeTerms('v2')).toBe('stale')
    cloudFetch.mockResolvedValueOnce({ status: 0, json: {} })
    expect(await agreeTerms('v2')).toBe('failed')
  })
})

describe('TermsUpdateDialog', () => {
  it('notice:只有「知道了」,点了记到账号上再关', async () => {
    const cloudFetch = vi.fn(async (_req: unknown): Promise<Res> => res(200))
    setBridge({ cloudFetch })
    const onDone = vi.fn()
    const el = render({ status: { ...STATUS, mode: 'notice' }, onDone, onReplace: vi.fn() })
    expect(buttons(el).map((b) => b.textContent)).toEqual(['知道了'])
    expect(el.textContent).toContain('写清数据存放位置')
    act(() => buttons(el)[0].click())
    await flush()
    expect(cloudFetch).toHaveBeenCalledWith({ path: '/auth/terms/agree', method: 'POST', body: { version: '2026-10-19' } })
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('consent:同意 / 不同意并退出;不同意只退出、退出前不关', async () => {
    const forsionLogout = vi.fn(async () => ({ ok: true }))
    const cloudFetch = vi.fn(async (_req: unknown): Promise<Res> => res(200))
    setBridge({ cloudFetch, forsionLogout })
    const onDone = vi.fn()
    const el = render({ status: { ...STATUS, mode: 'consent' }, onDone, onReplace: vi.fn() })
    expect(buttons(el).map((b) => b.textContent)).toEqual(['不同意并退出登录', '同意'])
    act(() => buttons(el)[0].click())
    await flush()
    expect(forsionLogout).toHaveBeenCalledOnce()
    expect(cloudFetch).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('版本又变了(409):重拉成功换成新版 / 不用再确认就关;重拉没成功留着卡、提示重试', async () => {
    const V3 = { latest: '2026-11-01', required: true, mode: 'consent', changes: null }
    const cloudFetch = vi.fn(async (req: unknown): Promise<Res> => ((req as { path: string }).path === '/auth/terms' ? res(200, V3) : res(409)))
    setBridge({ cloudFetch })
    const onDone = vi.fn(), onReplace = vi.fn()
    const el = render({ status: { ...STATUS, mode: 'consent' }, onDone, onReplace })
    act(() => buttons(el)[1].click())
    await flush()
    expect(onReplace).toHaveBeenLastCalledWith({ latest: '2026-11-01', required: true, mode: 'consent', changes: null })

    cloudFetch.mockImplementation(async (req: unknown) => ((req as { path: string }).path === '/auth/terms' ? res(200, { ...V3, required: false }) : res(409)))
    act(() => buttons(el)[1].click())
    await flush()
    expect(onReplace).toHaveBeenLastCalledWith(null)

    cloudFetch.mockImplementation(async (req: unknown) => ((req as { path: string }).path === '/auth/terms' ? res(503) : res(409)))
    onReplace.mockClear()
    act(() => buttons(el)[1].click())
    await flush()
    expect(onReplace).not.toHaveBeenCalled()
    expect(el.querySelector('.terms-error')).not.toBe(null)
    expect(onDone).not.toHaveBeenCalled()
    expect(buttons(el).every((b) => !b.disabled)).toBe(true)
  })

  it('记账失败:consent 留着卡可重试;notice 照样关(没记上,下次再提醒)', async () => {
    const cloudFetch = vi.fn(async (_req: unknown): Promise<Res> => res(0))
    setBridge({ cloudFetch })
    const c = { onDone: vi.fn(), onReplace: vi.fn() }
    const el = render({ status: { ...STATUS, mode: 'consent' }, ...c })
    act(() => buttons(el)[1].click())
    await flush()
    expect(c.onDone).not.toHaveBeenCalled()
    expect(el.querySelector('.terms-error')).not.toBe(null)
    act(() => root?.unmount()); host?.remove()

    const n = { onDone: vi.fn(), onReplace: vi.fn() }
    const el2 = render({ status: { ...STATUS, mode: 'notice' }, ...n })
    act(() => buttons(el2)[0].click())
    await flush()
    expect(n.onDone).toHaveBeenCalledOnce()
  })
})

describe('TermsUpdateHost', () => {
  afterEach(() => { useApp.setState({ authInfo: null }); usePopupQueue.setState({ waiting: [], active: null, blocked: false }) })
  const signIn = (accountId: string): void => useApp.setState({ authInfo: { loggedIn: true, accountId, cloudUrl: '', username: accountId, tokenSource: null } })

  it('A 点了同意还没回来就换成 B:A 迟到的成功不关 B 的卡', async () => {
    let releaseA: (r: Res) => void = () => {}
    const cloudFetch = vi.fn((req: unknown): Promise<Res> => {
      const r = req as { path: string }
      if (r.path === '/auth/terms') return Promise.resolve(res(200, { latest: '2026-10-19', required: true, mode: 'consent', changes: null }))
      return new Promise<Res>((ok) => { releaseA = ok })
    })
    setBridge({ cloudFetch })
    signIn('A')
    const el = mount(createElement(TermsUpdateHost))
    await flush()
    expect(el.querySelector('.terms-modal')).not.toBe(null)
    act(() => buttons(el)[1].click()) // A 同意,请求挂着
    await flush()
    act(() => signIn('B'))
    await flush()
    expect(el.querySelector('.terms-modal')).not.toBe(null) // B 的卡
    releaseA(res(200))
    await flush()
    expect(el.querySelector('.terms-modal')).not.toBe(null)
  })

  it('登出就收卡、让出队列', async () => {
    setBridge({ cloudFetch: vi.fn(async (): Promise<Res> => res(200, { latest: 'v', required: true, mode: 'notice', changes: null })) })
    signIn('A')
    const el = mount(createElement(TermsUpdateHost))
    await flush()
    expect(usePopupQueue.getState().active).toBe('terms')
    act(() => useApp.setState({ authInfo: null }))
    await flush()
    expect(el.querySelector('.terms-modal')).toBe(null)
    expect(usePopupQueue.getState().active).toBe(null)
  })
})
