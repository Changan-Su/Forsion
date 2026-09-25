// @vitest-environment happy-dom
// 审批卡与引擎口径一致:引擎不缓存「总允许」的几类(越界写 / ask 规则 / 控制面)不显示那个按钮,
// 控制面给出本地化的「为什么问你」。testSetup 把语言钉成 zh;en 侧另起一例。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../types'
import { ApprovalCard } from './ApprovalCard'
import { setLocaleGlobal, translate } from '../i18n'

describe('ApprovalCard「总允许」按钮与 why 行', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  const base: ApprovalRequest = {
    approvalId: 'p1', runId: 'r1', name: 'manage_automation',
    arguments: JSON.stringify({ action: 'set', desc: 'nightly' }),
    preview: 'manage_automation set (new): "nightly" · when time 09:00 · agent_run "xyra" unattended: tidy up',
    status: 'pending',
  }
  const render = async (req: ApprovalRequest): Promise<void> => {
    await act(async () => root.render(React.createElement(ApprovalCard, { req, onDecide: () => {} })))
  }
  const tr = (key: string, locale: 'zh' | 'en' = 'zh'): string => {
    setLocaleGlobal(locale)
    try { return translate(key) } finally { setLocaleGlobal('zh') }
  }
  const alwaysLabel = tr('approval.approveAlways')
  const buttons = (): string[] => Array.from(host.querySelectorAll('button')).map((b) => b.textContent?.trim() || '')

  it("kind='control':不给「总允许」,why 行是本地化的控制面说明(不拼档位)", async () => {
    await render({ ...base, reason: { kind: 'control', mode: 'full-auto' } })
    expect(buttons().some((b) => b.includes(alwaysLabel))).toBe(false)
    expect(buttons()).toHaveLength(2) // 批准 + 拒绝
    const why = host.querySelector('.approval-why')?.textContent || ''
    expect(why).toBe(tr('approval.why.control'))
    expect(why).not.toContain('approval.why') // 键真在字典里,不是原样渲染 key
    expect(why).not.toContain(tr('input.approval.fullAuto')) // 沙箱控制面带 full-auto,不能写成「完全放行下仍要批」
  })

  it('en 词条存在且不是中文', () => {
    const en = tr('approval.why.control', 'en')
    expect(en).not.toBe('approval.why.control')
    expect(en).not.toMatch(/[一-鿿]/)
  })

  it('控制面 why 行对三类控制面调用都成立:不写「创建」「完全放行」「总是要批」', () => {
    // 控制面也覆盖 manage_agent update:被改的 agent 可能自带只读档(预览写「approval tier stays readonly」),
    // host 会话的 full-auto 下控制面根本不问 —— 「创建以完全放行运行的任务,总要你确认」对它都是假话。
    const zh = tr('approval.why.control')
    const en = tr('approval.why.control', 'en')
    expect(zh).toContain('设置或修改')
    expect(zh).not.toMatch(/创建|完全放行/)
    expect(en).toMatch(/^This sets up or changes work that can later run without you watching/)
    expect(en).not.toMatch(/creates|full access|always needs/i)
  })

  it("正对照:kind='mode' 与无 reason 的旧事件仍显示「总允许」", async () => {
    await render({ ...base, name: 'run_bash', arguments: JSON.stringify({ command: 'npm test' }), preview: 'npm test', reason: { kind: 'mode', mode: 'auto-edit' } })
    expect(buttons().some((b) => b.includes(alwaysLabel))).toBe(true)
    await render({ ...base, approvalId: 'p2' })
    expect(buttons().some((b) => b.includes(alwaysLabel))).toBe(true)
  })

  it('escalate / custom-ask 照旧不给「总允许」', async () => {
    await render({ ...base, reason: { kind: 'escalate', mode: 'auto-edit' } })
    expect(buttons().some((b) => b.includes(alwaysLabel))).toBe(false)
    await render({ ...base, reason: { kind: 'custom-ask', rule: 'manage_automation', mode: 'auto-edit' } })
    expect(buttons().some((b) => b.includes(alwaysLabel))).toBe(false)
  })
})
