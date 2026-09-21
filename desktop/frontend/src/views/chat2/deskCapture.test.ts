// @vitest-environment happy-dom
// Desk 截屏的两处纯判定:截哪块 DOM(会话认领/形态优先级/隐身卡)、截多大(视口裁剪)。
// 伴随面(09-19 下午改口径):那块正演插件形象 → **照截**,回图带 companion = 伴随面 key(引擎据此告诉模型「这是插件
// 画的形象,不是你放上来的」)。上午那版回错误,用户实测 agent 什么都看不见。
// 多窗口:本窗口没有这个会话的 Desk → 晚 NOT_HERE_GRACE_MS 再报错,别抢在有 Desk 的窗口前面(引擎只认第一个回图)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { findDeskTarget, deskRect, captureDesk } from './deskCapture'

const html = (s: string): void => { document.body.innerHTML = s }
const card = (sid: string, gone = false): string =>
  `<div data-desk-session="${sid}" class="agent-desk-card${gone ? ' gone' : ''}"><div class="agent-desk-card-body"></div></div>`
const panel = (sid: string, open = true): string =>
  `<div data-desk-session="${sid}" class="agent-desk${open ? ' open' : ''}"><div class="agent-desk-body"></div></div>`
/** AgentDesk.tsx 的伴随面形状:body 里挂 .agent-desk-pane.agent-desk-companion(卡片 body 另带 .companion)。 */
const KEY = 'plugin:live3d:avatar'
/** DeskCompanionHost 的槽:data-companion = 伴随面 key。 */
const COMP = `<div class="agent-desk-pane agent-desk-companion"><div data-companion="${KEY}" data-surface="desk-card"><canvas></canvas></div></div>`
const compCard = (sid: string): string =>
  `<div data-desk-session="${sid}" class="agent-desk-card"><div class="agent-desk-card-body companion">${COMP}</div></div>`
const compPanel = (sid: string): string =>
  `<div data-desk-session="${sid}" class="agent-desk open"><div class="agent-desk-body">${COMP}</div></div>`

describe('findDeskTarget', () => {
  beforeEach(() => html(''))

  it('展开侧板优先于卡片', () => {
    html(card('s1') + panel('s1'))
    expect(findDeskTarget('s1')?.mode).toBe('open')
  })

  it('只有卡片时截卡片', () => {
    html(card('s1'))
    const t = findDeskTarget('s1')
    expect(t?.mode).toBe('card')
    expect(t?.el.className).toBe('agent-desk-card-body')
  })

  it('隐身卡(.gone)不截 —— 截了只是一块空白', () => {
    html(card('s1', true))
    expect(findDeskTarget('s1')).toBeNull()
  })

  it('未展开的侧板壳不算 —— 那时没宽度', () => {
    html(panel('s1', false))
    expect(findDeskTarget('s1')).toBeNull()
  })

  it('多面板按 sessionId 认领,不截别的会话', () => {
    html(panel('other') + card('s1'))
    expect(findDeskTarget('s1')?.mode).toBe('card')
    expect(findDeskTarget('nobody')).toBeNull()
  })

  it('普通卡片 / 侧板不带伴随面标记', () => {
    html(card('s1'))
    expect(findDeskTarget('s1')?.companion).toBeNull()
    html(panel('s1'))
    expect(findDeskTarget('s1')?.companion).toBeNull()
  })

  it('伴随面:卡片态与展开侧板都标出伴随面 key', () => {
    html(compCard('s1'))
    expect(findDeskTarget('s1')).toMatchObject({ mode: 'card', companion: KEY })
    html(compPanel('s1'))
    expect(findDeskTarget('s1')).toMatchObject({ mode: 'open', companion: KEY })
  })

  it('伴随面格里没有 data-companion 槽(还没挂上)→ 仍标成伴随面,不当普通内容', () => {
    html(`<div data-desk-session="s1" class="agent-desk-card"><div class="agent-desk-card-body companion"><div class="agent-desk-pane agent-desk-companion"></div></div></div>`)
    expect(findDeskTarget('s1')?.companion).toBe('plugin')
  })
})

describe('captureDesk', () => {
  const captureRect = vi.fn(async () => 'data:image/png;base64,AVATAR')
  beforeEach(() => {
    vi.useFakeTimers()
    captureRect.mockClear()
    ;(window as unknown as { tangu?: unknown }).tangu = { captureRect }
    // happy-dom 不排版(rect 全 0 → deskRect 判太小);给一块像样的矩形,让「没有闸就会真去截」成立。
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, right: 400, bottom: 400 } as DOMRect)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete (window as unknown as { tangu?: unknown }).tangu
    html('')
  })
  const shoot = async (sid: string) => {
    const p = captureDesk(sid)
    await vi.advanceTimersByTimeAsync(3000)
    return p
  }

  it('伴随面占着 Desk → 照截形象,回图带伴随面 key', async () => {
    html(compCard('s1'))
    expect(await shoot('s1')).toEqual({ dataUrl: 'data:image/png;base64,AVATAR', mode: 'card', companion: KEY })
    expect(captureRect).toHaveBeenCalledTimes(1)
  })

  it('展开侧板演伴随面同样照截(mode=open)', async () => {
    html(compPanel('s1'))
    expect(await shoot('s1')).toEqual({ dataUrl: 'data:image/png;base64,AVATAR', mode: 'open', companion: KEY })
  })

  it('正对照:普通卡片照常截图', async () => {
    html(card('s1'))
    expect(await shoot('s1')).toEqual({ dataUrl: 'data:image/png;base64,AVATAR', mode: 'card' })
    expect(captureRect).toHaveBeenCalledTimes(1)
  })

  it('没有 Desk → 「不在屏上」的错误,而且晚于有 Desk 的窗口正常截完的时刻(多窗口不抢答)', async () => {
    let done = false
    const p = captureDesk('s1').then((o) => { done = true; return o })
    await vi.advanceTimersByTimeAsync(1000) // SETTLE 400ms + 截图,有 Desk 的窗口这时早已回图
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    const out = await p
    expect(out.error).toMatch(/not on screen/)
    expect(out.error).not.toMatch(/[\u4e00-\u9fff]/) // 给模型读的,不许带中文
  })
})

const el = (left: number, top: number, right: number, bottom: number) =>
  ({ getBoundingClientRect: () => ({ left, top, right, bottom }) })

describe('deskRect', () => {
  it('视口坐标直用(zoom 已计入 rect,不再补偿)', () => {
    expect(deskRect(el(700.4, 80.2, 1180.9, 900.6), 1200, 920)).toEqual({ x: 700, y: 80, width: 480, height: 820 })
  })

  it('超出视口的部分裁掉 —— capturePage 越界会抓到黑边', () => {
    expect(deskRect(el(700, 80, 1400, 1200), 1200, 920)).toEqual({ x: 700, y: 80, width: 500, height: 840 })
  })

  it('负坐标(滚出上方)夹到 0', () => {
    expect(deskRect(el(-30, -50, 400, 300), 1200, 920)).toEqual({ x: 0, y: 0, width: 400, height: 300 })
  })

  it('小到没意义就别截了', () => {
    expect(deskRect(el(10, 10, 20, 300), 1200, 920)).toBeNull()
    expect(deskRect(el(10, 10, 300, 300), 15, 920)).toBeNull()
  })
})
