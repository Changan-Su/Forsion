// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildSelector, pickControlSource, pickerSource, sanitizePick, shortElementLabel, PICK_SELECTOR_MAX, PICK_TEXT_MAX } from './browserPick'

const mount = (html: string): void => { document.body.innerHTML = html }
const q = (sel: string): Element => document.querySelector(sel)!

describe('buildSelector', () => {
  it('uses a stable unique id', () => {
    mount('<div><a id="download" class="btn">Download</a></div>')
    expect(buildSelector(q('a'))).toBe('#download')
  })

  it('skips generated-looking ids and classes', () => {
    mount('<main><button id="react-12345" class="css-1x2y3z btn primary">Go</button></main>')
    expect(buildSelector(q('button'))).toBe('button.btn.primary')
  })

  it('adds nth-of-type when tag.class is not unique among siblings', () => {
    mount('<nav><a class="btn">A</a><a class="btn">B</a><a class="btn">C</a></nav>')
    const sel = buildSelector(document.querySelectorAll('a')[1])
    expect(sel).toBe('a.btn:nth-of-type(2)')
    expect(document.querySelectorAll(sel)).toHaveLength(1)
    expect(document.querySelector(sel)!.textContent).toBe('B')
  })

  it('walks up to a parent when needed and stays unique', () => {
    mount('<section class="hero"><div><span>x</span></div></section><section class="foot"><div><span>y</span></div></section>')
    const target = q('section.foot span')
    const sel = buildSelector(target)
    expect(document.querySelectorAll(sel)).toHaveLength(1)
    expect(document.querySelector(sel)).toBe(target)
    expect(sel).toContain('section.foot')
  })

  it('anchors on a parent id', () => {
    mount('<div id="pricing"><p>a</p><p>b</p></div><div><p>c</p><p>d</p></div>')
    const target = document.querySelectorAll('#pricing p')[1]
    const sel = buildSelector(target)
    expect(sel.startsWith('#pricing > ')).toBe(true)
    expect(document.querySelector(sel)).toBe(target)
  })

  it('escapes odd characters in class names it keeps', () => {
    mount('<div><i class="icon-é">x</i></div>')
    const sel = buildSelector(q('i'))
    expect(document.querySelector(sel)).toBe(q('i'))
  })

  it('is self-contained so it survives toString() injection', () => {
    // 注入 guest 时是整段源码;函数体里引用模块里的东西就会在 guest 里 ReferenceError
    const fn = new Function(`return (${buildSelector.toString()})`)() as typeof buildSelector
    mount('<nav><a class="btn">A</a><a class="btn">B</a></nav>')
    expect(fn(document.querySelectorAll('a')[1])).toBe('a.btn:nth-of-type(2)')
    expect(() => new Function(`return ${pickerSource()}`)).not.toThrow() // 至少能被解析
    expect(pickControlSource('parent')).toContain('.parent()')
    expect(pickControlSource('cancel')).toContain('.cancel()')
  })
})

describe('shortElementLabel', () => {
  it('is tag.firstUsableClass', () => {
    mount('<a class="w-[30px] btn big">x</a>')
    expect(shortElementLabel(q('a'))).toBe('a.btn')
    mount('<p>x</p>')
    expect(shortElementLabel(q('p'))).toBe('p')
  })
})

describe('sanitizePick', () => {
  const ok = { selector: 'a.btn', tag: 'A', text: '  Download \n now ', rect: { x: 10, y: 20, w: 100, h: 30 }, vw: 800, vh: 600 }
  it('normalises a good pick', () => {
    expect(sanitizePick(ok)).toEqual({ selector: 'a.btn', tag: 'a', text: 'Download now', rect: { x: 10, y: 20, w: 100, h: 30 }, vw: 800, vh: 600 })
  })
  it('caps text and selector length', () => {
    const r = sanitizePick({ ...ok, text: 'x'.repeat(5000), selector: 'a'.repeat(5000) })!
    expect(r.text).toHaveLength(PICK_TEXT_MAX)
    expect(r.selector).toHaveLength(PICK_SELECTOR_MAX)
  })
  it('clamps the rect into the viewport', () => {
    const r = sanitizePick({ ...ok, rect: { x: -50, y: 590, w: 9999, h: 9999 } })!
    expect(r.rect).toEqual({ x: 0, y: 590, w: 800, h: 10 })
  })
  it('rejects malformed input from the page', () => {
    expect(sanitizePick(null)).toBeNull()
    expect(sanitizePick('a.btn')).toBeNull()
    expect(sanitizePick({ ...ok, selector: 42 })).toBeNull()
    expect(sanitizePick({ ...ok, rect: { x: NaN, y: 0, w: 1, h: 1 } })).toBeNull()
    expect(sanitizePick({ ...ok, vw: Infinity })).toBeNull()
    expect(sanitizePick({ ...ok, tag: '<script>' })?.tag).toBe('script')
    expect(sanitizePick({ ...ok, tag: '!!!' })).toBeNull()
  })
})
