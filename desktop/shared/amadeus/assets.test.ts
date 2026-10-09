/** 图片链接的 display ↔ stored 往返(2026-08-27 用户实报「原来的图片文件都无法被引用了」)。
 *
 *  病根:粘贴一张名字带空格的图,编辑器序列化出 `![](amadeus-asset://…)`,这里换回相对路径时
 *  **原样**写下 `![](attachments/a b.png)` —— 而 CommonMark 的链接目标遇空格即止,这不是合法图片。
 *  remark 于是当纯文本读,下一次保存又给 `[`/`(` 加反斜杠 → 盘上永久变成 `!\[]\(…)` 一行死字。
 *  所以本文件钉的是:**写出去的一定是合法 markdown 目标**(空格/括号一律百分号编码)。
 *
 *  ⚠️ 方向很重要:真实链路是 display(协议 URL)→ stored,不是「盘上裸空格 → 盘上」——
 *  裸空格那种压根匹配不上 IMG_RE(见最后一格),那是**存量受损文件**,只能靠修复扫描,别指望这里自愈。 */
import { describe, it, expect } from 'vitest'
import { toDisplayMarkdown, toStoredMarkdown, assetRefs, toAssetUrl, setAssetUrlBuilder } from './assets'

/** 编辑器序列化出来的那一行(PM 的 image 节点 src 就是协议 URL)。 */
const disp = (ref: string): string => `![](${toAssetUrl(ref)})`

describe('图片链接 display → stored(落盘)', () => {
  it('普通文件名原样不动(不给存量文件制造无谓改动)', () => {
    expect(toStoredMarkdown(disp('attachments/pic.png'), '')).toBe('![](attachments/pic.png)')
  })

  it('⚠️名字带空格 → 落盘必须是 %20,绝不许留裸空格', () => {
    const out = toStoredMarkdown(disp('attachments/Screenshot 2026-08-27 at 22.25.59.png'), '')
    expect(out).toBe('![](attachments/Screenshot%202026-08-27%20at%2022.25.59.png)')
    expect(out).not.toMatch(/\]\([^)]* /)
  })

  it('⚠️名字带括号 → 一并编码(`export (1).png` 是真实存量文件名;裸括号会被 IMG_RE 截断)', () => {
    expect(toStoredMarkdown(disp('attachments/export (1).png'), '')).toBe('![](attachments/export%20%281%29.png)')
  })

  it('页目录相对化仍然生效', () => {
    expect(toStoredMarkdown(disp('笔记.fd/attachments/a b.png'), '笔记.fd')).toBe('![](attachments/a%20b.png)')
  })
})

describe('图片链接 stored → display(读盘)', () => {
  it('解码后再拼协议 URL —— 不解码会二次编码,协议侧就找不到文件', () => {
    const out = toDisplayMarkdown('![](attachments/a%20b.png)', '笔记.fd')
    expect(out).toBe(disp('笔记.fd/attachments/a b.png'))
    expect(out).not.toContain('%2520')
  })

  it('外链原样不动', () => {
    const ext = '![封面](https://example.com/a.jpg)'
    expect(toDisplayMarkdown(ext, '')).toBe(ext)
  })

  it('文件名里字面含 % 不许把函数搞崩(decodeURIComponent 遇裸 % 会抛)', () => {
    expect(() => toDisplayMarkdown('![](attachments/100%.png)', '')).not.toThrow()
  })
})

describe('往返稳定 + 账目', () => {
  it('落盘形态再走一圈必须字节稳定(编解码互为逆,不许每次保存都改字节)', () => {
    const stored = '![](attachments/a%20b%20%281%29.png)'
    expect(toStoredMarkdown(toDisplayMarkdown(stored, ''), '')).toBe(stored)
  })

  it('附件账目:媒体时刻锚 `#t=` 不影响独占计数(否则删笔记会漏算/错删)', () => {
    expect(assetRefs('![[lecture.mp4#t=95]]')).toEqual(['lecture.mp4'])
    expect(assetRefs('[[lecture.mp4#t=95|01:35]]')).toEqual(['lecture.mp4'])
    expect(assetRefs('[01:35](lecture.mp4#t=95)')).toEqual(['lecture.mp4'])
    // 同一份素材被多条时间戳引用 → 仍只算一条,不重复计数
    expect(assetRefs('![[a.m4a]] [[a.m4a#t=10|00:10]] [[a.m4a#t=20|00:20]]')).toEqual(['a.m4a'])
  })

  it('附件账目:`![[https://…]]` 网页嵌入不是 vault 附件(别把外链算进删除计数)', () => {
    expect(assetRefs('![[https://example.com/page]]')).toEqual([])
    expect(assetRefs('![[https://example.com/a.mp4]]')).toEqual([])
  })

  it('附件账目(assetRefs)认得编码过的引用 —— 否则删笔记时会漏算独占附件', () => {
    expect(assetRefs('![](attachments/a%20b.png)')).toEqual(['attachments/a b.png'])
  })

  it('⚠️已经写坏的存量文件(目标里裸空格)本层修不了 —— 匹配不上 IMG_RE,只能靠修复扫描', () => {
    const damaged = '![](attachments/a b.png)'
    expect(toDisplayMarkdown(damaged, '')).toBe(damaged) // 原样穿过 = 之后仍会被 remark 当文本转义
  })
})

