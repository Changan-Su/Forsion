// @vitest-environment happy-dom
/**
 * P1-K6 S2 · 审批卡按会话所在的目标判远端只读(INTEGRATION R-31;契约 C9)。手机把整端切到「我的电脑」后,
 * 那台电脑的引擎按远程钳制:改参数被拒、「总允许」降成单次 —— 卡片必须收起这两样(否则改了命令点批准什么都不发生)。
 *   ① 焦点在 unit(手机,没有 window.tangu.remoteCaller)→ 只读、没有「总允许」;
 *   ② 焦点在 home(手机本端 = 云端)→ 照旧可编辑、有「总允许」;
 *   ③ 设备页 home 目标仍按 window.tangu.remoteCaller(旧口径不变);
 *   ④ isRemoteApprover(sid) 不要求引擎宿主已装好(本文件不 import appStore)。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocaleProvider, translateFor } from '../i18n'
import { ApprovalCard, isRemoteApprover } from './ApprovalCard'
import { resetFocusForTests, useEngineFocus } from '../services/engine/targets'
import type { ApprovalRequest } from '../types'

const U = '7f0e8a52-0000-4000-8000-00000000000a'
const req: ApprovalRequest = {
  approvalId: 'a1', runId: 'r1', name: 'run_bash', arguments: JSON.stringify({ command: 'make build' }),
  preview: '$ make build', status: 'pending', reason: { kind: 'mode', mode: 'auto-edit' },
} as ApprovalRequest

let host: HTMLDivElement
let root: Root
async function render(sessionId?: string): Promise<void> {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ApprovalCard, { req, onDecide: () => {}, sessionId }) })))
}
const buttons = (): string[] => [...host.querySelectorAll('.approval-actions button')].map((b) => (b.textContent || '').trim())

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  resetFocusForTests()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as any).tangu; resetFocusForTests() })

describe('ApprovalCard × 会话所在的目标', () => {
  it('焦点在「我的电脑」(手机,无 remoteCaller)→ 命令只读、没有「总允许」', async () => {
    ;(window as any).tangu = { mobile: true }
    useEngineFocus.setState({ ref: { kind: 'unit', unitId: U }, name: 'Mac' })
    expect(isRemoteApprover('mac-1')).toBe(true)
    await render('mac-1')
    expect(host.querySelector('textarea.approval-edit')).toBeNull()
    expect(buttons()).toEqual([translateFor('zh', 'approval.approve'), translateFor('zh', 'approval.reject')])
    expect(host.querySelector('[data-remote-readonly]')).not.toBeNull()
  })

  it('焦点在 home(手机本端)→ 命令可编辑、「总允许」照旧', async () => {
    ;(window as any).tangu = { mobile: true }
    expect(isRemoteApprover('home-1')).toBe(false)
    await render('home-1')
    expect(host.querySelector('textarea.approval-edit')).not.toBeNull()
    expect(buttons().length).toBe(3)
  })

  it('设备页的 home 目标仍按 window.tangu.remoteCaller', async () => {
    ;(window as any).tangu = { unitPage: true, remoteCaller: true }
    expect(isRemoteApprover()).toBe(true)
    ;(window as any).tangu = { unitPage: true, remoteCaller: false }
    expect(isRemoteApprover()).toBe(false)
    ;(window as any).tangu = {}
    expect(isRemoteApprover('s')).toBe(false) // 桌面本机
  })
})
