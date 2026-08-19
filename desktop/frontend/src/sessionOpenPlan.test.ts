import { describe, expect, it } from 'vitest'
import { planChatRestore, planNewChat, planSessionOpen } from './sessionOpenPlan'

const primary = { id: 'chat', followActive: true }
const pinnedA = { id: 'chat#1', followActive: false as const, sessionId: 'A' }

describe('planSessionOpen', () => {
  it('主区无 leaf → fresh(兜底新建)', () => {
    expect(planSessionOpen(null)).toEqual({ act: 'fresh' })
  })
  it('焦点=跟随主聊天 → follow(只切 activeId)', () => {
    expect(planSessionOpen({ type: 'chat', followActive: true })).toEqual({ act: 'follow' })
    expect(planSessionOpen({ type: 'chat' })).toEqual({ act: 'follow' }) // followActive 缺省视为 true
  })
  it('焦点=固定会话聊天 → pin(就地改会话,勿被跟随引擎回拽)', () => {
    expect(planSessionOpen({ type: 'chat', followActive: false })).toEqual({ act: 'pin' })
  })
  it('焦点=空白新标签 / 笔记 / 其它 → pin(就地固定为该会话)', () => {
    expect(planSessionOpen({ type: 'launcher' })).toEqual({ act: 'pin' })
    expect(planSessionOpen({ type: 'home' })).toEqual({ act: 'pin' })
    expect(planSessionOpen({ type: 'amadeus-editor' })).toEqual({ act: 'pin' })
  })

  // ── 多标签(对齐 openNote 的语义)────────────────────────────────────────────
  it('已有钉住该会话的标签 → activate 它(不在当前标签里重开一份)', () => {
    expect(planSessionOpen({ type: 'chat', followActive: true }, { sessionId: 'A', leaves: [primary, pinnedA] }))
      .toEqual({ act: 'activate', leafId: 'chat#1' })
  })
  it('别的会话钉着 → 与没钉一样,照常 follow/pin', () => {
    expect(planSessionOpen({ type: 'chat', followActive: true }, { sessionId: 'B', leaves: [primary, pinnedA] }))
      .toEqual({ act: 'follow' })
    expect(planSessionOpen({ type: 'launcher' }, { sessionId: 'B', leaves: [primary, pinnedA] }))
      .toEqual({ act: 'pin' })
  })
  it('主聊天恰好正显示该会话**不算**认领(否则永远跳回主聊天,钉住的标签聚不上焦)', () => {
    expect(planSessionOpen({ type: 'launcher' }, { sessionId: 'A', leaves: [{ id: 'chat', followActive: true, sessionId: 'A' }] }))
      .toEqual({ act: 'pin' })
  })
  it('newTab 优先于一切:已开着也再来一个(⌘点击按了就该有新东西)', () => {
    expect(planSessionOpen({ type: 'chat', followActive: true }, { sessionId: 'A', leaves: [primary, pinnedA], newTab: true }))
      .toEqual({ act: 'newtab' })
  })
})

describe('planChatRestore', () => {
  // 用户实报(2026-08-17):「前进后退有时候失效,有时候控制别的 tabs。」钉住的标签同时中两条:
  // 走 activeId 的话本标签根本不看它(纹丝不动=失效),而别的跟随档标签被一起换掉(=控制别的 tabs)。
  it('⚠️钉住会话的标签 → pin(只改它自己),绝不走全局 activeId', () => {
    expect(planChatRestore({ type: 'chat', followActive: false })).toBe('pin')
  })
  it('跟随档主聊天 → follow(切 activeId,它自随)', () => {
    expect(planChatRestore({ type: 'chat', followActive: true })).toBe('follow')
    expect(planChatRestore({ type: 'chat' })).toBe('follow') // 缺省视为跟随
  })
  it('leaf 已被就地切成别的视图 → navigate 回聊天,且钉住(别再造第二个跟随档抢 activeId)', () => {
    expect(planChatRestore({ type: 'amadeus-editor' })).toBe('navigate')
  })
  it('leaf 已不在(标签被关) → null,什么都不做', () => {
    expect(planChatRestore(null)).toBeNull()
  })
})

describe('planNewChat', () => {
  // 用户实报:开着聊天 A → 点 ＋ 新标签 → 在里面点「新对话」,结果 A 被清空复用,新标签还空着。
  it('站在 ＋ 开出来的空白标签里 → 就开在这个标签', () => {
    expect(planNewChat({ type: 'launcher', id: 'launcher#1' }, 'chat')).toBe('here')
  })
  it('Space 的空白首页同理', () => {
    expect(planNewChat({ type: 'home', id: 'home' }, 'chat')).toBe('here')
  })
  it('一个聊天都没有时,空白标签照样就地变成新对话', () => {
    expect(planNewChat({ type: 'launcher', id: 'launcher#1' }, null)).toBe('here')
  })
  it('站在笔记/已有聊天上 → 复用主聊天(与「新建笔记」复用已有编辑器同口径)', () => {
    expect(planNewChat({ type: 'amadeus-editor', id: 'x' }, 'chat')).toBe('reuse')
    expect(planNewChat({ type: 'chat', id: 'chat' }, 'chat')).toBe('reuse')
  })
  it('焦点就是主聊天本身 → reuse(别把它导航成它自己,白重挂)', () => {
    expect(planNewChat({ type: 'launcher', id: 'chat' }, 'chat')).toBe('reuse')
  })
  it('主区没有 leaf → reuse(兜底新建)', () => {
    expect(planNewChat(null, null)).toBe('reuse')
  })
})
