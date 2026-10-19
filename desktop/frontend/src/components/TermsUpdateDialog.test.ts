// @vitest-environment happy-dom
/** 协议更新提示(TermsUpdateDialog):状态解析、两档按钮、同意 / 不同意各自走哪条路。
 *  负对照(2026-10-19 实跑):① fetchTermsStatus 不看 required → 「不用弹」那条红;② notice 也画「不同意」→ 按钮数那条红;
 *  ③ 409 当成失败 → 「版本又变了就重拉」那条红;④ 不同意时提前关卡 → 「退出前不关」那条红。
 *  ponytail: 用 createElement 而非 JSX(vitest include 只收 .ts)。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('../stores/appStore', () => ({ useApp: () => null }))
const { TermsUpdateDialog, agreeTerms, fetchTermsStatus } = await import('./TermsUpdateDialog')
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

const render = (props: Parameters<typeof TermsUpdateDialog>[0]): HTMLElement => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(createElement(TermsUpdateDialog, props)))
  return host
}
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
    const el = render({ status: { ...STATUS, mode: 'notice' }, onDone, onStale: vi.fn() })
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
    const el = render({ status: { ...STATUS, mode: 'consent' }, onDone, onStale: vi.fn() })
    expect(buttons(el).map((b) => b.textContent)).toEqual(['不同意并退出登录', '同意'])
    act(() => buttons(el)[0].click())
    await flush()
    expect(forsionLogout).toHaveBeenCalledOnce()
    expect(cloudFetch).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('版本又变了(409)就重拉;断网留着卡、提示重试', async () => {
    const cloudFetch = vi.fn(async (_req: unknown): Promise<Res> => res(409))
    setBridge({ cloudFetch })
    const onDone = vi.fn(), onStale = vi.fn()
    const el = render({ status: { ...STATUS, mode: 'consent' }, onDone, onStale })
    act(() => buttons(el)[1].click())
    await flush()
    expect(onStale).toHaveBeenCalledOnce()
    cloudFetch.mockResolvedValueOnce({ status: 0, json: {} })
    act(() => buttons(el)[1].click())
    await flush()
    expect(el.querySelector('.terms-error')).not.toBe(null)
    expect(onDone).not.toHaveBeenCalled()
  })
})
