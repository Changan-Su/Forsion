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
      expect(shown).not.toContain('page=') // 正文里的图不带 page:服务端照 ref 精确取,不按页目录再拼一遍
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
    const fresh = (ref: string): string => toAssetUrl(ref, true) // 正文里的图:ref 是完整的库内路径,不带 page(2026-10-10)
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

/** 服务端 GET /vaults/:v/asset 怎么找文件 —— 镜像 server/microserver/amadeus/routes.ts 与 lib/paths.ts 的 normalizePath
 *  (改那边要改这里;2026-10-10 对着真路由 + PGlite 逐条核过):先「page 的目录 + ref」,再把 ref 当库内路径精确找,
 *  ref 不含 `/` 时才全库按文件名找。路径里有 `.` / `..` 段一律**拒收**(不是折叠)。 */
function serverResolve(url: string, files: string[]): string | null {
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1))
  const norm = (p: string | null): string | null => {
    const t = (p ?? '').normalize('NFC').trim().replace(/\/+$/, '')
    if (!t || t.startsWith('/') || t.includes('\\') || t.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null
    return t
  }
  const ref = q.get('ref') ?? ''
  const cands: string[] = []
  const page = norm(q.get('page'))
  if (page) {
    const dir = page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : ''
    const c = norm(dir ? `${dir}/${ref}` : ref)
    if (c) cands.push(c)
  }
  const exact = norm(ref)
  if (exact && !cands.includes(exact)) cands.push(exact)
  for (const c of cands) if (files.includes(c)) return c
  if (ref.includes('/')) return null
  return [...files].sort().find((f) => !f.split('/').some((seg) => seg.startsWith('.')) && f.split('/').pop()!.toLowerCase() === ref.toLowerCase()) ?? null
}

/** 页目录之外的引用在云端库(2026-10-10)。两处既有缺陷,都是「客户端送过去的 ref 服务端找不到」:
 *    · 落盘写成了库内路径写法(relFrom 不产出 `../`)→ 重开按页相对拼成 notes/attachments/x.png,那里没有文件;
 *    · 盘上是 `../` 写法(附件放固定文件夹时产品自己写的)→ ref 里带着 `..`,服务端见到就拒收。
 *  加上第三处:ref 已经是完整的库内路径,却还带着 page → 服务端先按页目录再拼一遍,那里恰好有同路径的文件就显示成它。
 *  修法:落盘写 `../`(shared/amadeus/assets.ts 的 relFrom);接缝构建的地址先折叠 `.` / `..` 再送,原样写法另带在 lit 里
 *  供存盘逐字换回;笔记正文里的图(toDisplayMarkdown)不带 page。真编辑器、真存盘在 mobile 的 `npm run e2e:localasset` 场景 E / F。
 *  负对照(都实跑过,格号按本组顺序):接缝构建器改回 `(ref) => buildAssetUrl(ref)` → 第 1–5 格红;只去掉 exact 时不带 page
 *  (或 toDisplayMarkdown 不传 exact)→ 第 1 / 3 / 5 格红(取到的是页目录下同路径的那个文件);不补尾斜杠 → 第 4 格红;
 *  parseAssetUrl 不认 lit → 第 3 / 7 格红,不核对就认 lit → 第 7 格红;shared/amadeus/assets.ts 的 relFrom 改回只去前缀 → 第 1 / 5 格红。
 *  ref 末尾带 `/` 时服务端只做精确匹配这一条,2026-10-10 也对着真路由核过(不带 → 取到别处的同名文件;带 → 404)。 */
