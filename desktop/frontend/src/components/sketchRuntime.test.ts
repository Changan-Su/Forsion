// @vitest-environment happy-dom
/** 卡内运行时的直播补丁(10-09 二轮):原地 morph、新节点淡入标记、原生部件按源码比对、终稿接上脚本。 */
import { beforeAll, describe, expect, it } from 'vitest'
import runtime from './sketchRuntime.js?raw'
import figures from './sketchFigures.js?raw'

const w = window as any
const post = (msg: unknown): void => { window.dispatchEvent(new MessageEvent('message', { data: msg, source: window as any })) }

beforeAll(() => {
  w.ResizeObserver ||= class { observe() {} disconnect() {} }
  // 沙箱帧里 parent 就是自己;happy-dom 下同样成立
  new Function(runtime.replace('__SKETCH_INITIAL_STATE__', 'null').replace('__SKETCH_NONCE__', 'test-nonce'))()
  new Function(figures)()
})

describe('sketch runtime live patching', () => {
  it('keeps nodes in place: text continues, attributes sync, new nodes get data-fs-new', () => {
    document.body.innerHTML = '<h1 class="fs-title">Hel</h1>'
    const h1 = document.querySelector('h1')!
    post({ type: 'sketch-draft', html: '<h1 class="fs-title">Hello</h1><p>new</p>' })
    expect(document.querySelector('h1')).toBe(h1)
    expect(h1.textContent).toBe('Hello')
    expect(h1.hasAttribute('data-fs-new')).toBe(false)
    expect(document.querySelector('p')?.hasAttribute('data-fs-new')).toBe(true)
    post({ type: 'sketch-draft', html: '<h1 class="fs-title big">Hello</h1><p>new</p>' })
    expect(h1.className).toBe('fs-title big')
    expect(document.querySelector('p')?.hasAttribute('data-fs-new')).toBe(true) // 下一拍不剥掉淡入标记
  })
  it('replaces a native part only when its source changed (rendered DOM is never compared)', async () => {
    document.body.innerHTML = ''
    const src = '<fs-compare><script type="application/json">{"options":[{"label":"A"},{"label":"B"}]}</script></fs-compare>'
    post({ type: 'sketch-draft', html: src })
    await new Promise((r) => setTimeout(r, 0))
    const el = document.querySelector('fs-compare')!
    expect(el.querySelectorAll('.fs-option').length).toBe(2)
    post({ type: 'sketch-draft', html: src + '<p>tail</p>' })
    expect(document.querySelector('fs-compare')).toBe(el)
    post({ type: 'sketch-draft', html: src.replace('"B"', '"C"') + '<p>tail</p>' })
    await new Promise((r) => setTimeout(r, 0))
    const next = document.querySelector('fs-compare')!
    expect(next).not.toBe(el)
    expect(next.textContent).toContain('C')
  })
  it('final swaps inert scripts for live ones and fires DOMContentLoaded/load', () => {
    document.body.innerHTML = '<div id="x">a</div>'
    w.__fsRan = 0
    let dcl = 0
    document.addEventListener('DOMContentLoaded', () => { dcl++ })
    const inert = document.querySelector('script')
    post({ type: 'sketch-final', html: '<div id="x">a</div><script type="application/json">{"k":1}</script><script>window.__fsRan++</script>' })
    const scripts = [...document.body.querySelectorAll('script')]
    expect(scripts.length).toBe(2)
    expect(scripts[0].getAttribute('type')).toBe('application/json')
    expect(scripts[1]).not.toBe(inert)
    expect(dcl).toBe(1)
    // happy-dom 执行插入的脚本;要是环境不跑脚本,只验证替换与事件
    if (w.__fsRan !== 0) expect(w.__fsRan).toBe(1)
  })
  it('final also activates the other JavaScript MIME types, leaves importmap/json inert', () => {
    document.body.innerHTML = ''
    const html = '<script type="text/ecmascript">1</script><script type="application/x-javascript">2</script><script type="importmap">{}</script><script type="application/json">{}</script>'
    post({ type: 'sketch-draft', html })
    const inert = [...document.body.querySelectorAll('script')]
    expect(inert.length).toBe(4)
    post({ type: 'sketch-final', html })
    const after = [...document.body.querySelectorAll('script')]
    // 可执行类型的被换成新节点(执行路径),数据类型的还是原节点
    expect(after.map((s, i) => s === inert[i])).toEqual([false, false, true, true])
  })
  it('fs-choice multiple: a shorter setData drops out-of-range picks instead of throwing on submit', async () => {
    document.body.innerHTML = '<fs-choice id="c"><script type="application/json">{"question":"Q","multiple":true,"options":[{"label":"A"},{"label":"B"},{"label":"C"}],"ask":"pick {choices}"}</script></fs-choice>'
    await new Promise((r) => setTimeout(r, 0))
    const el = document.getElementById('c') as any
    const third = el.querySelectorAll('input')[2]
    third.checked = true; third.dispatchEvent(new Event('change'))
    el.setData({ question: 'Q', multiple: true, options: [{ label: 'A' }, { label: 'B' }], ask: 'pick {choices}' })
    expect(el.querySelectorAll('input').length).toBe(2)
    expect(() => el.querySelector('.fs-actions .fs-button').click()).not.toThrow()
  })
  it('ask/copy refuse without a user gesture', () => {
    expect(() => w.forsionSketch.ask('x')).toThrow(/user gesture/)
    expect(() => w.forsionSketch.copy('x')).toThrow(/user gesture/)
  })
})

describe('native parts', () => {
  const mount = async (html: string) => { document.body.innerHTML = html; await new Promise((r) => setTimeout(r, 0)); return document.body.firstElementChild! }
  it('fs-choice single: one button per option; multiple: checkboxes + submit', async () => {
    const single = await mount('<fs-choice><script type="application/json">{"question":"Q?","options":[{"label":"A"},{"label":"B","ask":"explain b"}]}</script></fs-choice>')
    expect(single.querySelectorAll('.fs-choice-options .fs-button').length).toBe(2)
    const multi = await mount('<fs-choice><script type="application/json">{"question":"Q?","multiple":true,"options":[{"label":"A"},{"label":"B"}],"submitLabel":"Go"}</script></fs-choice>')
    expect(multi.querySelectorAll('input[type=checkbox]').length).toBe(2)
    expect(multi.querySelector('.fs-actions .fs-button')?.textContent).toBe('Go')
  })
  it('fs-checklist persists ticks through forsionSketch.setState under checklists[id]', async () => {
    const el = await mount('<fs-checklist id="shop"><script type="application/json">{"items":[{"label":"eggs"},{"label":"milk","detail":"1L"}]}</script></fs-checklist>')
    const boxes = el.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    expect(boxes.length).toBe(2)
    boxes[1].checked = true
    boxes[1].dispatchEvent(new Event('change'))
    expect(w.forsionSketch.state).toEqual({ checklists: { shop: [1] } })
    // 重新接入(同一份状态)→ 勾选恢复
    const again = await mount('<fs-checklist id="shop"><script type="application/json">{"items":[{"label":"eggs"},{"label":"milk"}]}</script></fs-checklist>')
    expect(again.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1].checked).toBe(true)
  })
  it('invalid data renders the alert placeholder, never guessed content', async () => {
    const el = await mount('<fs-compare><script type="application/json">{"options":[{"label":"only one"}]}</script></fs-compare>')
    expect(el.querySelector('[role=alert]')).toBeTruthy()
    expect(el.querySelectorAll('.fs-option').length).toBe(0)
  })
})
