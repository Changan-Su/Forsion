// 插件双语展示的两条纪律(2026-08-14,codex 评审):
//  ①中文 canonical 永远兜底,英文缺失/坏掉只丢那一个字段,绝不整段消失;
//  ②onboarding 的英文 steps 按**中文原始下标**配对 —— 中文那步被消毒丢掉时英文那步一并丢,
//    否则翻译会错位到别的步骤上。
import { describe, expect, it } from 'vitest'
import { sanitizeOnboarding } from '@amadeus-shared/ipc'
import { localizedOnboarding, pluginDisplayName, pluginDisplayDescription, pluginsWithSettingsPanel, resolvePluginDetail } from './display'

describe('插件展示名/描述', () => {
  const p = { name: '闪念盒', nameEn: 'MemoFlow', description: '中文描述', descriptionEn: 'English desc' }
  it('按语言取,英文缺失回退中文', () => {
    expect(pluginDisplayName(p, 'zh')).toBe('闪念盒')
    expect(pluginDisplayName(p, 'en')).toBe('MemoFlow')
    expect(pluginDisplayName({ name: '只有中文' }, 'en')).toBe('只有中文')
    expect(pluginDisplayDescription({ name: 'x', description: '只有中文' }, 'en')).toBe('只有中文')
  })
})

describe('onboarding 英文镜像', () => {
  const raw = {
    intro: '中文引导',
    steps: [
      { title: '第一步', description: '中文说明一' },
      { title: '', description: '没标题会被丢掉' },
      { title: '第三步', description: '中文说明三' },
    ],
    settings: true,
    en: {
      intro: 'English intro',
      steps: [
        { title: 'Step one', description: 'English one' },
        { title: 'dropped along with its Chinese twin' },
        { title: 'Step three' }, // 只翻了标题
      ],
    },
  }

  it('消毒时按原始下标配对(中文丢一步,英文同步丢)', () => {
    const s = sanitizeOnboarding(raw)!
    expect(s.steps?.map((x) => x.title)).toEqual(['第一步', '第三步'])
    expect(s.en?.steps?.map((x) => x?.title)).toEqual(['Step one', 'Step three'])
  })

  it('英文视图逐字段回退:只翻了标题时描述仍用中文', () => {
    const s = sanitizeOnboarding(raw)!
    const en = localizedOnboarding(s, 'en')!
    expect(en.intro).toBe('English intro')
    expect(en.steps?.[0]).toEqual({ title: 'Step one', description: 'English one' })
    expect(en.steps?.[1]).toEqual({ title: 'Step three', description: '中文说明三' })
    expect(en.settings).toBe(true) // 结构字段原样
  })

  it('中文视图完全不受英文镜像影响', () => {
    const s = sanitizeOnboarding(raw)!
    const zh = localizedOnboarding(s, 'zh')!
    expect(zh.intro).toBe('中文引导')
    expect(zh.steps?.[1]).toEqual({ title: '第三步', description: '中文说明三' })
  })

  it('⚠️坏掉的 en 不许抹掉原 onboarding', () => {
    const s = sanitizeOnboarding({ intro: '中文', steps: [{ title: '一' }], en: 'not an object' })!
    expect(s.intro).toBe('中文')
    expect(s.en).toBeUndefined()
    expect(localizedOnboarding(s, 'en')!.intro).toBe('中文')
  })

  it('只有英文没有中文 canonical = 无引导(中文是必备回退)', () => {
    expect(sanitizeOnboarding({ en: { intro: 'only english' } })).toBeUndefined()
  })
})

// 左栏一级项的入选口径。⚠️ 每个启用插件都被 pluginStore 自动塞了一行 workFolder ——
// 漏掉那条排除,「有设置的插件」就等于「所有启用插件」,左栏被几十条冲垮。
describe('够格进设置左栏的插件', () => {
  const plugins = [{ id: 'pomodoro' }, { id: 'hello' }, { id: 'latex' }, { id: 'off' }]
  const active = ['pomodoro', 'hello', 'latex']
  const settings = [
    { pluginId: 'pomodoro', item: { key: 'workFolder' } },
    { pluginId: 'pomodoro', item: { key: 'minutes' } },
    { pluginId: 'hello', item: { key: 'workFolder' } },
    { pluginId: 'latex', item: { key: 'workFolder' } },
    { pluginId: 'off', item: { key: 'anything' } },
  ]
  const views = [{ pluginId: 'latex' }]

  it('只有自动那行 workFolder 的插件不进左栏', () => {
    expect(pluginsWithSettingsPanel(plugins, active, settings, views).map((p) => p.id)).not.toContain('hello')
  })
  it('声明式设置行与自绘面板都算,未启用的一律不进', () => {
    expect(pluginsWithSettingsPanel(plugins, active, settings, views).map((p) => p.id)).toEqual(['pomodoro', 'latex'])
  })
})

// 受控详情面 vs 列表内部选中态的优先级。⚠️ 陈旧深链(插件已卸载)那条是 codex 揪出来的真 bug:
// 受控 id 无条件优先 → 回落的卡片列表点哪张都被它盖住,成了一张点不开的假列表。
describe('插件详情面归属', () => {
  const plugins = [{ id: 'pomodoro' }, { id: 'latex' }]

  it('受控 id 解析得到时压过内部选中', () => {
    const r = resolvePluginDetail(plugins, 'latex', 'pomodoro')
    expect(r.plugin?.id).toBe('latex')
    expect(r.controlled).toBe(true)
  })
  it('陈旧受控 id(插件已卸载)让位给内部选中,列表仍点得动', () => {
    const r = resolvePluginDetail(plugins, 'uninstalled', 'pomodoro')
    expect(r.plugin?.id).toBe('pomodoro')
    expect(r.controlled).toBe(false)
  })
  it('陈旧受控 id 且列表没选中 → 落回列表,不留白板', () => {
    expect(resolvePluginDetail(plugins, 'uninstalled', null).plugin).toBeUndefined()
  })
})
