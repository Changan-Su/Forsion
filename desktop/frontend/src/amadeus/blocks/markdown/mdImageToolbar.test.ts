// @vitest-environment happy-dom
//
// 图片说明 / 对齐(2026-11-17 Notion 对齐第 4 条):说明写进 title `![alt](src "说明")`,对齐 = 段首对齐标记。
// 真 Milkdown(生产装配,parseFidelity.testkit)+ 生产存取两端 toDisplayMarkdown / toStoredMarkdown:
// 说明里的 `"` 序列化成 `\"`,旧版 IMG_RE 认不出整张图 → 显示地址原样落盘。只测编辑器往返会绿,所以这里走整条链。
// 真浏览器那一半:npm run check:imagetoolbar。
import { afterEach, describe, expect, it } from 'vitest'
import { NodeSelection } from '@milkdown/kit/prose/state'
import { bootEditor, roundTrip, type Booted } from './parseFidelity.testkit'
import { mdImagePlugin } from './mdImage'
import { setTextAlignment } from './paragraphIndent'
import { toDisplayMarkdown, toStoredMarkdown } from '@amadeus-shared/assets'

const CAPS = ['新版主页 · Team Desk 视图', 'say "hi"', 'back\\slash', 'ends with \\', '\\"both\\"', 'paren ) here', "it's", 'a\\b"c', '  spaced  ']

let open: Booted[] = []
afterEach(async () => {
  for (const b of open) await b.destroy()
  open = []
})
async function boot(md: string, extra = false): Promise<Booted> {
  const b = await bootEditor(md, extra ? { extra: [mdImagePlugin()] } : {})
  open.push(b)
  return b
}
function imagePos(b: Booted): number {
  let at = -1
  b.view.state.doc.descendants((n, p) => { if (at < 0 && n.type.name === 'image') at = p })
  if (at < 0) throw new Error('没有图片')
  return at
}
function setTitle(b: Booted, title: string | null): void {
  const pos = imagePos(b)
  const node = b.view.state.doc.nodeAt(pos)!
  b.view.dispatch(b.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, title }))
}
const titleOf = (b: Booted): unknown => b.view.state.doc.nodeAt(imagePos(b))!.attrs.title

describe('说明 = 图片 title,逐字往返', () => {
  for (const cap of CAPS) {
    it(`编辑器往返:${JSON.stringify(cap)}`, async () => {
      const b = await boot('# 标题\n\n![新版主页|320](attachments/home.jpg)\n')
      setTitle(b, cap)
      const md = b.saved()
      const re = await boot(md)
      expect(titleOf(re)).toBe(cap)
      expect(re.saved()).toBe(md) // 重开再存:一个字节不变
    })
  }

  it('双引号 / 反斜杠的落盘写法', async () => {
    const b = await boot('![|200](a.png)\n')
    setTitle(b, 'say "hi" \\ end \\"')
    // `"` → `\"`;反斜杠只在后面跟着标点时才要转义(CommonMark:`\ ` 本来就是字面反斜杠)
    expect(b.saved()).toContain('![|200](a.png "say \\"hi\\" \\ end \\\\\\"")')
  })

  it('盘上已有说明的图:不编辑原样落盘(Obsidian 写的也一样)', async () => {
    for (const md of ['![新版主页|720](home.jpg "新版主页 · Team Desk 视图")\n', '前文\n\n![x](a%20b.png "say \\"hi\\"")\n\n后文\n']) {
      expect(await roundTrip(md)).toBe(md)
    }
  })

  for (const cap of CAPS) {
    it(`整条存取链(显示地址 → 编辑 → 落盘 → 重开):${JSON.stringify(cap)}`, async () => {
      const stored = '前文\n\n![封面|240](attachments/a%20b.png)\n\n后文\n'
      const b = await boot(toDisplayMarkdown(stored, 'notes'))
      expect(String(b.view.state.doc.nodeAt(imagePos(b))!.attrs.src)).toMatch(/^amadeus-asset:/)
      setTitle(b, cap)
      const disk = toStoredMarkdown(b.saved(), 'notes')
      expect(disk).not.toContain('amadeus-asset') // 显示地址绝不落盘
      expect(disk).toContain('![封面|240](attachments/a%20b.png "')
      const re = await boot(toDisplayMarkdown(disk, 'notes'))
      expect(titleOf(re)).toBe(cap)
      expect(String(re.view.state.doc.nodeAt(imagePos(re))!.attrs.src)).toMatch(/^amadeus-asset:/) // 读回来照样换成显示地址
      expect(toStoredMarkdown(re.saved(), 'notes')).toBe(disk)
    })
  }

  it('清空说明 = 去掉 title,回到无标题写法', async () => {
    const b = await boot('![|200](a.png "旧说明")\n')
    setTitle(b, null)
    expect(b.saved()).toBe('![|200](a.png)\n')
  })
})

