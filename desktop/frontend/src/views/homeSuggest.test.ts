import { describe, expect, it } from 'vitest'
import { showHomeSuggest, suggestNeedsConfirm, type HomeSuggestGate } from './homeSuggest'

const OPEN: HomeSuggestGate = { phone: true, tangu: true, phoneApp: true, pending: true, onboarding: false, sent: false, composerFocused: false }

describe('showHomeSuggest', () => {
  it('全部满足才出', () => {
    expect(showHomeSuggest(OPEN)).toBe(true)
  })
  it.each([
    ['不是手机布局', { phone: false }],
    ['没有 Tangu', { tangu: false }],
    ['不是手机 App(网页版窄屏)', { phoneApp: false }],
    ['没有引导记号(台架只种旧完成键)', { pending: false }],
    ['引导浮层还开着', { onboarding: true }],
    ['发过消息', { sent: true }],
    ['输入区展开着', { composerFocused: true }],
  ] as const)('%s 不出', (_name, patch) => {
    expect(showHomeSuggest({ ...OPEN, ...patch })).toBe(false)
  })
})

describe('suggestNeedsConfirm', () => {
  const ours = ['理一理今天要做的事', 'Sort out what I need to do today']
  it('没草稿 / 空白不问', () => {
    expect(suggestNeedsConfirm(undefined, ours)).toBe(false)
    expect(suggestNeedsConfirm({ text: '', pastes: [] }, ours)).toBe(false)
    expect(suggestNeedsConfirm({ text: '  \n', pastes: [] }, ours)).toBe(false)
  })
  it('草稿是建议之一(任一种语言)不问', () => {
    expect(suggestNeedsConfirm({ text: '理一理今天要做的事', pastes: [] }, ours)).toBe(false)
    expect(suggestNeedsConfirm({ text: 'Sort out what I need to do today ', pastes: [] }, ours)).toBe(false)
  })
  it('自己打的字要问', () => {
    expect(suggestNeedsConfirm({ text: '理一理今天要做的事,再加一条', pastes: [] }, ours)).toBe(true)
  })
  it('有长粘贴要问', () => {
    expect(suggestNeedsConfirm({ text: '', pastes: ['long text'] }, ours)).toBe(true)
    expect(suggestNeedsConfirm({ text: '理一理今天要做的事', pastes: ['x'] }, ours)).toBe(true)
  })
})
