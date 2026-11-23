import { describe, expect, it, vi } from 'vitest'

vi.mock('../../services/backendService', () => ({ getMuseStarters: vi.fn(async () => []), patchMuseStarter: vi.fn(async () => ({ ok: true })) }))
vi.mock('../../services/engine/targets', () => ({ homeTarget: () => ({}) }))

import { DROP_EASE, DROP_MS, FRESH_GAP, FRESH_MIN_TOP, freshCenterOn, freshPlacement, startersPlace } from './freshLayout'
import { splitStarter } from './museStarterStore'

describe('居中与否和画不画 Muse 建议读同一个位置判定(11-23)', () => {
  const MAIN = { loc: 'main', type: 'chat' }
  const RIGHT = { loc: 'right', type: 'chat-panel' } // Tangu「显示对话面板」/ 笔记 Space 右栏
  const COMPANION = { loc: 'main', type: 'chat-panel' } // 插件摆在主区旁的伴随对话(mainCompanions)
  const LEFT = { loc: 'left', type: 'chat' }
  it('主区对话:画建议、居中(宽窄都是,不看宽度)', () => {
    expect(startersPlace(MAIN)).toBe(true)
    expect(freshCenterOn(MAIN)).toBe(true)
  })
  it('右栏 / 伴随 / 左栏的对话:不画建议,输入框贴底不居中', () => {
    for (const leaf of [RIGHT, COMPANION, LEFT]) {
      expect(startersPlace(leaf)).toBe(false)
      expect(freshCenterOn(leaf)).toBe(false)
    }
  })
  it('不画建议就不居中:没有一处「不画建议却居中」', () => {
    for (const loc of ['main', 'left', 'right', 'bottom']) for (const type of ['chat', 'chat-panel']) {
      if (!startersPlace({ loc, type })) expect(freshCenterOn({ loc, type })).toBe(false)
    }
  })
  it('小窗 / 子会话面板 / 手机照旧不居中', () => {
    expect(freshCenterOn({ ...MAIN, mini: true })).toBe(false)
    expect(freshCenterOn({ ...MAIN, child: true })).toBe(false)
    expect(freshCenterOn({ ...MAIN, mobile: true })).toBe(false)
  })
})

describe('freshPlacement:空对话时空状态 + 输入区整块居中', () => {
  it('放得下:整块上下居中,输入区抬到空状态下面隔一个 gap', () => {
    // 列 900 高;空状态 130;输入区原位贴底(top 680,高 220)
    const p = freshPlacement(900, 130, 680, 220)
    const stack = 130 + FRESH_GAP + 220
    expect(p.emptyTop).toBe(Math.round((900 - stack) / 2))
    expect(p.lift).toBe(680 - (p.emptyTop + 130 + FRESH_GAP))
    // 上下留白相等(差一像素以内:取整)
    const below = 900 - (680 - p.lift + 220)
    expect(Math.abs(below - p.emptyTop)).toBeLessThanOrEqual(1)
  })
  it('空状态藏起来了(传 0):只居中输入区,不留 gap', () => {
    const p = freshPlacement(600, 0, 400, 200)
    expect(p.emptyTop).toBe(200)
    expect(p.lift).toBe(200)
  })
  it('放不下:顶到最小上边距为止,输入区不往下压(lift 不为负)', () => {
    const p = freshPlacement(300, 130, 100, 200)
    expect(p.emptyTop).toBe(FRESH_MIN_TOP)
    expect(p.lift).toBe(0)
  })
  it('落底与发送动效同曲线同时长(sendFlight.ts:420ms --ease-spring)', () => {
    expect(DROP_MS).toBe(420)
    expect(DROP_EASE).toBe('cubic-bezier(0.2, 0.8, 0.3, 1)')
  })
})

describe('splitStarter:句子里第一处 label 画成链接', () => {
  it('拆成前半 / 链接 / 后半', () => {
    expect(splitStarter({ text: '明天 10:00 的「产品周会」还没有议程。', source: { kind: 'calendar', label: '产品周会' } }))
      .toEqual({ pre: '明天 10:00 的「', link: '产品周会', post: '」还没有议程。' })
  })
  it('只认第一处', () => {
    expect(splitStarter({ text: 'Plan A, then plan A again', source: { kind: 'muse', label: 'plan A' } }).pre).toBe('Plan A, then ')
  })
  it('label 不在句子里:整句当正文,不画链接', () => {
    expect(splitStarter({ text: 'Draft the agenda', source: { kind: 'note', label: 'Weekly sync' } })).toEqual({ pre: 'Draft the agenda', link: '', post: '' })
  })
})
