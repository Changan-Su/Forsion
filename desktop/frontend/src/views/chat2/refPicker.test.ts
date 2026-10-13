import { describe, expect, it } from 'vitest'
import { catOf, moveRefCat, pickerMatches, refCats, type RefCand } from './refPicker'

const win = (title: string): RefCand => ({ p: title, app: { kind: 'window', id: 'com.x', name: title } })
const app = (name: string): RefCand => ({ p: name, app: { kind: 'app', id: `com.${name}`, name } })
const note = (p: string): RefCand => ({ p, note: true })
const file = (p: string): RefCand => ({ p })
const chat = (title: string): RefCand => ({ p: title, session: { id: title, title } })

describe('引用菜单分类', () => {
  it('候选归类', () => {
    expect([win('w'), app('a'), note('n.md'), file('src/a.ts'), chat('c')].map(catOf)).toEqual(['window', 'app', 'note', 'file', 'session'])
  })
  it('没有候选的种类不出标签;只剩一种不出分类条', () => {
    expect(refCats([win('w'), chat('c')])).toEqual(['all', 'window', 'session'])
    expect(refCats([chat('a'), chat('b')])).toEqual([])
    expect(refCats([])).toEqual([])
  })
  it('分类像接在查询词后面的几个字:→ 往右到头停住,← 往回,在「全部」上按 ← 不接(那是移光标)', () => {
    const cats = refCats([win('w'), app('a'), chat('c')])
    expect(moveRefCat(cats, 'all', 'ArrowRight')).toBe('window')
    expect(moveRefCat(cats, 'window', 'ArrowLeft')).toBe('all')
    expect(moveRefCat(cats, 'all', 'ArrowLeft')).toBeNull()
    expect(moveRefCat(cats, 'session', 'ArrowRight')).toBe('session') // 到头:键吃掉,不绕回「全部」
    expect(moveRefCat(cats, 'all', 'ArrowDown')).toBeNull()
    expect(moveRefCat([], 'all', 'ArrowRight')).toBeNull()
  })
  it('「全部」没打字:窗口在前、应用其次,保留原顺序,后面仍有笔记和会话', () => {
    const cands = [win('zzzz 很长的窗口标题'), win('b'), app('Keynote'), app('A'), note('x.md'), chat('聊天')]
    const got = pickerMatches(cands, '', 'all')
    expect(got.slice(0, 4).map((c) => c.p)).toEqual(['zzzz 很长的窗口标题', 'b', 'Keynote', 'A'])
    expect(got.some((c) => c.note) && got.some((c) => c.session)).toBe(true)
  })
  it('打了字混排;选了分类只出那一类', () => {
    const cands = [win('Linear – Pricing'), app('Lark'), note('调研/Linear 定价.md'), chat('别的')]
    expect(pickerMatches(cands, 'lin', 'all').map(catOf).sort()).toEqual(['note', 'window'])
    expect(pickerMatches(cands, '', 'app').map((c) => c.p)).toEqual(['Lark'])
    expect(pickerMatches(cands, 'lin', 'app')).toEqual([])
    // 窗口分类没打字:前到后的原顺序,不按名字长短重排
    expect(pickerMatches([win('很长很长的最前面那扇'), win('b')], '', 'window').map((c) => c.p)).toEqual(['很长很长的最前面那扇', 'b'])
  })
})
