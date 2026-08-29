// @vitest-environment happy-dom
/** 2026-08-29 用户实报「粘贴视频链接直接就 embed 了」后的分流契约,**真挂组件**验:
 *    裸 URL(BookmarkCard) → 永远是卡片,视频也不例外(以前这里直接出 iframe 播放器)
 *    嵌入形态(WebEmbed)  → YouTube / B 站走 iframe 播放器,其余走 webview/冻结卡
 *  纯函数测不出这条:分类结果(bookmark / web)本来就没变,变的全在渲染分支。
 *  ponytail: createElement 不用 JSX,免为两个用例把 vitest include 扩到 .tsx。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as React from 'react'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BookmarkCard, VideoIframe, genCover } from './BookmarkCard'
import { WebEmbed } from './WebEmbed'

vi.mock('../api', () => ({ amadeus: {} }))
vi.mock('../../builtins/browserView', () => ({ Webview: () => null }))
const g = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean; React: typeof React }
g.IS_REACT_ACT_ENVIRONMENT = true
g.React = React

const YT = 'https://www.youtube.com/watch?v=abc12345'
const BILI = 'https://www.bilibili.com/video/BV1xx411c7mD'
const noop = (): void => {}

let root: Root | null = null
let container: HTMLElement | null = null
const host = (): HTMLElement => container!

/** ⚠️ 容器**刻意不挂进 document**:happy-dom 的 <iframe> 一 connect 就真去 fetch 那个 src
 *  (测试跑起来会打 youtube/b 站的网)。断言读的是 src 属性,不需要它真加载。 */
async function mount(el: React.ReactElement): Promise<void> {
  container = document.createElement('div')
  await act(async () => {
    root = createRoot(container!)
    root.render(el)
  })
}
beforeEach(() => { container = null })
afterEach(async () => { await act(async () => root?.unmount()); root = null; container = null })

describe('裸 URL = 书签卡', () => {
  it('YouTube 裸链不出 iframe', async () => {
    await mount(createElement(BookmarkCard, { url: YT, onChangeUrl: noop }))
    expect(host().querySelector('iframe')).toBeNull()
    expect(host().querySelector('.amx-bm')).not.toBeNull()
  })
  it('B 站裸链不出 iframe', async () => {
    await mount(createElement(BookmarkCard, { url: BILI, onChangeUrl: noop }))
    expect(host().querySelector('iframe')).toBeNull()
  })
  it('视频卡给「▶ 内嵌」按钮(以前 yt 被排除在外,降级后没这个按钮就回不去播放器了)', async () => {
    await mount(createElement(BookmarkCard, { url: YT, onChangeUrl: noop, onEmbed: noop }))
    const btns = [...host().querySelectorAll('.amx-bm-tool')].map((b) => b.textContent)
    expect(btns).toContain('▶')
  })
  it('og 抓不到时 YouTube 仍有确定性缩略图(否则视频链接变成一行光秃秃的字)', async () => {
    await mount(createElement(BookmarkCard, { url: YT, onChangeUrl: noop }))
    expect(host().querySelector<HTMLImageElement>('.amx-bm-thumb img')?.src)
      .toContain('i.ytimg.com/vi/abc12345/')
  })
})

describe('嵌入形态 = 播放器', () => {
  it('WebEmbed 把 YouTube 分流给 iframe 播放器', async () => {
    await mount(createElement(WebEmbed, { url: YT, toCard: noop }))
    expect(host().querySelector('iframe')?.getAttribute('src')).toContain('youtube-nocookie.com/embed/abc12345')
  })
  it('WebEmbed 把 B 站分流给 iframe 播放器', async () => {
    await mount(createElement(WebEmbed, { url: BILI, toCard: noop }))
    expect(host().querySelector('iframe')?.getAttribute('src')).toContain('player.bilibili.com/player.html?bvid=BV1xx411c7mD')
  })
  it('⚠️ 普通网页绝不走 iframe(webhost 铁律:任意第三方网页只能 webview)', async () => {
    await mount(createElement(WebEmbed, { url: 'https://example.com/a', toCard: noop }))
    expect(host().querySelector('iframe')).toBeNull()
  })
  it('起播时刻带进播放器 URL', async () => {
    await mount(createElement(VideoIframe, { url: `${YT}&t=90` }))
    expect(host().querySelector('iframe')?.getAttribute('src')).toContain('start=90')
  })
})

describe('封面位永远在(2026-08-29 用户实报「书签卡没有封面」)', () => {
  it('抓不到元数据也有生成封面 + 首字母', async () => {
    await mount(createElement(BookmarkCard, { url: 'https://news.ycombinator.com/' }))
    const gen = host().querySelector<HTMLElement>('.amx-bm-thumb-gen')
    expect(gen).not.toBeNull()
    expect(gen!.style.backgroundImage).toContain('linear-gradient')
    expect(host().querySelector('.amx-bm-gen-letter')?.textContent).toBe('N')
  })
  it('⚠️ 封面图加载失败 → 换生成封面,**不许把封面位藏掉**(原先 onError 是 display:none)', async () => {
    await mount(createElement(BookmarkCard, { url: YT }))
    const img = host().querySelector<HTMLImageElement>('.amx-bm-thumb img')
    expect(img).not.toBeNull()
    await act(async () => { img!.dispatchEvent(new Event('error')) })
    expect(host().querySelector('.amx-bm-thumb-gen')).not.toBeNull()
    expect(host().querySelector('.amx-bm-thumb')).not.toBeNull()
  })
  it('genCover 同域恒定、不同域不同,首字母取主机名', () => {
    expect(genCover('https://a.test/x')).toEqual(genCover('https://a.test/y?z=1'))
    expect(genCover('https://www.zhihu.com/q/1').letter).toBe('Z')
    expect(genCover('https://a.test/x').c1).not.toBe(genCover('https://b.test/x').c1)
  })
})
