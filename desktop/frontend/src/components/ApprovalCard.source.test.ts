// @vitest-environment happy-dom
/**
 * 审批卡来源行(P1 · K1 S12 渲染半边):远程会话发起的审批在标题下写「来自远程会话 · 设备名」或按来路写;本机 run 不写。
 * 设备名是登记者自选的不可信串:只进文本节点,带 HTML 的名字不许变成元素。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocaleProvider, translateFor } from '../i18n'
import { ApprovalCard } from './ApprovalCard'
import type { ApprovalRequest } from '../types'

const base: ApprovalRequest = {
  approvalId: 'a1', runId: 'r1', name: 'run_bash', arguments: JSON.stringify({ command: 'make build' }),
  preview: '$ make build', status: 'pending', reason: { kind: 'mode', mode: 'auto-edit' },
}
let host: HTMLDivElement
let root: Root
async function render(req: ApprovalRequest): Promise<void> {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ApprovalCard, { req, onDecide: () => {} }) })))
}
const source = (): string | null => host.querySelector('[data-approval-remote]')?.textContent ?? null

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as any).tangu })

describe('ApprovalCard 来源行', () => {
  it('调用方有名字 → 「来自远程会话 · 名字」,在理由行之前、复用 .approval-why', async () => {
    await render({ ...base, remote: { via: 'tunnel', callerUnit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', callerKind: 'phone', callerName: '小米 14' } })
    expect(source()).toBe(translateFor('zh', 'approval.remote.caller', { name: '小米 14' }))
    expect(source()).toBe('来自远程会话 · 小米 14')
    const rows = [...host.querySelectorAll('.approval-why')]
    expect(rows[0].hasAttribute('data-approval-remote')).toBe(true)
    expect(rows[1].textContent).toBe(translateFor('zh', 'approval.why.mode', { mode: translateFor('zh', 'approval.mode.autoEdit') }))
  })

  it('hub 验过的调用方、名字清洗后为空 → 「已登记设备」,不说成「未识别的客户端」', async () => {
    await render({ ...base, remote: { via: 'tunnel', callerUnit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', callerKind: 'phone' } })
    expect(source()).toBe(translateFor('zh', 'approval.remote.device'))
    expect(source()).toBe('来自远程会话 · 已登记设备')
    expect(source()).not.toBe(translateFor('zh', 'approval.remote.account'))
  })

  it('没有调用方 → 按来路;本机 run(无 remote)→ 不显示', async () => {
    await render({ ...base, remote: { via: 'tunnel' } })
    expect(source()).toBe(translateFor('zh', 'approval.remote.account'))
    await render({ ...base, remote: { via: 'lan' } })
    expect(source()).toBe(translateFor('zh', 'approval.remote.lan'))
    await render({ ...base, remote: { via: 'p2p' } })
    expect(source()).toBe(translateFor('zh', 'approval.remote.p2p'))
    await render({ ...base, remote: {} })
    expect(source()).toBe(translateFor('zh', 'approval.remote.unknown'))
    await render(base)
    expect(source()).toBeNull()
  })

  it('设备名里的 HTML 只是文字(不进 dangerouslySetInnerHTML)', async () => {
    await render({ ...base, remote: { via: 'tunnel', callerUnit: '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f', callerKind: 'phone', callerName: '<img src=x onerror=alert(1)>' } })
    expect(host.querySelector('[data-approval-remote] img')).toBeNull()
    expect(source()).toBe('来自远程会话 · <img src=x onerror=alert(1)>')
  })
})
