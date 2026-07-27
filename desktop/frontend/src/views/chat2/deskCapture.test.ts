// @vitest-environment happy-dom
// Desk 截屏的两处纯判定:截哪块 DOM(会话认领/形态优先级/隐身卡)、截多大(视口裁剪)。
import { describe, it, expect, beforeEach } from 'vitest'
import { findDeskTarget, deskRect } from './deskCapture'

const html = (s: string): void => { document.body.innerHTML = s }
const card = (sid: string, gone = false): string =>
  `<div data-desk-session="${sid}" class="agent-desk-card${gone ? ' gone' : ''}"><div class="agent-desk-card-body"></div></div>`
const panel = (sid: string, open = true): string =>
  `<div data-desk-session="${sid}" class="agent-desk${open ? ' open' : ''}"><div class="agent-desk-body"></div></div>`

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
