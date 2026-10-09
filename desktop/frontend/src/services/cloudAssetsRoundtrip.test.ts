/**
 * 云端库资源地址的「显示 ↔ 落盘」往返(2026-10-09 事故的验收,真云桥那一对:web/src/amadeus/cloudAssets.ts)。
 * 事故:云桥只装了地址的构建、没有解析,编辑器一存盘就把 `![](.amadeus/pic.png)` 写成
 * `![](https://…/amadeus/vaults/<库>/asset?ref=…&page=…&at=<令牌>)` —— 令牌 24 小时过期后图片失联。
 * 接缝本身的单测在 shared/amadeus/assets.test.ts;真编辑器、真存盘在 mobile 的 `npm run e2e:localasset` 场景 C。
 * 负对照(实跑过):installCloudAssetUrls 里不传 parseAssetUrl → 第 1 / 2 / 5 格红。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetAssetUrlBuilder, toAssetUrl, toDisplayMarkdown, toStoredMarkdown } from '@amadeus-shared/assets'
import { installCloudAssetUrls, parseAssetUrl } from '../../../../web/src/amadeus/cloudAssets'

const VID = '0b7f2c1e-6a4d-4f6e-9a57-2d1c3e4f5a6b'
let vid = VID
beforeEach(() => {
  vid = VID
  installCloudAssetUrls({ apiBase: 'https://api.example/api', vaultId: () => vid, assetToken: () => 'TOKEN', activePage: () => 'dir/笔记.md' })
})
afterEach(() => resetAssetUrlBuilder())

describe('cloud asset URLs: display ↔ stored', () => {
  it('往返逐字稳定:普通 / 带空格 / 带括号的文件名,落盘仍是页相对路径', () => {
    for (const md of ['前文\n\n![](.amadeus/pic.png)\n', '![alt](a%20b.png "t")\n', '![](export%20%281%29.png)\n']) {
      const shown = toDisplayMarkdown(md, 'dir')
      expect(shown).toContain(`https://api.example/api/amadeus/vaults/${VID}/asset?`) // 防空过:显示形是带令牌的云端地址
      expect(shown).toContain('at=TOKEN')
      expect(toStoredMarkdown(shown, 'dir')).toBe(md)
    }
  })

  it('编辑器给 & 加了反斜杠的形态(图片与文字同段)也还原', () => {
    const url = `https://api.example/api/amadeus/vaults/${VID}/asset?ref=dir%2F.amadeus%2Fpic.png\\&page=dir%2F%E7%AC%94%E8%AE%B0.md\\&at=TOKEN`
    expect(toStoredMarkdown(`![](${url}) x\n`, 'dir')).toBe('![](.amadeus/pic.png) x\n')
  })

  it('只认当前这个库:别的库的资源地址、路径只是长得像的、没有 ref 的,逐字不动', () => {
    const keep = [
      `https://api.example/api/amadeus/vaults/another-vault-id/asset?ref=z.png&at=T`,
      `https://evil.example/asset?ref=../y.png`,
      `https://api.example/api/amadeus/vaults/${VID}/asset-token?ref=z.png`,
      `https://api.example/api/xamadeus/vaults/${VID}/assetx?ref=z.png`,
      `https://api.example/api/amadeus/vaults/${VID}/asset?at=T`,
      `https://api.example/api/amadeus/vaults/${VID}/asset`,
      // 带片段的一律不认(构建时从不带):外链的片段里写着本库端点的字样,不能被骗过去(评审 2026-10-09)
      `https://cdn.example/logo.png#/amadeus/vaults/${VID}/asset?ref=dir%2Fwrong.png`,
      `https://api.example/api/amadeus/vaults/${VID}/asset?ref=dir%2Fa.png#frag`,
    ]
    for (const u of keep) expect(parseAssetUrl(u), u).toBeNull()
    const md = keep.map((u) => `![](${u})`).join('\n') + '\n'
    expect(toStoredMarkdown(md, 'dir')).toBe(md)
  })

  it('已经存坏的笔记:显示时按当前的接口源与令牌重拼(图当场显示得出),存盘再换回页相对路径;尖括号里的、代码里的、别的库的不动', () => {
    const old = (ref: string): string => `https://old.example/api/amadeus/vaults/${VID}/asset?ref=${encodeURIComponent(ref)}&page=dir%2Fnote.md&at=EXPIRED`
    const md = [
      `![](${old('dir/.amadeus/pic.png')})`,
      `文字 ![alt](${old('dir/a b.png').replace(/&/g, '\\&')} "t") 文字`, // 图片与文字同段时盘上是 \& 的形态
      `![](${old('dir/c.png')})`,
      `![](<${old('dir/angle.png')}>)`, // 尖括号目标:存盘那一侧不拆,这里也不动(否则原本逐字保住的引用会被改写)
      `\`![](${old('dir/in-code.png')})\``,
      '![](https://api.example/api/amadeus/vaults/another-vault/asset?ref=z.png&at=T)',
      '![](https://example.com/logo.png)',
      '',
    ].join('\n')
    const shown = toDisplayMarkdown(md, 'dir').split('\n')
    const fresh = (ref: string): string => toAssetUrl(ref)
    expect(fresh('dir/c.png')).toContain('at=') // 防空过:当前构建器带着现在的令牌
    expect(fresh('dir/c.png')).not.toContain('EXPIRED')
    expect(shown[0]).toBe(`![](${fresh('dir/.amadeus/pic.png')})`)
    expect(shown[1]).toBe(`文字 ![alt](${fresh('dir/a b.png')} "t") 文字`)
    expect(shown[2]).toBe(`![](${fresh('dir/c.png')})`)
    expect(shown.slice(3)).toEqual(md.split('\n').slice(3)) // 尖括号里的、代码里的、别的库的、普通外链:逐字不动
    expect(toStoredMarkdown(shown[3], 'dir')).toBe(md.split('\n')[3]) // 尖括号那条:显示不动,存盘也逐字保住
    expect(toStoredMarkdown(shown.slice(0, 3).join('\n'), 'dir')).toBe('![](.amadeus/pic.png)\n文字 ![alt](a%20b.png "t") 文字\n![](c.png)')
  })

  it('库 id 现取:换库之后,旧库的地址不再认(不把别的库的引用写成这个库的相对路径)', () => {
    const shown = toDisplayMarkdown('![](a.png)\n', '')
    vid = 'f3a1b2c4-0000-4000-8000-000000000001'
    expect(toStoredMarkdown(shown, '')).toBe(shown)
  })

  it('另一端改写过的存量笔记也认得回来:源不同(网页版同源 /api、相对地址)、令牌已过期、没有 page', () => {
    const forms = [
      `https://tangu.example/api/amadeus/vaults/${VID}/asset?ref=dir%2F.amadeus%2Fpic.png&page=x.md&at=EXPIRED`,
      `/api/amadeus/vaults/${VID}/asset?ref=dir%2F.amadeus%2Fpic.png`,
      `http://localhost:3001/api/amadeus/vaults/${VID}/asset?at=T&ref=dir%2F.amadeus%2Fpic.png`,
    ]
    for (const u of forms) expect(toStoredMarkdown(`![](${u})\n`, 'dir'), u).toBe('![](.amadeus/pic.png)\n')
  })
})
