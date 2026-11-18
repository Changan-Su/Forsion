// @vitest-environment happy-dom
//
// `![[x.png|200]]` 图片的工具条(2026-11-18 定「①」:与 `![](…)` 同一排,只是没有「说明」;存法一个字节不变)。
// 真 Milkdown + 真 wikilink 装饰层;宿主的存图 / 复制用桩。观感与真实悬停在 scripts/image-toolbar.check.cjs。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeSelection } from '@milkdown/kit/prose/state'
import { history, undo } from '@milkdown/kit/prose/history'
import { $prose } from '@milkdown/kit/utils'
import { bootEditor, roundTrip, type Booted } from './parseFidelity.testkit'
import { editorFocusPlugin } from './editorFocus'
import { wikilinkPlugin } from './wikilink'
import { isEmbedSafeName, replaceEmbedName, type WikiImageOpts } from './wikiImageToolbar'

let open: Booted[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const b of open) await b.destroy()
  open = []
})

const onOpen = vi.fn()
async function boot(md: string, opts: WikiImageOpts = {}, canOpen = true, withHistory = false): Promise<Booted> {
  onOpen.mockClear()
  const extra = [editorFocusPlugin(), wikilinkPlugin(onOpen, () => true, undefined, () => canOpen, opts)]
  const b = await bootEditor(md, { extra: withHistory ? [...extra, $prose(() => history())] : extra })
  open.push(b)
  return b
}
const wrapOf = (b: Booted, i = 0): HTMLElement => b.view.dom.querySelectorAll<HTMLElement>('.wiki-inline-img-wrap')[i]
/** 悬停 → 工具条(第一次悬停才建)。 */
function hover(b: Booted, i = 0): HTMLElement {
  wrapOf(b, i).dispatchEvent(new PointerEvent('pointerenter'))
  return wrapOf(b, i).querySelector<HTMLElement>('.amx-img-tb')!
}
const shownActs = (tb: HTMLElement): string[] => [...tb.querySelectorAll<HTMLButtonElement>('button')].filter((x) => !x.hidden).map((x) => x.dataset.act!)
const click = (tb: HTMLElement, act: string): void => tb.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!.click()
const menuItems = (b: Booted): string[] => [...b.view.dom.querySelectorAll<HTMLButtonElement>('.amx-img-more [role="menuitem"]')].map((x) => x.dataset.act!)

describe('同一排工具条,没有「说明」', () => {
  it('独占一段的图:对齐 · 替换 · 全屏 · 下载 · `</>` · ⋯;没有说明键', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n', { saveEmbed: async () => 'x.png', copyImage: async () => true })
    expect(wrapOf(b).querySelector('.amx-img-tb')).toBeNull() // 没悬停过:还没建
    expect(wrapOf(b).classList.contains('amx-img-wiki')).toBe(true)
    const tb = hover(b)
    expect(shownActs(tb)).toEqual(['alignLeft', 'alignCenter', 'alignRight', 'replace', 'fullscreen', 'download', 'source', 'more'])
    expect(tb.querySelector('[data-act="caption"]')).toBeNull()
    expect(wrapOf(b).querySelector('.amx-open-btn')).toBeNull() // 「打开」收进 ⋯,不再单挂
  })

  it('宿主不给存图 / 复制(整篇宿主):没有替换;⋯ 里只有打开 · 删除', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n')
    const tb = hover(b)
    expect(shownActs(tb)).toEqual(['alignLeft', 'alignCenter', 'alignRight', 'fullscreen', 'download', 'source', 'more'])
    click(tb, 'more')
    expect(menuItems(b)).toEqual(['open', 'delete'])
  })

  it('只读:不出会改文档的键;⋯ 里只剩打开', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n', { saveEmbed: async () => 'x.png' })
    b.view.setProps({ editable: () => false })
    const tb = hover(b)
    expect(shownActs(tb)).toEqual(['fullscreen', 'download', 'more'])
    click(tb, 'more')
    expect(menuItems(b)).toEqual(['open'])
  })

  it('没有 vault(canOpen = false)又只读:⋯ 整颗收起', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n', {}, false)
    b.view.setProps({ editable: () => false })
    expect(shownActs(hover(b))).toEqual(['fullscreen', 'download'])
  })

  it('小图(amx-img-tiny):不出工具条,只留那颗缩小版 `</>`', async () => {
    const b = await boot('前文\n\n![[pic.png|30]]\n\n后文\n')
    wrapOf(b).classList.add('amx-img-tiny') // happy-dom 不排版,watchTinyImage 量不出宽度:直接打标
    wrapOf(b).dispatchEvent(new PointerEvent('pointerenter'))
    expect(wrapOf(b).querySelector('.amx-img-tb')).toBeNull()
    expect(wrapOf(b).querySelector(':scope > .amx-src-btn')?.textContent).toBe('</>')
  })
})

