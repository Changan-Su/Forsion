import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyApp, useNotifications } from './notificationStore'

const reset = (): void => {
  useNotifications.getState().dismissAll()
  useNotifications.setState({ prefs: { enabled: true, osEnabled: true, events: {} }, paused: false })
}

beforeEach(() => {
  vi.useFakeTimers()
  reset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('notificationStore', () => {
  it('info 自动消失,error 常驻', () => {
    notifyApp({ text: 'hi', level: 'info' })
    notifyApp({ text: 'boom', level: 'error' })
    expect(useNotifications.getState().items).toHaveLength(2)
    vi.advanceTimersByTime(10_000)
    const left = useNotifications.getState().items
    expect(left).toHaveLength(1)
    expect(left[0].level).toBe('error')
  })

  it('总开关关闭 → 静默;force 穿透(测试通知)', () => {
    useNotifications.getState().setEnabled(false)
    expect(notifyApp({ text: 'a' })).toBeNull()
    expect(notifyApp({ text: 'b', force: true })).not.toBeNull()
    expect(useNotifications.getState().items).toHaveLength(1)
  })

  it('事件开关:显式关闭的事件不弹,重开后弹', () => {
    useNotifications.getState().setEventOn('sync.done', false)
    expect(notifyApp({ text: 'done', event: 'sync.done' })).toBeNull()
    useNotifications.getState().setEventOn('sync.done', true)
    expect(notifyApp({ text: 'done', event: 'sync.done' })).not.toBeNull()
  })

  it('插件事件默认开,可按插件关闭', () => {
    expect(notifyApp({ text: 'p', event: 'plugin:foo' })).not.toBeNull()
    useNotifications.getState().setEventOn('plugin:foo', false)
    expect(notifyApp({ text: 'p2', event: 'plugin:foo' })).toBeNull()
  })

  it('dedupeKey 合并计数并更新文案', () => {
    const a = notifyApp({ text: 'v1', dedupeKey: 'k' })
    const b = notifyApp({ text: 'v2', dedupeKey: 'k' })
    expect(b).toBe(a)
    const items = useNotifications.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('v2')
    expect(items[0].count).toBe(2)
  })

  it('同屏上限 4 条,溢出排队,关掉顶上补位', () => {
    for (let i = 0; i < 6; i++) notifyApp({ text: `n${i}`, level: 'error' })
    let st = useNotifications.getState()
    expect(st.items.map((n) => n.text)).toEqual(['n0', 'n1', 'n2', 'n3'])
    expect(st.queue).toHaveLength(2)
    st.dismiss(st.items[0].id)
    st = useNotifications.getState()
    expect(st.items.map((n) => n.text)).toEqual(['n1', 'n2', 'n3', 'n4'])
    expect(st.queue).toHaveLength(1)
  })

  it('hover 暂停期间不消失,恢复后按剩余时间消失', () => {
    notifyApp({ text: 'hi', level: 'info' }) // 5000ms
    vi.advanceTimersByTime(3000)
    useNotifications.getState().pause()
    vi.advanceTimersByTime(60_000)
    expect(useNotifications.getState().items).toHaveLength(1)
    useNotifications.getState().resume()
    vi.advanceTimersByTime(2500) // 剩余 2000ms(≥下限 800)
    expect(useNotifications.getState().items).toHaveLength(0)
  })

  it('超长文本截断(防插件轰炸)', () => {
    notifyApp({ text: 'x'.repeat(2000) })
    expect(useNotifications.getState().items[0].text).toHaveLength(500)
  })
})
