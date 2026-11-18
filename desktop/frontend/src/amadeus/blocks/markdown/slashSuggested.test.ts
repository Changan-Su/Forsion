// 斜杠菜单「常用」一组的排法(Notion 对齐 A2)。台架不装内置插件,插件项「提示标注」只能在这里测。
import { describe, expect, it } from 'vitest'
import type { SlashItem } from './MarkdownBlock'
import { SUGGESTED_SLASH_KEYS, withSuggestedGroup } from './slashSuggested'

const item = (key: string, group: string, category?: SlashItem['category']): SlashItem =>
  ({ key, label: key, hint: '', icon: null, group, scaffold: '', kw: key, ...(category ? { category } : {}) })

const ITEMS: SlashItem[] = [
  item('ai', 'AI', 'ai'),
  item('text', '基础'), item('h1', '基础'), item('h2', '基础'), item('h3', '基础'),
  item('ul', '列表'), item('ol', '列表'), item('todo', '列表'),
  item('quote', '高级'), item('table', '高级'), item('image', '高级'), item('columns', '高级'),
  item('callout-note', '标注', 'plugin'), item('callout-info', '标注', 'plugin'),
]

describe('withSuggestedGroup', () => {
  it('常用按规定顺序排最前、归到「基础」页;缺的(toc)跳过', () => {
    const out = withSuggestedGroup(ITEMS, '常用', true)
    const head = out.filter((it) => it.group === '常用')
    expect(head.map((it) => it.key)).toEqual(['text', 'todo', 'ul', 'h1', 'h2', 'callout-note', 'table', 'image', 'columns'])
    expect(head.every((it) => it.category === 'basic')).toBe(true)
    expect(out.slice(0, head.length)).toEqual(head)
  })

  it('原分组不再重复;其余项顺序不变', () => {
    const rest = withSuggestedGroup(ITEMS, '常用', true).filter((it) => it.group !== '常用')
    expect(rest.map((it) => it.key)).toEqual(['ai', 'h3', 'ol', 'quote', 'callout-note', 'callout-info'])
  })

  it('桌面(按页显示):插件页的「提示标注」原地也留一份;手机(单列清单):只留常用那份', () => {
    const desk = withSuggestedGroup(ITEMS, '常用', true)
    expect(desk.filter((it) => it.key === 'callout-note').map((it) => it.category ?? 'basic')).toEqual(['basic', 'plugin'])
    const phone = withSuggestedGroup(ITEMS, '常用', false)
    expect(phone.filter((it) => it.key === 'callout-note')).toHaveLength(1)
  })

  it('不改入参;关掉插件(没有 callout-note)就少一项', () => {
    const before = JSON.stringify(ITEMS)
    const out = withSuggestedGroup(ITEMS.filter((it) => !it.key.startsWith('callout')), '常用', true)
    expect(JSON.stringify(ITEMS)).toBe(before)
    expect(out.filter((it) => it.group === '常用').map((it) => it.key)).not.toContain('callout-note')
  })

  it('常用清单是方案里那十项', () => {
    expect(SUGGESTED_SLASH_KEYS).toEqual(['text', 'todo', 'ul', 'h1', 'h2', 'callout-note', 'table', 'image', 'columns', 'toc'])
  })
})