// I-15(评审 2026-09-27 P1):代码块 / 行内代码里的 `![](路径)` 被当资源引用改写 —— 显示成协议地址、复制代码拿到
// 内部地址,落盘按解码→编码不对称写回(`%E5%9B%BE` → `图`、`<a.png>` → `%3Ca.png%3E`)。
// 真浏览器那一半:评审探针 verify-inline-3/v15-codeasset.cjs / v15b.cjs。
// 负对照:toDisplayMarkdown 改回全文 `md.replace(IMG_RE, …)` → 「代码逐字」两格红。
describe('代码里的图片语法逐字(I-15)', () => {
  const CODE = '写法:`![图](img/a.png)` 即可\n\n```md\n![截图](shots/b%20c.png)\n![编码](%E5%9B%BE.png)\n![尖](<a.png>)\n```\n\n末段\n'

  it('围栏代码与行内代码:显示侧不换成协议 URL', () => {
    const d = toDisplayMarkdown(CODE, 'notes')
    expect(d).toBe(CODE)
    expect(d).not.toContain('amadeus-asset')
  })

  it('往返逐字(display → stored)', () => {
    expect(toStoredMarkdown(toDisplayMarkdown(CODE, 'notes'), 'notes')).toBe(CODE)
    // 列表项里的围栏(编辑器把列表首个代码块写成 `* ```…`)同样跳过
    const listFence = '* ```md\n  ![x](%E5%9B%BE.png)\n  ```\n'
    expect(toStoredMarkdown(toDisplayMarkdown(listFence, ''), '')).toBe(listFence)
  })

  it('代码外照常换;同一行里代码内外各一个只换外面那个', () => {
    const d = toDisplayMarkdown('![a](x.png) 与 `![b](y.png)`\n', '')
    expect(d).toBe(`![a](${toAssetUrl('x.png')}) 与 \`![b](y.png)\`\n`)
  })

  it('代码外的尖括号目标:括号是语法 —— 显示解析到真文件,落盘写成合法的百分号形态', () => {
    const d = toDisplayMarkdown('![尖](<a.png>)\n\n![空](<a b.png> "t")\n', 'n')
    expect(d).toBe(`![尖](${toAssetUrl('n/a.png')})\n\n![空](${toAssetUrl('n/a b.png')} "t")\n`)
    expect(toStoredMarkdown(d, 'n')).toBe('![尖](a.png)\n\n![空](a%20b.png "t")\n')
    expect(toDisplayMarkdown('![](<>)\n', '')).toBe('![](<>)\n') // 空目标不碰
    expect(toDisplayMarkdown('![](<https://x.y/a b.png>)\n', '')).toBe('![](<https://x.y/a b.png>)\n') // 外链不碰
  })

  it('落盘侧仍是全文安全网:代码里残留的协议 URL 也换回相对路径,绝不漏到盘上', () => {
    expect(toStoredMarkdown('```\n' + disp('a.png') + '\n```\n', '')).toBe('```\n![](a.png)\n```\n')
  })
})

/** ⚠️ 已知缺陷的钉子(2026-10-09 实证,**尚未修**)。显示地址的构建器可以换(setAssetUrlBuilder:云端库 / 设备网页版
 *  都换成带资源令牌的 http 地址),但落盘侧的还原(fromAssetUrl)只认默认的 `amadeus-asset://v/` 前缀 ——
 *  换了构建器之后,编辑器一存盘就把 `![](.amadeus/pic.png)` 写成 `![](https://…/asset?ref=…&at=<令牌>)`:
 *  令牌过期图片就失联,同步到别的设备是一条外链而不是附件。整条链(真编辑器、真存盘)在 mobile 的
 *  `npm run e2e:localasset` 场景 B / C。
 *  用 it.fails 钉住现状:修好之后这一格会变红 —— 那时把 .fails 去掉,它就是修法的验收。 */
describe('换了显示地址的构建器之后的往返(已知缺陷,未修)', () => {
  it.fails('云端形态的构建器:display → stored 必须还原成页相对路径', () => {
    const md = '前文\n\n![](.amadeus/pic.png)\n'
    setAssetUrlBuilder((ref) => `https://api.example/api/amadeus/vaults/v1/asset?ref=${encodeURIComponent(ref)}&at=TOKEN`)
    try {
      expect(toStoredMarkdown(toDisplayMarkdown(md, 'dir'), 'dir')).toBe(md)
    } finally {
      setAssetUrlBuilder((ref) => `amadeus-asset://v/${encodeURIComponent(ref)}`) // 还原成默认构建器,别带坏后面的用例
    }
  })
})
