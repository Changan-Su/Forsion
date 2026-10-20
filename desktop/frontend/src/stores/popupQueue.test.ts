/** 弹窗排队(stores/popupQueue):同一时间只露一个;优先级小的先出、同级先来后到;不抢占;引导开着谁都不出;
 *  插件撤销 / 停用不留「隐形弹窗」堵队列。
 *  负对照(2026-10-19 实跑):① pump 改成按 seq 取(去掉优先级)→「协议排在 What's new 前面」红;
 *  ② requestPopup 有人在显示时也直接顶上 → 「不抢占」红;③ releasePopupsOf 只清 waiting 不清 active → 「停用收掉」红。 */
import { afterEach, describe, expect, it } from 'vitest'
import { POPUP_PRIORITY, queuePopup, releasePopup, releasePopupsOf, requestPopup, setPopupsBlocked, usePopupQueue } from './popupQueue'

const active = (): string | null => usePopupQueue.getState().active

afterEach(() => usePopupQueue.setState({ waiting: [], active: null, blocked: false }))

describe('popupQueue', () => {
  it('前面没人立刻出;同 id 重复排是无操作', () => {
    requestPopup('whatsNew', POPUP_PRIORITY.whatsNew)
    requestPopup('whatsNew', POPUP_PRIORITY.whatsNew)
    expect(active()).toBe('whatsNew')
    expect(usePopupQueue.getState().waiting).toEqual([])
  })

  it('不抢占,关掉后按优先级再先来后到', () => {
    requestPopup('plugin:a:1', POPUP_PRIORITY.plugin)
    requestPopup('plugin:b:2', POPUP_PRIORITY.plugin)
    requestPopup('whatsNew', POPUP_PRIORITY.whatsNew)
    requestPopup('terms', POPUP_PRIORITY.terms)
    expect(active()).toBe('plugin:a:1')
    const order: (string | null)[] = []
    for (let i = 0; i < 4; i++) { order.push(active()); releasePopup(active()!) }
    expect(order).toEqual(['plugin:a:1', 'terms', 'whatsNew', 'plugin:b:2'])
    expect(active()).toBe(null)
  })

  it('引导开着谁都不出,关了按顺序出', () => {
    setPopupsBlocked(true)
    requestPopup('whatsNew', POPUP_PRIORITY.whatsNew)
    requestPopup('terms', POPUP_PRIORITY.terms)
    expect(active()).toBe(null)
    setPopupsBlocked(false)
    expect(active()).toBe('terms')
  })

  it('queuePopup:轮到才 resolve;没轮到就 done = 撤销', async () => {
    requestPopup('terms', POPUP_PRIORITY.terms)
    const a = queuePopup('plugin:x:1', POPUP_PRIORITY.plugin)
    const b = queuePopup('plugin:x:2', POPUP_PRIORITY.plugin)
    let aReady = false
    void a.ready.then(() => { aReady = true })
    await Promise.resolve()
    expect(aReady).toBe(false)
    b.done() // 还没轮到就撤销
    releasePopup('terms')
    await a.ready
    expect(active()).toBe('plugin:x:1')
    a.done()
    a.done() // 重复调无害
    expect(active()).toBe(null)
  })

  it('插件停用:排着的和正在显示的一并收掉,队列接着往下走', () => {
    requestPopup('plugin:ext:1', POPUP_PRIORITY.plugin)
    requestPopup('plugin:ext:2', POPUP_PRIORITY.plugin)
    requestPopup('plugin:other:3', POPUP_PRIORITY.plugin)
    expect(active()).toBe('plugin:ext:1')
    releasePopupsOf('plugin:ext:')
    expect(active()).toBe('plugin:other:3')
    expect(usePopupQueue.getState().waiting).toEqual([])
  })
})