describe('cloud asset URLs: 页目录之外的引用', () => {
  const FILES = ['notes/note.md', 'attachments/x.png', 'assets/y.png', 'notes/pic.png', 'pic.png']
  // 当前页就是 notes/ 下那篇:服务端「先按页目录拼」的那一步才踩得到 notes/attachments/x.png(同路径的另一个文件)。
  beforeEach(() => installCloudAssetUrls({ apiBase: 'https://api.example/api', vaultId: () => VID, assetToken: () => 'TOKEN', activePage: () => 'notes/note.md' }))
  const srcOf = (displayMd: string): string => /\]\(([^)\s]+)/.exec(displayMd)![1]
  /** 落盘的那一行在 notes/ 下的笔记里重开,服务端最终给的是哪个文件。 */
  const served = (stored: string, files = FILES): string | null => serverResolve(srcOf(toDisplayMarkdown(stored, 'notes')), files)

  it('⚠️从别的文件夹贴进来的图:存成 ../,重开取到的是同一个文件;同路径的另一个文件不会顶替它', () => {
    const stored = toStoredMarkdown(`![](${toAssetUrl('attachments/x.png', true)})`, 'notes')
    expect(stored).toBe('![](../attachments/x.png)')
    expect(served(stored)).toBe('attachments/x.png')
    expect(served(stored, [...FILES, 'notes/attachments/x.png'])).toBe('attachments/x.png')
  })

  it('盘上的 ../ 写法(附件放固定文件夹):送给服务端的 ref 已折叠,取得到;存回去逐字不变', () => {
    const md = '![](../assets/y.png)\n'
    const shown = toDisplayMarkdown(md, 'notes')
    expect(new URLSearchParams(srcOf(shown).split('?')[1]).get('ref')).toBe('assets/y.png')
    expect(serverResolve(srcOf(shown), FILES)).toBe('assets/y.png')
    expect(toStoredMarkdown(shown, 'notes')).toBe(md)
  })

  it('盘上本来的 ./ 、中途的 .. 、绕回页目录的 ../notes/ :取得到,存回去逐字不变(原样写法带在 lit 里)', () => {
    for (const [md, file] of [['![](./pic.png)\n', 'notes/pic.png'], ['![](sub/../pic.png)\n', 'notes/pic.png'], ['![](../notes/pic.png)\n', 'notes/pic.png'], ['![](../pic.png "t")\n', 'pic.png']] as const) {
      const shown = toDisplayMarkdown(md, 'notes')
      expect(serverResolve(srcOf(shown), FILES), md).toBe(file)
      expect(toStoredMarkdown(shown, 'notes'), md).toBe(md)
    }
  })

  it('⚠️带路径的引用折叠后成了裸文件名(../pic.png → pic.png):库根那个文件不在了就是取不到,不许全库按名找到别处的同名文件', () => {
    // 评审 2026-10-10:服务端对不含 `/` 的 ref 找不到就全库按文件名找;桌面对带路径的地址只做精确匹配。ref 末尾补 `/` 对齐。
    // 负对照(实跑过):seamAssetUrl 不补尾斜杠 → 本格红(取到 other/pic.png)。
    const md = '![](../pic.png)\n'
    const shown = toDisplayMarkdown(md, 'notes')
    expect(serverResolve(srcOf(shown), ['notes/note.md', 'other/pic.png'])).toBeNull()
    expect(serverResolve(srcOf(shown), ['notes/note.md', 'other/pic.png', 'pic.png'])).toBe('pic.png')
    expect(toStoredMarkdown(shown, 'notes')).toBe(md)
    // 库根笔记里的裸文件名(盘上本来就不带路径)照旧可以全库按名找 —— 桌面也是这样
    expect(serverResolve(srcOf(toDisplayMarkdown('![](pic.png)\n', '')), ['other/pic.png'])).toBe('other/pic.png')
  })

  it('图片源码行里填的库内路径(mdImage.commitSource → toAssetUrl(p, true)):显示的和存下去的是同一张', () => {
    // 评审 2026-10-10:不按 exact 取的话,云端先按当前页的目录找(显示 notes/pic.png),存盘却按库内路径写成 ../pic.png(库根那张)。
    const src = toAssetUrl('pic.png', true)
    expect(serverResolve(src, FILES)).toBe('pic.png')
    const stored = toStoredMarkdown(`![](${src})`, 'notes')
    expect(stored).toBe('![](../pic.png)')
    expect(served(stored)).toBe('pic.png')
  })

  it('折叠后逃出库根的引用:原样送(服务端拒收,显示不出),存回去逐字不变', () => {
    const md = '![](../../secret.png)\n'
    const shown = toDisplayMarkdown(md, 'notes')
    expect(serverResolve(srcOf(shown), [...FILES, 'secret.png'])).toBeNull()
    expect(toStoredMarkdown(shown, 'notes')).toBe(md)
  })

  it('lit 只在它折叠后确实等于 ref 时才认(结果会被写回正文);没有 lit 的旧地址照旧按 ref 认', () => {
    const base = `https://api.example/api/amadeus/vaults/${VID}/asset`
    expect(parseAssetUrl(`${base}?ref=assets%2Fy.png&lit=notes%2F..%2Fassets%2Fy.png&at=T`)).toBe('notes/../assets/y.png')
    expect(parseAssetUrl(`${base}?ref=assets%2Fy.png&lit=other%2Fz.png&at=T`)).toBe('assets/y.png')
    expect(parseAssetUrl(`${base}?ref=assets%2Fy.png&lit=..%2F..%2Fetc&at=T`)).toBe('assets/y.png')
    expect(parseAssetUrl(`${base}?ref=assets%2Fy.png&page=notes%2Fnote.md&at=T`)).toBe('assets/y.png')
    expect(parseAssetUrl(`${base}?ref=pic.png%2F&lit=notes%2F..%2Fpic.png&at=T`)).toBe('notes/../pic.png') // 补了尾斜杠的那种
  })

  it('`![[裸文件名]]` 这类嵌入(不经 toDisplayMarkdown)照旧带 page:同文件夹的那张优先', () => {
    const url = toAssetUrl('pic.png')
    expect(new URLSearchParams(url.split('?')[1]).get('page')).toBe('notes/note.md')
    expect(serverResolve(url, FILES)).toBe('notes/pic.png')
  })

  it('已经存成库内路径写法的存量笔记不自愈:重开仍按页相对拼,服务端找不到', () => {
    expect(served('![](attachments/x.png)\n')).toBeNull()
  })
})
