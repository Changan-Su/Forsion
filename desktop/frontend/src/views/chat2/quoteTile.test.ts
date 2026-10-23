// @vitest-environment happy-dom
/** 引用磁贴跳回原文:按字面往前找最近一条含这段字的消息(QuoteTile.findQuoteSource)。 */
import { describe, expect, it } from 'vitest'
import { findQuoteSource } from './QuoteTile'

function stream(): HTMLElement {
  document.body.innerHTML = `<div class="t2-stream-inner">
    <div id="tocmsg-a1" class="t2-asst"><p>官网那条</p><p>先做 P0</p></div>
    <div id="tocmsg-u1"><p>好的</p></div>
    <div id="tocmsg-a2" class="t2-asst"><p>官网那条也可以晚点</p></div>
    <div id="tocmsg-u2"><span class="tile">x</span></div>
    <div id="tocmsg-a3" class="t2-asst"><p>官网那条写在后面</p></div>
  </div>`
  return document.querySelector('#tocmsg-u2 .tile') as HTMLElement
}

describe('findQuoteSource', () => {
  it('取这条之前最近的一条,之后的不算', () => {
    expect(findQuoteSource(stream(), '官网那条')).toBe('a2')
  })
  it('划选跨段带换行也认(比较时去掉空白)', () => {
    expect(findQuoteSource(stream(), '官网那条\n先做 P0')).toBe('a1')
  })
  it('找不到 / 空引文 → undefined', () => {
    expect(findQuoteSource(stream(), '没有这句')).toBeUndefined()
    expect(findQuoteSource(stream(), '  \n')).toBeUndefined()
  })
})
