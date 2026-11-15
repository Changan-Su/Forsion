// @vitest-environment happy-dom
/**
 * 限时开放的本地时钟(useModelTrialClock):到点翻回锁住靠它。
 * 钉住 Codex 评审第 3 条:额度回包在路上时开放就到期了 → now 不能停在到期之前(否则选择器一直显示能用)。
 */
import { StrictMode, act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useModelTrialClock, type ModelTrials } from './modelTierLock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const T0 = Date.parse('2026-11-20T00:00:00Z')
let host: HTMLDivElement, root: Root, seen = 0
const Probe = ({ trials }: { trials: ModelTrials }) => { seen = useModelTrialClock(trials); return null }
const render = (trials: ModelTrials) => act(() => root.render(h(StrictMode, null, h(Probe, { trials }))))

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

it('额度回包路上开放已到期:拿到回包那一刻 now 拨到现在(不再停在到期之前)', () => {
  render({})
  expect(seen).toBe(T0)
  vi.setSystemTime(T0 + 5_000) // 回包在路上走了 5 秒,开放在第 2 秒到期
  render({ fable: T0 + 2_000 })
  expect(seen).toBeGreaterThanOrEqual(T0 + 2_000)
})

it('开放还在:到期那一刻(+250ms)自己往后跳', () => {
  render({ fable: T0 + 60_000 })
  expect(seen).toBe(T0)
  act(() => { vi.advanceTimersByTime(60_000 + 300) })
  expect(seen).toBeGreaterThanOrEqual(T0 + 60_000)
})
