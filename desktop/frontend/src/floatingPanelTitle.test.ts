import { afterEach, describe, expect, it } from 'vitest'
import { setLocaleGlobal, translate } from './i18n'
import { floatingPanelTitle } from './floatingPanelTitle'
// 浮窗入口(main.tsx)渲染前注册的词条:全量字典 + 旁聊的片段
import './i18n.generated'
import './views/chat2/btwStore'

describe('floatingPanelTitle', () => {
  afterEach(() => setLocaleGlobal('zh'))

  it('内置面板按当前语言现译,不用开窗时定格的 title;视图面板照用开窗方给的', () => {
    const t = (k: string): string => translate(k)
    const settings = { builtin: 'settings' as const, title: '设置' }
    expect(floatingPanelTitle(settings, t)).toBe('设置')
    setLocaleGlobal('en')
    expect(floatingPanelTitle(settings, t)).toBe('Settings')
    for (const builtin of ['market', 'achievements', 'feedback', 'btw'] as const) {
      expect(floatingPanelTitle({ builtin, title: '旧标题' }, t), builtin).not.toMatch(/[一-鿿]/)
    }
    expect(floatingPanelTitle({ title: 'My view' }, t)).toBe('My view')
  })
})
