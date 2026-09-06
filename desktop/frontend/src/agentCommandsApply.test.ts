// @vitest-environment happy-dom
/**
 * `set_ui_setting` 的回执必须报「应用**之后**」的状态。
 *
 * 2026-09-05 实报:模型把 color_mode 切成 light,回执却说「now dark」—— 因为 setModePref 把
 * apply() 包在 document.startViewTransition 里,回调是**下一帧**才跑,而 applyUiSetting 同步读
 * state() 拿到的是切换前的值。模型据此判定失败,来回翻了三次。
 *
 * ⚠️ happy-dom **没有** startViewTransition,themeStore 会走同步的 `fn()` 分支 → 不装异步桩,
 *    这条测试在旧代码上照样绿(负对照已实跑:去掉桩即假绿)。所以桩是本测试的前置态,不是装饰。
 */
import { describe, it, expect, beforeAll } from 'vitest'

beforeAll(() => {
  ;(document as unknown as Record<string, unknown>).startViewTransition = (cb: () => void) => {
    let res!: () => void, rej!: (e: unknown) => void
    const updateCallbackDone = new Promise<void>((a, b) => { res = a; rej = b })
    setTimeout(() => { try { cb(); res() } catch (e) { rej(e) } }, 0) // 真浏览器语义:回调异步跑
    return { updateCallbackDone, ready: Promise.resolve(), finished: updateCallbackDone, skipTransition() {} }
  }
})

describe('set_ui_setting(color_mode) 的回执报应用之后的明暗', () => {
  it('切到 dark 时 state 必须是 dark,不能是切换前的 light', async () => {
    const { applyUiSetting } = await import('@/agentCommands')
    const { useTheme } = await import('@/stores/themeStore')
    expect(useTheme.getState().mode).toBe('light') // 前置态
    const r = await applyUiSetting('color_mode', 'dark')
    expect(r.ok).toBe(true)
    expect(r.state).toBe('dark')
    expect(useTheme.getState().mode).toBe('dark')
  })

  it('同值重设不挂起:偏好没变时立即返回当前值', async () => {
    const { applyUiSetting } = await import('@/agentCommands')
    const r = await applyUiSetting('color_mode', 'dark')
    expect(r).toEqual({ ok: true, state: 'dark' })
  })
})
