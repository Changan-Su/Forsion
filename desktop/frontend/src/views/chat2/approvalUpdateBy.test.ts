// @vitest-environment happy-dom
/**
 * M1B · K3 反方向:托盘模式下审批卡答完即撤,手机上只剩聊天流里的 <approval_update> 结局行 —— 「谁批的」要写在那一行下面
 * (按 approval_result.by,reducer 清洗后挂在原审批上;回灌正文是给模型看的,不改)。
 *   ① 手机把整端切到那台电脑(焦点 = unit,名册名「K9 Studio Mac」)+ 电脑本机批 →「在执行的电脑上（K9 Studio Mac）批准」;拒绝同理;
 *   ② 别的已登记设备批 →「在 Pixel 9 上批准」;
 *   ③ 本页就是答复方 → 不写;桌面本机会话(焦点 home)看本机答的 → 不写;
 *   ④ 结局行找得到审批:按 callId = approval.toolCallId 翻全会话(挂起审批拍板时 run 往往已切到后面的段)。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocaleProvider, translateFor } from '../../i18n'
import { EditorialMessage } from './EditorialMessage'
import { approvalForCall } from './approvalQueue'
import { ApprovalCard } from '../../components/ApprovalCard'
import { useApp } from '../../stores/appStore'
import { bindSession, clearSessionBindings, resetFocusForTests, useEngineFocus } from '../../services/engine/targets'
import type { ApprovalRequest, UiMessage } from '../../types'

const SID = 's-m1b'
const UNIT = '6f99bfba-c9dc-4e10-9b51-43e50fde8db1'
const update = (rows: Array<[string, string]>): string => '<approval_update>\nThe user has decided on tool calls that were waiting for approval:\n\n' +
  rows.map(([st, id]) => `[${st}] run_bash (call ${id}) — $ ls\nIt has run.\n`).join('\n') + '</approval_update>'
const apv = (id: string, call: string, extra: Partial<ApprovalRequest>): ApprovalRequest => ({
  approvalId: id, runId: 'r1', name: 'run_bash', preview: '$ ls', status: 'approved', toolCallId: call, ...extra,
})

let host: HTMLDivElement
let root: Root
const initial = useApp.getState()

function seed(approvals: ApprovalRequest[], content: string): UiMessage {
  const user: UiMessage = { id: 'u-upd', role: 'user', content, status: 'done', timestamp: 2 } as UiMessage
  // 审批挂在前一段助手消息上(托盘 run 拍板时已切段),结局行在后面
  const asst: UiMessage = { id: 'a-1', role: 'assistant', content: '命令在等你批准。', status: 'done', timestamp: 1, approvals } as UiMessage
  useApp.setState({ messagesBySession: { ...useApp.getState().messagesBySession, [SID]: [asst, user] } })
  return user
}
async function renderMsg(msg: UiMessage): Promise<void> {
  await act(async () => root.render(React.createElement(LocaleProvider, {
    children: React.createElement(EditorialMessage, { msg, fileCtx: { cfg: useApp.getState().cfg, sessionId: SID, onOpenPreview: () => {} } as never }),
  })))
}
const captions = (): Array<{ after: string; by: string }> => [...host.querySelectorAll('.t2-apv-update-row')].map((r) => {
  const n = r.nextElementSibling
  return { after: r.getAttribute('data-status') || '', by: n?.matches('[data-answered-by]') ? (n.textContent || '') : '' }
})
/** 手机把焦点切到那台电脑、这条会话建在那台上(S4:会话的位置来自绑定表,名字来自焦点那台的名册名)。 */
const onUnit = (name: string | null): void => {
  useEngineFocus.setState({ ref: Object.freeze({ kind: 'unit' as const, unitId: UNIT }), name })
  bindSession(SID, { kind: 'unit', unitId: UNIT })
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  useApp.setState(initial, true)
  resetFocusForTests()
  clearSessionBindings()
})

