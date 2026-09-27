/**
 * 审批理由(契约 C6):引擎为「写凭据 / Forsion 本机配置」发 reason.kind='protected'。
 * 钉三件:reducer 的白名单清洗认它(否则整条理由被丢,卡上不解释);文案走 approval.why.protected;
 * 「总允许」按钮不给(引擎对受保护路径每次都问、不落总允许)。
 */
import { describe, expect, it } from 'vitest'
import { alwaysAllowWorks, approvalReasonText, sanitizeApprovalReason } from './approvalReason'
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
})