describe('对齐 = 段首对齐标记(复用段落对齐)', () => {
  it('居中 / 靠右落盘为段首标记,重开读回;回到左对齐标记消失', async () => {
    const b = await boot('前文\n\n![图|300](a.png "说明")\n\n后文\n')
    for (const a of ['center', 'right'] as const) {
      b.view.dispatch(b.view.state.tr.setSelection(NodeSelection.create(b.view.state.doc, imagePos(b))))
      setTextAlignment(b.view.state, (tr) => b.view.dispatch(tr), a)
      const md = b.saved()
      expect(md).toBe(`前文\n\n<span data-amadeus-align="${a}"></span>![图|300](a.png "说明")\n\n后文\n`)
      const re = await boot(md)
      expect(re.view.state.doc.resolve(imagePos(re)).parent.attrs.align).toBe(a)
      expect(re.saved()).toBe(md)
    }
    setTextAlignment(b.view.state, (tr) => b.view.dispatch(tr), 'left')
    expect(b.saved()).toBe('前文\n\n![图|300](a.png "说明")\n\n后文\n')
  })
})

describe('NodeView:工具条「说明」输入行', () => {
  // 工具条第一次悬停才建(长笔记别每张图都先挂一排按钮)
  const capBtn = (b: Booted): HTMLButtonElement => {
    b.view.dom.querySelector('.wiki-inline-img-wrap')!.dispatchEvent(new PointerEvent('pointerenter'))
    return b.view.dom.querySelector<HTMLButtonElement>('.amx-img-tb [data-act="caption"]')!
  }
  const line = (b: Booted): HTMLInputElement | null => b.view.dom.querySelector<HTMLInputElement>('.amx-img-capline')
  const key = (el: HTMLElement, k: string): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) }

  it('输入 → 回车提交写进 title,图下显示;空说明不占位', async () => {
    const b = await boot('![|200](a.png)\n', true)
    const cap = b.view.dom.querySelector<HTMLElement>('.amx-img-cap')!
    expect(cap.hidden).toBe(true) // 没有说明:不占位
    expect(b.view.dom.querySelector('.amx-img-tb')).toBeNull() // 没悬停过:工具条还没建
    capBtn(b).click()
    const input = line(b)!
    expect(input).toBeTruthy()
    input.value = 'a "q" \\ b'
    key(input, 'Enter')
    expect(line(b)).toBeNull()
    expect(titleOf(b)).toBe('a "q" \\ b')
    expect(cap.hidden).toBe(false)
    expect(cap.textContent).toBe('a "q" \\ b')
  })

  it('Esc 取消不改;值没变不派事务;清空 = 去掉 title', async () => {
    const b = await boot('![|200](a.png "原说明")\n', true)
    const before = b.view.state.doc
    capBtn(b).click()
    line(b)!.value = '改了'
    key(line(b)!, 'Escape')
    expect(b.view.state.doc).toBe(before)
    capBtn(b).click()
    key(line(b)!, 'Enter') // 原样提交
    expect(b.view.state.doc).toBe(before) // 没派事务:这一块仍可逐字落盘
    capBtn(b).click()
    line(b)!.value = '   '
    key(line(b)!, 'Enter')
    expect(titleOf(b)).toBeNull()
    expect(b.saved()).toBe('![|200](a.png)\n')
  })

  it('输入法选词的回车不提交', async () => {
    const b = await boot('![|200](a.png)\n', true)
    capBtn(b).click()
    const input = line(b)!
    input.value = '中文'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
    expect(line(b)).toBe(input)
    expect(titleOf(b)).toBeNull()
  })

  it('只读:不出会改文档的键', async () => {
    const b = await boot('![|200](a.png)\n', true)
    b.view.setProps({ editable: () => false })
    b.view.dom.querySelector('.wiki-inline-img-wrap')!.dispatchEvent(new PointerEvent('pointerenter'))
    const shown = [...b.view.dom.querySelectorAll<HTMLButtonElement>('.amx-img-tb button')].filter((x) => !x.hidden).map((x) => x.dataset.act)
    expect(shown).toEqual(['fullscreen', 'download'])
  })
})
