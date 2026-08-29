// @vitest-environment happy-dom
/**
 * paintHlBands 的 pulseAge 契约(Codex 评审:动画不许在重画时重头播)。
 * 几何那半由 `npm run check:hlband`(真 PDFViewer + 真画布像素)钉,这里只钉纯 DOM 的三档行为。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { paintHlBands } from './hlBand'

// happy-dom 的 getBoundingClientRect 恒返回 0,带子会被 `r.width <= 0` 跳过 —— 桩一个非零矩形。
const realRect = Element.prototype.getBoundingClientRect
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return { x: 0, y: 0, top: 10, left: 20, right: 120, bottom: 26, width: 100, height: 16, toJSON: () => ({}) } as DOMRect
  }
})
afterEach(() => { Element.prototype.getBoundingClientRect = realRect })

function fixture(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = '<div class="page"><div class="canvasWrapper"></div><div class="textLayer"><span><span class="highlight"></span></span></div></div>'
  document.body.appendChild(root)
  return root
}

describe('paintHlBands 的提醒动画契约', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('不传 pulseAge = 不放动画(滚动/缩放引发的重画走这条,否则一滚就闪)', () => {
    const root = fixture()
    expect(paintHlBands(root)).toBe(1)
    const b = root.querySelector('.pdfa-citehl-band') as HTMLElement
    expect(b.classList.contains('is-pulse')).toBe(false)
    expect(b.style.animationDelay).toBe('')
  })

  it('pulseAge=0 = 从头播', () => {
    const root = fixture()
    paintHlBands(root, 0)
    const b = root.querySelector('.pdfa-citehl-band') as HTMLElement
    expect(b.classList.contains('is-pulse')).toBe(true)
    expect(b.style.animationDelay).toBe('0ms')
  })

  it('动画播到一半再重画:接着原相位往下播(负 animation-delay),不是从 0% 重来', () => {
    const root = fixture()
    paintHlBands(root, 0)
    paintHlBands(root, 620) // 邻页渲染完 → textlayerrendered → 重画
    const b = root.querySelector('.pdfa-citehl-band') as HTMLElement
    expect(b.classList.contains('is-pulse')).toBe(true)
    expect(b.style.animationDelay).toBe('-620ms')
  })

  it('命中消失后旧的 overlay 层被清掉(翻页/换关键词的残留)', () => {
    const root = fixture()
    paintHlBands(root, 0)
    expect(root.querySelectorAll('.pdfa-citehl').length).toBe(1)
    root.querySelector('.highlight')!.remove()
    expect(paintHlBands(root)).toBe(0)
    expect(root.querySelectorAll('.pdfa-citehl').length).toBe(0)
  })
})