describe('approvalForCall', () => {
  it('按 toolCallId 翻全会话;没有 toolCallId 的旧事件不认;空 callId → undefined', () => {
    const a = apv('a1', 'c-1', {}), b = apv('b1', 'c-2', {}), old = { ...apv('o1', '', {}), toolCallId: undefined }
    const list = [{ approvals: [old, a] }, { approvals: [b] }] as unknown as UiMessage[]
    expect(approvalForCall(list, 'c-2')).toBe(b)
    expect(approvalForCall(list, 'c-1')).toBe(a)
    expect(approvalForCall(list, '')).toBeUndefined()
    expect(approvalForCall(undefined, 'c-1')).toBeUndefined()
  })
})

describe('<approval_update> 结局行 ×「在哪批的」(M1B)', () => {
  it('手机驱动那台电脑 + 电脑本机批 / 拒 →「在执行的电脑上（K9 Studio Mac）批准 / 拒绝」', async () => {
    onUnit('K9 Studio Mac')
    const msg = seed([
      apv('h1', 'c-1', { answeredBy: { via: 'local' } }),
      apv('h2', 'c-2', { status: 'rejected', answeredBy: { via: 'local' } }),
    ], update([['approved', 'c-1'], ['rejected', 'c-2']]))
    await renderMsg(msg)
    const where = translateFor('zh', 'approval.byHostNamed', { device: 'K9 Studio Mac' })
    expect(where).toContain('在执行的电脑上')
    expect(captions()).toEqual([
      { after: 'approved', by: translateFor('zh', 'chat.approval.update.byApproved', { where }) },
      { after: 'rejected', by: translateFor('zh', 'chat.approval.update.byRejected', { where }) },
    ])
  })

  it('焦点没有名册名 → 只写「在执行的电脑上」,不拿「你的电脑」兜底凑括号', async () => {
    onUnit(null)
    await renderMsg(seed([apv('h3', 'c-3', { answeredBy: { via: 'local' } })], update([['approved', 'c-3']])))
    expect(captions()[0].by).toBe(translateFor('zh', 'chat.approval.update.byApproved', { where: translateFor('zh', 'approval.byHost') }))
  })

  it('别的已登记设备批的 →「在 Pixel 9 上批准」', async () => {
    onUnit('K9 Studio Mac')
    await renderMsg(seed([apv('d1', 'c-4', { answeredBy: { via: 'tunnel', callerUnit: UNIT, callerName: 'Pixel 9' } })], update([['approved', 'c-4']])))
    expect(captions()[0].by).toBe(translateFor('zh', 'chat.approval.update.byApproved', { where: translateFor('zh', 'approval.byDevice', { device: 'Pixel 9' }) }))
  })

  it('本页就是答复方 → 不写(托盘里点的就是同一张 ApprovalCard)', async () => {
    onUnit('K9 Studio Mac')
    const pending = apv('me1', 'c-5', { status: 'pending' })
    await act(async () => root.render(React.createElement(LocaleProvider, { children: React.createElement(ApprovalCard, { req: pending, onDecide: () => {} }) })))
    await act(async () => (host.querySelector('.approval-actions .btn.primary') as HTMLButtonElement).click())
    await renderMsg(seed([{ ...pending, status: 'approved', answeredBy: { via: 'tunnel', callerUnit: UNIT, callerName: 'K9 Pixel' } }], update([['approved', 'c-5']])))
    expect(captions()).toEqual([{ after: 'approved', by: '' }])
  })

  it('桌面本机会话(焦点 home)看本机答的 → 不写;没有 by 的旧事件 → 不写', async () => {
    await renderMsg(seed([apv('l1', 'c-6', { answeredBy: { via: 'local' } }), apv('l2', 'c-7', {})], update([['approved', 'c-6'], ['approved', 'c-7']])))
    expect(captions().map((c) => c.by)).toEqual(['', ''])
  })

  it('新文案 zh / en 成对、占位符一致、英文不含汉字', () => {
    for (const [k, v] of [['approval.byHostNamed', { device: 'X' }], ['chat.approval.update.byApproved', { where: 'W' }], ['chat.approval.update.byRejected', { where: 'W' }]] as const) {
      const zh = translateFor('zh', k, v), en = translateFor('en', k, v)
      expect(zh, k).not.toBe(k)
      expect(en, k).not.toBe(k)
      expect(/[一-龥]/.test(en), k).toBe(false)
      for (const x of Object.values(v)) { expect(zh).toContain(x); expect(en).toContain(x) }
    }
  })
})
