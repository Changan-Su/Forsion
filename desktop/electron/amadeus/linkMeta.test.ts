/** pickLinkMeta:封面图取值链(2026-08-29 用户实报「书签卡没有封面」)。
 *  链路是**实测定的**(13 个站):og:image → twitter:image → apple-touch-icon(标 icon)。
 *  取不到也不算坏 —— 渲染端有生成封面兜底,这里只钉「能取到的都取到、且分得清照片与图标」。 */
import { describe, it, expect } from 'vitest'
import { pickLinkMeta, biliJsonToMeta } from './linkMeta'

const BASE = 'https://x.test/a/b'
const wrap = (head: string): string => `<html><head>${head}</head><body>x</body></html>`

describe('pickLinkMeta 封面链', () => {
  it('og:image 优先,算 photo', () => {
    const m = pickLinkMeta(wrap('<meta property="og:image" content="/p.png"><meta name="twitter:image" content="/t.png">'), BASE)
    expect(m.image).toBe('https://x.test/p.png')
    expect(m.imageKind).toBe('photo')
  })
  it('只有 twitter:image 时取它(两种属性写法都认)', () => {
    expect(pickLinkMeta(wrap('<meta name="twitter:image" content="https://c/t.png">'), BASE).image).toBe('https://c/t.png')
    expect(pickLinkMeta(wrap('<meta content="https://c/s.png" property="twitter:image:src">'), BASE).imageKind).toBe('photo')
  })
  it('⚠️ 都没有才退 apple-touch-icon,且必须标成 icon(方形 logo,渲染端要 contain)', () => {
    const m = pickLinkMeta(wrap('<link rel="apple-touch-icon" sizes="180x180" href="/icon.png">'), BASE)
    expect(m.image).toBe('https://x.test/icon.png')
    expect(m.imageKind).toBe('icon')
  })
  it('什么都没有 → image/imageKind 都缺(渲染端生成封面接手)', () => {
    const m = pickLinkMeta(wrap('<title>T</title>'), BASE)
    expect(m.image).toBeUndefined()
    expect(m.imageKind).toBeUndefined()
    expect(m.title).toBe('T')
  })
  it('相对/协议相对地址都转绝对', () => {
    expect(pickLinkMeta(wrap('<meta property="og:image" content="//cdn.test/p.png">'), BASE).image).toBe('https://cdn.test/p.png')
    expect(pickLinkMeta(wrap('<meta property="og:image" content="../up.png">'), BASE).image).toBe('https://x.test/up.png')
  })
  it('favicon 取不到时退 /favicon.ico', () => {
    expect(pickLinkMeta(wrap(''), BASE).favicon).toBe('https://x.test/favicon.ico')
  })
})

describe('⚠️ 图片 URL 一律升 https(2026-08-29 实测:B 站封面全灭的真因)', () => {
  it('http 的 og:image 升成 https —— 渲染层 CSP 是 `img-src … https:`,明文会被拦掉', () => {
    const m = pickLinkMeta(wrap('<meta property="og:image" content="http://i0.hdslb.com/x.jpg">'), BASE)
    expect(m.image).toBe('https://i0.hdslb.com/x.jpg')
  })
  it('已经是 https 的原样,favicon 同样升', () => {
    expect(pickLinkMeta(wrap('<meta property="og:image" content="https://a/b.png">'), BASE).image).toBe('https://a/b.png')
    expect(pickLinkMeta(wrap('<link rel="icon" href="http://a/f.ico">'), BASE).favicon).toBe('https://a/f.ico')
  })
  it('apple-touch-icon 兜底也升 https', () => {
    expect(pickLinkMeta(wrap('<link rel="apple-touch-icon" href="http://a/i.png">'), BASE).image).toBe('https://a/i.png')
  })
})

describe('B 站 view 接口 → LinkMeta(实测:视频页 og 被风控挡掉,只能走官方接口)', () => {
  const ok = { code: 0, data: { pic: 'http://i2.hdslb.com/bfs/archive/a.jpg', title: '标题', desc: '简介', owner: { name: 'UP主' } } }
  it('封面升 https,UP 主进站点名', () => {
    const m = biliJsonToMeta(ok)!
    expect(m.image).toBe('https://i2.hdslb.com/bfs/archive/a.jpg')
    expect(m.imageKind).toBe('photo')
    expect(m.siteName).toBe('哔哩哔哩 · UP主')
    expect(m.title).toBe('标题')
  })
  it('⚠️ code≠0 一律当没抓到 —— **哪怕 data 里还有东西**(负对照:只判 data 的话这条不会红)', () => {
    expect(biliJsonToMeta({ code: -404, data: { title: '视频去哪了呢', pic: 'http://x/y.jpg' } })).toBeNull()
    expect(biliJsonToMeta({ code: -403, data: { title: '稿件不可见' } })).toBeNull()
    expect(biliJsonToMeta({ code: -404, data: null })).toBeNull()
    expect(biliJsonToMeta({ code: 0 })).toBeNull()
    expect(biliJsonToMeta(null)).toBeNull()
  })
  it('只有标题没封面也算有效(总比一行网址强)', () => {
    expect(biliJsonToMeta({ code: 0, data: { title: 'T' } })?.title).toBe('T')
  })
})
