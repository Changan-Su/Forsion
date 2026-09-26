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

  it('操作回执(receipt)不受总开关 / 事件开关过滤,也不跟发系统通知(Codex 第一轮 C-2)', () => {
    const os = vi.fn()
    vi.stubGlobal('window', { tangu: { notify: os } })
    vi.stubGlobal('document', { hasFocus: () => false })
    try {
      useNotifications.getState().setEnabled(false)
      useNotifications.setState((s) => ({ prefs: { ...s.prefs, events: { 'workspace.layout': false } } }))
      expect(notifyApp({ text: 'plain', event: 'workspace.layout' })).toBeNull()
      const id = notifyApp({ text: 'restored', event: 'workspace.layout', receipt: true, action: { label: 'Undo', run: () => {} } })
      expect(id).not.toBeNull()
      expect(useNotifications.getState().items.map((n) => n.text)).toEqual(['restored'])
      expect(os).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
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

  it('durationMs 覆盖 level 缺省停留(撤销提示留够 8 秒),补位与去重重置都沿用它', () => {
    notifyApp({ text: 'undo', level: 'info', durationMs: 8000, dedupeKey: 'k' })
    vi.advanceTimersByTime(6000) // info 缺省 5000 早该走了
    expect(useNotifications.getState().items).toHaveLength(1)
    notifyApp({ text: 'undo again', level: 'info', dedupeKey: 'k' }) // 去重重置停留:仍按 8000
    vi.advanceTimersByTime(7000)
    expect(useNotifications.getState().items).toHaveLength(1)
    vi.advanceTimersByTime(1500)
    expect(useNotifications.getState().items).toHaveLength(0)
  })

  it('inAppOnly:窗口无焦点也不跟发系统通知;缺省照发', () => {
    const osNotify = vi.fn()
    // node 环境:没有 window / document,按需桩(store 用 typeof document 判定有无 DOM)。
    vi.stubGlobal('window', { tangu: { notify: osNotify } })
    vi.stubGlobal('document', { hasFocus: () => false })
    try {
      notifyApp({ text: 'restored', inAppOnly: true })
      expect(osNotify).not.toHaveBeenCalled()
      expect(useNotifications.getState().items).toHaveLength(1)
      notifyApp({ text: 'plain' })
      expect(osNotify).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
