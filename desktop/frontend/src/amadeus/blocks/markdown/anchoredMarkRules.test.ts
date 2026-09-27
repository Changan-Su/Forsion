// @vitest-environment happy-dom
//
// I-01:段落里已有字面 `~x~` / `_x_` 时,行末每敲一个字都删掉远处一个字、吞掉刚敲的字(评审 2026-09-27)。
// 真 Milkdown(生产装配,见 parseFidelity.testkit.ts)+ 真 customInputRules:打字走 handleTextInput(同浏览器键入),
// 输入法上屏后的「空串重跑」走真 compositionend 事件。真浏览器键盘 + CDP 输入法那一半:npm run check:attention 的 I1~I4。
import { describe, expect, it } from 'vitest'
import type { EditorView } from '@milkdown/kit/prose/view'
import { TextSelection } from '@milkdown/kit/prose/state'
import { bootEditor } from './parseFidelity.testkit'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { STRIKETHROUGH_RE, UNDERSCORE_EMPHASIS_RE, endsAtCursor } from './anchoredMarkRules'

/** 在光标处「键入」:先问输入规则(handleTextInput),没人接就按默认插入 —— 同 ProseMirror 处理 beforeinput。 */
function type(view: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)))
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
}
const caretToEnd = (view: EditorView): void => {
  const end = view.state.doc.firstChild!.nodeSize - 1
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)))
}
/** 首段:文字 + 带 mark 的片段(`~` 删除线 / `*` 强调 / `**` 加粗 / `` ` `` 代码)。 */
function firstPara(view: EditorView): { text: string; marked: string[] } {
  const p = view.state.doc.firstChild!
  const marked: string[] = []
  p.forEach((n) => { if (n.isText && n.marks.length) marked.push(`${n.marks.map((m) => m.type.name).join('+')}:${n.text}`) })
  return { text: p.textContent, marked }
}

async function typed(seed: string, keys: string) {
  const b = await bootEditor(seed)
  try {
    caretToEnd(b.view)
    type(b.view, keys)
    return { ...firstPara(b.view), md: b.md() }
  } finally { await b.destroy() }
}

describe('远处的字面定界符不再被行末键入触发', () => {
  it.each([
    ['字面 `~` 对(评审原例)', '今天好累~ 明天继续~ 加油\n', '!', '今天好累~ 明天继续~ 加油!'],
    ['中文里的 `_tmp_`', '变量_tmp_的值是多少\n', '？', '变量_tmp_的值是多少？'],
    ['转义写法 `\\_b\\_`', 'see \\_b\\_ yz\n', 'w', 'see _b_ yzw'],
    ['行内代码里的 `_tmp_`', '变量 `_tmp_` 的值是多少呢\n', 'x', '变量 _tmp_ 的值是多少呢x'],
    ['连续击键不逐字蚕食', '今天好累~ 明天继续~ 加油\n', 'abc', '今天好累~ 明天继续~ 加油abc'],
  ])('%s', async (_label, seed, keys, want) => {
    const r = await typed(seed, keys)
    expect(r.text).toBe(want)
    expect(r.marked.filter((m) => /strike|emphasis/.test(m))).toEqual([])
  })

  it('输入法上屏后的空串重跑(compositionend)不删字', async () => {
    const b = await bootEditor('今天好累~ 明天继续~ 加油\n')
    try {
      caretToEnd(b.view)
      b.view.dispatch(b.view.state.tr.insertText('我们')) // 上屏的字(组合期间规则本来就不跑)
      b.view.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '我们', bubbles: true }))
      await new Promise((r) => setTimeout(r, 30)) // customInputRules 在 setTimeout 里重跑
      expect(firstPara(b.view)).toEqual({ text: '今天好累~ 明天继续~ 加油我们', marked: [] })
    } finally { await b.destroy() }
  })
})

describe('正常的 markdown 快捷输入照旧触发', () => {
  it.each([
    ['`~~x~~`', ' ~~删~~', 'strike_through:删'],
    ['`~x~`', ' ~删~', 'strike_through:删'],
    ['`*x*`', ' *斜*', 'emphasis:斜'],
    ['`**x**`', ' **粗**', 'strong:粗'],
    ['`_x_`', ' _斜_', 'emphasis:斜'],
    ['`` `x` ``', ' `码`', 'inlineCode:码'],
  ])('%s', async (_label, keys, mark) => {
    // 种子段落 `a`,空格也是键入的(md 解析会吃掉行尾空格)
    const r = await typed('a\n', keys)
    expect(r.marked).toEqual([mark])
  })

  it('同一行前面还有一对 `_`:只转刚闭合的那对', async () => {
    const r = await typed('a \\_b\\_ c\n', ' _d_') // 前面那对是字面(转义)
    expect(r.marked).toEqual(['emphasis:d'])
    expect(r.text).toBe('a _b_ c d')
  })

  it('`~~a~` 敲到第一个闭合 `~` 不提前触发单波浪线', async () => {
    const r = await typed('x\n', ' ~~a~')
    expect(r.marked).toEqual([])
    expect(r.text).toBe('x ~~a~')
  })
})

describe('endsAtCursor(所有 mark 规则外面那一层)', () => {
  it('匹配不贴光标就放弃 —— 以后谁再加一条无锚规则,也删不到远处的字', () => {
    const hits: string[] = []
    const re = /~(.+?)~/ // 故意无锚
    const wrapped = endsAtCursor(new InputRule(re, (_s, m) => { hits.push(m[0]); return null }))
    const handler = (wrapped as unknown as { handler: (...a: unknown[]) => unknown }).handler
    handler({}, re.exec('今天~ 明天~ 加油!'), 0, 0)
    expect(hits).toEqual([])
    handler({}, re.exec('a ~b~'), 0, 0)
    expect(hits).toEqual(['~b~'])
  })
})

describe('正则本身', () => {
  it('删除线:带锚、首尾非空白、内容不含 `~`', () => {
    expect(STRIKETHROUGH_RE.test('今天好累~ 明天继续~ 加油!')).toBe(false)
    expect(STRIKETHROUGH_RE.test('今天好累~ 明天继续~')).toBe(false) // 内容以空格开头
    expect(STRIKETHROUGH_RE.test('3~5小时，持续2~')).toBe(false) // 开定界符前是数字
    expect(STRIKETHROUGH_RE.exec('a ~~b~~')?.[2]).toBe('b')
  })
  it('下划线:带锚、内容不含 `_`', () => {
    expect(UNDERSCORE_EMPHASIS_RE.test('变量_tmp_的值')).toBe(false)
    expect(UNDERSCORE_EMPHASIS_RE.exec('a _b_ c _d_')?.[1]).toBe('d')
    expect(UNDERSCORE_EMPHASIS_RE.test('snake_case_')).toBe(false) // 词内下划线
  })
})