describe('⋯ →「打开」', () => {
  it('点 = 原地打开;⌘/Ctrl+点 = 新标签页', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n')
    const tb = hover(b)
    click(tb, 'more')
    b.view.dom.querySelector<HTMLButtonElement>('.amx-img-more [data-act="open"]')!.click()
    expect(onOpen).toHaveBeenLastCalledWith('pic.png', undefined)
    click(tb, 'more')
    b.view.dom.querySelector<HTMLButtonElement>('.amx-img-more [data-act="open"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))
    expect(onOpen).toHaveBeenLastCalledWith('pic.png', { newTab: true })
  })
})

describe('对齐 = 段首对齐标记(与 `![](…)` / Mod-Shift-E 同一条)', () => {
  it('独占一段:居中 / 靠右落盘为段首标记,重开仍是图片、仍独占一段;回到左对齐标记消失', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n')
    for (const a of ['center', 'right'] as const) {
      click(hover(b), a === 'center' ? 'alignCenter' : 'alignRight')
      const md = b.saved()
      expect(md).toBe(`前文\n\n<span data-amadeus-align="${a}"></span>![[pic.png|200]]\n\n后文\n`)
      expect(await roundTrip(md)).toBe(md)
      const re = await boot(md)
      expect(re.view.dom.querySelectorAll('.wiki-inline-img')).toHaveLength(1) // 重开照样渲染成图
      expect(wrapOf(re).querySelector('.amx-src-btn')).toBeTruthy()
      // 独占一段:点一下选的是整段(NodeSelection),而不是源码区间
      wrapOf(re).dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
      expect(re.view.state.selection instanceof NodeSelection).toBe(true)
    }
    click(hover(b), 'alignLeft')
    expect(b.saved()).toBe('前文\n\n![[pic.png|200]]\n\n后文\n')
  })

  it('独占一段:对齐后图仍选中(选中环 / 手机底栏不塌),工具条钉住到下一次指针移动', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n')
    click(hover(b), 'alignCenter')
    const sel = b.view.state.selection
    expect(sel instanceof NodeSelection && sel.node.type.name === 'paragraph' && sel.node.textContent === '![[pic.png|200]]').toBe(true)
    expect(wrapOf(b).hasAttribute('data-tb-hold')).toBe(true)
    document.dispatchEvent(new PointerEvent('pointermove'))
    expect(wrapOf(b).hasAttribute('data-tb-hold')).toBe(false)
  })

  it('混在文字里的图:对齐整段(段落级),源码不动', async () => {
    const b = await boot('文字 ![[pic.png|120]] 更多文字\n\n最后一行\n')
    click(hover(b), 'alignCenter')
    expect(b.saved()).toBe('<span data-amadeus-align="center"></span>文字 ![[pic.png|120]] 更多文字\n\n最后一行\n')
  })

  it('当前档高亮(aria-pressed)', async () => {
    const b = await boot('<span data-amadeus-align="right"></span>![[pic.png|200]]\n\n后文\n')
    const tb = hover(b)
    expect(tb.querySelector('[data-act="alignRight"]')!.getAttribute('aria-pressed')).toBe('true')
    expect(tb.querySelector('[data-act="alignLeft"]')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('每次对齐一步撤销', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n', {}, true, true)
    click(hover(b), 'alignCenter')
    click(hover(b), 'alignRight') // 紧接着点(500ms 内):缺省会并进同一步
    undo(b.view.state, b.view.dispatch)
    expect(b.saved()).toBe('前文\n\n<span data-amadeus-align="center"></span>![[pic.png|200]]\n\n后文\n')
  })
})

