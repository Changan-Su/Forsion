// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TAIL_FIRST, useTailFirst } from './useTailFirst'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const msgs = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

describe('useTailFirst', () => {
  let root: Root
  let seen: number[] = []
  const Probe = (p: { items: number[]; sessionId: string; enabled: boolean }) => { seen = useTailFirst(p.items, p.sessionId, p.enabled); return null }
  const render = (items: number[], sessionId: string, enabled: boolean) => act(async () => root.render(createElement(Probe, { items, sessionId, enabled })))
  const idle = () => act(async () => { vi.advanceTimersByTime(40) })

  beforeEach(() => { vi.stubGlobal('requestIdleCallback', undefined); vi.useFakeTimers(); root = createRoot(document.createElement('div')) })
  afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })

  it('长对话先给最后几条,空闲时补齐', async () => {
    await render(msgs(60), 'a', true)
    expect(seen).toEqual(msgs(60).slice(-TAIL_FIRST))
    for (let i = 0; i < 6; i++) await idle()
    expect(seen).toHaveLength(60)
  })

  it('补齐之后来新消息:前面的不被卸掉', async () => {
    await render(msgs(60), 'a', true)
    for (let i = 0; i < 6; i++) await idle()
    await render(msgs(61), 'a', true)
    expect(seen).toHaveLength(61)
  })

  it('短对话来新消息超过首批条数:前面的不被卸掉', async () => {
    await render(msgs(TAIL_FIRST), 'a', true)
    await render(msgs(TAIL_FIRST + 1), 'a', true)
    expect(seen).toHaveLength(TAIL_FIRST + 1)
  })

  it('不许分批时整段给(跳到某条消息);之后放开也不回到只给最后几条', async () => {
    await render(msgs(60), 'b', false)
    expect(seen).toHaveLength(60)
    await render(msgs(60), 'b', true)
    expect(seen).toHaveLength(60)
  })

  it('换一段会话:重新从最后几条开始', async () => {
    await render(msgs(60), 'a', true)
    for (let i = 0; i < 6; i++) await idle()
    await render(msgs(40), 'c', true)
    expect(seen).toEqual(msgs(40).slice(-TAIL_FIRST))
  })

  it('历史还没到时不算整段:到了照样分批', async () => {
    await render([], 'a', true)
    await render(msgs(60), 'a', true)
    expect(seen).toHaveLength(TAIL_FIRST)
  })
})
