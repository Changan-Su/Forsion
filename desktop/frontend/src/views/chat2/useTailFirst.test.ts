// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, act, useLayoutEffect } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { TAIL_FIRST, useTailFirst } from './useTailFirst'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const msgs = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

describe('useTailFirst', () => {
  let root: Root
  let seen: number[] = []
  let commits: number[][]
  const Probe = (p: { items: number[]; sessionId: string; enabled: boolean; deferFirstBatch: boolean }) => {
    const messages = useTailFirst(p.items, p.sessionId, p.enabled, p.deferFirstBatch)
    useLayoutEffect(() => {
      seen = messages
      commits.push(messages)
    })
    return null
  }
  const render = (items: number[], sessionId: string, enabled: boolean) => act(async () => root.render(createElement(Probe, { items, sessionId, enabled, deferFirstBatch: true })))
  const idle = () => act(async () => { vi.advanceTimersByTime(40) })

  beforeEach(() => {
    commits = []
    vi.stubGlobal('requestIdleCallback', undefined)
    vi.useFakeTimers()
    root = createRoot(document.createElement('div'))
  })
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

  it('同步打开长会话时让路给导航提交，下一次提交才挂新会话首批', async () => {
    await render(msgs(6), 'a', true)
    const history = msgs(60)
    await act(async () => {
      flushSync(() => root.render(createElement(Probe, { items: history, sessionId: 'b', enabled: true, deferFirstBatch: true })))
      expect(seen).toEqual([])
    })
    expect(seen).toEqual(history.slice(-TAIL_FIRST))
  })

  it('开启首批让路时，首次提交为空，下一次提交挂最后 12 条', async () => {
    const history = msgs(60)
    await act(async () => {
      flushSync(() => root.render(createElement(Probe, { items: history, sessionId: 'a', enabled: true, deferFirstBatch: true })))
      expect(commits).toEqual([[]])
    })
    expect(commits).toEqual([[], history.slice(-12)])
  })

  it('关闭首批让路时，首次提交直接挂最后 12 条', async () => {
    const history = msgs(60)
    const tail = history.slice(-12)
    await act(async () => {
      flushSync(() => root.render(createElement(Probe, { items: history, sessionId: 'a', enabled: true, deferFirstBatch: false })))
      expect(commits).toEqual([tail])
    })
    expect(commits).toEqual([tail])
    // 切至窄屏时，已提交的首批继续留在流中。
    await render(history, 'a', true)
    expect(commits).toEqual([tail, tail])
  })
})