describe('悬停着时快捷键 / 撤销改了对齐:工具条高亮跟上', () => {
  it('Mod-Shift-E 那条命令改了段落对齐,露着的工具条刷新当前档', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n')
    const tb = hover(b)
    wrapOf(b).setAttribute('data-tb-hold', '') // happy-dom 没有 :hover:用钉住态代表「指针还在上面」
    expect(tb.querySelector('[data-act="alignLeft"]')!.getAttribute('aria-pressed')).toBe('true')
    let at = -1
    b.view.state.doc.descendants((n, p) => { if (at < 0 && n.type.name === 'paragraph' && n.textContent.startsWith('![[')) at = p })
    const { setTextAlignment } = await import('./paragraphIndent')
    b.view.dispatch(b.view.state.tr.setSelection(NodeSelection.create(b.view.state.doc, at)))
    setTextAlignment(b.view.state, (tr) => b.view.dispatch(tr), 'center')
    const now = wrapOf(b).querySelector('.amx-img-tb')!
    expect(now.querySelector('[data-act="alignCenter"]')!.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('替换:只换库内名,`|宽度` 原样', () => {
  it('replaceEmbedName', () => {
    expect(replaceEmbedName('![[a.png|200]]', 'b.png')).toBe('![[b.png|200]]')
    expect(replaceEmbedName('![[a.png]]', 'b.png')).toBe('![[b.png]]')
    expect(replaceEmbedName('![[dir/a.png|alt|300]]', 'c d.png')).toBe('![[c d.png|alt|300]]')
  })

  function pickFile(): void {
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, 'files', { value: [new File([new Uint8Array([1])], 'new.png', { type: 'image/png' })] })
      this.onchange?.(new Event('change'))
    })
  }

  it('选图 → 存进库 → 源码换成新名字,宽度留着', async () => {
    let resolve!: (v: string) => void
    const saveEmbed = vi.fn(() => new Promise<string>((r) => { resolve = r }))
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n', { saveEmbed })
    pickFile()
    click(hover(b), 'replace')
    expect(saveEmbed).toHaveBeenCalledTimes(1)
    resolve('attachments/new.png')
    await new Promise((r) => setTimeout(r, 0))
    expect(b.saved()).toBe('前文\n\n![[attachments/new.png|200]]\n\n后文\n')
  })

  it('存盘期间这张图被改过:不写(不覆盖用户刚做的事)', async () => {
    let resolve!: (v: string) => void
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n', { saveEmbed: () => new Promise<string>((r) => { resolve = r }) })
    pickFile()
    click(hover(b), 'replace')
    // 期间用户把宽度改成 300(源码变了 → widget 重建)
    const doc = b.view.state.doc
    let at = -1
    doc.descendants((n, p) => { if (at < 0 && n.isText && n.text!.includes('![[pic')) at = p })
    b.view.dispatch(b.view.state.tr.insertText('![[pic.png|300]]', at, at + '![[pic.png|200]]'.length))
    resolve('new.png')
    await new Promise((r) => setTimeout(r, 0))
    expect(b.saved()).toBe('前文\n\n![[pic.png|300]]\n\n后文\n')
  })

  it('库内名带 wiki 定界符(`]` `|` `#` `^` 换行):不写,源码不坏', async () => {
    for (const bad of ['bad].png', 'a|b.png', 'x#y.png', 'p^q.png', 'n\nl.png']) expect(isEmbedSafeName(bad)).toBe(false)
    expect(isEmbedSafeName('dir/正常 名字-1.png')).toBe(true)
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n', { saveEmbed: async () => 'bad].png' })
    pickFile()
    click(hover(b), 'replace')
    await new Promise((r) => setTimeout(r, 0))
    expect(b.saved()).toBe('前文\n\n![[pic.png|200]]\n\n后文\n')
  })

  it('存盘失败:不动文档', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n', { saveEmbed: async () => null })
    pickFile()
    click(hover(b), 'replace')
    await new Promise((r) => setTimeout(r, 0))
    expect(b.saved()).toBe('前文\n\n![[pic.png|200]]\n\n后文\n')
  })
})

describe('⋯ →「删除」', () => {
  it('独占一段:连段落一起删,不留空段', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n')
    click(hover(b), 'more')
    b.view.dom.querySelector<HTMLButtonElement>('.amx-img-more [data-act="delete"]')!.click()
    expect(b.saved()).toBe('前文\n\n后文\n')
  })
  it('混在文字里:只删这段源码', async () => {
    const b = await boot('文字 ![[pic.png|120]] 更多文字\n\n最后一行\n')
    click(hover(b), 'more')
    b.view.dom.querySelector<HTMLButtonElement>('.amx-img-more [data-act="delete"]')!.click()
    expect(b.saved()).toBe('文字  更多文字\n\n最后一行\n')
  })
})

describe('`</>`', () => {
  it('工具条的 `</>` 露出字面源码', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n')
    click(hover(b), 'source')
    expect(b.view.dom.querySelectorAll('.wiki-inline-img')).toHaveLength(0)
    expect(b.view.dom.textContent).toContain('![[pic.png|200]]')
  })
})

describe('widget 重建:旧工具条跟着卸掉', () => {
  it('源码一变旧 DOM 换掉,旧工具条不留在文档里', async () => {
    const b = await boot('前文\n\n![[pic.png|200]]\n\n后文\n')
    const oldTb = hover(b)
    let at = -1
    b.view.state.doc.descendants((n, p) => { if (at < 0 && n.isText && n.text!.includes('![[pic')) at = p })
    b.view.dispatch(b.view.state.tr.insertText('![[pic.png|300]]', at, at + '![[pic.png|200]]'.length))
    expect(oldTb.isConnected).toBe(false)
    expect(wrapOf(b).querySelector('.amx-img-tb')).toBeNull() // 新那颗等下一次悬停才建
  })
})
