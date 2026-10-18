// @vitest-environment happy-dom
/**
 * 使用指南(Forsion Extend)要的三条接缝的闸(2026-10-17):
 *  · ctx.app.runCommand 只放行首方内置包 —— 命令里有删除 / 改设置,别的插件调了恒 false、命令不跑;
 *  · ctx.achievements.count 只读:官方事件读裸名,`plugin:` 开头的(别家插件的计数)一律 0,own 读自己的;
 *  · ctx.inbox 只注入给首方内置包;插件信的卡只认「本机系统消息 + 发件人 plugin:<id>」,服务端广播冒名拿不到。
 * 负对照:删掉 runCommand 里的 locked 判断 → 第一条红;inboxCardOf 去掉 sender_kind 判断 → 第三条红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalPluginSource } from '@amadeus-shared/ipc'

const env = vi.hoisted(() => ({ sources: [] as ExternalPluginSource[] }))
vi.mock('../api', () => ({
  amadeus: { listPlugins: async () => env.sources, listPages: async () => [], listFiles: async () => [] },
}))
const { usePluginStore } = await import('./pluginStore')
const { useCommandStore } = await import('@lcl/engine')
const { track, useAchievements } = await import('../../achievements/store')
const { inboxCardOf } = await import('./inboxCards')

const src = (over: Partial<ExternalPluginSource> & { id: string }): ExternalPluginSource => ({ name: over.id, version: '0.0.1', apiVersion: 1, code: '', ...over })
const seen = (): Record<string, unknown> => (window as unknown as { __seen: Record<string, unknown> }).__seen

beforeEach(() => {
  localStorage.clear()
  usePluginStore.setState({ plugins: [], activeIds: [], disabledIds: [], disposers: {}, lastSetupError: {}, initialized: false })
  useAchievements.setState({ counters: {}, claimed: {}, queue: [] })
  ;(window as unknown as { __seen: Record<string, unknown> }).__seen = {}
  env.sources = []
})

describe('使用指南接缝', () => {
  it('runCommand:首方内置包能跑现成命令,普通插件恒 false', async () => {
    const ran: string[] = []
    useCommandStore.getState().addCommand({ id: 'guide-test-cmd', title: 't', run: () => { ran.push('x') } })
    env.sources = [
      src({ id: 'forsion-extend', preinstalled: true, locked: true, bundleOff: false, code: "window.__seen.ext = ctx.app.runCommand('guide-test-cmd'); window.__seen.extMissing = ctx.app.runCommand('nope')" }),
      src({ id: 'third', code: "window.__seen.third = ctx.app.runCommand('guide-test-cmd')" }),
    ]
    await usePluginStore.getState().loadExternal()
    expect(seen()).toEqual({ ext: true, extMissing: false, third: false })
    expect(ran).toEqual(['x'])
  })

  it('achievements.count:读官方计数与自己的计数,读不到别家插件的', async () => {
    track('chat.send', 3)
    track('plugin:other:secret', 2)
    env.sources = [src({ id: 'mine', code: [
      "ctx.achievements.track('lv', 1)",
      "window.__seen.official = ctx.achievements.count('chat.send')",
      "window.__seen.other = ctx.achievements.count('plugin:other:secret')",
      "window.__seen.own = ctx.achievements.count('lv', { own: true })",
      "window.__seen.never = ctx.achievements.count('note.create')",
    ].join(';') })]
    await usePluginStore.getState().loadExternal()
    expect(seen()).toEqual({ official: 3, other: 0, own: 1, never: 0 })
  })

  it('inbox:只给首方内置包;卡只认本机系统消息 + 发件人 plugin:<id>', async () => {
    env.sources = [
      src({ id: 'forsion-extend', preinstalled: true, locked: true, bundleOff: false, code: "window.__seen.ext = !!ctx.inbox; ctx.inbox.registerCard({ sender: () => 'Guide', mount: () => {} })" }),
      src({ id: 'third', code: 'window.__seen.third = !!ctx.inbox' }),
    ]
    await usePluginStore.getState().loadExternal()
    expect(seen()).toEqual({ ext: true, third: false })
    expect(inboxCardOf({ sender_kind: 'system', sender_id: 'plugin:forsion-extend' })?.sender?.()).toBe('Guide')
    expect(inboxCardOf({ sender_kind: 'server', sender_id: 'plugin:forsion-extend' })).toBeUndefined()
    expect(inboxCardOf({ sender_kind: 'agent', sender_id: 'plugin:forsion-extend' })).toBeUndefined()
    env.sources = [] // 包没了 = 停用(locked 包不吃 disable,跟主进程开关走)
    await usePluginStore.getState().loadExternal()
    expect(inboxCardOf({ sender_kind: 'system', sender_id: 'plugin:forsion-extend' })).toBeUndefined()
  })
})
