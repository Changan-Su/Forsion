import { describe, it, expect } from 'vitest'
import { deskCardGone, deskCardIdle, deskCardPlan } from './AgentDesk'
import { DESK_DRAFT_KEY, packDeskMap } from '../../stores/deskPlan'

describe('deskCardGone', () => {
  it('开聊前空态照常在场(用户要求:新对话草稿也要有 Desk 卡;07-27 那条隐身理由已随 pickers 收进 anchor 失效)', () => {
    expect(deskCardGone(undefined, false)).toBe(false)
  })
  it('历史还在加载的空会话不隐身(切会话瞬间不闪)', () => {
    // 旧口径按 hasMessages 判,消息没到就先隐身、到了再弹进来;新口径与消息无关
    expect(deskCardGone(undefined, false)).toBe(false)
    expect(deskCardGone(undefined, true)).toBe(false)
  })
  it('侧板在演时卡片隐身', () => {
    expect(deskCardGone('open', true)).toBe(true)
  })
  it('侧板 open 但内容已散 → 卡片兜底,别双双消失', () => {
    expect(deskCardGone('open', false)).toBe(false)
  })
})

describe('deskCardPlan', () => {
  const plan = (mode: 'open' | undefined, itemCount: number, companion: 'always' | 'idle' | null, draft = false) =>
    deskCardPlan({ mode, itemCount, companion, draft })

  it('无伴随面:与旧行为一致(除草稿修复)', () => {
    expect(plan(undefined, 0, null)).toEqual({ gone: false, showCompanion: false, expandable: false, clearable: false })
    expect(plan(undefined, 1, null)).toEqual({ gone: false, showCompanion: false, expandable: true, clearable: false })
    expect(plan('open', 1, null)).toEqual({ gone: true, showCompanion: false, expandable: false, clearable: false })
    expect(plan(undefined, 0, null, true)).toEqual({ gone: false, showCompanion: false, expandable: false, clearable: false })
  })

  it('idle:零条目时卡片是伴随面,不可展开', () => {
    expect(plan(undefined, 0, 'idle')).toEqual({ gone: false, showCompanion: true, expandable: false, clearable: false })
    expect(plan(undefined, 0, 'idle', true).showCompanion).toBe(true)
  })
  it('idle:agent 一放东西伴随面就让位,出现「清空 Desk」', () => {
    expect(plan(undefined, 1, 'idle')).toEqual({ gone: false, showCompanion: false, expandable: true, clearable: true })
    // 展开侧板时卡片退场,清空键在侧板头上
    expect(plan('open', 2, 'idle')).toEqual({ gone: true, showCompanion: false, expandable: false, clearable: true })
  })

  it('always:有没有条目卡片都只演伴随面,且可展开成侧板', () => {
    expect(plan(undefined, 0, 'always')).toEqual({ gone: false, showCompanion: true, expandable: true, clearable: false })
    expect(plan(undefined, 2, 'always')).toEqual({ gone: false, showCompanion: true, expandable: true, clearable: false })
  })
  it('always:侧板展开 → 卡片退场(伴随面挪到侧板),零条目也一样', () => {
    expect(plan('open', 0, 'always').gone).toBe(true)
  })
  it('always + 草稿:没有侧板可展开,卡片永不退场', () => {
    expect(plan(undefined, 0, 'always', true)).toEqual({ gone: false, showCompanion: true, expandable: false, clearable: false })
    expect(plan('open', 0, 'always', true).gone).toBe(false)
  })
})

describe('deskCardIdle(U-18 零条目小坞)', () => {
  it('草稿 / 空会话零条目 → 小坞', () => {
    expect(deskCardIdle(deskCardPlan({ mode: undefined, itemCount: 0, companion: null, draft: true }), 0)).toBe(true)
    expect(deskCardIdle(deskCardPlan({ mode: undefined, itemCount: 0, companion: null, draft: false }), 0)).toBe(true)
  })
  it('有条目 → 回到半高卡', () => {
    expect(deskCardIdle(deskCardPlan({ mode: undefined, itemCount: 1, companion: null, draft: false }), 1)).toBe(false)
  })
  it('卡片已退场(侧板在演)不算小坞 —— 否则 :not(.gone) 之外又多一个让位分支', () => {
    const plan = deskCardPlan({ mode: 'open', itemCount: 0, companion: 'always', draft: false })
    expect(plan.gone).toBe(true)
    expect(deskCardIdle(plan, 0)).toBe(false)
  })
  it('伴随面在场、零条目仍是小坞(伴随面同 surface 缩进坞里,不重挂)', () => {
    expect(deskCardIdle(deskCardPlan({ mode: undefined, itemCount: 0, companion: 'idle', draft: false }), 0)).toBe(true)
  })
})

describe('DESK_DRAFT_KEY', () => {
  it('草稿键永不落盘(哪怕带了用户痕迹)', () => {
    const snap = { items: [], size: 'half' as const, mode: 'open' as const, fraction: 0.5 }
    const out = JSON.parse(packDeskMap({ [DESK_DRAFT_KEY]: snap, s1: snap }))
    expect(Object.keys(out)).toEqual(['s1'])
  })
})
