/**
 * 审批理由(契约 C6):引擎为「写凭据 / Forsion 本机配置」发 reason.kind='protected'。
 * 钉三件:reducer 的白名单清洗认它(否则整条理由被丢,卡上不解释);文案走 approval.why.protected;
 * 「总允许」按钮不给(引擎对受保护路径每次都问、不落总允许)。
 */
import { describe, expect, it } from 'vitest'
import { alwaysAllowWorks, approvalReasonText, approvalRemoteText, sanitizeApprovalReason, sanitizeApprovalRemote } from './approvalReason'
import { translateFor } from './i18n'

const t = (k: string): string => k

describe('审批理由 protected(C6)', () => {
  it('清洗认 protected;白名单外的 kind 与畸形字段丢掉', () => {
    expect(sanitizeApprovalReason({ kind: 'protected', mode: 'full-auto' })).toEqual({ kind: 'protected', mode: 'full-auto' })
    expect(sanitizeApprovalReason({ kind: 'escalate', rule: 'x'.repeat(300), mode: 'bogus' })).toEqual({ kind: 'escalate', rule: 'x'.repeat(200) })
    expect(sanitizeApprovalReason({ kind: 'nope' })).toBeUndefined()
    expect(sanitizeApprovalReason(null)).toBeUndefined()
    expect(sanitizeApprovalReason('protected')).toBeUndefined()
  })

  it('文案 = approval.why.protected,zh/en 都有且英文里没有汉字', () => {
    expect(approvalReasonText({ kind: 'protected' }, t)).toBe('approval.why.protected')
    const zh = translateFor('zh', 'approval.why.protected')
    const en = translateFor('en', 'approval.why.protected')
    expect(zh).not.toBe('approval.why.protected')
    expect(en).not.toBe(zh) // en 缺词条会回落成中文(translateIn 的回退链),这里要真有英文
    expect(en).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('「总允许」只对普通档位理由有效', () => {
    expect(alwaysAllowWorks({ kind: 'protected' })).toBe(false)
    expect(alwaysAllowWorks({ kind: 'escalate' })).toBe(false)
    expect(alwaysAllowWorks({ kind: 'custom-ask' })).toBe(false)
    expect(alwaysAllowWorks({ kind: 'mode', mode: 'auto-edit' })).toBe(true)
    expect(alwaysAllowWorks(undefined)).toBe(true)
  })

  // 引擎 capabilities.approval:'always'(花掉账号里的东西这类动作):每次都问,完全通行与「总允许」都不跳过
  it('always:清洗认它、有自己的中英文案、不给「总允许」', () => {
    expect(sanitizeApprovalReason({ kind: 'always' })).toEqual({ kind: 'always' }) // 云端会话没有档位,mode 缺席
    expect(approvalReasonText({ kind: 'always' }, t)).toBe('approval.why.always')
    expect(alwaysAllowWorks({ kind: 'always' })).toBe(false)
    const zh = translateFor('zh', 'approval.why.always')
    const en = translateFor('en', 'approval.why.always')
    expect(zh).not.toBe('approval.why.always')
    expect(en).not.toBe(zh)
    expect(en).not.toMatch(/[\u4e00-\u9fff]/)
  })
})

// P1-K1
describe('审批来源 remote(P1 · K1 S12)', () => {
  const UNIT = '0f8e8c1e-9b7a-4c55-9d3e-3a1b2c4d5e6f'
  it('清洗:via 枚举;调用方只在 tunnel 时收,uuid / kind 缺一则整组丢;名字剥控制符截 120;畸形一律丢', () => {
    expect(sanitizeApprovalRemote({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: 'Pixel', marked: true, evil: 1 }))
      .toEqual({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: 'Pixel' })
    expect(sanitizeApprovalRemote({ via: 'tunnel', callerUnit: UNIT.toUpperCase(), callerKind: 'desktop' })).toEqual({ via: 'tunnel', callerUnit: UNIT, callerKind: 'desktop' })
    // 非隧道带调用方 = 不该发生(引擎只在 marked && tunnel 时给),渲染层同样不认
    expect(sanitizeApprovalRemote({ via: 'lan', callerUnit: UNIT, callerKind: 'phone', callerName: 'Spoof' })).toEqual({ via: 'lan' })
    expect(sanitizeApprovalRemote({ via: 'tunnel', callerUnit: 'nope', callerKind: 'phone', callerName: 'x' })).toEqual({ via: 'tunnel' })
    expect(sanitizeApprovalRemote({ via: 'tunnel', callerUnit: UNIT, callerKind: 'server', callerName: 'x' })).toEqual({ via: 'tunnel' })
    expect(sanitizeApprovalRemote({ via: 'bogus' })).toEqual({})
    const long = sanitizeApprovalRemote({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: `Pi\u0000x\u202e\u200bel ${'z'.repeat(300)}` })!
    expect(long.callerName!.startsWith('Pixel ')).toBe(true)
    expect(long.callerName!.length).toBe(120)
    expect(sanitizeApprovalRemote({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: { toString: () => 'x' } })).toEqual({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone' })
    for (const bad of [null, undefined, 'tunnel', 42, ['tunnel']]) expect(sanitizeApprovalRemote(bad)).toBeUndefined()
  })

  it('文案:有名字 → caller;否则按来路;本机(undefined)→ 空', () => {
    const t = (k: string, v?: Record<string, unknown>): string => (v?.name ? `${k}:${v.name}` : k)
    expect(approvalRemoteText({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: 'Pixel' }, t)).toBe('approval.remote.caller:Pixel')
    expect(approvalRemoteText({ via: 'tunnel' }, t)).toBe('approval.remote.account')
    expect(approvalRemoteText({ via: 'lan' }, t)).toBe('approval.remote.lan')
    expect(approvalRemoteText({ via: 'p2p' }, t)).toBe('approval.remote.p2p')
    expect(approvalRemoteText({}, t)).toBe('approval.remote.unknown')
    expect(approvalRemoteText(undefined, t)).toBe('')
  })

  it('hub 验过的调用方名字清洗后为空(零宽 / 双向符号)→ 「已登记设备」,不说成「未识别的客户端」', () => {
    const t = (k: string, v?: Record<string, unknown>): string => (v?.name ? `${k}:${v.name}` : k)
    // 服务端 String.trim() 不剥零宽字符 → registered_name 非空;桌面 / 引擎 / 渲染层清洗后成了空串,名字一路被丢掉
    const r = sanitizeApprovalRemote({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: '\u200b\u200b' })
    expect(r).toEqual({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone' })
    expect(approvalRemoteText(r, t)).toBe('approval.remote.device')
    expect(approvalRemoteText({ via: 'tunnel', callerUnit: UNIT, callerKind: 'desktop' }, t)).toBe('approval.remote.device')
    expect(approvalRemoteText(sanitizeApprovalRemote({ via: 'tunnel', callerUnit: UNIT, callerKind: 'phone', callerName: '\u202e\u2066 \ufeff' }), t)).toBe('approval.remote.device')
  })

  it('六个来源文案 zh / en 成对,英文不含汉字,{name} 占位两边一致', async () => {
    await import('./components/ApprovalCard') // 文案在组件模块级 registerMessages
    for (const k of ['approval.remote.caller', 'approval.remote.device', 'approval.remote.account', 'approval.remote.lan', 'approval.remote.p2p', 'approval.remote.unknown']) {
      const zh = translateFor('zh', k)
      const en = translateFor('en', k)
      expect(zh, k).not.toBe(k)
      expect(en, k).not.toBe(zh)
      expect(en, k).not.toMatch(/[\u4e00-\u9fff]/)
      expect(zh.includes('{name}'), k).toBe(en.includes('{name}'))
    }
    expect(translateFor('en', 'approval.remote.caller', { name: 'Pixel' })).toBe('From a remote session · Pixel')
  })
})
