import { afterEach, describe, expect, it } from 'vitest'
import { tanguCount, tanguSetting } from './telemetry'

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
