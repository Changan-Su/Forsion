import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markUserGesture } from '@lcl/engine/userGesture'
import { PHONE, notifyApp, resetNotificationThrottle, useNotifications } from './notificationStore'

const reset = (): void => {
  useNotifications.getState().setBanner(false)
  useNotifications.getState().dismissAll()
  resetNotificationThrottle()
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
  it('an explicit non-sticky error expires, and a settled success clears inherited stickiness', () => {
    notifyApp({ text: 'temporary error', level: 'error', sticky: false, dedupeKey: 'temp' })
    const id = notifyApp({ text: 'failed', level: 'error', dedupeKey: 'operation' })
    notifyApp({ text: 'recovered', level: 'success', settle: true, dedupeKey: 'operation' })
    expect(useNotifications.getState().items.find((n) => n.id === id)?.sticky).toBe(false)
    vi.advanceTimersByTime(12_000)
    expect(useNotifications.getState().items).toHaveLength(0)
  })
  it('手机上把浏览器的原话 Failed to fetch 换成一句人话(单独出现 / 拼在别的话后面);桌面不换', () => {
    vi.stubGlobal('window', { tangu: { mobile: true } })
    try {
      notifyApp({ text: 'TypeError: Failed to fetch', level: 'error' })
      notifyApp({ text: '保存失败：Failed to fetch', level: 'error' })
      notifyApp({ text: 'Fetch failed for another reason', level: 'error' })
      expect(useNotifications.getState().items.map((n) => n.text)).toEqual(['网络不可用，请稍后再试', '保存失败：网络不可用，请稍后再试', 'Fetch failed for another reason'])
    } finally { vi.unstubAllGlobals() }
    reset()
    vi.stubGlobal('window', { tangu: {} })
    try {
      notifyApp({ text: 'Failed to fetch', level: 'error' })
      expect(useNotifications.getState().items.map((n) => n.text)).toEqual(['Failed to fetch'])
    } finally { vi.unstubAllGlobals() }
  })

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

  it('replace:同 key 的后一条整条顶掉前一条 —— 不出 ×N,标题 / 按钮 / 停留 / 常驻都换成新的,停留从顶替那一刻重算', () => {
    const run = (): void => {}
    const a = notifyApp({ text: '乙组：第一条', title: '乙组', dedupeKey: 'p', replace: true, action: { label: '打开', run }, durationMs: 8000 })
    vi.advanceTimersByTime(3000)
    const b = notifyApp({ text: '丙组：第二条', title: '丙组', dedupeKey: 'p', replace: true, action: undefined, sticky: false })
    expect(b).toBe(a) // 原地换:同一张卡,不先滑走再滑进
    const [n] = useNotifications.getState().items
    expect(n).toMatchObject({ text: '丙组：第二条', title: '丙组', count: 1, sticky: false })
    expect(n.action).toBeUndefined()
    expect(n.durationMs).toBeUndefined() // 前一条的 8 秒不沿用:这一条没按钮,按 info 缺省 5 秒
    vi.advanceTimersByTime(4900)
    expect(useNotifications.getState().items).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(useNotifications.getState().items).toHaveLength(0)
    // 没给标题的那一条不沿用前一条的标题
    notifyApp({ text: 'x', title: '旧标题', dedupeKey: 'q', replace: true })
    notifyApp({ text: 'y', dedupeKey: 'q', replace: true })
    expect(useNotifications.getState().items[0]).toMatchObject({ text: 'y', title: undefined, count: 1 })
    // 前一条常驻、这一条不常驻:跟这一条
    notifyApp({ text: 's1', dedupeKey: 's', replace: true, sticky: true })
    notifyApp({ text: 's2', dedupeKey: 's', replace: true })
    expect(useNotifications.getState().items.find((i) => i.dedupeKey === 's')).toMatchObject({ text: 's2', sticky: false, count: 1 })
  })

  it('settle:原地换成结果,计数回 1、拿掉动作钮', () => {
    const run = (): void => {}
    const a = notifyApp({ text: '已删除', dedupeKey: 'u', action: { label: '撤销', run } })
    notifyApp({ text: '已删除', dedupeKey: 'u', action: { label: '撤销', run } })
    const b = notifyApp({ text: '已撤销', dedupeKey: 'u', action: undefined, durationMs: 1200, settle: true })
    expect(b).toBe(a)
    const [n] = useNotifications.getState().items
    expect(n).toMatchObject({ text: '已撤销', count: 1, settle: true, durationMs: 1200 })
    expect(n.action).toBeUndefined()
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

  it('系统通知:页面看不见也算在后台(安卓 WebView 退后台仍报有焦点);桥收到这是哪类事件', () => {
    const osNotify = vi.fn()
    vi.stubGlobal('window', { tangu: { notify: osNotify } })
    try {
      vi.stubGlobal('document', { hasFocus: () => true, visibilityState: 'visible' })
      notifyApp({ text: 'seen', event: 'inbox.message' })
      expect(osNotify).not.toHaveBeenCalled()
      vi.stubGlobal('document', { hasFocus: () => true, visibilityState: 'hidden' })
      notifyApp({ text: 'unseen', title: 'Inbox', event: 'inbox.message' })
      notifyApp({ text: 'untyped' })
      expect(osNotify.mock.calls).toEqual([['Inbox', 'unseen', { event: 'inbox.message' }], ['Forsion', 'untyped', { event: 'system.generic' }]])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('replace 顶替也跟发系统通知(在后台时上一张还停着又来一件,照样有横幅;排队中的那张被顶替也算);宿主自己的合并不重发;门控一条不少', () => {
    const os = vi.fn()
    vi.stubGlobal('window', { tangu: { notify: os } })
    vi.stubGlobal('document', { hasFocus: () => true, visibilityState: 'hidden' }) // 安卓退到后台:有焦点、看不见
    try {
      const key = 'plugin:biz:phone'
      notifyApp({ text: '乙组：第一条', title: '乙组', event: 'plugin:biz', sourceLabel: '商业版', dedupeKey: key, replace: true })
      notifyApp({ text: '丙组：第二条', event: 'plugin:biz', sourceLabel: '商业版', dedupeKey: key, replace: true })
      expect(useNotifications.getState().items).toHaveLength(1)
      expect(os.mock.calls).toEqual([['乙组', '乙组：第一条', { event: 'plugin:biz' }], ['商业版', '丙组：第二条', { event: 'plugin:biz' }]])
      // 排队中的那张:先占满同屏 4 条,第 5 条进队列,再顶替它
      for (const k of ['a', 'b', 'c']) notifyApp({ text: k, dedupeKey: `x:${k}` })
      notifyApp({ text: '排队的', dedupeKey: 'plugin:biz:queued', replace: true })
      expect(useNotifications.getState().queue.map((n) => n.text)).toEqual(['排队的'])
      os.mockClear()
      notifyApp({ text: '顶替排队的', title: 'Q', dedupeKey: 'plugin:biz:queued', replace: true })
      expect(useNotifications.getState().queue.map((n) => n.text)).toEqual(['顶替排队的'])
      expect(os.mock.calls).toEqual([['Q', '顶替排队的', { event: 'system.generic' }]])
      // 宿主自己的去重合并(不带 replace):计数,不重发
      useNotifications.getState().dismissAll()
      os.mockClear()
      notifyApp({ text: '同步失败', dedupeKey: 'sync.error:x' })
      notifyApp({ text: '同步失败', dedupeKey: 'sync.error:x' })
      expect(useNotifications.getState().items[0].count).toBe(2)
      expect(os).toHaveBeenCalledTimes(1)
      // 门控:前台(有焦点且看得见)不发 —— 日历「已完成 · 撤销」、行内补全的开关提示这类带 key 的前台即时反馈靠的就是这一条
      os.mockClear()
      vi.stubGlobal('document', { hasFocus: () => true, visibilityState: 'visible' })
      notifyApp({ text: '已完成', event: 'plugin:cal', dedupeKey: 'plugin:cal:todo-completed', replace: true })
      notifyApp({ text: '又完成一个', event: 'plugin:cal', dedupeKey: 'plugin:cal:todo-completed', replace: true })
      expect(os).not.toHaveBeenCalled()
      // inAppOnly / receipt / 系统通知开关关了:顶替时也不发
      vi.stubGlobal('document', { hasFocus: () => false, visibilityState: 'visible' })
      notifyApp({ text: 'i', dedupeKey: 'plugin:cal:todo-completed', replace: true, inAppOnly: true })
      notifyApp({ text: 'r', dedupeKey: 'plugin:cal:todo-completed', replace: true, receipt: true })
      useNotifications.getState().setOsEnabled(false)
      notifyApp({ text: 'o', dedupeKey: 'plugin:cal:todo-completed', replace: true })
      expect(os).not.toHaveBeenCalled()
      // 事件开关关了:整条不弹,也就不顶替、不发
      useNotifications.setState((s) => ({ prefs: { ...s.prefs, osEnabled: true, events: { 'plugin:cal': false } } }))
      expect(notifyApp({ text: 'muted', event: 'plugin:cal', dedupeKey: 'plugin:cal:todo-completed', replace: true })).toBeNull()
      expect(useNotifications.getState().items.find((n) => n.dedupeKey === 'plugin:cal:todo-completed')?.text).toBe('o')
      expect(os).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
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

// 手机横幅(窄屏手机壳):方案页「我替你定的细节」那张表逐条一例。负对照见各例注释。
describe('手机横幅模式(banner)', () => {
  const st = () => useNotifications.getState()
  const shown = () => st().items.map((n) => n.text)
  beforeEach(() => { st().setBanner(true) })

  it('停留:5 秒;撤销回执 8 秒;读屏开着 10 秒;sticky / error 一直留着(桌面的 durationMs、success 3.2 秒都不看)', () => {
    notifyApp({ text: 'plain', level: 'success', durationMs: 8000 }) // 插件带按钮时宿主给的 8000:手机上不算撤销
    vi.advanceTimersByTime(4999)
    expect(shown()).toEqual(['plain'])
    vi.advanceTimersByTime(1)
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(300)
    notifyApp({ text: 'undo', undo: true, event: 'plugin:cal' })
    vi.advanceTimersByTime(7999)
    expect(shown()).toEqual(['undo'])
    vi.advanceTimersByTime(1)
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(300)
    // 宿主自己的回执(receipt + action)视同撤销
    notifyApp({ text: 'receipt', receipt: true, action: { label: 'Undo', run() {} } })
    vi.advanceTimersByTime(5000)
    expect(shown()).toEqual(['receipt'])
    vi.advanceTimersByTime(3000)
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(300)
    vi.stubGlobal('document', { documentElement: { hasAttribute: (a: string) => a === 'data-reader' }, hasFocus: () => true, visibilityState: 'visible' })
    try {
      notifyApp({ text: 'reader', event: 'plugin:x' })
      vi.advanceTimersByTime(9999)
      expect(shown()).toEqual(['reader'])
      vi.advanceTimersByTime(1)
      expect(shown()).toEqual([])
    } finally { vi.unstubAllGlobals() }
    vi.advanceTimersByTime(300)
    notifyApp({ text: 'boom', level: 'error' })
    vi.advanceTimersByTime(600_000)
    expect(shown()).toEqual(['boom'])
  })

  it('一次一条,其余排队(先来后到;有人在等的排到不急的前面);前一条走后 300ms 才出下一条', () => {
    notifyApp({ text: 'a', event: 'plugin:a' })
    notifyApp({ text: 'b', event: 'plugin:b' })
    notifyApp({ text: 'c', event: 'plugin:c' })
    notifyApp({ text: 'wait', event: 'plugin:d', urgent: true })
    expect(shown()).toEqual(['a'])
    expect(st().queue.map((n) => n.text)).toEqual(['wait', 'b', 'c'])
    vi.advanceTimersByTime(5000)
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(299)
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(shown()).toEqual(['wait'])
    // 屏上空着、但还在间隔里:新来的也等间隔
    st().dismiss(st().items[0].id, 'action')
    notifyApp({ text: 'late', event: 'plugin:e' })
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(300)
    expect(shown()).toEqual(['b'])
  })

  it('同一个键:直接换文案和按钮,不出 ×N,停留从第一次出现起算、不顺延(负对照:按桌面重新计时 → 第 5 秒还在)', () => {
    const run1 = vi.fn(), run2 = vi.fn()
    const id = notifyApp({ text: '(1) 张三', dedupeKey: 'plugin:biz:phone', replace: true, event: 'plugin:biz', action: { label: '打开', run: run1 } })
    vi.advanceTimersByTime(3000)
    expect(notifyApp({ text: '(2) 张三', dedupeKey: 'plugin:biz:phone', replace: true, event: 'plugin:biz', action: { label: '打开', run: run2 } })).toBe(id)
    // 宿主自己的去重(不带 replace)在手机上也不出 ×N
    notifyApp({ text: '(3) 张三', dedupeKey: 'plugin:biz:phone', event: 'plugin:biz' })
    expect(st().items[0]).toMatchObject({ text: '(3) 张三', count: 1 })
    st().activate(id!)
    expect(run2).toHaveBeenCalledTimes(1)
    expect(run1).not.toHaveBeenCalled()
    // activate 收起了它;再来一遍看计时
    vi.advanceTimersByTime(300 + 30_000)
    notifyApp({ text: 'x1', dedupeKey: 'k', event: 'plugin:k' })
    vi.advanceTimersByTime(4000)
    notifyApp({ text: 'x2', dedupeKey: 'k', event: 'plugin:k' })
    vi.advanceTimersByTime(999)
    expect(shown()).toEqual(['x2'])
    vi.advanceTimersByTime(1)
    expect(shown(), '同 key 换了内容,停留被往后顺延了').toEqual([])
  })

  it('同一个键:剩下不足 800ms 也露够 800ms;撤销回执与收尾(settle)重新计时', () => {
    notifyApp({ text: 'x1', dedupeKey: 'k', event: 'plugin:k' })
    vi.advanceTimersByTime(4900)
    notifyApp({ text: 'x2', dedupeKey: 'k', event: 'plugin:k' })
    vi.advanceTimersByTime(799)
    expect(shown()).toEqual(['x2'])
    vi.advanceTimersByTime(1)
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(300)
    // 日历连删两次:第二个「撤销」是新的退路,重新给满 8 秒
    notifyApp({ text: '已删除 A', dedupeKey: 'plugin:cal:undo', replace: true, undo: true, event: 'plugin:cal', action: { label: '撤销', run() {} } })
    vi.advanceTimersByTime(6000)
    notifyApp({ text: '已删除 B', dedupeKey: 'plugin:cal:undo', replace: true, undo: true, event: 'plugin:cal', action: { label: '撤销', run() {} } })
    vi.advanceTimersByTime(7999)
    expect(shown()).toEqual(['已删除 B'])
    // 点了撤销 → 「已撤销」按调用方给的 1.2 秒
    notifyApp({ text: '已撤销', dedupeKey: 'plugin:cal:undo', action: undefined, durationMs: 1200, settle: true, event: 'plugin:cal' })
    vi.advanceTimersByTime(1199)
    expect(shown()).toEqual(['已撤销'])
    vi.advanceTimersByTime(1)
    expect(shown()).toEqual([])
  })

  it('节流:同一来源到点走后 30 秒内不出卡(插件照常调、不报错),别的来源不受影响;过了 30 秒照常', () => {
    notifyApp({ text: 'm1', event: 'plugin:biz' })
    vi.advanceTimersByTime(5000 + 300)
    expect(notifyApp({ text: 'm2', event: 'plugin:biz' })).toBeNull()
    expect(shown()).toEqual([])
    expect(notifyApp({ text: 'other', event: 'plugin:cal' })).not.toBeNull()
    expect(shown()).toEqual(['other'])
    st().dismiss(st().items[0].id, 'timeout')
    vi.advanceTimersByTime(35_000 - 5300 - 1) // m1 在第 5 秒走:冷却到第 35 秒
    expect(notifyApp({ text: 'm3', event: 'plugin:biz' })).toBeNull()
    vi.advanceTimersByTime(1)
    expect(notifyApp({ text: 'm4', event: 'plugin:biz' })).not.toBeNull()
    vi.advanceTimersByTime(300)
    expect(shown()).toEqual(['m4'])
  })

  it('节流:用户自己收的(上滑 / 点 ×)冷却 2 分钟;点了动作 30 秒;程序自己撤的不算', () => {
    const id = notifyApp({ text: 'm1', event: 'plugin:biz' })!
    st().dismiss(id, 'user')
    vi.advanceTimersByTime(119_999)
    expect(notifyApp({ text: 'm2', event: 'plugin:biz' })).toBeNull()
    vi.advanceTimersByTime(1)
    const id2 = notifyApp({ text: 'm3', event: 'plugin:biz', action: { label: 'Open', run() {} } })!
    vi.advanceTimersByTime(300)
    st().activate(id2)
    vi.advanceTimersByTime(29_999)
    expect(notifyApp({ text: 'm4', event: 'plugin:biz' })).toBeNull()
    vi.advanceTimersByTime(1)
    const id3 = notifyApp({ text: 'm5', event: 'plugin:biz' })!
    vi.advanceTimersByTime(300)
    st().dismiss(id3) // 程序自己撤
    vi.advanceTimersByTime(300)
    expect(notifyApp({ text: 'm6', event: 'plugin:biz' })).not.toBeNull()
  })

  it('节流管不着:sticky / error / urgent / 撤销 / 回执 / 宿主即时反馈(system.generic);它们收起也不开始冷却', () => {
    const id = notifyApp({ text: 'm1', event: 'plugin:biz' })!
    st().dismiss(id, 'user')
    for (const input of [
      { text: 'sticky', sticky: true }, { text: 'err', level: 'error' as const }, { text: 'approve', urgent: true },
      { text: 'undo', undo: true }, { text: 'receipt', receipt: true, action: { label: 'U', run() {} } },
    ]) {
      expect(notifyApp({ event: 'plugin:biz', ...input }), input.text).not.toBeNull()
    }
    expect(notifyApp({ text: 'copied' })).not.toBeNull() // system.generic
    // urgent 那张收起后,别的来源 / 同来源的冷却不因它延长
    useNotifications.getState().dismissAll()
    resetNotificationThrottle()
    const u = notifyApp({ text: 'approve', urgent: true, event: 'plugin:biz' })!
    st().dismiss(u, 'user')
    vi.advanceTimersByTime(300)
    expect(notifyApp({ text: 'next', event: 'plugin:biz' })).not.toBeNull()
  })

  it('被节流的那一条照样跟发系统通知(App 在后台的横幅不受节流;负对照:把 sendOs 挪到节流之后 → 这里红)', () => {
    const os = vi.fn()
    let hidden = false
    vi.stubGlobal('window', { tangu: { notify: os } })
    vi.stubGlobal('document', { hasFocus: () => true, get visibilityState() { return hidden ? 'hidden' : 'visible' } })
    try {
      const id = notifyApp({ text: 'm1', event: 'plugin:biz', sourceLabel: '商业版' })!
      st().dismiss(id, 'timeout') // 在前台到点走:冷却 30 秒
      hidden = true
      st().visibilityChanged()
      expect(notifyApp({ text: 'm2', event: 'plugin:biz', sourceLabel: '商业版' })).toBeNull()
      expect(os.mock.calls.map((c) => c[1])).toEqual(['m2'])
    } finally { vi.unstubAllGlobals() }
  })

  it('排队中的同来源卡:前一张走后进入冷却,它被丢下(不在 30 秒里再弹一次)', () => {
    notifyApp({ text: 'b1', event: 'plugin:biz', dedupeKey: 'plugin:biz:conv-1', replace: true })
    notifyApp({ text: 'b2', event: 'plugin:biz', dedupeKey: 'plugin:biz:conv-2', replace: true })
    notifyApp({ text: 'c1', event: 'plugin:cal' })
    vi.advanceTimersByTime(5000 + 300)
    expect(shown()).toEqual(['c1'])
    expect(st().queue).toHaveLength(0)
  })

  it('常驻那张让一让:新来的先上,新来的走了它再回来(不然一张常驻把后面的全堵住)', () => {
    notifyApp({ text: 'reminder', sticky: true, event: 'note.reminder' })
    notifyApp({ text: 'msg', event: 'plugin:biz' })
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(300)
    expect(shown()).toEqual(['msg'])
    vi.advanceTimersByTime(5000 + 300)
    expect(shown()).toEqual(['reminder'])
  })

  it('常驻让位的间隔里又来一条:新来的都走完了常驻才回来(负对照:按先来后到 → 第三条永远出不来)', () => {
    notifyApp({ text: 'reminder', sticky: true, event: 'note.reminder' })
    notifyApp({ text: 'msg', event: 'plugin:biz' })
    notifyApp({ text: 'later', event: 'plugin:cal' }) // 300ms 间隔里到的
    vi.advanceTimersByTime(300)
    expect(shown()).toEqual(['msg'])
    vi.advanceTimersByTime(5000 + 300)
    expect(shown()).toEqual(['later'])
    vi.advanceTimersByTime(5000 + 300)
    expect(shown()).toEqual(['reminder'])
    expect(st().queue).toHaveLength(0)
  })

  it('常驻卡的动作自己弹了一条(重试 → 进度):常驻那张照样收掉、onClose 一次,不在新的走后又回来', () => {
    const closed = vi.fn()
    const id = notifyApp({ text: 'failed', level: 'error', event: 'plugin:sync', onClose: closed,
      action: { label: 'retry', run: () => { notifyApp({ text: 'retrying', event: 'plugin:sync2' }) } } })!
    st().activate(id)
    expect(closed).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    expect(shown()).toEqual(['retrying'])
    vi.advanceTimersByTime(5000 + 300)
    expect(shown()).toEqual([])
    expect(st().queue).toHaveLength(0)
  })

  it('排着队时 App 退到后台:排着的卡在退到后台那一刻补发系统通知(来时在前台没发),不重发;回到前台照队列出,一张不丢', () => {
    const os = vi.fn()
    let hidden = false
    vi.stubGlobal('window', { tangu: { notify: os } })
    vi.stubGlobal('document', { hasFocus: () => !hidden, get visibilityState() { return hidden ? 'hidden' : 'visible' } })
    try {
      const aClosed = vi.fn(), bClosed = vi.fn()
      notifyApp({ text: 'a', event: 'plugin:biz' })
      notifyApp({ text: 'b same source', event: 'plugin:biz', onClose: bClosed })
      notifyApp({ text: 'c other', event: 'plugin:cal' })
      notifyApp({ text: 'quiet', event: 'plugin:x', inAppOnly: true, onClose: aClosed })
      expect(os).not.toHaveBeenCalled() // 在前台:卡片就是提醒
      hidden = true
      st().visibilityChanged() // 退到后台:排着的 b、c 在后台不会上屏 → 现在补发;quiet 是应用内回执,不发
      expect(os.mock.calls.map((c) => c[1])).toEqual(['b same source', 'c other'])
      vi.advanceTimersByTime(5000 + 300) // a 在后台到点走:不开冷却;后面的不在后台上屏
      expect(shown()).toEqual([])
      expect(st().queue.map((n) => n.text)).toEqual(['b same source', 'c other', 'quiet'])
      st().visibilityChanged() // 还在后台:不再补发
      expect(os).toHaveBeenCalledTimes(2)
      hidden = false
      // 回到前台:照队列出,不按「系统通知响过、早该走了」丢 —— 系统通知可能根本没出(没权限 / 关了渠道,桥照样回成功),
      // 手机外壳回到前台还会把它清掉(Codex 评审 P1;负对照:按停留丢 → 这里红)
      st().visibilityChanged()
      expect(bClosed).not.toHaveBeenCalled()
      expect(aClosed).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(shown(), '后台到点走的 a 不该开冷却:同来源的 b 照出').toEqual(['b same source'])
      notifyApp({ text: 'd', event: 'plugin:d' }) // 回到前台再来的:不发
      expect(os).toHaveBeenCalledTimes(2)
      expect(st().queue.map((n) => n.text)).toEqual(['c other', 'quiet', 'd'])
    } finally { vi.unstubAllGlobals() }
  })

  it('用户在前台看到过的卡不补发:常驻让位后在后台回屏、宽屏的卡收窄后在后台轮到,都不发系统通知', () => {
    const os = vi.fn()
    let hidden = false
    vi.stubGlobal('window', { tangu: { notify: os } })
    vi.stubGlobal('document', { hasFocus: () => !hidden, get visibilityState() { return hidden ? 'hidden' : 'visible' } })
    try {
      notifyApp({ text: 'reminder', sticky: true, event: 'note.reminder' })
      notifyApp({ text: 'msg', event: 'plugin:biz' })
      vi.advanceTimersByTime(300)
      expect(shown()).toEqual(['msg'])
      hidden = true
      st().visibilityChanged()
      vi.advanceTimersByTime(5000 + 300)
      expect(os, '常驻那张用户看过了,退到后台不该再发').not.toHaveBeenCalled()
      hidden = false
      st().visibilityChanged()
      vi.advanceTimersByTime(300)
      expect(shown(), '常驻的不会「早该走了」,回到前台照出').toEqual(['reminder'])
      st().dismissAll()
      st().setBanner(false)
      notifyApp({ text: 'w1', event: 'plugin:w1' })
      notifyApp({ text: 'w2', event: 'plugin:w2' })
      st().setBanner(true)
      hidden = true
      st().visibilityChanged()
      vi.advanceTimersByTime(5000 + 300)
      expect(os, '宽屏时就在屏上的卡,收窄后退到后台不该再发').not.toHaveBeenCalled()
      hidden = false
      st().visibilityChanged()
      vi.advanceTimersByTime(300)
      expect(shown(), '没响过系统通知的回到前台照出').toEqual(['w2'])
    } finally { vi.unstubAllGlobals() }
  })

  it('App 在后台:来的卡不上屏、不开冷却(回到前台已走、30 秒里同来源全哑 —— 安卓真壳实测);系统通知照发;回来照队列出,撤销卡一张不丢', () => {
    const os = vi.fn()
    let hidden = true
    vi.stubGlobal('window', { tangu: { notify: os } })
    vi.stubGlobal('document', { hasFocus: () => true, get visibilityState() { return hidden ? 'hidden' : 'visible' } })
    try {
      st().visibilityChanged()
      const committed = vi.fn()
      expect(notifyApp({ text: 'bg 1', event: 'plugin:biz' }), '调用照常成功').not.toBeNull()
      expect(shown(), '在后台不上屏(上了屏用户看不见,却开始计时)').toEqual([])
      notifyApp({ text: 'deleted', event: 'plugin:cal', undo: true, action: { label: 'Undo', run() {} }, onClose: committed })
      notifyApp({ text: 'pinned', event: 'note.reminder', sticky: true })
      expect(os.mock.calls.map((c) => c[1])).toEqual(['bg 1', 'deleted', 'pinned'])
      vi.advanceTimersByTime(60_000) // 在后台待了一分钟
      expect(shown()).toEqual([])
      expect(committed, '撤销卡在后台没上屏,不能到点落定').not.toHaveBeenCalled()
      hidden = false
      st().visibilityChanged()
      vi.advanceTimersByTime(300)
      expect(shown()).toEqual(['bg 1'])
      vi.advanceTimersByTime(5000 + 300)
      expect(shown(), '撤销卡回到前台照出:系统通知上没有撤销').toEqual(['deleted'])
      expect(committed).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })

  it('屏上那张在 App 退到后台后到点走:不开冷却(负对照:照开 → 回来 30 秒内同来源不出)', () => {
    let hidden = false
    vi.stubGlobal('document', { hasFocus: () => true, get visibilityState() { return hidden ? 'hidden' : 'visible' } })
    try {
      notifyApp({ text: 'on screen', event: 'plugin:biz' })
      hidden = true
      st().visibilityChanged()
      vi.advanceTimersByTime(5000 + 300)
      expect(shown()).toEqual([])
      hidden = false
      st().visibilityChanged()
      expect(notifyApp({ text: 'back', event: 'plugin:biz' })).not.toBeNull()
      vi.advanceTimersByTime(300)
      expect(shown()).toEqual(['back'])
    } finally { vi.unstubAllGlobals() }
  })

  it('用户手势里同步弹出、带按钮的卡(旧插件不带 undo 的「撤销」):不受节流、不开冷却、停 8 秒;同 key 第二件重新计满', () => {
    // 手机随包的日历插件勾完待办:「已完成 A · 撤销」,不带 undo。勾第二件时 A 那张到点走了、来源在冷却
    const tap = (fn: () => void): void => { markUserGesture(); fn(); vi.advanceTimersByTime(0) }
    const cal = { event: 'plugin:forsion-calendar', dedupeKey: 'plugin:forsion-calendar:todo-completed', replace: true }
    const undoA = vi.fn(), undoB = vi.fn()
    tap(() => notifyApp({ ...cal, text: 'done A', action: { label: '撤销', run: undoA } }))
    expect(shown()).toEqual(['done A'])
    vi.advanceTimersByTime(7999)
    expect(shown(), '撤销一类停 8 秒').toEqual(['done A'])
    vi.advanceTimersByTime(1)
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(300)
    let idB: string | null = null
    tap(() => { idB = notifyApp({ ...cal, text: 'done B', action: { label: '撤销', run: undoB } }) })
    expect(idB, '到点走的撤销卡不该让下一张进冷却').not.toBeNull()
    expect(shown()).toEqual(['done B'])
    // A、B 同一张卡:B 在 A 还停着时来(+3 秒) → 按撤销回执重新计满 8 秒,不是 A 剩下的那点
    vi.advanceTimersByTime(3000)
    tap(() => notifyApp({ ...cal, text: 'done C', action: { label: '撤销', run: undoB } }))
    vi.advanceTimersByTime(7999)
    expect(shown(), '同 key 第二件只剩前一张的余下时间').toEqual(['done C'])
    st().dismiss(st().items[0].id, 'user')
    vi.advanceTimersByTime(300)
    tap(() => { idB = notifyApp({ ...cal, text: 'done D', action: { label: '撤销', run: undoB } }) })
    expect(idB, '用户点 × 收掉撤销卡后,下一件的撤销照出').not.toBeNull()
  })

  it('手势判据不放过普通提示:定时器里弹的带按钮卡、手势里弹的不带按钮卡照样节流(负对照:不看手势 / 不看按钮 → 这里红)', () => {
    const id = notifyApp({ text: 'm1', event: 'plugin:biz', action: { label: 'Open', run() {} } })!
    st().dismiss(id, 'timeout')
    // 用户刚点了一下(手势那个任务结束了),随后网络 / 定时器里来的消息:不算
    markUserGesture()
    let fromTimer: string | null | undefined
    setTimeout(() => { fromTimer = notifyApp({ text: 'from a timer', event: 'plugin:biz', action: { label: 'Open', run() {} } }) }, 10)
    vi.advanceTimersByTime(10)
    expect(fromTimer, '用户点完之后定时器里来的带按钮卡,不该被当成手势的结果').toBeNull()
    // 手势里同步弹、但没有按钮:不是退路,照样节流
    markUserGesture()
    expect(notifyApp({ text: 'no button', event: 'plugin:biz' })).toBeNull()
    vi.advanceTimersByTime(0)
    expect(shown()).toEqual([])
  })

  it('到点收掉的那一刻用户点的(点按晚到一次桥往返):PHONE.lateTap 之内照样执行,只一次;带 onClose 的已经落定、不执行;用户自己收的不留', () => {
    const run = vi.fn()
    const id = notifyApp({ text: 'open conv', event: 'plugin:biz', action: { label: 'Open', run } })!
    vi.advanceTimersByTime(5000) // 到点
    expect(shown()).toEqual([])
    vi.advanceTimersByTime(PHONE.lateTap - 100)
    st().activate(id)
    st().activate(id)
    expect(run, '晚到的点按该执行,且只一次').toHaveBeenCalledTimes(1)
    // 过了宽限:不执行
    resetNotificationThrottle()
    vi.advanceTimersByTime(300)
    const late = vi.fn()
    const id2 = notifyApp({ text: 'late', event: 'plugin:biz2', action: { label: 'Open', run: late } })!
    vi.advanceTimersByTime(5000 + PHONE.lateTap + 1)
    st().activate(id2)
    expect(late).not.toHaveBeenCalled()
    // 带 onClose(撤销回执一类):到点那一刻 onClose 已经落定,迟到的「撤销」不跑
    vi.advanceTimersByTime(300)
    const undo = vi.fn(), commit = vi.fn()
    const id3 = notifyApp({ text: 'deleted', event: 'plugin:c', action: { label: 'Undo', run: undo }, onClose: commit })!
    vi.advanceTimersByTime(5000)
    expect(commit).toHaveBeenCalledTimes(1)
    st().activate(id3)
    expect(undo).not.toHaveBeenCalled()
    // 用户自己点 × 收的:不留宽限
    vi.advanceTimersByTime(300)
    const gone = vi.fn()
    const id4 = notifyApp({ text: 'x', event: 'plugin:d', action: { label: 'Open', run: gone } })!
    st().dismiss(id4, 'user')
    st().activate(id4)
    expect(gone).not.toHaveBeenCalled()
  })

  it('横幅 ↔ 堆叠:收窄时只留最早那条、其余回队首;放宽时队列补满 4 条', () => {
    st().setBanner(false)
    for (const t of ['a', 'b', 'c']) notifyApp({ text: t, level: 'error' })
    st().setBanner(true)
    expect(shown()).toEqual(['a'])
    expect(st().queue.map((n) => n.text)).toEqual(['b', 'c'])
    st().setBanner(false)
    expect(shown()).toEqual(['a', 'b', 'c'])
  })
})
