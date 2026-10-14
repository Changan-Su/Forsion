// @vitest-environment happy-dom
/** 划线条的动作表:插件动作在哪个视图里列、怎么跑、条的排法偏好,以及「翻译」的目标语言。 */
import { describe, expect, it } from 'vitest'
import { listSelectionActions, runSelectionAction, selectionActionKey, selectionBarOrder, selectionScopeMatches, setSelectionBarOrder, type OwnedSelectionAction } from './selectionActions'
import { translateTargetOf } from './translateTarget'
import { SELECTION_BAR_ORDER_KEY } from './types'

const act = (pluginId: string, id: string, extra: Partial<OwnedSelectionAction['item']> = {}): OwnedSelectionAction => ({ pluginId, item: { id, title: id, run: () => '', ...extra } })
const keys = (list: OwnedSelectionAction[]): string[] => list.map(selectionActionKey)

describe('scope:动作出现在哪些视图', () => {
  it("缺省 / 'note' 只在笔记;'all' 到处;'own' 只在这个插件自己的视图", () => {
    expect(selectionScopeMatches(undefined, 'p', 'note')).toBe(true)
    expect(selectionScopeMatches(undefined, 'p', 'chat')).toBe(false)
    expect(selectionScopeMatches('note', 'p', 'p:reader')).toBe(false)
    expect(selectionScopeMatches('all', 'p', 'chat')).toBe(true)
    expect(selectionScopeMatches('own', 'pdf-reader', 'pdf-reader:reader')).toBe(true)
    expect(selectionScopeMatches('own', 'pdf-reader', 'pdf-reader-pro:reader')).toBe(false) // 前缀要到冒号为止
    expect(selectionScopeMatches('own', 'pdf-reader', 'note')).toBe(false)
  })
  it('点名的视图:整个 id,或只写插件 id 认它的所有视图;写错的 scope 当不匹配', () => {
    expect(selectionScopeMatches(['chat', 'pdf-reader:reader'], 'x', 'chat')).toBe(true)
    expect(selectionScopeMatches(['chat', 'pdf-reader:reader'], 'x', 'pdf-reader:reader')).toBe(true)
    expect(selectionScopeMatches(['chat', 'pdf-reader:reader'], 'x', 'pdf-reader:outline')).toBe(false)
    expect(selectionScopeMatches(['pdf-reader'], 'x', 'pdf-reader:outline')).toBe(true)
    expect(selectionScopeMatches(['chat'], 'x', 'note')).toBe(false)
    expect(selectionScopeMatches([''], 'x', 'note')).toBe(false)
    expect(selectionScopeMatches('everywhere' as never, 'x', 'note')).toBe(false)
    expect(selectionScopeMatches([1] as never, 'x', '1')).toBe(false)
  })
})

describe('listSelectionActions', () => {
  const all = [
    act('zeta', 'note-only'),
    act('alpha', 'everywhere', { scope: 'all' }),
    act('zeta', 'long-only', { scope: 'all', when: (cx) => cx.length >= 10 }),
    act('alpha', 'editable-only', { scope: 'all', when: (cx) => cx.editable }),
    act('mid', 'throws', { scope: 'all', when: () => { throw new Error('boom') } }),
    act('mid', 'undefined-when', { scope: 'all', when: (() => undefined) as never }),
  ]
  it('scope 不认、when 说不要 / 抛错 / 没返回真值的都不列', () => {
    expect(keys(listSelectionActions(all, { view: 'chat', editable: false, length: 3 }))).toEqual(['plugin:alpha:everywhere'])
    expect(keys(listSelectionActions(all, { view: 'chat', editable: false, length: 30 }))).toEqual(['plugin:alpha:everywhere', 'plugin:zeta:long-only'])
  })
  it('按插件 id 排,同一个插件保持注册顺序', () => {
    expect(keys(listSelectionActions(all, { view: 'note', editable: true, length: 30 }))).toEqual([
      'plugin:alpha:everywhere', 'plugin:alpha:editable-only', 'plugin:zeta:note-only', 'plugin:zeta:long-only',
    ])
  })
  it('when 拿到的是副本,改不动宿主手里的那份', () => {
    const where = { view: 'chat', editable: false, length: 5 }
    listSelectionActions([act('p', 'x', { scope: 'all', when: (cx) => { (cx as { view: string }).view = 'note'; return true } })], where)
    expect(where.view).toBe('chat')
  })
})

describe('runSelectionAction:返回值当外部输入校验', () => {
  const cx = { text: 't', markdown: 't', view: 'chat', editable: false }
  it('字符串原样;空 / 没返回 = 没有要给人看的', async () => {
    expect(await runSelectionAction(act('p', 'a', { run: () => '**ok**\n\t行' }), cx)).toBe('**ok**\n\t行')
    expect(await runSelectionAction(act('p', 'a', { run: async () => '' }), cx)).toBe('')
    expect(await runSelectionAction(act('p', 'a', { run: () => undefined }), cx)).toBe('')
  })
  it('非字符串、带控制字符的拒掉', async () => {
    await expect(runSelectionAction(act('p', 'a', { run: (() => 42) as never }), cx)).rejects.toThrow(/number/)
    await expect(runSelectionAction(act('p', 'a', { run: () => `a${String.fromCharCode(0)}b` }), cx)).rejects.toThrow()
  })
  it("output: 'none' 的返回值不看(插件自己办完了)", async () => {
    expect(await runSelectionAction(act('p', 'a', { output: 'none', run: (() => 42) as never }), cx)).toBe('')
  })
})

describe('条的排法偏好', () => {
  it("没存过 = 工具在前;只认 'actions' 这一个别的值", () => {
    localStorage.removeItem(SELECTION_BAR_ORDER_KEY)
    expect(selectionBarOrder()).toBe('tools')
    setSelectionBarOrder('actions')
    expect(selectionBarOrder()).toBe('actions')
    localStorage.setItem(SELECTION_BAR_ORDER_KEY, 'rows')
    expect(selectionBarOrder()).toBe('tools')
    localStorage.removeItem(SELECTION_BAR_ORDER_KEY)
  })
})

describe('翻译的目标语言:译成界面语言,选中的已经是界面语言就译成另一种', () => {
  it('中文界面', () => {
    expect(translateTargetOf('这是一段中文', 'zh')).toBe('English')
    expect(translateTargetOf('Plain English text', 'zh')).toBe('Chinese (Simplified)')
    expect(translateTargetOf('これは日本語の文章です', 'zh')).toBe('Chinese (Simplified)') // 有假名 = 不是中文
    expect(translateTargetOf('Ceci est une phrase en français', 'zh')).toBe('Chinese (Simplified)')
    expect(translateTargetOf('RAG 检索增强生成 pipeline', 'zh')).toBe('English') // 中英夹杂、汉字够多
    expect(translateTargetOf('  12 … ', 'zh')).toBe('English')
  })
  it('英文界面', () => {
    expect(translateTargetOf('Plain English text', 'en')).toBe('Chinese (Simplified)')
    expect(translateTargetOf('这是一段中文', 'en')).toBe('English')
    expect(translateTargetOf('これは日本語の文章です', 'en')).toBe('English')
    expect(translateTargetOf('Привет, как дела?', 'en')).toBe('English')
    expect(translateTargetOf('Über die Brücke gehen wir später', 'en')).toBe('English') // 带变音符的不当英文
  })
})
