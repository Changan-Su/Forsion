// @vitest-environment happy-dom
//
// 整块颜色(Notion 对齐 A1)的「保存—重开」往返:块首标记 ↔ 节点 attr。
// 走的是与落盘同源的真 Milkdown 链(parseFidelity.testkit),md() = 整篇重新序列化(不走逐字回填),
// 所以这里红 = 编辑过一次就会变样。
import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { bootEditor, roundTrip } from './parseFidelity.testkit'
import { stripBlockMarkers, takeBlockMarkers } from './blockColor'

const BG = (c: string) => `<span data-amadeus-bg="${c}"></span>`

/** 文档里每个带颜色的节点:类型 + bg/fg(+ 对齐 / 缩进,确认没串到别的 attr 上)。 */
function colored(doc: PMNode): string[] {
  const out: string[] = []
  doc.descendants((n) => {
    const a = n.attrs as Record<string, unknown>
    if (a.bg || a.fg) out.push(`${n.type.name}${n.type.name === 'heading' ? a.level : ''}:${a.bg || '-'}/${a.fg || '-'}${a.align && a.align !== 'left' ? `@${a.align}` : ''}${a.indent ? `>${a.indent}` : ''}${a.checked != null ? (a.checked ? '[x]' : '[ ]') : ''}`)
  })
  return out
}

async function open(md: string): Promise<{ attrs: string[]; text: string; md: string }> {
  const b = await bootEditor(md)
  try { return { attrs: colored(b.view.state.doc), text: b.view.state.doc.textContent, md: b.md() } } finally { await b.destroy() }
}

describe('块首颜色标记:读进 attr、原样写回', () => {
  it.each([
    ['段落底色', `${BG('blue')}整段蓝底\n`, ['paragraph:blue/-']],
    ['段落字色', '<span data-amadeus-fg="red"></span>红字\n', ['paragraph:-/red']],
    ['底色 + 字色同一枚', '<span data-amadeus-bg="yellow" data-amadeus-fg="blue"></span>黄底蓝字\n', ['paragraph:yellow/blue']],
    ['对齐 + 颜色', `<span data-amadeus-align="center"></span>${BG('green')}居中绿底\n`, ['paragraph:green/-@center']],
    ['颜色 + 制表符缩进', `${BG('grey')}&#9;缩进一档\n`, ['paragraph:grey/->1']],
    ['跟随强调色', '<span data-amadeus-bg="accent"></span>强调色\n', ['paragraph:accent/-']],
    ['更多颜色(hex)', '<span data-amadeus-fg="#1a2b3c"></span>自定义\n', ['paragraph:-/#1a2b3c']],
    ['空段落只有颜色', `前\n\n${BG('red')}\n\n后\n`, ['paragraph:red/-']],
    ['标题', `## ${BG('yellow')}黄底标题\n`, ['heading2:yellow/-']],
    ['标题 + 对齐', `## <span data-amadeus-align="right"></span>${BG('purple')}右对齐紫底\n`, ['heading2:purple/-@right']],
    ['缩进标题(结构缩进注释)', `前\n\n<!-- amadeus-indent:1 -->\n\n## ${BG('teal')}缩进标题\n`, ['heading2:teal/->1']],
    ['列表项', `- ${BG('green')}绿底项\n- 普通项\n`, ['list_item:green/-']],
    ['编号项', '1. <span data-amadeus-fg="purple"></span>紫字\n2. 二\n', ['list_item:-/purple']],
    ['待办', `- [ ] ${BG('red')}红底待办\n- [x] 已完成\n`, ['list_item:red/-[ ]']],
    ['列表项里对齐 + 颜色:对齐留给段落', `- <span data-amadeus-align="center"></span>${BG('blue')}居中\n`, ['list_item:blue/-']],
    ['空列表项只有颜色', `- ${BG('grey')}\n- 二\n`, ['list_item:grey/-']],
    ['嵌套列表项', `- 父\n  - ${BG('orange')}子\n`, ['list_item:orange/-']],
    ['引用', `> ${BG('purple')}紫底引用\n> 第二行\n`, ['blockquote:purple/-']],
    ['引用里第二段自己上色', `> 第一段\n>\n> ${BG('red')}第二段\n`, ['paragraph:red/-']],
  ])('%s', async (_label, md, want) => {
    const got = await open(md)
    expect(got.attrs).toEqual(want)
    expect(got.text).not.toContain('data-amadeus') // 标记不进正文
    expect(got.md).toBe(md) // 整篇重新序列化逐字相同
    expect(await roundTrip(got.md)).toBe(md) // 再存一轮不变
  })

  it.each([
    ['未知颜色名', '<span data-amadeus-bg="chartreuse"></span>字\n'],
    ['未知 data-amadeus 属性', '<span data-amadeus-icon="🚀"></span>字\n'],
    ['颜色值不规范(大写 hex)', '<span data-amadeus-bg="#ABCDEF"></span>字\n'],
    ['同一属性出现两次', `${BG('red')}${BG('blue')}字\n`],
    // Codex 评审 #2:容器摘走第一枚后,段落别再把第二枚当自己的颜色读走(写回时会被容器颜色盖掉)
    ['列表项里同一属性两次', `- ${BG('red')}${BG('blue')}first\n- second\n`],
    ['引用里同一属性两次', `> ${BG('red')}${BG('blue')}引用\n`],
  ])('读不懂的标记不摘、不丢:%s', async (_label, md) => {
    const got = await open(md)
    expect(await roundTrip(md)).toBe(md)
    // 同一属性两次:第一枚认、第二枚留在正文;其余整串留在正文
    expect(got.md).toBe(md)
  })

  // Codex 评审 #3:引用里摘掉颜色会露出 [!type] —— 不摘,标记照旧是正文 HTML、不变成标注 / 折叠块。
  // 整篇重存时 `[` 被转义成 `\[`:main(没有 A1)上同一份笔记一模一样(实测),没编辑过的块逐字回写不受影响。
  it.each([
    ['折叠令牌', `> ${BG('red')}[!fold]- title\n> body\n`],
    ['标注令牌(前面还有对齐)', `> <span data-amadeus-align="center"></span>${BG('red')}[!tip] title\n> body\n`],
  ])('颜色标记后面紧跟 %s:标记不丢、不变成标注,和没有 A1 时一致', async (_label, src) => {
    const got = await open(src)
    expect(got.attrs).toEqual([])
    expect(got.md).toBe(src.replace('[!', '\\[!'))
    expect(await roundTrip(got.md)).toBe(got.md)
  })

  it('非规范顺序(颜色在对齐前)读得懂,重写成规范形,不丢信息', async () => {
    const md = `${BG('blue')}<span data-amadeus-align="center"></span>字\n`
    const got = await open(md)
    expect(got.attrs).toEqual(['paragraph:blue/-@center'])
    expect(got.md).toBe(`<span data-amadeus-align="center"></span>${BG('blue')}字\n`)
  })
})

