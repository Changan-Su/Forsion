// @vitest-environment happy-dom
//
// I-13 落盘半:句中「文字 === 地址」的链接,裸写后重解析等价 → 落裸 URL;不等价(全角标点会被 gfm 吞进地址、
// 紧贴字母不成链)→ 回落上游 `<url>`。真 Milkdown(生产装配,parseFidelity.testkit)。
// 输入规则与书签卡不抢跑在台架:npm run check:linkcard 的 AU 组;句中语料:npm run check:rtcorpus 的 i13 条。
import { describe, expect, it } from 'vitest'
import { bootEditor } from './parseFidelity.testkit'
import { bareUrlRoundTrips, trimUrlTrail } from './autolink'

const reserialize = async (md: string): Promise<string> => {
  const b = await bootEditor(md)
  try { return b.md() } finally { await b.destroy() }
}

describe('autolink 落盘', () => {
  it('句中裸 URL 重新序列化仍是裸 URL(不再写 `<url>`)', async () => {
    for (const md of ['see https://x.com/a_b ok\n', 'see https://x.com/a. Next\n', 'see **https://x.com/s** ok\n', '见 https://x.com/p。后\n', '(https://x.com/q)\n'])
      expect(await reserialize(md), md).toBe(md)
  })
  it('裸写不等价的留 `<url>`', async () => {
    expect(await reserialize('见 <https://x.com/p>。后\n')).toBe('见 <https://x.com/p>。后\n')
    expect(await reserialize('abc<https://x.com/d>\n')).toBe('abc<https://x.com/d>\n')
  })
  it('等价判定与尾随标点', () => {
    expect(bareUrlRoundTrips('https://x.com/a', ' ', ' ok')).toBe(true)
    expect(bareUrlRoundTrips('https://x.com/a', ' ', '。后')).toBe(false)
    expect(bareUrlRoundTrips('https://x.com/a', 'c', ' ')).toBe(false)
    expect(bareUrlRoundTrips('https://x.com/a', ' ', '.**b**')).toBe(false)
    expect(trimUrlTrail('https://x.com/a.),')).toBe('https://x.com/a')
    expect(trimUrlTrail('https://x.com/w_(b)')).toBe('https://x.com/w_(b)')
  })
})
