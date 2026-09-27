// @vitest-environment happy-dom
/**
 * 设备页审批卡(Codex 终审 F#2):引擎对远端调用方拒收改参数(C9 → 400 REMOTE_ARGS_OVERRIDE_FORBIDDEN)、把「总允许」
 * 降成单次批准。旧卡在设备页照样给可编辑命令框和「总允许」,改了命令点批准 → 400 被 decideApproval 静默吞掉,
 * 卡片一直挂着、按钮像没反应;两个远端拒绝码也没有 zh/en 文案(英文 detail 原样上屏)。
 *   ① 远端身份(window.tangu.remoteCaller):run_bash 命令只读、不给「总允许」、说明为什么,批准不带 argsOverride;
 *   ② 本机(对照):命令可编辑、「总允许」照旧;
 *   ③ resolveApproval 把非 2xx 的远端拒绝码换成本地化提示带回;decideApproval 必须上屏(toast),网络异常同样上屏;
 *   ④ 共享 request() 对 400 的远端拒绝码(REMOTE_CWD_FORBIDDEN)同样本地化。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider, translateFor } from '../i18n'
import { ApprovalCard } from './ApprovalCard'
import type { ApprovalRequest } from '../types'

vi.mock('../services/http', () => ({ authFetch: vi.fn() }))
import { authFetch } from '../services/http'
import { resolveApproval } from '../services/agentRunService'
import { syncNow } from '../services/backendService'
import { useApp } from '../stores/appStore'

const req: ApprovalRequest = {
  approvalId: 'a1', runId: 'r1', name: 'run_bash', arguments: JSON.stringify({ command: 'make build' }),
  preview: '$ make build', status: 'pending', reason: { kind: 'mode', mode: 'auto-edit' },
} as ApprovalRequest

let host: HTMLDivElement
let root: Root
const onDecide = vi.fn()
const setRemote = (remote: boolean): void => { (window as any).tangu = remote ? { unitPage: true, remoteCaller: true } : {} }
async function render(): Promise<void> {
  await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ApprovalCard, { req, onDecide }) })))
}
const buttons = (): string[] => [...host.querySelectorAll('.approval-actions button')].map((b) => (b.textContent || '').trim())

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  onDecide.mockReset()
  vi.mocked(authFetch).mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as any).tangu })

describe('ApprovalCard × 远端身份', () => {
  it('设备页(remoteCaller):命令只读、没有「总允许」、给出原因;批准不带 argsOverride', async () => {
    setRemote(true)
    await render()
    expect(host.querySelector('textarea.approval-edit')).toBeNull()
    expect(host.querySelector('.approval-preview')?.textContent).toBe('$ make build')
    expect(buttons()).toEqual([translateFor('zh', 'approval.approve'), translateFor('zh', 'approval.reject')])
    expect(host.querySelector('[data-remote-readonly]')?.textContent).toBe(translateFor('zh', 'approval.remoteReadOnly'))
    await act(async () => (host.querySelector('.approval-actions .btn.primary') as HTMLButtonElement).click())
    expect(onDecide).toHaveBeenCalledWith('approve', undefined)
  })

  it('本机(对照):命令可编辑、「总允许」照旧,改过的命令作为 argsOverride 发出', async () => {
    setRemote(false)
    await render()
    const ta = host.querySelector('textarea.approval-edit') as HTMLTextAreaElement
    expect(ta).not.toBeNull()
    expect(buttons()).toContain(translateFor('zh', 'approval.approveAlways'))
    expect(host.querySelector('[data-remote-readonly]')).toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, 'make test')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => (host.querySelector('.approval-actions .btn.primary') as HTMLButtonElement).click())
    expect(onDecide).toHaveBeenCalledWith('approve', { command: 'make test' })
  })
})

const cfg = { backendUrl: 'http://unit/engine', token: 't' } as any
const reply = (body: unknown, status: number): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status }))

describe('远端拒绝码上屏(zh/en)', () => {
  it('resolveApproval:400 REMOTE_ARGS_OVERRIDE_FORBIDDEN → ok=false、gone=false、本地化 message', async () => {
    vi.mocked(authFetch).mockImplementation(() => reply({ code: 'REMOTE_ARGS_OVERRIDE_FORBIDDEN', detail: 'Editing the arguments of an approval is only available on the host computer.' }, 400))
    const r = await resolveApproval(cfg, 'r1', 'a1', 'approve', { command: 'x' })
    expect(r).toEqual({ ok: false, gone: false, code: 'REMOTE_ARGS_OVERRIDE_FORBIDDEN', message: translateFor('zh', 'unitpage.remoteArgsOverride') })
    vi.mocked(authFetch).mockImplementation(() => reply({ detail: 'gone' }, 410))
    expect(await resolveApproval(cfg, 'r1', 'a1', 'approve')).toEqual({ ok: false, gone: true })
  })

  it('request():400 REMOTE_CWD_FORBIDDEN → 本地化提示 + code(英文 detail 不上屏)', async () => {
    vi.mocked(authFetch).mockImplementation(() => reply({ code: 'REMOTE_CWD_FORBIDDEN', detail: 'A remote session cannot use /Users/x as its working directory' }, 400))
    const err = await syncNow(cfg).catch((e) => e)
    expect(err.message).toBe(translateFor('zh', 'unitpage.remoteCwd'))
    expect(err.code).toBe('REMOTE_CWD_FORBIDDEN')
  })

  it('两个新码 zh / en 成对,英文不含汉字', () => {
    for (const k of ['unitpage.remoteCwd', 'unitpage.remoteArgsOverride', 'approval.remoteReadOnly', 'agentrun.approvalFailed']) {
      expect(translateFor('zh', k)).not.toBe(k)
      const en = translateFor('en', k)
      expect(en).not.toBe(k)
      expect(/[一-龥]/.test(en), k).toBe(false)
    }
  })
})

describe('decideApproval 不再静默吞掉失败', () => {
  const initial = useApp.getState()
  const seed = (): ReturnType<typeof vi.fn> => {
    const toast = vi.fn()
    useApp.setState({
      activeId: 's', cfg, toast, tr: (k: string, v?: Record<string, unknown>) => `${k}:${v?.e ?? ''}`,
      messagesBySession: { s: [{ id: 'm', role: 'assistant', content: '', timestamp: 1, status: 'streaming', approvals: [{ ...req }] }] } as any,
    })
    return toast
  }
  afterEach(() => { useApp.setState(initial, true) })

  it('非 2xx(远端改参数被拒)→ toast 本地化原因;卡片不被误标过期', async () => {
    const toast = seed()
    vi.mocked(authFetch).mockImplementation(() => reply({ code: 'REMOTE_ARGS_OVERRIDE_FORBIDDEN', detail: 'x' }, 400))
    await useApp.getState().decideApproval('m', 'a1', 'approve', { command: 'y' })
    expect(toast).toHaveBeenCalledWith(`agentrun.approvalFailed:${translateFor('zh', 'unitpage.remoteArgsOverride')}`, true)
    expect(useApp.getState().messagesBySession.s[0].approvals?.[0].status).toBe('pending')
  })

  it('网络异常 → toast,不抛出(以前是未处理的 rejection)', async () => {
    const toast = seed()
    vi.mocked(authFetch).mockImplementation(() => Promise.reject(new Error('offline')))
    await expect(useApp.getState().decideApproval('m', 'a1', 'approve')).resolves.toBeUndefined()
    expect(toast).toHaveBeenCalledWith('agentrun.approvalFailed:offline', true)
  })

  it('410 仍按过期处理,不 toast', async () => {
    const toast = seed()
    vi.mocked(authFetch).mockImplementation(() => reply({ detail: 'gone' }, 410))
    await useApp.getState().decideApproval('m', 'a1', 'approve')
    expect(toast).not.toHaveBeenCalled()
    expect(useApp.getState().messagesBySession.s[0].approvals?.[0].status).toBe('expired')
  })
})