describe('上色 → 存 → 重开 = 同一个 attr', () => {
  it('段落 / 标题 / 列表项 / 引用 setNodeMarkup 后存盘,重开 attr 一致,再存不变', async () => {
    const md = '# 标题\n\n正文\n\n- 项\n\n> 引用\n'
    const b = await bootEditor(md)
    let saved: string
    try {
      const { state } = b.view
      let tr = state.tr
      state.doc.descendants((n, pos) => {
        if (n.type.name === 'heading') tr = tr.setNodeMarkup(pos, undefined, { ...n.attrs, fg: 'red' })
        if (n.type.name === 'paragraph' && n.textContent === '正文') tr = tr.setNodeMarkup(pos, undefined, { ...n.attrs, bg: 'blue', fg: 'grey' })
        if (n.type.name === 'list_item') tr = tr.setNodeMarkup(pos, undefined, { ...n.attrs, bg: 'green' })
        if (n.type.name === 'blockquote') tr = tr.setNodeMarkup(pos, undefined, { ...n.attrs, bg: 'yellow' })
        return true
      })
      b.view.dispatch(tr)
      saved = b.saved()
    } finally { await b.destroy() }
    expect(saved).toBe(`# <span data-amadeus-fg="red"></span>标题\n\n<span data-amadeus-bg="blue" data-amadeus-fg="grey"></span>正文\n\n- ${BG('green')}项\n\n> ${BG('yellow')}引用\n`)
    const re = await open(saved)
    expect(re.attrs).toEqual(['heading1:-/red', 'paragraph:blue/grey', 'list_item:green/-', 'blockquote:yellow/-'])
    expect(re.md).toBe(saved)
  })

  it('标注(> [!tip])上的颜色不写段首标记(令牌必须在段首,A5 另定存法)', async () => {
    const md = '> [!tip] 标题\n> 正文\n'
    const b = await bootEditor(md)
    try {
      const { state } = b.view
      let tr = state.tr
      state.doc.descendants((n, pos) => { if (n.type.name === 'blockquote') tr = tr.setNodeMarkup(pos, undefined, { ...n.attrs, bg: 'blue' }); return true })
      b.view.dispatch(tr)
      expect(b.md()).not.toContain('data-amadeus')
      expect(b.md()).toContain('[!tip] 标题')
    } finally { await b.destroy() }
  })
})

describe('纯函数', () => {
  it('stripBlockMarkers 只剥认识的块标记', () => {
    expect(stripBlockMarkers(`${BG('red')}<span data-amadeus-align="center"></span>标题`)).toBe('标题')
    expect(stripBlockMarkers('<span data-amadeus-icon="x"></span>标题')).toBe('<span data-amadeus-icon="x"></span>标题')
  })
  it('takeBlockMarkers 认开闭两节点形态', () => {
    const r = takeBlockMarkers([{ type: 'html', value: '<span data-amadeus-bg="red">' }, { type: 'html', value: '</span>' }, { type: 'text', value: 'x' }])
    expect([r.bg, r.children?.length]).toEqual(['red', 1])
  })
})
