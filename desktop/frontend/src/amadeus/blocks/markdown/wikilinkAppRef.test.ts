// @vitest-environment happy-dom
//
// 应用 / 窗口引用 `[[app://…]]` / `[[window://…]]`(契约 shared/appRefs.ts)在笔记编辑器里的那一半:
// 渲染成芯片而不是笔记链接(没有 data-wiki、不算「未解析」、点了不走开笔记那条路),光标行照旧露源码,
// 「打开光标处链接」认得它。真 Milkdown + 真装饰层;宿主接口用桩。真应用里的观感(图标、变灰、悬停卡)只能在桌面端看。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { AppRef } from '../../../../../shared/appRefs'
import { bootEditor, type Booted } from './parseFidelity.testkit'
import { editorFocusKey, editorFocusPlugin } from './editorFocus'
import { wikilinkPlugin } from './wikilink'
import { linkAtCursor } from './linkFollow'

const MD = '去 [[window://com.apple.Safari|季度计划]] 和 [[app://com.apple.Notes|Notes]] 再看 [[缺页]]\n\n第二段\n'
const WIN: AppRef = { kind: 'window', id: 'com.apple.Safari', name: '季度计划' }

const openNote = vi.fn()
const openApp = vi.fn(async () => ({ ok: true }))
let b: Booted

const chips = (): HTMLElement[] => [...b.view.dom.querySelectorAll<HTMLElement>('.wikilink.amx-app-ref')]
/** 光标放到第一段里 `needle` 之后 offset 个字符处。 */
const caretAt = (needle: string, offset = 0, focus = true): void => {
  const at = 1 + b.view.state.doc.firstChild!.textContent.indexOf(needle) + offset
  const tr = b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, at))
  b.view.dispatch(focus ? tr.setMeta(editorFocusKey, true) : tr)
}

beforeEach(async () => {
  openNote.mockClear()
  openApp.mockClear()
  ;(window as unknown as { tangu: unknown }).tangu = {
    appRefs: {
      list: async () => ({ windows: [], apps: [] }),
      // 窗口已经关了、应用在跑:前者要变灰
      status: async (refs: AppRef[]) => refs.map((r) => ({ state: r.kind === 'window' ? 'closed' : 'running', appName: 'Safari' })),
      icons: async () => ({}),
      frontmost: async () => null,
      open: openApp,
    },
  }
  b = await bootEditor(MD, { extra: [editorFocusPlugin(), wikilinkPlugin(openNote, () => false)] })
})
afterEach(async () => {
  await b.destroy()
  delete (window as unknown as { tangu?: unknown }).tangu
})

describe('渲染', () => {
  it('两条引用都成芯片,不带笔记链接的标记;旁边真正的双链不受影响', () => {
    expect(chips()).toHaveLength(2)
    for (const el of chips()) {
      expect(el.hasAttribute('data-wiki')).toBe(false) // 悬停页面预览(WikiHoverPreview)按 [data-wiki] 认
      expect(el.classList.contains('wikilink-unresolved')).toBe(false)
      expect(el.getAttribute('contenteditable')).toBe('false')
    }
    // 不等 React 提交(占位那一拍)就已经是芯片的样子和名字,看不到 `window://…` 源码
    for (const [i, name] of ['季度计划', 'Notes'].entries()) {
      const chip = chips()[i].querySelector('.app-ref')
      expect(chip?.textContent?.startsWith(name)).toBe(true)
      expect(chips()[i].textContent).not.toContain('://')
    }
    const notes = [...b.view.dom.querySelectorAll<HTMLElement>('.wikilink[data-wiki]')]
    expect(notes.map((el) => [el.dataset.wiki, el.classList.contains('wikilink-unresolved'), el.classList.contains('amx-app-ref')])).toEqual([['缺页', true, false]])
  })

  it('芯片本体是聊天同款的 .app-ref:带种类,窗口关了变灰', async () => {
    await vi.waitFor(() => expect(chips()[0].querySelector('.app-ref[data-kind="window"][data-state="closed"]')).toBeTruthy())
    const [win, app] = chips().map((el) => el.querySelector<HTMLElement>('.app-ref')!)
    expect(win.hasAttribute('data-off')).toBe(true)
    expect(app.dataset.kind).toBe('app')
    expect(app.dataset.state).toBe('running')
    expect(app.hasAttribute('data-off')).toBe(false)
    // 悬停卡的文案走共享那份;卡片挂在 body 上(不在正文里,滚动区裁不到它),停留一会儿才出
    expect(document.querySelector('.app-ref-card')).toBeNull()
    win.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('body > .app-ref-card')?.textContent).toContain('找不到这个窗口了'))
    win.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('.app-ref-card')).toBeNull())
  })

  it('光标进到那一行 → 露出源码;离开 → 又是芯片', () => {
    caretAt('再看')
    expect(chips()).toHaveLength(0)
    expect(b.view.dom.querySelector('.wikilink-src-hidden')).toBeNull()
    b.view.dispatch(b.view.state.tr.setSelection(TextSelection.create(b.view.state.doc, b.view.state.doc.content.size - 1)))
    expect(chips()).toHaveLength(2)
  })

  it('落盘的还是那行纯文本', () => {
    expect(b.md()).toBe(MD)
  })
})

describe('点击', () => {
  it('点芯片 = 切到那个窗口;不落光标、不走开笔记那条路', async () => {
    await vi.waitFor(() => expect(chips()[0].querySelector('.app-ref[data-kind="window"]')).toBeTruthy())
    const inner = chips()[0].querySelector<HTMLElement>('.app-ref')!
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    inner.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    expect(openApp).toHaveBeenCalledTimes(1)
    expect(openApp).toHaveBeenCalledWith(WIN)
    expect(openNote).not.toHaveBeenCalled()
    expect(chips()).toHaveLength(2) // 还是芯片,没有被点成源码
  })

  it('Shift / Alt+点击是扩选、落光标:按下放行给编辑器,这一下不算打开', async () => {
    await vi.waitFor(() => expect(chips()[0].querySelector('.app-ref[data-kind="window"]')).toBeTruthy())
    const inner = chips()[0].querySelector<HTMLElement>('.app-ref')!
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, shiftKey: true })
    inner.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(false)
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, shiftKey: true }))
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true }))
    expect(openApp).not.toHaveBeenCalled()
  })
})

describe('打开光标处链接(linkAtCursor)', () => {
  it('光标在引用里 → 应用 / 窗口引用,不是笔记链接', () => {
    caretAt('[[window://', 5)
    expect(linkAtCursor(b.view.state)).toEqual({ kind: 'app', ref: WIN })
    caretAt('[[app://', 0) // 贴着开头也算
    expect(linkAtCursor(b.view.state)).toEqual({ kind: 'app', ref: { kind: 'app', id: 'com.apple.Notes', name: 'Notes' } })
  })
  it('旁边的双链照旧交给开笔记那条路;不在链接上 = null', () => {
    caretAt('[[缺页', 3)
    expect(linkAtCursor(b.view.state)).toEqual({ kind: 'wiki', arg: '缺页' })
    caretAt('再看', 1)
    expect(linkAtCursor(b.view.state)).toBeNull()
  })
})
