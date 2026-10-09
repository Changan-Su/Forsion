import { describe, expect, it } from 'vitest'
import { draftHtml } from './sketchDraft'

describe('sketch draft html (structure first, behavior on completion)', () => {
  it('drops complete behavior scripts but keeps markup', () => {
    expect(draftHtml('<h1 class="fs-title">T</h1><script>document.body.textContent="x"</script><p>after</p>'))
      .toBe('<h1 class="fs-title">T</h1><p>after</p>')
  })
  it('cuts an unclosed behavior script and a half-typed script tag', () => {
    expect(draftHtml('<p>a</p><script>const x = 1;\nfunction f(')).toBe('<p>a</p>')
    expect(draftHtml('<p>a</p><scr')).toBe('<p>a</p><scr') // 不是 <script\b:浏览器自己丢掉残缺标签
    expect(draftHtml('<p>a</p><script ty')).toBe('<p>a</p>')
  })
  it('treats only a real type= attribute as data: data-type="application/json" is an executable script', () => {
    expect(draftHtml('<p>a</p><script data-type="application/json">alert(1)</script>')).toBe('<p>a</p>')
    expect(draftHtml("<script type='application/json'>{\"a\":1}</script>")).toBe("<script type='application/json'>{\"a\":1}</script>")
    expect(draftHtml('<script type=application/json>{"a":1}</script>')).toBe('<script type=application/json>{"a":1}</script>')
  })
  it('strips inline event handlers inside tags (they run without a click), leaves prose alone', () => {
    expect(draftHtml('<svg onload="run()"><circle r="1"/></svg>')).toBe('<svg><circle r="1"/></svg>')
    expect(draftHtml('<img src=x onerror=run() alt="y">')).toBe('<img src=x alt="y">')
    expect(draftHtml("<body onLoad='run()'><p>go online=1 now</p>")).toBe("<body><p>go online=1 now</p>")
    expect(draftHtml('<p>a</p><svg onload="ru')).toBe('<p>a</p><svg')
  })
  it('keeps figure data scripts (application/json), closed or still streaming', () => {
    const closed = '<fs-chart type="bar"><script type="application/json">{"data":[{"label":"a","value":1}]}</script></fs-chart>'
    expect(draftHtml(closed)).toBe(closed)
    const open = '<fs-flow><script type="application/json">{"steps":[{"label":"Und'
    expect(draftHtml(open)).toBe(open)
    expect(draftHtml(closed + '<script>alert(1)</script>')).toBe(closed)
  })
})
