/**
 * 新会话的起步档位:延续「上次用的」审批档 / 思考档。
 * 会话本身的持久化走后端 agent_config(老路,已有);这里钉住的是**新会话拿什么起步**——
 * 病史:硬编码 'auto-edit',用户换到全自动后每建一个会话都要重设一次。
 */
import { describe, it, expect } from 'vitest'
import { stickyDefaults, DEFAULT_APPROVAL } from './appStore'
import type { StoredDesktopConfig } from '../types'

const cfg = (p: Partial<StoredDesktopConfig>): StoredDesktopConfig => p as StoredDesktopConfig

describe('stickyDefaults', () => {
  it('没有记忆 → 全端默认「替我批准」', () => {
    expect(stickyDefaults(null, true)).toEqual({ approvalMode: DEFAULT_APPROVAL })
    expect(DEFAULT_APPROVAL).toBe('auto-edit')
  })

  it('记住的档位原样延续(含自定义)', () => {
    expect(stickyDefaults(cfg({ lastApprovalMode: 'full-auto' }), true).approvalMode).toBe('full-auto')
    expect(stickyDefaults(cfg({ lastApprovalMode: 'custom' }), true).approvalMode).toBe('custom')
  })

  it('云沙箱会话不带审批档(缺席=引擎按 full-auto,写死会让云端 MCP 逐个弹审批)', () => {
    expect(stickyDefaults(cfg({ lastApprovalMode: 'readonly' }), false).approvalMode).toBeUndefined()
  })

  it('思考档记住了才带上,两种执行模式都带', () => {
    expect(stickyDefaults(cfg({}), true).thinkingLevel).toBeUndefined()
    expect(stickyDefaults(cfg({ lastThinkingLevel: 'high' }), true).thinkingLevel).toBe('high')
    expect(stickyDefaults(cfg({ lastThinkingLevel: 'high' }), false).thinkingLevel).toBe('high')
  })
})
