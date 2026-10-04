// 收件箱审批卡的理由行:引擎写的 reason JSON → 本地化短标签,绝不把 `control` / `escalate` / `mode` 裸词摆给用户。
import { describe, expect, it } from 'vitest'
import { approvalReasonLabel } from './InboxBody'
import { setLocaleGlobal, translate } from '../../i18n'

const t = (key: string, vars?: Record<string, unknown>): string => translate(key, vars)

describe('approvalReasonLabel', () => {
  it('control / escalate / mode 映射成字典里的本地化标签', () => {
    expect(approvalReasonLabel(JSON.stringify({ kind: 'control', mode: 'full-auto' }), t)).toBe(translate('inbox.approval.reason.control'))
    expect(approvalReasonLabel(JSON.stringify({ kind: 'escalate', mode: 'auto-edit' }), t)).toBe(translate('inbox.approval.reason.escalate'))
    expect(approvalReasonLabel(JSON.stringify({ kind: 'mode', mode: 'readonly' }), t)).toBe(translate('inbox.approval.reason.mode'))
    for (const kind of ['control', 'escalate', 'mode']) {
      const label = approvalReasonLabel(JSON.stringify({ kind }), t)
      expect(label).not.toContain(kind) // 引擎裸词不上屏
      expect(label).not.toContain('inbox.approval') // 键在字典里,不是原样渲染
    }
  })

  it('custom-ask 带规则串;没规则串给通用标签', () => {
    expect(approvalReasonLabel(JSON.stringify({ kind: 'custom-ask', rule: 'run_bash:rm' }), t)).toBe(translate('inbox.approval.reason.rule', { rule: 'run_bash:rm' }))
    expect(approvalReasonLabel(JSON.stringify({ kind: 'custom-ask', rule: 'run_bash:rm' }), t)).toContain('run_bash:rm')
    expect(approvalReasonLabel(JSON.stringify({ kind: 'custom-ask' }), t)).toBe(translate('inbox.approval.reason.customAsk'))
  })

  it('不认识的 kind、坏 JSON、空值 → 不显示', () => {
    expect(approvalReasonLabel(JSON.stringify({ kind: 'bogus' }), t)).toBe('')
    expect(approvalReasonLabel('{not json', t)).toBe('')
    expect(approvalReasonLabel(null, t)).toBe('')
    expect(approvalReasonLabel('', t)).toBe('')
  })

  it('control 标签对 manage_agent update 也成立:「设置」而非「创建」', () => {
    expect(approvalReasonLabel(JSON.stringify({ kind: 'control' }), t)).toBe('设置无人值守工作')
    setLocaleGlobal('en')
    try {
      expect(approvalReasonLabel(JSON.stringify({ kind: 'control' }), t)).toBe('Sets up unattended work')
    } finally {
      setLocaleGlobal('zh')
    }
  })

  it('en 侧同样是英文标签', () => {
    setLocaleGlobal('en')
    try {
      const label = approvalReasonLabel(JSON.stringify({ kind: 'control' }), t)
      expect(label).toBe(translate('inbox.approval.reason.control'))
      expect(label).not.toMatch(/[一-鿿]/)
    } finally {
      setLocaleGlobal('zh')
    }
  })
})
