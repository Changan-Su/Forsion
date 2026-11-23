// @vitest-environment happy-dom
/** 划线条的动作表:插件动作在哪个视图里列、怎么跑、条的排法偏好,以及「翻译」的目标语言。 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HOST_SELECTION_KEYS, arrangeSelectionActions, autoSelectionAction, placementOf, hostSelectionEntry, hostTranslateAllowed, listSelectionActions, orderedSelectionEntries,
  pinSelectionAction, pluginSelectionEntry, readSelectionActionPrefs, rememberSelectionLanguage, moveSelectionAction, runSelectionAction,
  selectionActionKey, selectionActionPrefs, selectionActionTitle, selectionBarOrder, selectionScopeMatches, setSelectionAuto, setSelectionBarOrder,
  setSelectionPlacement, type OwnedSelectionAction, type SelectionActionPrefs, type SelectionEntry,
} from './selectionActions'
import { setLocaleGlobal } from './i18n'
import { translateTargetOf } from './translateTarget'
import { SELECTION_ACTION_PREFS_KEY, SELECTION_BAR_ORDER_KEY } from './types'

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

// ── 2026-11-21 划线插件常驻 / 自动 / 翻译改插件 ──────────────────────────────────────────────
const P = (p: Partial<SelectionActionPrefs> = {}): SelectionActionPrefs => ({ placement: {}, order: [], auto: {}, language: {}, ...p })
const installed = [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }, { id: 'translation', builtin: true }, { id: 'forsion-calendar', builtin: true }]
const pe = (o: OwnedSelectionAction, i = 0): SelectionEntry => pluginSelectionEntry(o, i, installed)
const ks = (l: SelectionEntry[]): string[] => l.map((e) => e.key)

describe('放哪:插件给缺省、用户的永远优先、插件位最多 3 个', () => {
  const host = [hostSelectionEntry(HOST_SELECTION_KEYS.ask), hostSelectionEntry(HOST_SELECTION_KEYS.translate), hostSelectionEntry(HOST_SELECTION_KEYS.speak)]
  const a1 = pe(act('alpha', 'a1', { placement: 'bar' }), 0)
  const a2 = pe(act('alpha', 'a2', { placement: 'bar' }), 1)
  const b1 = pe(act('beta', 'b1', { placement: 'bar' }), 2)
  const g1 = pe(act('gamma', 'g1', { placement: 'bar' }), 3)
  const g2 = pe(act('gamma', 'g2'), 4)
  const all = [...host, g2, g1, b1, a2, a1]
  it("缺省:宿主那组照固定次序;placement 'bar' 的按装的先后上条,第 4 个落进 ⋯ 并计入「放不下」", () => {
    const r = arrangeSelectionActions(all, P())
    expect(ks(r.lead)).toEqual(['host:ask', 'host:translate', 'host:speak'])
    expect(ks(r.plugins)).toEqual(['plugin:alpha:a1', 'plugin:alpha:a2', 'plugin:beta:b1'])
    expect(ks(r.more)).toEqual(['plugin:gamma:g1', 'plugin:gamma:g2'])
    expect(r.overflow).toBe(1)
  })
  it("用户的选择优先:收进 ⋯ / 不显示 / 把 'more' 的钉上条;宿主的也能收", () => {
    const r = arrangeSelectionActions(all, P({ placement: { 'plugin:alpha:a1': 'hidden', 'plugin:alpha:a2': 'more', 'plugin:gamma:g2': 'bar', 'host:translate': 'more' } }))
    expect(ks(r.lead)).toEqual(['host:ask', 'host:speak'])
    expect(ks(r.plugins)).toEqual(['plugin:beta:b1', 'plugin:gamma:g1', 'plugin:gamma:g2'])
    expect(ks(r.more)).toEqual(['host:translate', 'plugin:alpha:a2'])
    expect(r.overflow).toBe(0)
  })
  it('用户排过的在前,没排过的按缺省接在后面', () => {
    const r = arrangeSelectionActions(all, P({ order: ['plugin:gamma:g1', 'host:speak'] }))
    expect(ks(r.lead)).toEqual(['host:speak', 'host:ask', 'host:translate'])
    expect(ks(r.plugins)).toEqual(['plugin:gamma:g1', 'plugin:alpha:a1', 'plugin:alpha:a2'])
  })
  it('核心插件的动作和宿主那组站一起(翻译之后、朗读之前),不占插件位', () => {
    // 用核心名单里的日历做样本(翻译插件的接管另见下一组)
    const cal = pluginSelectionEntry(act('forsion-calendar', 'todo', { placement: 'bar' }), 9, installed)
    const cal2 = pluginSelectionEntry(act('forsion-calendar', 'x'), 10, installed)
    expect(cal.kind).toBe('core')
    const r = arrangeSelectionActions([hostSelectionEntry(HOST_SELECTION_KEYS.ask), hostSelectionEntry(HOST_SELECTION_KEYS.speak), cal, cal2, a1, a2, b1], P())
    expect(ks(r.lead)).toEqual(['host:ask', 'plugin:forsion-calendar:todo', 'host:speak'])
    expect(ks(r.plugins)).toEqual(['plugin:alpha:a1', 'plugin:alpha:a2', 'plugin:beta:b1'])
    expect(ks(r.more)).toEqual(['plugin:forsion-calendar:x']) // 核心插件没要 bar 的照样进 ⋯
    // 名单里没有 builtin / preinstalled 标记的同名插件(商店里冒名的)不算核心
    expect(pluginSelectionEntry(act('forsion-calendar', 'todo'), 0, [{ id: 'forsion-calendar' }]).kind).toBe('plugin')
  })
})

describe('宿主翻译的归属:翻译插件是核心插件(停用也算),或启用着且注册了划线动作,宿主就不出', () => {
  const tr = act('translation', 'translate')
  it('没装 / 装着但没注册动作的同名普通插件:宿主翻译照旧', () => {
    expect(hostTranslateAllowed([{ id: 'alpha' }], [])).toBe(true)
    expect(hostTranslateAllowed([], [])).toBe(true)
    expect(hostTranslateAllowed([{ id: 'translation', enabled: true }], [])).toBe(true)
    expect(hostTranslateAllowed([{ id: 'translation', enabled: false }], [tr])).toBe(true) // 停用着的普通插件不算
  })
  it('启用着且注册了动作:接管', () => {
    expect(hostTranslateAllowed([{ id: 'translation', enabled: true }], [tr])).toBe(false)
    expect(hostTranslateAllowed([{ id: 'translation' }], [tr])).toBe(false)
  })
  it('接管它的动作沿用 host:translate 的「放在哪」;自己设过的优先', () => {
    const e = pe(tr, 0)
    expect(e.alias).toBe(HOST_SELECTION_KEYS.translate)
    expect(placementOf(e, P({ placement: { [HOST_SELECTION_KEYS.translate]: 'hidden' } }))).toBe('hidden')
    expect(placementOf(e, P({ placement: { [HOST_SELECTION_KEYS.translate]: 'hidden', 'plugin:translation:translate': 'bar' } }))).toBe('bar')
    expect(pe(act('alpha', 'translate'), 0).alias).toBeUndefined()
  })
  it('随包的翻译插件是核心插件:停用了宿主也不出(条上零颗,不回落成两颗);动作站在宿主那组、不占插件位', () => {
    expect(hostTranslateAllowed([{ id: 'translation', builtin: true, enabled: false }], [])).toBe(false)
    expect(hostTranslateAllowed([{ id: 'translation', builtin: true, enabled: false }], [tr])).toBe(false)
    expect(hostTranslateAllowed([{ id: 'translation', preinstalled: true }], [tr])).toBe(false)
    // 核心插件启用着却没注册上(setup 抛错 / 还没载完)不算接管:宿主翻译照旧,条上不至于一颗都没有
    expect(hostTranslateAllowed([{ id: 'translation', preinstalled: true }], [])).toBe(true)
    // 宿主载不了它(版本闸等)不是用户关的:宿主翻译照旧,条上不至于一颗都没有
    expect(hostTranslateAllowed([{ id: 'translation', builtin: true, blocked: 'minApp' }], [])).toBe(true)
    const core = pluginSelectionEntry(act('translation', 'translate', { placement: 'bar' }), 0, [{ id: 'translation', builtin: true }])
    expect(core.kind).toBe('core')
    const r = arrangeSelectionActions([hostSelectionEntry(HOST_SELECTION_KEYS.ask), hostSelectionEntry(HOST_SELECTION_KEYS.speak), core, pluginSelectionEntry(act('alpha', 'a1', { placement: 'bar' }), 1, installed)], P())
    expect(ks(r.lead)).toEqual(['host:ask', 'plugin:translation:translate', 'host:speak'])
    expect(ks(r.plugins)).toEqual(['plugin:alpha:a1'])
  })
})

describe('划选后自动:只跑排最前、用户开了的那个', () => {
  const x = pe(act('alpha', 'x', { auto: true, scope: 'all' }), 0)
  const y = pe(act('beta', 'y', { auto: true, scope: 'all' }), 1)
  const z = pe(act('gamma', 'z', { auto: true, output: 'none', scope: 'all' }), 2)
  it('插件声明了 auto 也不会自己开(缺省关)', () => {
    expect(autoSelectionAction([x, y], P())).toBeNull()
  })
  it('开了两个只跑排在最前那个;排序换了跟着换;不显示的不跑;output none 的不算支持', () => {
    expect(autoSelectionAction([x, y], P({ auto: { 'plugin:alpha:x': true, 'plugin:beta:y': true } }))?.key).toBe('plugin:alpha:x')
    expect(autoSelectionAction([x, y], P({ auto: { 'plugin:alpha:x': true, 'plugin:beta:y': true }, order: ['plugin:beta:y'] }))?.key).toBe('plugin:beta:y')
    expect(autoSelectionAction([x, y], P({ auto: { 'plugin:alpha:x': true, 'plugin:beta:y': true }, placement: { 'plugin:alpha:x': 'hidden' } }))?.key).toBe('plugin:beta:y')
    expect(z.auto).toBe(false)
    expect(autoSelectionAction([z], P({ auto: { 'plugin:gamma:z': true } }))).toBeNull()
  })
  it('只认笔记的动作(scope 缺省 / note)在哪都自动不了:不算支持,管理表不给开关也不挂「先跑」', () => {
    const noteOnly = pe(act('delta', 'n', { auto: true }), 3)
    const own = pe(act('delta', 'o', { auto: true, scope: 'own' }), 4)
    const listed = pe(act('delta', 'l', { auto: true, scope: ['note', 'chat'] }), 5)
    expect([noteOnly.auto, own.auto, listed.auto]).toEqual([false, true, true])
    expect(autoSelectionAction([noteOnly, y], P({ auto: { 'plugin:delta:n': true, 'plugin:beta:y': true } }))?.key).toBe('plugin:beta:y')
  })
  it('核心插件排在宿主那组里,比普通插件先', () => {
    const core = pluginSelectionEntry(act('forsion-calendar', 'c', { auto: true, scope: 'all' }), 0, installed)
    expect(autoSelectionAction([x, core], P({ auto: { 'plugin:alpha:x': true, 'plugin:forsion-calendar:c': true } }))?.key).toBe('plugin:forsion-calendar:c')
    expect(ks(orderedSelectionEntries([x, core], P()))).toEqual(['plugin:forsion-calendar:c', 'plugin:alpha:x'])
  })
})

describe('偏好的读写:读失败 ≠ 空、只改动到的、不修剪', () => {
  beforeEach(() => { localStorage.removeItem(SELECTION_ACTION_PREFS_KEY); localStorage.removeItem(`${SELECTION_ACTION_PREFS_KEY}.unreadable`) })
  it('没存过 = 空;存坏了 = 不知道(按缺省显示,读一遍不写回)', () => {
    expect(readSelectionActionPrefs()).toEqual({ ok: true, prefs: P() })
    localStorage.setItem(SELECTION_ACTION_PREFS_KEY, '{not json')
    expect(readSelectionActionPrefs().ok).toBe(false)
    expect(selectionActionPrefs()).toEqual(P())
    expect(localStorage.getItem(SELECTION_ACTION_PREFS_KEY)).toBe('{not json') // 只读不写
    localStorage.setItem(SELECTION_ACTION_PREFS_KEY, JSON.stringify({ placement: [] }))
    expect(readSelectionActionPrefs().ok).toBe(false)
  })
  it('读不出来就不写:用户这一下不生效(返回 false、界面回弹),原件一个字节不动', () => {
    localStorage.setItem(SELECTION_ACTION_PREFS_KEY, '\u0000garbage')
    let pinged = 0
    const on = (): void => { pinged++ }
    window.addEventListener('forsion:selection-action-prefs', on)
    expect(setSelectionPlacement('plugin:a:b', 'bar')).toBe(false)
    expect(setSelectionAuto('plugin:a:b', true)).toBe(false)
    window.removeEventListener('forsion:selection-action-prefs', on)
    expect(localStorage.getItem(SELECTION_ACTION_PREFS_KEY)).toBe('\u0000garbage')
    expect(localStorage.getItem(`${SELECTION_ACTION_PREFS_KEY}.unreadable`)).toBeNull()
    expect(pinged).toBe(2) // 订阅者重画(开关回弹)
  })
  it('写一律现读再改一处:别的窗口刚写进 localStorage 的字段不会被这一窗的旧快照盖掉', () => {
    setSelectionAuto('plugin:a:b', true)
    // 另一窗直接写盘(这一窗没收到任何信号)
    const raw = JSON.parse(localStorage.getItem(SELECTION_ACTION_PREFS_KEY)!)
    localStorage.setItem(SELECTION_ACTION_PREFS_KEY, JSON.stringify({ ...raw, language: { 'plugin:a:b': 'French' } }))
    setSelectionPlacement('plugin:a:b', 'more')
    expect(selectionActionPrefs()).toMatchObject({ auto: { 'plugin:a:b': true }, language: { 'plugin:a:b': 'French' }, placement: { 'plugin:a:b': 'more' } })
  })
  it('只改动到的那一项;此刻没注册的动作的选择、不认识的字段都原样留着', () => {
    localStorage.setItem(SELECTION_ACTION_PREFS_KEY, JSON.stringify({ placement: { 'plugin:gone:x': 'hidden', bad: 'sideways' }, auto: { 'plugin:gone:x': true }, order: ['plugin:gone:x'], future: { v: 2 } }))
    setSelectionAuto('plugin:a:b', true)
    rememberSelectionLanguage('plugin:a:b', 'Japanese')
    moveSelectionAction('plugin:a:b', 'plugin:gone:x', false, ['plugin:a:b'])
    const raw = JSON.parse(localStorage.getItem(SELECTION_ACTION_PREFS_KEY)!)
    expect(raw.placement).toEqual({ 'plugin:gone:x': 'hidden' }) // 认不出的单个值丢掉,别的不连累
    expect(raw.auto).toEqual({ 'plugin:gone:x': true, 'plugin:a:b': true })
    expect(raw.language).toEqual({ 'plugin:a:b': 'Japanese' })
    expect(raw.order).toEqual(['plugin:a:b', 'plugin:gone:x'])
    expect(raw.future).toEqual({ v: 2 })
  })
  const e = (id: string, placement?: 'bar' | 'more'): SelectionEntry => pe(act('alpha', id, placement ? { placement } : {}), 0)
  it('插件位先给用户点名「条上」的:缺省上条的三个占不掉第四个被点名的;钉上不改先后', () => {
    const all = [e('p1', 'bar'), e('p2', 'bar'), e('p3', 'bar'), e('p4')].map((x, i) => ({ ...x, rank: i }))
    pinSelectionAction('plugin:alpha:p4', true, all)
    const r = arrangeSelectionActions(all)
    expect(ks(r.plugins)).toEqual(['plugin:alpha:p1', 'plugin:alpha:p2', 'plugin:alpha:p4'])
    expect(ks(r.more)).toEqual(['plugin:alpha:p3'])
    expect(r.overflow).toBe(1)
    expect(selectionActionPrefs().order).toEqual([])
    pinSelectionAction('plugin:alpha:p4', false, all) // 收进 ⋯
    expect(ks(arrangeSelectionActions(all).plugins)).toEqual(['plugin:alpha:p1', 'plugin:alpha:p2', 'plugin:alpha:p3'])
  })
  it('三个位都被点名的占着再钉一个:只把它挪到条上第一个前面,别的视图里的排序不动', () => {
    localStorage.setItem(SELECTION_ACTION_PREFS_KEY, JSON.stringify({ order: ['plugin:other:z', 'plugin:alpha:p2'] }))
    const all = [e('p1'), e('p2'), e('p3'), e('p4')].map((x, i) => ({ ...x, rank: i }))
    for (const k of ['p1', 'p2', 'p3']) setSelectionPlacement(`plugin:alpha:${k}`, 'bar')
    pinSelectionAction('plugin:alpha:p4', true, all)
    expect(ks(arrangeSelectionActions(all).plugins)).toEqual(['plugin:alpha:p4', 'plugin:alpha:p2', 'plugin:alpha:p1'])
    expect(selectionActionPrefs().order.indexOf('plugin:other:z')).toBe(0) // 表外的键还在原位
  })
  it('管理表拖排序只挪被拖的那个:表外的键不被挤到末尾', () => {
    localStorage.setItem(SELECTION_ACTION_PREFS_KEY, JSON.stringify({ order: ['plugin:other:z', 'plugin:alpha:p1'] }))
    moveSelectionAction('plugin:alpha:p3', 'plugin:alpha:p1', false, ['plugin:alpha:p1', 'plugin:alpha:p2', 'plugin:alpha:p3'])
    expect(selectionActionPrefs().order).toEqual(['plugin:other:z', 'plugin:alpha:p3', 'plugin:alpha:p1', 'plugin:alpha:p2'])
  })
})

describe('动作名:字符串 / 函数 / { zh, en } 画的那一刻求值', () => {
  it('跟着界面语言换', () => {
    const o = act('p', 'x', { title: { zh: '翻译', en: 'Translate' } })
    setLocaleGlobal('zh')
    expect(selectionActionTitle(o)).toBe('翻译')
    setLocaleGlobal('en')
    expect(selectionActionTitle(o)).toBe('Translate')
    expect(selectionActionTitle(act('p', 'y', { title: () => 'Fn' }))).toBe('Fn')
    expect(selectionActionTitle(act('p', 'z', { title: (() => { throw new Error('x') }) as never }))).toBe('z') // 抛了退回 id
    setLocaleGlobal('zh')
  })
})
