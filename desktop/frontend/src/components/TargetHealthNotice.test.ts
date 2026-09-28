// @vitest-environment happy-dom
// P1-K6 S2 · 焦点目标连接态提示:本端 → 原样渲染 fallback(额度提示),零改变;焦点在「我的电脑」→ 按健康态给一句人话,
// 除设备被移除外都给「重试」(终局态不自动重试,按钮是就地出口);拒绝码优先走 localOnly 的本地化表。设备名只进文本节点。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocaleProvider, setLocaleGlobal, translateFor } from '../i18n'
import { TargetHealthNotice } from './TargetHealthNotice'
import { resetFocusForTests, useEngineFocus } from '../services/engine/targets'
import { noteHealth, noteVerdict, resetHealth } from '../services/engine/health'
import { useApp } from '../stores/appStore'

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const KEY = `unit:${U}` as const
let host: HTMLDivElement
let root: Root
async function render(): Promise<void> {
  await act(async () => root.render(React.createElement(LocaleProvider, {
    children: React.createElement(TargetHealthNotice, { fallback: React.createElement('div', { 'data-testid': 'quota' }, 'quota') }),
  })))
}
const notice = (): HTMLElement | null => host.querySelector('.t2-target-health')

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  resetFocusForTests()
  resetHealth()
  useApp.setState({ connState: 'ok', connMessage: '' })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('TargetHealthNotice', () => {
  it('焦点在本端 → 只渲染 fallback', async () => {
    noteVerdict(KEY, 'offline') // 别的目标的健康态不影响本端
    await render()
    expect(notice()).toBeNull()
    expect(host.querySelector('[data-testid="quota"]')).not.toBeNull()
  })

  it('焦点在我的电脑且健康 → fallback;离线 → 提示 + 重试,替代 fallback(两条不叠放)', async () => {
    useEngineFocus.setState({ ref: { kind: 'unit', unitId: U }, name: '<b>Mac</b>' })
    noteVerdict(KEY, 'ok')
    await render()
    expect(notice()).toBeNull()
    await act(async () => { noteVerdict(KEY, 'offline') })
    expect(notice()?.dataset.targetHealth).toBe('offline')
    expect(notice()?.textContent).toContain(translateFor('zh', 'engine.target.offline', { name: '<b>Mac</b>' }))
    expect(notice()?.querySelector('b')).toBeNull() // 设备名是纯文本
    expect(notice()?.querySelector('button')?.textContent).toContain(translateFor('zh', 'engine.target.retry'))
    expect(host.querySelector('[data-testid="quota"]')).toBeNull()
  })

  it('设备被移除不给重试(connect 会自己切回本端);拒绝码走本地化表', async () => {
    useEngineFocus.setState({ ref: { kind: 'unit', unitId: U }, name: 'Mac' })
    noteVerdict(KEY, 'gone')
    await render()
    expect(notice()?.dataset.targetHealth).toBe('gone')
    expect(notice()?.querySelector('button')).toBeNull()
    await act(async () => { resetHealth(); noteHealth(KEY, { state: 'caller-unavailable', since: 1, code: 'BAD_CALLER_ASSERTION' }) })
    expect(notice()?.textContent).toContain(translateFor('zh', 'engine.refusal.badCallerAssertion'))
  })

  // 评审 F3:身份取不到(K8 换票抖一下)/ 引擎拒了凭据 / 拒绝 —— 不自动重试(R-32),但得给用户一个出口:
  // 原先只有切走再切回、或重载整个 app。设备被移除才是真没救(connect 会自己切回本端)。
  it.each([
    ['caller-unavailable', 'CALLER_UNAVAILABLE'],
    ['engine-auth', undefined],
    ['refused', 'REMOTE_LOCKED'],
  ] as const)('%s 给「重试」(手动,不自动)', async (state, code) => {
    useEngineFocus.setState({ ref: { kind: 'unit', unitId: U }, name: 'Mac' })
    noteHealth(KEY, { state, since: 1, ...(code ? { code } : {}) })
    await render()
    expect(notice()?.dataset.targetHealth).toBe(state)
    expect(notice()?.querySelector('button')?.textContent).toContain(translateFor('zh', 'engine.target.retry'))
  })

  it('刚切过去还在连 → 「正在连接」', async () => {
    useEngineFocus.setState({ ref: { kind: 'unit', unitId: U }, name: 'Mac' })
    useApp.setState({ connState: 'idle' })
    await render()
    expect(notice()?.dataset.targetHealth).toBe('connecting')
    expect(notice()?.textContent).toContain(translateFor('zh', 'engine.target.connecting', { name: 'Mac' }))
  })
})

// P1-KF:「拒绝」这一格带上拒绝体的 state / reason —— 只凭码会一律说「正在等待那台电脑确认」,而带 reason 时那边根本没有弹框。
describe('TargetHealthNotice × P1-KF 拒绝按 reason 先、state 后', () => {
  const RCU = 'REMOTE_CALLER_UNCONFIRMED'
  it.each(['zh', 'en'] as const)('[%s] reason 那句;reason 变了提示条跟着换(同态不同原因要重写健康格);没有 reason 的 pending 才是「等待确认」', async (lang) => {
    await act(async () => setLocaleGlobal(lang))
    try {
      useEngineFocus.setState({ ref: { kind: 'unit', unitId: U }, name: 'Mac' })
      noteVerdict(KEY, 'refused', { code: RCU, refusal: { state: 'denied', reason: 'strict' } })
      await render()
      const waiting = translateFor(lang, 'unitpage.remoteCallerUnconfirmed')
      expect(notice()?.dataset.targetHealth).toBe('refused')
      expect(notice()?.textContent).toContain(translateFor(lang, 'unitpage.remoteCallerStrict'))
      expect(notice()?.textContent).not.toContain(waiting)
      await act(async () => { noteVerdict(KEY, 'refused', { code: RCU, refusal: { state: 'unconfirmed', reason: 'not-signed-in' } }) })
      expect(notice()?.textContent).toContain(translateFor(lang, 'unitpage.remoteCallerNotSignedIn'))
      await act(async () => { noteVerdict(KEY, 'refused', { code: RCU, refusal: { state: 'denied', reason: 'roster-miss' } }) })
      expect(notice()?.textContent).toContain(translateFor(lang, 'unitpage.remoteCallerRosterMiss'))
      expect(notice()?.textContent).not.toMatch(/10\s*分钟|10 minutes/)
      await act(async () => { noteVerdict(KEY, 'refused', { code: RCU, refusal: { state: 'pending' } }) })
      expect(notice()?.textContent).toContain(waiting)
    } finally { await act(async () => setLocaleGlobal('zh')) }
  })
})

