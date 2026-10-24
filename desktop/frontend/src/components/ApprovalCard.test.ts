// @vitest-environment happy-dom
// 审批卡与引擎口径一致:引擎不缓存「总允许」的几类(越界写 / ask 规则 / 控制面)不显示那个按钮,
// 控制面给出本地化的「为什么问你」。testSetup 把语言钉成 zh;en 侧另起一例。
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../types'
import { ApprovalCard } from './ApprovalCard'
import { HostLocaleProvider, setLocaleGlobal, translate } from '../i18n'
import { sanitizeApprovalPreviewI18n } from '../approvalReason'

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

describe('run_bash 命令框:所见即所跑', () => {
  let host: HTMLDivElement
  let root: Root
  let scrollH = 0
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  beforeEach(() => {
    setLocaleGlobal('zh'); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    // happy-dom 没有布局:用桩 scrollHeight 模拟「软换行后内容比框高」
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => scrollH })
  })
  afterEach(() => {
    act(() => root.unmount()); host.remove()
    if (desc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', desc)
  })
  const bash = (command: string, id = 'b1'): ApprovalRequest => ({ approvalId: id, name: 'run_bash', arguments: JSON.stringify({ command }), preview: `$ ${command.replace(/ {25,}/g, (m) => `[${m.length} spaces]`)}`, status: 'pending' } as ApprovalRequest)

  it('内容高过上限:如实提示没显示完;放得下则不提示', () => {
    scrollH = 2000
    act(() => root.render(React.createElement(ApprovalCard, { req: bash('echo ok'), onDecide: () => {} })))
    expect(host.textContent).toContain(translate('approval.cmdOverflow'))
    scrollH = 40
    act(() => root.render(React.createElement(ApprovalCard, { key: 'b2', req: bash('ls', 'b2'), onDecide: () => {} })))
    expect(host.textContent).not.toContain(translate('approval.cmdOverflow'))
  })

  it('一大段空白(长单行也算):提示并摆出引擎标过空白的预览', () => {
    const cmd = `echo ok${' '.repeat(200)}&& rm -rf ~/Documents`
    act(() => root.render(React.createElement(ApprovalCard, { req: bash(cmd), onDecide: () => {} })))
    expect(host.textContent).toContain(translate('approval.cmdWideBlank'))
    expect(host.querySelector('.approval-preview')?.textContent).toContain('[200 spaces]&& rm -rf ~/Documents')
  })

  it('RLO / ALM / 零宽等伪装字符:提示所见可能不是所跑', () => {
    for (const ch of ['\u202E', '\u061C', '\u200B', '\uFEFF', '\u0085']) {
      act(() => root.render(React.createElement(ApprovalCard, { key: ch, req: bash(`echo ${ch}x`, ch), onDecide: () => {} })))
      expect(host.textContent, JSON.stringify(ch)).toContain(translate('approval.cmdHiddenChars'))
    }
  })
})

describe('散文类预览(previewI18n)跟随界面语言', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => { ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); setLocaleGlobal('zh') })

  // 引擎 webPublishPreview 的原样输出(publish_web_page { path: 'tea-signup.html', slug: 'tea-signup' })
  const enPublish = 'Publish tea-signup.html as a Forsion web page "tea-signup" (link name: tea-signup).\n' +
    'Anyone with the link can open it. The files go to your Forsion cloud drive and count toward its storage. If you already have a page called tea-signup, it is replaced.'
  const publish: ApprovalRequest = {
    approvalId: 'w1', runId: 'r1', name: 'publish_web_page', status: 'pending', reason: { kind: 'always', mode: 'full-auto' },
    arguments: JSON.stringify({ path: 'tea-signup.html', slug: 'tea-signup' }), preview: enPublish,
    previewI18n: { key: 'approval.preview.webPublish', vars: { path: 'tea-signup.html', name: 'tea-signup', slug: 'tea-signup' } },
  }
  const shown = async (req: ApprovalRequest, locale: 'zh' | 'en'): Promise<string> => {
    setLocaleGlobal(locale)
    await act(async () => root.render(React.createElement(HostLocaleProvider, null, React.createElement(ApprovalCard, { key: `${req.approvalId}-${locale}`, req, onDecide: () => {} }))))
    return host.querySelector('.approval-preview')?.textContent || ''
  }

  it('publish_web_page:中文界面出中文,英文界面与引擎那句逐字相同', async () => {
    const zh = await shown(publish, 'zh')
    expect(zh).toContain('把 tea-signup.html 发布为 Forsion 网页「tea-signup」')
    expect(zh).toContain('拿到链接的人都能打开')
    expect(await shown(publish, 'en')).toBe(enPublish)
  })

  it('账号动作三种 + 下线:zh 是中文、en 不含汉字,值都填进去了', async () => {
    const cases: Array<[ApprovalRequest['previewI18n'], string]> = [
      [{ key: 'approval.preview.resetCard' }, '重置卡'],
      [{ key: 'approval.preview.moveQuota', vars: { percent: 30 } }, '30%'],
      [{ key: 'approval.preview.feedback', vars: { message: 'dark mode please' } }, 'dark mode please'],
      [{ key: 'approval.preview.webUnpublish', vars: { slug: 'tea-signup' } }, 'tea-signup'],
    ]
    for (const [previewI18n, needle] of cases) {
      const req = { ...publish, approvalId: previewI18n!.key, name: 'forsion_account_action', preview: 'english', previewI18n }
      const zh = await shown(req, 'zh')
      expect(zh, previewI18n!.key).toMatch(/[一-鿿]/)
      expect(zh).toContain(needle)
      const en = await shown(req, 'en')
      expect(en, previewI18n!.key).not.toMatch(/[一-鿿]/)
      expect(en).not.toBe('english')
      if (previewI18n!.key !== 'approval.preview.resetCard') expect(en).toContain(needle.replace('%', ''))
    }
  })

  it('旧事件 / 本端没有的键:退回英文 preview', async () => {
    expect(await shown({ ...publish, previewI18n: undefined }, 'zh')).toBe(enPublish)
    expect(await shown({ ...publish, previewI18n: { key: 'approval.preview.notYet' } }, 'zh')).toBe(enPublish)
  })

  it('清洗:键只认 approval.preview.*,vars 有一个不是串 / 有限数就整份丢', () => {
    expect(sanitizeApprovalPreviewI18n({ key: 'approval.preview.resetCard' })).toEqual({ key: 'approval.preview.resetCard' })
    expect(sanitizeApprovalPreviewI18n({ key: 'approval.approve' })).toBeUndefined()
    expect(sanitizeApprovalPreviewI18n({ key: 'approval.preview.moveQuota', vars: { percent: Infinity } })).toBeUndefined()
    expect(sanitizeApprovalPreviewI18n({ key: 'approval.preview.feedback', vars: { message: { x: 1 } } })).toBeUndefined()
    expect(sanitizeApprovalPreviewI18n({ key: 'approval.preview.feedback', vars: [] })).toBeUndefined()
    expect(sanitizeApprovalPreviewI18n('approval.preview.resetCard')).toBeUndefined()
  })
})

