/**
 * 新会话的起步档位:延续「上次用的」审批档 / 思考档。
 * 会话本身的持久化走后端 agent_config(老路,已有);这里钉住的是**新会话拿什么起步**——
 * 病史:硬编码 'auto-edit',用户换到全自动后每建一个会话都要重设一次。
 */
import { describe, it, expect } from 'vitest'
import { stickyDefaults, DEFAULT_APPROVAL } from './appStore'
import { newSessionConfig, settleModes, settlePlanMode, settleUltra, teamModeOn } from './projectSettings'
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

  it('settleUltra:只在本机 host、非 chat、非外部引擎、非团队且档位是 max 时保留(建会话 / 空态显示 / 发 run 三处同口径)', () => {
    const ok = { execMode: 'host' as const, thinkingLevel: 'max' as const, ultra: true }
    expect(settleUltra(ok)).toEqual(ok)
    expect(settleUltra({ ...ok, execMode: 'sandbox' as const })).not.toHaveProperty('ultra') // 草稿换成云端工作区
    expect(settleUltra({ ...ok, preset: 'chat' as const })).not.toHaveProperty('ultra')
    expect(settleUltra({ ...ok, engineId: 'codex' })).not.toHaveProperty('ultra') // 外部引擎跑自己的 loop
    expect(settleUltra({ ...ok, groupChat: true })).not.toHaveProperty('ultra') // 团队成员各跑各的档
    expect(settleUltra({ ...ok, thinkingLevel: 'high' as const })).not.toHaveProperty('ultra') // Agent 自带非 max 档
    expect(settleUltra({ ...ok, ultra: false })).not.toHaveProperty('ultra') // 草稿里挡回填的 false 不落库
    const none = { execMode: 'host' as const }
    expect(settleUltra(none)).toBe(none) // 没这个键:原样返回
  })

  // 10-05 用户定「团队模式不能开计划模式」。口径与引擎 settleTeamPlanMode 一字不差:groupChat 为真;团队轨道会话没显式切回普通也算。
  it('settlePlanMode:团队模式下计划模式落成关;不是团队模式、或没开计划模式时原样返回', () => {
    expect(teamModeOn({ groupChat: true })).toBe(true)
    expect(teamModeOn({ teamSlug: 'crew' })).toBe(true)
    expect(teamModeOn({ teamSlug: 'crew', groupChat: false })).toBe(false) // 团队会话切回了普通模式
    expect(teamModeOn({ groupChat: false })).toBe(false)
    expect(teamModeOn({})).toBe(false)
    expect(teamModeOn(undefined)).toBe(false)
    expect(settlePlanMode({ groupChat: true, planMode: true })).toEqual({ groupChat: true, planMode: false })
    expect(settlePlanMode({ teamSlug: 'crew', planMode: true })).toEqual({ teamSlug: 'crew', planMode: false })
    for (const same of [{ planMode: true }, { groupChat: true }, { groupChat: true, planMode: false }, { teamSlug: 'crew', groupChat: false, planMode: true }]) {
      expect(settlePlanMode(same)).toBe(same)
    }
  })

  it('settleModes:两条互斥一起结(建会话 / 空态显示 / 发 run 用的就是它)', () => {
    expect(settleModes({ execMode: 'host' as const, thinkingLevel: 'max' as const, ultra: true, groupChat: true, planMode: true }))
      .toEqual({ execMode: 'host', thinkingLevel: 'max', groupChat: true, planMode: false })
    const solo = { execMode: 'host' as const, thinkingLevel: 'max' as const, ultra: true, planMode: true }
    expect(settleModes(solo)).toEqual(solo)
  })
})
