/**
 * 手机本地库的资源地址(mobile/src/amadeus/localAssets.ts)—— 成对的「构建 + 解析」与「显示 ↔ 落盘」往返。
 * 库根地址取安卓上的真实形态(Capacitor 本地文件服务,与页面同源)。接缝本身的单测在 shared/amadeus/assets.test.ts;
 * 真编辑器、真存盘在 mobile 的 `npm run e2e:localasset` 场景 A / B。
 * 负对照(实跑过):localAssetUrl 里把 `..` 折叠掉再拼地址 → 「逐字保留」那一格红。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { resetAssetUrlBuilder, toDisplayMarkdown, toStoredMarkdown } from '@amadeus-shared/assets'
import { installLocalAssetUrls, localAssetRef, localAssetUrl } from '../../../../mobile/src/amadeus/localAssets'

const BASE = 'https://localhost/_capacitor_file_/data/user/0/com.forsion.tangu/files/vault'
afterEach(() => resetAssetUrlBuilder())

describe('mobile local vault asset URLs', () => {
  it('地址 = 库根 + 按段编码的库内路径;解析是它的逆', () => {
    const cases: Array<[string, string]> = [
      ['.amadeus/pic.png', `${BASE}/.amadeus/pic.png`],
      ['笔记/a b.png', `${BASE}/%E7%AC%94%E8%AE%B0/a%20b.png`],
      ['x/100%.png', `${BASE}/x/100%25.png`],
      ['x/a?b#c.png', `${BASE}/x/a%3Fb%23c.png`],
    ]
    for (const [ref, url] of cases) {
      expect(localAssetUrl(BASE, ref)).toBe(url)
      expect(localAssetRef(BASE, url)).toBe(ref)
    }
  })

  it('显示 ↔ 落盘往返逐字稳定:普通 / 空格 / 括号 / 中文目录', () => {
    installLocalAssetUrls(() => BASE)
    for (const [md, dir] of [['前文\n\n![](.amadeus/pic.png)\n', '笔记'], ['![alt](a%20b.png "t")\n', 'dir'], ['![](export%20%281%29.png)\n', '']] as const) {
      const shown = toDisplayMarkdown(md, dir)
      expect(shown).toContain(`${BASE}/`) // 防空过:显示形是本地文件服务的地址
      expect(shown).not.toMatch(/\]\(\S*[ ()]\S*\.png/) // 目标里没有裸空格 / 裸括号(否则图片语法当场截断)
      expect(toStoredMarkdown(shown, dir)).toBe(md)
    }
  })

  it('⚠️指到页目录之外的引用(../)逐字保留:地址里带着 ..,存回去还是 ../ —— 折叠掉就再也拼不回原文件', () => {
    installLocalAssetUrls(() => BASE)
    const md = '![](../附件/x.png)\n'
    const shown = toDisplayMarkdown(md, '笔记夹')
    expect(shown).toBe(`![](${BASE}/%E7%AC%94%E8%AE%B0%E5%A4%B9/../%E9%99%84%E4%BB%B6/x.png)\n`)
    expect(toStoredMarkdown(shown, '笔记夹')).toBe(md)
  })

  it('逃出库根的引用不给可加载地址(退回默认协议:加载不出,往返照样是好的);解析也不认逃出去的地址', () => {
    expect(localAssetUrl(BASE, '../secret.png')).toBeNull()
    expect(localAssetUrl(BASE, 'a/../../secret.png')).toBeNull()
    expect(localAssetRef(BASE, `${BASE}/../shared_prefs/x.xml`)).toBeNull()
    installLocalAssetUrls(() => BASE)
    const md = '![](../../secret.png)\n'
    const shown = toDisplayMarkdown(md, 'a')
    expect(shown).toContain('amadeus-asset://v/')
    expect(toStoredMarkdown(shown, 'a')).toBe(md)
  })

  it('只认以库根地址开头的:别的本地文件、外链、坏的百分号序列一律不认,逐字不动', () => {
    for (const u of [
      'https://localhost/_capacitor_file_/data/user/0/com.forsion.tangu/files/vaultx/a.png',
      'https://localhost/_capacitor_file_/data/user/0/com.forsion.tangu/files/plugins/a.png',
      'https://example.com/vault/a.png',
      `${BASE}/a%ZZ.png`,
      BASE,
      // 带查询串 / 片段的不是我们构建的(名字里的 ? # 都编码了):认了会把 `a.png?v=1` 当文件名写回去(评审 2026-10-09)
      `${BASE}/dir/a.png?v=1`,
      `${BASE}/dir/a.png#preview`,
    ]) expect(localAssetRef(BASE, u), u).toBeNull()
    installLocalAssetUrls(() => BASE)
    const ext = `![](https://example.com/a.png)\n![](${BASE}/dir/a.png?v=1)\n`
    expect(toStoredMarkdown(ext, 'dir')).toBe(ext)
  })

  it('库根地址还没拿到(开库之前):退回默认协议,往返不坏;拿到之后换成可加载的地址', () => {
    let base = ''
    installLocalAssetUrls(() => base)
    const md = '![](a.png)\n'
    const early = toDisplayMarkdown(md, 'dir')
    expect(early).toBe('![](amadeus-asset://v/dir%2Fa.png)\n')
    base = BASE
    expect(toStoredMarkdown(early, 'dir')).toBe(md) // 早先显示出去的那条,拿到库根之后照样认得回来
    expect(toDisplayMarkdown(md, 'dir')).toBe(`![](${BASE}/dir/a.png)\n`)
  })
})
