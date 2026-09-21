// @vitest-environment happy-dom
/**
 * 造物的 deep link 落地(registerDeepLinkOpener('product', …)):**从应用外拉起**必须先过宿主那一问。
 * 深链是任意网页可达的输入,而作品页面握着 Forsion Connect 代理(读账号、花额度)—— 一个下载来的文件夹配一条链接
 * 不该零点击跑起来;一串不存在的 id 也不该各开一个空窗口(Codex 评审)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Opener = (params: Record<string, string>) => boolean | Promise<boolean>
const seen = vi.hoisted(() => ({ opener: null as Opener | null }))
vi.mock('../deepLinkInstall', () => ({
  registerDeepLinkOpener: (type: string, open: Opener) => { if (type === 'product') seen.opener = open; return () => { seen.opener = null } },
}))
vi.mock('../windowKind', () => ({ windowKind: () => 'main' }))
vi.mock('@lcl/engine', () => ({
  registerView: vi.fn(), registerSpace: vi.fn(), addRibbonIcon: vi.fn(), unregisterSpace: vi.fn(), removeRibbonIcon: vi.fn(),
  setActiveSpace: vi.fn(), useSpaceStore: { getState: () => ({ spaces: [], activeSpaceId: 'tangu' }) },
  useWorkspace: { getState: () => ({ openView: vi.fn(), setSidebarDefaults: vi.fn(), initializeSidebar: vi.fn() }) },
}))

const ID = 'p_0123456789ab'
const openDetached = vi.fn(async () => ({ id: 'w1' }))
const allowed = vi.fn(async () => true)

beforeEach(async () => {
  openDetached.mockClear(); allowed.mockReset(); allowed.mockResolvedValue(true)
  window.tangu = { productsList: vi.fn(), openDetached, productsExternalLaunchAllowed: allowed } as unknown as typeof window.tangu
  const { installArtificialViews } = await import('./artificial')
  installArtificialViews()
})
afterEach(() => { delete window.tangu })

describe('product deep link', () => {
  it('宿主放行才开独立窗口,且只把 id 往下传', async () => {
    expect(await seen.opener!({ id: ID, evil: 'x', space: 'amadeus' })).toBe(true)
    expect(allowed).toHaveBeenCalledWith(ID)
    expect(openDetached).toHaveBeenCalledWith([{ type: 'product', params: { id: ID } }])
  })

  it('⚠️宿主没放行(没为它建过快捷方式 / 产物不存在)→ 不开窗,交回「链接目标不可用」', async () => {
    allowed.mockResolvedValue(false)
    expect(await seen.opener!({ id: ID })).toBe(false)
    expect(openDetached).not.toHaveBeenCalled()
  })

  it('宿主那一问抛错 / 老宿主没有这道闸 → 同样不开窗(fail closed)', async () => {
    allowed.mockRejectedValue(new Error('ipc down'))
    expect(await seen.opener!({ id: ID })).toBe(false)
    delete (window.tangu as unknown as Record<string, unknown>).productsExternalLaunchAllowed
    expect(await seen.opener!({ id: ID })).toBe(false)
    expect(openDetached).not.toHaveBeenCalled()
  })

  it('形态不合的 id 连宿主都不去问', async () => {
    expect(await seen.opener!({ id: '../../etc' })).toBe(false)
    expect(allowed).not.toHaveBeenCalled()
  })
})
