// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { addCommand } from '@lcl/engine'
import { APPREF_EVENT, APPREF_TARGET_ATTR, captureFrontWindow, type AppRefDelivery } from './appRefCommand'

describe('全局双 ⌘ 的落点:屏上没有输入卡', () => {
  it('同时到的两条共用一次等待:对话面板只开一次(那条命令在面板已显示时是收起),两条都进新开的输入卡', async () => {
    vi.useFakeTimers()
    const runs: string[] = []
    const got: string[] = []
    const shots: AppRefDelivery['image'][] = []
    const snapshot = vi.fn(async (ref: { name: string }) => ({ mimeType: 'image/jpeg', data: btoa(ref.name) }))
    ;(window as unknown as { tangu: unknown }).tangu = { appRefs: { snapshot } } // 宿主截那扇窗口(窗口引用才截)
    addCommand({ id: 'new-chat', title: 'n', run: () => { runs.push('new-chat') } })
    addCommand({ id: 'show-chat-panel', title: 'p', run: () => {
      runs.push('show-chat-panel')
      setTimeout(() => { // 面板里的输入卡挂得慢(比下一次补跑还晚)
        const card = document.createElement('div')
        card.setAttribute(APPREF_TARGET_ATTR, '')
        card.getClientRects = () => [{}] as unknown as DOMRectList
        card.addEventListener(APPREF_EVENT, (e) => { const d = (e as CustomEvent<AppRefDelivery>).detail; got.push(d.ref.name); shots.push(d.image) })
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
    expect(snapshot).toHaveBeenCalledTimes(2) // 截图和找落点同时开始,不等输入卡
    expect((await Promise.all(shots))?.map((x) => x?.data).sort()).toEqual([btoa('A'), btoa('B')])
  })
})
