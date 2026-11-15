/** 「由谁来跑」在界面上的判断:这台设备能不能跑、输入框写什么、引擎的错误码翻成哪句话。 */
import { describe, expect, it } from 'vitest'
import { translateFor } from '../i18n'
import { agentEngineErrorText, agentEngineOf, agentEnginePlaceholder, agentEngineState, isRosterEngine } from './agentEngine'

const zh = (k: string, v?: Record<string, unknown>) => translateFor('zh', k, v)
const en = (k: string, v?: Record<string, unknown>) => translateFor('en', k, v)

describe('agentEngineState', () => {
  it('Tangu(空)恒能跑', () => {
    expect(agentEngineState('', [])).toBe('ready')
  })
  it('本机清单里有、不是未安装 → 能跑(需登录也算,让 DSH 自己说原因)', () => {
    expect(agentEngineState('dsh', [{ id: 'dsh', status: 'available' }])).toBe('ready')
    expect(agentEngineState('dsh', [{ id: 'dsh', status: 'needs-signin' }])).toBe('ready')
  })
  it('清单里标着未安装 → not-installed', () => {
    expect(agentEngineState('dsh', [{ id: 'dsh', status: 'not-installed' }])).toBe('not-installed')
  })
  it('清单是空的(手机 / 网页 / 连着别的设备)→ elsewhere', () => {
    expect(agentEngineState('dsh', [])).toBe('elsewhere')
  })
  it('本版本不认识的引擎 → unsupported,不当 Tangu', () => {
    expect(agentEngineState('claude-code', [{ id: 'claude-code', status: 'available' }])).toBe('unsupported')
  })
})

describe('输入框写什么', () => {
  it('能跑时不改占位', () => {
    expect(agentEnginePlaceholder('dsh', 'ready', zh)).toBeNull()
  })
  it('手机 / 网页:说只能在电脑上用', () => {
    expect(agentEnginePlaceholder('dsh', 'elsewhere', zh)).toBe('只能在电脑上用：这个 Agent 由 DSH 运行')
    expect(agentEnginePlaceholder('dsh', 'elsewhere', en)).toBe('Computer only: this agent runs on DSH')
  })
  it('没装:指到设置里的安装命令', () => {
    expect(agentEnginePlaceholder('dsh', 'not-installed', zh)).toContain('设置 › 本机 Agent CLI')
  })
})

describe('引擎的错误码', () => {
  it('agent_engine_* 翻成人话,带引擎名', () => {
    expect(agentEngineErrorText('agent_engine_not_installed:dsh DSH is not installed', zh)).toBe('这台电脑上没装 DSH，这个 Agent 跑不起来。安装命令在设置 › 本机 Agent CLI')
    expect(agentEngineErrorText('agent_engine_elsewhere:dsh This agent runs on DSH…', en)).toContain('only works in its own chats')
  })
  it('别的错误不认', () => {
    expect(agentEngineErrorText('rate limited', zh)).toBeNull()
    expect(agentEngineErrorText(undefined, zh)).toBeNull()
  })
})

describe('小工具', () => {
  it('agentEngineOf 去空白;没有就是空串', () => {
    expect(agentEngineOf({ engine: ' dsh ' })).toBe('dsh')
    expect(agentEngineOf({})).toBe('')
    expect(agentEngineOf(null)).toBe('')
  })
  it('名册里有 Agent 形态的引擎只有 DSH', () => {
    expect(isRosterEngine('dsh')).toBe(true)
    expect(isRosterEngine('codex')).toBe(false)
  })
})
