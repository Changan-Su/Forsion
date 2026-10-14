// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { addCommand } from '@lcl/engine'
import { APPREF_EVENT, APPREF_TARGET_ATTR, captureFrontWindow } from './appRefCommand'

describe('全局双 ⌘ 的落点:屏上没有输入卡', () => {
  it('同时到的两条共用一次等待:对话面板只开一次(那条命令在面板已显示时是收起),两条都进新开的输入卡', async () => {
    vi.useFakeTimers()
    const runs: string[] = []
    const got: string[] = []
    addCommand({ id: 'new-chat', title: 'n', run: () => { runs.push('new-chat') } })
    addCommand({ id: 'show-chat-panel', title: 'p', run: () => {
      runs.push('show-chat-panel')
      setTimeout(() => { // 面板里的输入卡挂得慢(比下一次补跑还晚)
        const card = document.createElement('div')
        card.setAttribute(APPREF_TARGET_ATTR, '')
        card.getClientRects = () => [{}] as unknown as DOMRectList
        card.addEventListener(APPREF_EVENT, (e) => got.push((e as CustomEvent<{ name: string }>).detail.name))
        document.body.append(card)
      }, 1500)
    } })
    const ref = (name: string) => ({ kind: 'window' as const, id: 'com.apple.iWork.Numbers', name })
    const both = Promise.all([captureFrontWindow(ref('A')), captureFrontWindow(ref('B'))])
    await vi.advanceTimersByTimeAsync(4500)
    await both
    vi.useRealTimers()
    expect(runs.filter((r) => r === 'show-chat-panel')).toHaveLength(1)
    expect(runs[0]).toBe('new-chat') // 先照 ⌘N 开新会话,摆不出来才动对话面板
    expect(got.sort()).toEqual(['A', 'B'])
  })
})
