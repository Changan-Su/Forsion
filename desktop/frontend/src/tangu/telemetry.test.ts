import { afterEach, describe, expect, it } from 'vitest'
import { resetQuotaPromptStateForTest, tanguCount, tanguModelCount, tanguQuotaPromptShownOnce, tanguQuotaPromptVisible, tanguSetting } from './telemetry'

const g = globalThis as Record<string, unknown>
const prev = g.window
afterEach(() => { g.window = prev })

describe('Tangu 界面的遥测发送口', () => {
  it('走 preload 桥;没有桥 / 桥抛错都不影响调用方', () => {
    const sent: unknown[] = []
    g.window = { tangu: { telemetryReport: (kind: string, props: unknown) => sent.push([kind, props]) } }
    tanguCount('chatStop')
    tanguSetting('approval.defaultMode', 'full-auto')
    expect(sent).toEqual([['count', { key: 'chatStop' }], ['setting', { key: 'approval.defaultMode', value: 'full-auto' }]])
    g.window = { tangu: { telemetryReport: () => { throw new Error('ipc gone') } } }
    expect(() => tanguCount('chatStop')).not.toThrow()
    g.window = {}
    expect(() => tanguCount('chatStop')).not.toThrow()
  })
})

describe('v3:额度提示露出只在「从不显示变成显示」时计', () => {
  it('分栏几份同时挂着 / 重挂只计一次;等级变了算新的一次;全卸了再挂算新的一次', () => {
    resetQuotaPromptStateForTest()
    const sent: unknown[] = []
    g.window = { tangu: { telemetryReport: (kind: string, props: unknown) => sent.push([kind, props]) } }
    const a = tanguQuotaPromptVisible('chat-banner', 'main:daily:10')
    const b = tanguQuotaPromptVisible('chat-banner', 'main:daily:10') // 第二个分栏
    expect(sent).toHaveLength(1)
    a(); a() // 重复释放无害
    const c = tanguQuotaPromptVisible('chat-banner', 'main:daily:10') // 一份卸了又挂(另一份还挂着)
    expect(sent).toHaveLength(1)
    const d = tanguQuotaPromptVisible('chat-banner', 'main:daily:5') // 等级变了
    expect(sent).toHaveLength(2)
    b(); c(); d()
    tanguQuotaPromptVisible('chat-banner', 'main:daily:5')()
    expect(sent).toHaveLength(3)
    expect(sent[0]).toEqual(['quotaPrompt', { entry: 'chat-banner', action: 'shown' }])
  })
  it('按条目只计一次(运行出错那行的芯片),两颗芯片同一条消息共用;模型计数没有模型就不报', () => {
    resetQuotaPromptStateForTest()
    const sent: unknown[] = []
    g.window = { tangu: { telemetryReport: (kind: string, props: unknown) => sent.push([kind, props]) } }
    tanguQuotaPromptShownOnce('run-error', 'msg-1')
    tanguQuotaPromptShownOnce('run-error', 'msg-1')
    tanguQuotaPromptShownOnce('run-error', 'msg-2')
    tanguModelCount('stop', '')
    tanguModelCount('stop', 'codex/gpt-6-luna')
    expect(sent).toEqual([
      ['quotaPrompt', { entry: 'run-error', action: 'shown' }],
      ['quotaPrompt', { entry: 'run-error', action: 'shown' }],
      ['modelCount', { key: 'stop', modelId: 'codex/gpt-6-luna' }],
    ])
  })
})
