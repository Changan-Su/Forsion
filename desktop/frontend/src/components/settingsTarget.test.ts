import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LEGACY_TARGETS, SETTINGS_TABS, agentSettingsTargets, resolveAgentSettingsTarget, resolveSettingsTarget, suggestSettingsTargets } from './settingsTarget'
import { SETTINGS_SEARCH_INDEX } from './settingsSearchIndex'

// U-02:登录失效 / 订阅过期 / `/login` 三条入口必须落到按钮所在的子页,不许再被归一到第一项「连接」。
describe('resolveSettingsTarget', () => {
  it.each([
    [undefined, { tab: 'general' }],
    ['', { tab: 'general' }],
    ['forsion', { tab: 'forsion' }], // appStore handleAuthExpired、/login:落到第一个子页(Extend 的「账号」)
    ['general/g-forsion', { tab: 'forsion' }], // 2026-09-28 前的二级落点
    ['sync/s-cloud', { tab: 'forsion', sub: 'f-sync' }],
    ['forsion/fx:forsion-extend:quota', { tab: 'forsion', sub: 'fx:forsion-extend:quota' }], // Extend 自绘子页的深链
    ['connection', { tab: 'general', sub: 'g-conn' }],
    ['agent-clis', { tab: 'agents', sub: 'ag-clis' }],
    ['wechat', { tab: 'channels' }],
    ['plugins', { tab: 'amadeus-plugins' }], // `/plugins`:旧引擎插件页并进统一插件页(此前落在「常规」)
    ['model/m-providers', { tab: 'model', sub: 'm-providers' }], // ReloginChip(订阅登录按钮在提供方)
    ['general/g-basic', { tab: 'general', sub: 'g-basic' }],
    ['skills', { tab: 'skills' }],
    ['remote-sessions', { tab: 'remote-sessions' }], // P1-K4:设备切换器的「设置 ›」深链
    ['plugin:a/b', { tab: 'plugin:a/b' }], // 插件 id 里的 `/` 不拆
    ['fplugin:x', { tab: 'fplugin:x' }],
    ['model/', { tab: 'model/' }], // 空 sub 不算二级落点(交给 SettingsModal 兜底到第一个可用页)
  ])('%s → %j', (input, expected) => {
    expect(resolveSettingsTarget(input as string | undefined)).toEqual(expected)
  })

  it('别名里的一级页都是真实存在的 StaticTab', () => {
    const known = new Set<string>(SETTINGS_TABS)
    for (const [alias, [tab]] of Object.entries(LEGACY_TARGETS)) expect(known.has(tab), alias).toBe(true)
  })
})

// 反馈 6a239e58:agent 传了不存在的页名,弹窗静默落到「常规」,命令却回报成功 —— 它于是告诉用户「语音设置已打开」。
describe('resolveAgentSettingsTarget', () => {
  it.each([
    ['model', { tab: 'model' }],
    ['model/m-voice', { tab: 'model', sub: 'm-voice' }],
    ['voice', { tab: 'model', sub: 'm-voice' }], // 具体设置项 id → 它所在的子页
    ['fonts', { tab: 'theme' }],
    ['connection', { tab: 'general', sub: 'g-conn' }], // 旧别名照认
    ['plugin:a/b', { tab: 'plugin:a/b' }],
    ['computer-history', { tab: 'computer-history' }], // 页 id 与设置项 id 同名:按页
  ])('%s → %j', (input, expected) => expect(resolveAgentSettingsTarget(input)).toEqual(expected))

  it.each(['speech', 'voice-settings', 'model/', 'plugin:', 'nope/m-voice'])('认不出的 %s → null(调用方报错,不落到第一页装作成功)', (input) => {
    expect(resolveAgentSettingsTarget(input)).toBeNull()
  })

it('落点清单:列出的每个名字都解析得出来;真页不漏、旧别名不当作页列出;塞得进引擎的 params 上限', () => {
    const text = agentSettingsTargets()
    const [, pageList, settingList] = /^Pages: (.*)\. Settings: (.*)\.$/.exec(text)!
    const pages = pageList.split(', ')
    for (const page of pages) expect(resolveAgentSettingsTarget(page), page).toEqual({ tab: page })
    expect(pages).toContain('forsion') // 自指的别名(forsion → forsion)是真页,别跟着别名一起滤掉
    for (const alias of ['plugins', 'connection', 'agent-clis', 'wechat']) expect(pages).not.toContain(alias)
    const settings = settingList.split(', ')
    expect(settings).toEqual(SETTINGS_SEARCH_INDEX.map((entry) => entry.id))
    for (const id of settings) expect(resolveAgentSettingsTarget(id)!.tab, id).toBe(SETTINGS_SEARCH_INDEX.find((entry) => entry.id === id)!.tab)
    // 引擎对命令 params 的 JSON 设 2000 字符上限,超了整个丢弃(模型连 tab 参数都看不到)。留 300 的余量给日后新增设置项。
    const params = { type: 'object', properties: { tab: { type: 'string', description: `A page id, \`page/subpage\`, or a setting id. Omit for the default page. ${text}` } } }
    expect(JSON.stringify(params).length).toBeLessThan(1700)
  })

  it('真模型台架 settingsnav 场景里抄的落点清单与这里逐字一致(改了设置页 / 搜索索引就同步 tangu-agent/scripts/live-harness.mjs)', () => {
    const harness = readFileSync(fileURLToPath(new URL('../../../../tangu-agent/scripts/live-harness.mjs', import.meta.url)), 'utf8')
    expect(harness.includes(`const TARGETS = '${agentSettingsTargets()}';`), agentSettingsTargets()).toBe(true)
  })

  it('认不出的名字按搜索别名给相近项', () => {
    expect(suggestSettingsTargets('speech')).toEqual(['voice'])
    expect(suggestSettingsTargets('语音')).toEqual(['voice'])
    expect(suggestSettingsTargets('zzz')).toEqual([])
    expect(suggestSettingsTargets('')).toEqual([])
  })

  it('搜索索引里的页都是真实存在的一级页', () => {
    for (const entry of SETTINGS_SEARCH_INDEX) expect(SETTINGS_TABS as readonly string[], entry.id).toContain(entry.tab)
  })
})
