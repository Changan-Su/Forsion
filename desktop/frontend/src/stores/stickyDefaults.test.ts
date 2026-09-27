/**
 * 新会话的起步档位:延续「上次用的」审批档 / 思考档。
 * 会话本身的持久化走后端 agent_config(老路,已有);这里钉住的是**新会话拿什么起步**——
 * 病史:硬编码 'auto-edit',用户换到全自动后每建一个会话都要重设一次。
 */
import { describe, it, expect } from 'vitest'
import { stickyDefaults, DEFAULT_APPROVAL } from './appStore'
import { newSessionConfig } from './projectSettings'
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

  it('Ultra 只延续到本机 work 会话,且只跟 max 同在', () => {
    const dc = cfg({ lastThinkingLevel: 'max', lastUltra: true })
    expect(stickyDefaults(dc, true)).toMatchObject({ thinkingLevel: 'max', ultra: true })
    expect(stickyDefaults(dc, false).ultra).toBeUndefined() // 云端会话:没有 delegate,药丸也显示不出来
    expect(stickyDefaults(dc, true, 'chat').ultra).toBeUndefined() // chat 槽没有 Ultra
    expect(stickyDefaults(cfg({ lastThinkingLevel: 'high', lastUltra: true }), true).ultra).toBeUndefined()
  })

  it('建会话三层次序下 Ultra 只跟 max 同在:项目默认 / 草稿显式改过档就不带上次的 Ultra', () => {
    const sticky = { thinkingLevel: 'max' as const, ultra: true }
    expect(newSessionConfig(sticky, {}).ultra).toBe(true)
    expect(newSessionConfig(sticky, { thinkingLevel: 'high' }).ultra).toBeUndefined() // 项目默认的档压过 sticky
    expect(newSessionConfig(sticky, {}, { thinkingLevel: 'max', ultra: false })).not.toHaveProperty('ultra') // 草稿里点了 Max:false 挡住回填,落库前去掉
    expect(newSessionConfig(sticky, {}, { thinkingLevel: 'low' })).not.toHaveProperty('ultra')
  })
})
