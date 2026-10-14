import { describe, expect, it } from 'vitest'
import { appRefToken, parseAppRefInner, type AppRefList } from '../../../../../shared/appRefs'
import { APP_REF_LIMIT, appRefInner, appRefQueryOk, isAppRefQuery, moveWikiCat, pickAppRefs, wikiCats } from './wikiAppRefs'

// 宿主给的顺序:窗口前到后,应用在跑的在前、其余按名字。
const LIST: AppRefList = {
  windows: [
    { id: 'com.apple.Safari', app: 'Safari', title: '季度计划 — 飞书文档' },
    { id: 'com.microsoft.VSCode', app: 'Code', title: 'wikilink.ts — genesis' },
    { id: 'com.apple.Safari', app: 'Safari', title: 'GitHub | Pull requests' },
  ],
  apps: [
    { id: 'com.apple.Safari', name: 'Safari', running: true },
    { id: 'com.microsoft.VSCode', name: 'Visual Studio Code', running: true },
    { id: 'com.apple.Notes', name: 'Notes', running: false },
    { id: 'com.apple.Preview', name: 'Preview', running: false },
  ],
}
const names = (kind: 'window' | 'app', q: string, limit?: number): string[] => pickAppRefs(LIST, q, kind, limit).map((c) => c.ref.name)

describe('分类条', () => {
  it('没有宿主接口 → 不出分类条(面板与从前一样)', () => {
    expect(wikiCats(false, true)).toEqual([])
    expect(wikiCats(false, false)).toEqual([])
  })
  it('有接口:全部 / 窗口 / 应用 / 笔记;候选池里没有笔记就不出「笔记」这一格', () => {
    expect(wikiCats(true, true)).toEqual(['all', 'window', 'app', 'note'])
    expect(wikiCats(true, false)).toEqual(['all', 'window', 'app'])
  })
  it('→ 往右到头停住,← 往回,在「全部」上按 ← 不接(那是移光标);别的键不管;没有分类条时一个键都不接', () => {
    const cats = wikiCats(true, true)
    expect(moveWikiCat(cats, 'all', 'ArrowRight')).toBe('window')
    expect(moveWikiCat(cats, 'note', 'ArrowRight')).toBe('note')
    expect(moveWikiCat(cats, 'window', 'ArrowLeft')).toBe('all')
    expect(moveWikiCat(cats, 'all', 'ArrowLeft')).toBeNull()
    expect(moveWikiCat(cats, 'app', 'ArrowUp')).toBeNull()
    expect(moveWikiCat([], 'all', 'ArrowRight')).toBeNull()
  })
  it('记着的分类不在这次的分类条里(笔记那格没了)→ 从头算', () => {
    expect(moveWikiCat(wikiCats(true, false), 'note', 'ArrowRight')).toBe('window')
  })
})

describe('pickAppRefs', () => {
  it('空查询保持宿主给的顺序,并按上限截断', () => {
    expect(names('window', '')).toEqual(['季度计划 — 飞书文档', 'wikilink.ts — genesis', 'GitHub | Pull requests'])
    expect(names('app', '', 2)).toEqual(['Safari', 'Visual Studio Code'])
    expect(APP_REF_LIMIT).toBeGreaterThan(4)
  })
  it('窗口:标题命中排前;标题不中、所属应用名中的跟在后面(打应用名带出它的窗口)', () => {
    expect(names('window', 'wiki')).toEqual(['wikilink.ts — genesis'])
    expect(names('window', 'safari')).toEqual(['季度计划 — 飞书文档', 'GitHub | Pull requests'])
    expect(names('window', 'git')).toEqual(['GitHub | Pull requests'])
  })
  it('应用:按名字模糊命中,不中的滤掉', () => {
    expect(names('app', 'vsc')).toEqual(['Visual Studio Code'])
    expect(names('app', 'pre')).toEqual(['Preview'])
    expect(names('app', 'zzz')).toEqual([])
  })
  it('窗口候选带所属应用名作右侧灰字,应用没有', () => {
    expect(pickAppRefs(LIST, 'wiki', 'window')[0]).toEqual({ ref: { kind: 'window', id: 'com.microsoft.VSCode', name: 'wikilink.ts — genesis' }, hint: 'Code' })
    expect(pickAppRefs(LIST, 'pre', 'app')[0]).toEqual({ ref: { kind: 'app', id: 'com.apple.Preview', name: 'Preview' } })
  })
  it('列表还没取回来 → 空', () => {
    expect(pickAppRefs(null, '', 'window')).toEqual([])
  })
  it('查询里有 # | ^ = 用户在写笔记的锚点 / 别名:不拿窗口标题去撞', () => {
    expect(appRefQueryOk('Git')).toBe(true)
    expect(appRefQueryOk('GitHub |')).toBe(false)
    expect(names('window', 'GitHub |')).toEqual([])
    expect(names('app', 'Notes#')).toEqual([])
    expect(names('app', 'Notes#^a')).toEqual([])
  })
})

describe('插入', () => {
  it('`[[` + 内文 + `]]` 就是契约里的 token,并且解析得回来', () => {
    const ref = { kind: 'window', id: 'com.apple.Safari', name: 'GitHub | Pull [requests]' } as const
    expect(`[[${appRefInner(ref)}]]`).toBe(appRefToken(ref))
    // 标题里的 | [ ] 被契约换成空格(否则拆坏 [[..]])
    expect(parseAppRefInner(appRefInner(ref))).toEqual({ kind: 'window', id: 'com.apple.Safari', name: 'GitHub Pull requests' })
    expect(appRefInner({ kind: 'app', id: 'com.apple.Notes', name: 'Notes' })).toBe('app://com.apple.Notes|Notes')
  })
  it('手写到一半的引用不是笔记名(不给「新建链接」行)', () => {
    expect(isAppRefQuery('app://com.apple')).toBe(true)
    expect(isAppRefQuery('window://')).toBe(true)
    expect(isAppRefQuery('app')).toBe(false)
    expect(isAppRefQuery('app:')).toBe(false)
    expect(isAppRefQuery('my app://x')).toBe(false)
  })
})
