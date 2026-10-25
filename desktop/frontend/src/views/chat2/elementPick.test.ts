// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { ELEMENT_EVENT, ELEMENT_TARGET_ATTR, composeElements, deliverElementPick, elementImages, formatElementBlock, hostOf, markComposerUsed, pickTargetCard, selectorTail, tileExcerpt, type ElementPick } from './elementPick'
import { translate } from '../../i18n'
import './QuoteTile' // 登记 element.* 文案

const pick = (over: Partial<ElementPick> = {}): ElementPick => ({
  id: 'e1', url: 'https://forsion.net/download?x=1', host: 'forsion.net', title: 'Forsion', selector: 'section.hero > a.btn', tag: 'a',
  text: 'Download for macOS', image: { name: 'element-a.png', mimeType: 'image/png', data: 'AAAA', size: 3 }, ...over,
})

describe('elementPick', () => {
  it('hostOf keeps the port and names files', () => {
    expect(hostOf('https://forsion.net/a')).toBe('forsion.net')
    expect(hostOf('http://127.0.0.1:8000/x')).toBe('127.0.0.1:8000')
    expect(hostOf('file:///Users/me/site/index.html')).toBe('index.html')
    expect(hostOf('not a url')).toBe('')
  })

  it('tile excerpt is the first 20 characters, by code point', () => {
    expect(tileExcerpt('  Download  ')).toBe('Download')
    expect(tileExcerpt('一二三四五六七八九十一二三四五六七八九十一二')).toBe('一二三四五六七八九十一二三四五六七八九十…')
    expect(tileExcerpt('😀'.repeat(25))).toBe('😀'.repeat(20) + '…')
    expect(tileExcerpt('   ')).toBeNull()
  })

  it('tile sub shows the last compound of the selector', () => {
    expect(selectorTail('section.hero > a.btn:nth-of-type(2)')).toBe('a.btn:nth-of-type(2)')
    expect(selectorTail('#download')).toBe('#download')
  })

  it('tile title and sub strings in both languages', () => {
    expect(translate('element.tile.title', { text: '下载' })).toBe('「下载」')
    expect(translate('element.tile.sub', { selector: 'a.btn', host: 'forsion.net' })).toBe('网页元素 · a.btn · forsion.net')
  })

  it('formats what the model reads: URL, selector, text, screenshot note', () => {
    expect(formatElementBlock(pick())).toBe([
      '[Web element picked in the built-in browser]',
      'URL: https://forsion.net/download?x=1',
      'Page title: Forsion',
      'Selector: section.hero > a.btn',
      'Text: "Download for macOS"',
      'Screenshot of the element is attached.',
    ].join('\n'))
    const bare = formatElementBlock(pick({ text: '', image: null, title: '' }))
    expect(bare).toContain('Text: (none)')
    expect(bare).not.toContain('Screenshot')
    expect(bare).not.toContain('Page title')
  })

  it('appends element blocks after the body and collects screenshots', () => {
    const els = [pick(), pick({ id: 'e2', image: null, text: 'b' })]
    const out = composeElements('fix this button', els)
    expect(out.startsWith('fix this button\n\n[Web element')).toBe(true)
    expect(out.split('[Web element').length - 1).toBe(2)
    expect(composeElements('', [pick()]).startsWith('[Web element')).toBe(true)
    expect(elementImages(els)).toEqual([pick().image])
  })
})

describe('element delivery target', () => {
  const card = (parent: Element = document.body): HTMLElement => {
    const el = document.createElement('div')
    el.setAttribute(ELEMENT_TARGET_ATTR, '')
    el.getClientRects = () => [{}] as unknown as DOMRectList // happy-dom 没有布局:当它可见
    parent.appendChild(el)
    return el
  }

  it('prefers the chat that hosts the Agent Desk the browser sits in', () => {
    document.body.innerHTML = ''
    const other = card()
    const view = document.createElement('div'); view.className = 't2-chat-view'; document.body.appendChild(view)
    const desk = document.createElement('div'); desk.className = 'agent-desk'; view.appendChild(desk)
    const browser = document.createElement('div'); desk.appendChild(browser)
    const own = card(view)
    markComposerUsed(other)
    expect(pickTargetCard(browser)).toBe(own)
  })

  it('otherwise the most recently used visible composer', async () => {
    document.body.innerHTML = ''
    const a = card(), b = card()
    markComposerUsed(a)
    await new Promise((r) => setTimeout(r, 5))
    markComposerUsed(b)
    expect(pickTargetCard(null)).toBe(b)
  })

  it('a cancelled wait never lands in a composer that shows up later', async () => {
    document.body.innerHTML = ''
    const ac = new AbortController()
    const p = deliverElementPick(pick(), null, ac.signal)
    ac.abort()
    const late = card()
    let got = false
    late.addEventListener(ELEMENT_EVENT, () => { got = true })
    expect(await p).toBe(false)
    expect(got).toBe(false)
  })
})
