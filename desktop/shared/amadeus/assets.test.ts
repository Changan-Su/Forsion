/** 图片链接的 display ↔ stored 往返(2026-08-27 用户实报「原来的图片文件都无法被引用了」)。
 *
 *  病根:粘贴一张名字带空格的图,编辑器序列化出 `![](amadeus-asset://…)`,这里换回相对路径时
 *  **原样**写下 `![](attachments/a b.png)` —— 而 CommonMark 的链接目标遇空格即止,这不是合法图片。
 *  remark 于是当纯文本读,下一次保存又给 `[`/`(` 加反斜杠 → 盘上永久变成 `!\[]\(…)` 一行死字。
 *  所以本文件钉的是:**写出去的一定是合法 markdown 目标**(空格/括号一律百分号编码)。
 *
 *  ⚠️ 方向很重要:真实链路是 display(协议 URL)→ stored,不是「盘上裸空格 → 盘上」——
 *  裸空格那种压根匹配不上 IMG_RE(见最后一格),那是**存量受损文件**,只能靠修复扫描,别指望这里自愈。 */
import { afterEach, describe, it, expect } from 'vitest'
import { toDisplayMarkdown, toStoredMarkdown, assetRefs, toAssetUrl, setAssetUrlBuilder, resetAssetUrlBuilder, fromAssetUrl, fromDefaultAssetUrl, joinRel, relFrom, normPath, rebaseFileRefs } from './assets'

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

describe('toDisplayMarkdown 对盘上已经是显示地址的图片', () => {
  afterEach(() => resetAssetUrlBuilder())
  it('桌面(没装解析器):外链逐字不动 —— 云端 / 设备网页版写坏的地址在桌面上认不出;盘上的默认协议地址重拼后还是它自己', () => {
    const md = '![](https://api.example/api/amadeus/vaults/v1/asset?ref=a.png&at=T)\n![](amadeus-asset://v/dir%2Fa%20b.png)\n'
    expect(toDisplayMarkdown(md, 'dir')).toBe(md)
  })
  it('默认协议的字面地址一律逐字不动(带查询串的、尖括号里的、不规范编码的):重拼会把 ?v=1 编进文件名、把尖括号拆掉', () => {
    const md = '![](amadeus-asset://v/dir%2Fx.png?v=1)\n![](<amadeus-asset://v/attachments%2Fx.png>)\n![](amadeus-asset://v/dir/x.png)\n'
    expect(toDisplayMarkdown(md, 'notes')).toBe(md)
    setAssetUrlBuilder((ref) => `https://h.example/f?ref=${encodeURIComponent(ref)}`, () => null)
    expect(toDisplayMarkdown(md, 'notes')).toBe(md) // 换了构建器的宿主上也不动
  })
  it('装了解析器:认得出的重拼成当前的显示地址,认不出的外链不动', () => {
    setAssetUrlBuilder((ref) => `https://h.example/f?ref=${encodeURIComponent(ref)}&at=NEW`, (url) => (url.startsWith('https://h.example/f?') ? new URLSearchParams(url.split('?')[1]).get('ref') : null))
    expect(toDisplayMarkdown('![](https://h.example/f?ref=dir%2Fa.png&at=OLD)\n![](https://example.com/x.png)\n', 'dir'))
      .toBe('![](https://h.example/f?ref=dir%2Fa.png&at=NEW)\n![](https://example.com/x.png)\n')
  })
})

describe('fromDefaultAssetUrl:只认默认协议,不问装上的解析器(删文件那条路用它)', () => {
  afterEach(() => resetAssetUrlBuilder())
  it('装了解析器:解析器认得的地址 fromAssetUrl 认、fromDefaultAssetUrl 不认;默认协议两边都认', () => {
    setAssetUrlBuilder((ref) => `https://h.example/f?ref=${encodeURIComponent(ref)}`, (url) => new URLSearchParams(url.split('?')[1] ?? '').get('ref'))
    const url = 'https://h.example/f?ref=dir%2Fa.png'
    expect(fromAssetUrl(url)).toBe('dir/a.png')
    expect(fromDefaultAssetUrl(url)).toBeNull()
    expect(fromDefaultAssetUrl('amadeus-asset://v/dir%2Fa.png')).toBe('dir/a.png')
    expect(fromDefaultAssetUrl('amadeus-asset://v/%ZZ')).toBeNull()
  })
})

/** 换了显示地址的构建器之后的往返(2026-10-09 事故)。接缝此前只有去程(setAssetUrlBuilder)没有回程:
 *  云端库 / 设备网页版把显示地址换成带资源令牌的 http 地址,落盘侧的还原却只认默认的 `amadeus-asset://v/` 前缀 ——
 *  编辑器一存盘就把 `![](.amadeus/pic.png)` 写成 `![](https://…/asset?ref=…&at=<令牌>)`,令牌过期图片失联。
 *  现在是成对的「构建 + 解析」。真云桥那一对的往返在 frontend/src/services/cloudAssetsRoundtrip.test.ts;
 *  整条链(真编辑器、真存盘)在 mobile 的 `npm run e2e:localasset`。
 *  负对照(实跑过):fromAssetUrl 里去掉「问装上的解析器」那一段 → 本组前两格红。 */
describe('换了显示地址的构建器之后的往返', () => {
  const BASE = 'https://host.example/files?ref='
  const install = (): void => setAssetUrlBuilder(
    (ref) => `${BASE}${encodeURIComponent(ref)}&at=TOKEN`,
    (url) => (url.startsWith(BASE) ? new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('ref') : null),
  )
  afterEach(() => resetAssetUrlBuilder())

  it('display → stored 还原成页相对路径,三种文件名逐字稳定(普通 / 空格 / 括号)', () => {
    install()
    for (const md of ['前文\n\n![](.amadeus/pic.png)\n', '![alt](a%20b.png "t")\n', '![](export%20%281%29.png)\n']) {
      const shown = toDisplayMarkdown(md, 'dir')
      expect(shown).toContain(BASE) // 防空过:显示形确实换成了注入的地址
      expect(toStoredMarkdown(shown, 'dir')).toBe(md)
    }
  })

  it('图片与文字同段时编辑器会把目标里的 & 写成 \\&:照样认得回来', () => {
    install()
    const shown = `![](${BASE}dir%2F.amadeus%2Fpic.png\\&at=TOKEN) 后面有字\n`
    expect(toStoredMarkdown(shown, 'dir')).toBe('![](.amadeus/pic.png) 后面有字\n')
  })

  it('换了构建器的宿主上,残留的默认协议地址照样还原(先认默认前缀,再问解析器)', () => {
    install()
    expect(toStoredMarkdown('![](amadeus-asset://v/dir%2Fa.png)\n', 'dir')).toBe('![](a.png)\n')
  })

  it('解析器不认的地址逐字不动(真正的外链不许被「还原」成库内路径);解析器抛错 = 不认', () => {
    install()
    const ext = '![](https://evil.example/files?ref=z.png)\n![](https://host.example/other?ref=z.png)\n'
    expect(toStoredMarkdown(ext, 'dir')).toBe(ext)
    setAssetUrlBuilder((ref) => `${BASE}${ref}`, () => { throw new Error('boom') })
    expect(toStoredMarkdown(`![](${BASE}x.png)\n`, 'dir')).toBe(`![](${BASE}x.png)\n`)
  })

  it('只装构建不给解析(只读宿主)= 旧行为:地址原样留着;resetAssetUrlBuilder 换回默认的那一对', () => {
    setAssetUrlBuilder((ref) => `${BASE}${encodeURIComponent(ref)}`)
    const shown = toDisplayMarkdown('![](a.png)\n', '')
    expect(toStoredMarkdown(shown, '')).toBe(shown)
    resetAssetUrlBuilder()
    expect(toDisplayMarkdown('![](a.png)\n', '')).toBe('![](amadeus-asset://v/a.png)\n')
  })
})

/** 页目录之外的引用(2026-10-10)。此前 relFrom 只会去掉「页目录/」前缀,引用不在页目录之下时原样返回库内路径 ——
 *  笔记在 notes/、图片在库根 attachments/(从别的文件夹复制 / 搬块过来的图就是这样)存成 `![](attachments/x.png)`,
 *  而重开时一律按页相对拼成 notes/attachments/x.png:三端都取不到(桌面的协议处理器对带路径的地址没有兜底,
 *  electron/amadeus/assetProtocol.test.ts 钉着),那里恰好有同路径的文件时显示的还是另一张图。
 *  现在 relFrom 是 joinRel 的真逆:页目录之外写成 `../…`(附件放固定文件夹时产品本来就这么写,attachmentPaths 的 pageRel)。
 *  负对照(实跑过):relFrom 改回只去前缀 → 本组第 1 / 3 / 4 / 5 格红。 */
describe('页目录之外的引用:存盘写成 ../,重开指回同一个文件', () => {
  /** 落盘的那一行在 pageDir 这篇笔记里重开后指向的库内路径(`.` / `..` 按词法折叠,各宿主取文件时都是这么折的)。 */
  const reopened = (stored: string, pageDir: string): string =>
    normPath(fromAssetUrl(/\]\(([^)\s]+)/.exec(toDisplayMarkdown(stored, pageDir))![1])!)

  it('relFrom 是 joinRel 的逆;库根的笔记(页目录为空)照旧原样', () => {
    expect(relFrom('notes', 'attachments/x.png')).toBe('../attachments/x.png')
    expect(relFrom('notes/sub', 'notes/x.png')).toBe('../x.png')
    expect(relFrom('a/b/c', 'x.png')).toBe('../../../x.png')
    expect(relFrom('notes', 'notes2/x.png')).toBe('../notes2/x.png') // 只是名字有相同前缀,不算在页目录之下
    expect(relFrom('', 'attachments/x.png')).toBe('attachments/x.png')
    expect(relFrom('notes', 'notes/.amadeus/x.png')).toBe('.amadeus/x.png')
    for (const [dir, ref] of [['notes', 'attachments/x.png'], ['notes/sub', 'notes/x.png'], ['a/b', 'a/c/d/x.png'], ['a/b/c', 'x.png'], ['笔记 夹', '附件/a b.png']]) {
      expect(normPath(joinRel(dir, relFrom(dir, ref))), `${dir} ← ${ref}`).toBe(ref)
    }
  })

  it('页目录之下的逐字不动:盘上本来的 ./ 、../ 、中途的 .. 不被改写', () => {
    for (const md of ['![](./x.png)\n', '![](../x.png)\n', '![](sub/../x.png)\n', '![](../notes/x.png)\n', '![](../../out.png)\n', '![](../assets/a%20b.png "t")\n']) {
      expect(toStoredMarkdown(toDisplayMarkdown(md, 'notes'), 'notes'), md).toBe(md)
    }
  })

  it('⚠️从别的文件夹贴 / 搬进来的图:写成 ../,重开指回同一个文件;再存一遍字节稳定', () => {
    const stored = toStoredMarkdown(disp('attachments/a b.png'), 'notes')
    expect(stored).toBe('![](../attachments/a%20b.png)')
    expect(reopened(stored, 'notes')).toBe('attachments/a b.png')
    expect(toStoredMarkdown(toDisplayMarkdown(stored, 'notes'), 'notes')).toBe(stored)
    // 更深一层、兄弟目录
    expect(toStoredMarkdown(disp('a/c/x.png'), 'a/b/n')).toBe('![](../../c/x.png)')
    expect(reopened('![](../../c/x.png)', 'a/b/n')).toBe('a/c/x.png')
  })

  it('显示地址里带着没折叠的 ..(原笔记里就是 ../ 写法)贴到别的文件夹:先折叠再算,不写出 ../other/../ 这种', () => {
    const src = /\]\(([^)\s]+)/.exec(toDisplayMarkdown('![](../assets/x.png)', 'other'))![1] // 在 other/ 下的笔记里它的显示地址
    const stored = toStoredMarkdown(`![](${src})`, 'notes/sub')
    expect(stored).toBe('![](../../assets/x.png)')
    expect(reopened(stored, 'notes/sub')).toBe('assets/x.png')
  })

  it('折叠后逃出库根的地址:照算相对路径,不会变成指向库内的另一个文件', () => {
    const stored = toStoredMarkdown(disp('../x.png'), 'notes') // 手写的默认协议地址才会有这种
    expect(stored).toBe('![](../../x.png)')
    expect(reopened(stored, 'notes')).toBe('../x.png')
  })

  it('已经存成库内路径写法的存量笔记不自愈:重开仍按页相对拼,存回去字节不变(修不了,也不改写)', () => {
    const md = '![](attachments/x.png)\n'
    expect(reopened(md, 'notes')).toBe('notes/attachments/x.png')
    expect(toStoredMarkdown(toDisplayMarkdown(md, 'notes'), 'notes')).toBe(md)
  })
})

/** 挪笔记 / 挪文件夹之后的引用重算(rebaseFileRefs,2026-10-10)。宿主接线后的真链路在
 *  electron/amadeus/ipc.moveFileRefs.test.ts 与 desktop 的 npm run e2e:notemove;这里钉纯函数的规则。
 *  「评审」那几格是 Codex 聚焦评审(2026-10-10)逐条复现过的输入,第一版在这些输入上会把引用改指另一个文件。
 *  负对照(实跑过)写在各格的注里。 */
describe('挪了位置之后的引用(rebaseFileRefs)', () => {
  const still = (f: string): string => f // 没有文件换位置
  const disk = (...paths: string[]) => (f: string): boolean => paths.includes(f)
  const under = (from: string, to: string) => (f: string): string => (f.startsWith(`${from}/`) ? to + f.slice(from.length) : f)

  it('挪单篇笔记:页目录下的、页目录外的都改成从新位置指过去;同深度的 ../ 写法本来就对,不动;挪回去正文回到原样', async () => {
    const md = '![](.amadeus/p.png)\n![x](../assets/x%20y.png "t")\n[doc](attachments/d.pdf)\n'
    const has = disk('notes/.amadeus/p.png', 'assets/x y.png', 'notes/attachments/d.pdf')
    const moved = '![](../notes/.amadeus/p.png)\n![x](../assets/x%20y.png "t")\n[doc](../notes/attachments/d.pdf)\n'
    expect(await rebaseFileRefs(md, 'notes/a.md', 'other/a.md', still, has)).toBe(moved)
    expect(await rebaseFileRefs(md, 'notes/a.md', 'a.md', still, has))
      .toBe('![](notes/.amadeus/p.png)\n![x](assets/x%20y.png "t")\n[doc](notes/attachments/d.pdf)\n')
    expect(await rebaseFileRefs(md, 'notes/a.md', 'deep/er/a.md', still, has))
      .toBe('![](../../notes/.amadeus/p.png)\n![x](../../assets/x%20y.png "t")\n[doc](../../notes/attachments/d.pdf)\n')
    // 负对照:去掉「绕出页目录再回来的换回规范写法」→ 下面这句红(留着 ../notes/.amadeus/p.png)
    expect(await rebaseFileRefs(moved, 'other/a.md', 'notes/a.md', still, has)).toBe(md)
  })

  it('断的保持断:原先就指不到文件的引用不改(存量的库内路径写法靠「退回库根」还打得开,改了反而打不开)', async () => {
    // 负对照:exists 恒真 → 红
    const md = '![](attachments/x.png) [gone](sub/nope.pdf)\n'
    expect(await rebaseFileRefs(md, 'notes/a.md', 'other/a.md', still, disk('attachments/x.png'))).toBe(md)
  })

  it('不碰的:围栏代码块、行内代码、外链 / 协议 / 绝对路径 / 纯锚点、尖括号目标、指到库外的、转义的 \\[、`![[…]]`', async () => {
    // 负对照:去掉围栏的跳过 → 红(~~~ 那一块;``` 那块还有「没配上对的反引号」兜着);不查 `[` 前的反斜杠 → 红
    const md = [
      '```md', '![](p.png)', '```',
      '~~~', '', '![](p.png)', '~~~',
      '行内 `![](p.png)` 是代码',
      '![](https://e.com/p.png) ![](data:image/png;base64,AA) ![](/p.png) [t](#p.png) [m](mailto:a@p.png)',
      '![](<p.png>) ![](../../p.png) ![[p.png]] \\[不是链接](./p.png) !\\[不是图](p.png)',
    ].join('\n')
    expect(await rebaseFileRefs(md, 'notes/a.md', 'other/a.md', still, () => true)).toBe(md)
  })

  it('笔记没挪、它引用的文件也没挪:一个字节不变(手写的 ./、多余的 .. 都留着),连问都不问宿主', async () => {
    // 负对照:去掉「没挪就不碰」→ 红
    const md = '![](./p.png) ![](sub/../p.png) ![](p.png)\n'
    let asked = 0
    expect(await rebaseFileRefs(md, 'notes/a.md', 'notes/a2.md', still, () => { asked++; return true })).toBe(md)
    expect(asked).toBe(0)
  })

  it('只管附件:指向笔记的 `[名](x.md)`、没有扩展名的不归这里', async () => {
    // 负对照:`.md` 目标不跳过 → 红
    const md = '[n](sub/x.md) [n](sub/x) [w](sub/draw.excalidraw.md)\n'
    expect(await rebaseFileRefs(md, 'notes/a.md', 'other/a.md', still, () => true)).toBe(md)
  })

  it('挪文件夹:夹内互相引用的不变(手写的 ./ 也不变);指向夹外的按新深度重算;夹外的笔记指进来的跟着走', async () => {
    const moved = under('notes', 'archive/notes')
    // 负对照:改回「挪动的笔记里一律写成规范形态」→ 红(./q.png 被改成 q.png)
    const has = disk('archive/notes/.amadeus/p.png', 'archive/notes/d.pdf', 'archive/notes/q.png', 'assets/x.png')
    expect(await rebaseFileRefs('![](.amadeus/p.png) [d](./d.pdf) ![](./q.png) ![](../assets/x.png)', 'notes/a.md', 'archive/notes/a.md', moved, has))
      .toBe('![](.amadeus/p.png) [d](./d.pdf) ![](./q.png) ![](../../assets/x.png)')
    expect(await rebaseFileRefs('![](notes/.amadeus/p.png)', 'root.md', 'root.md', moved, has)).toBe('![](archive/notes/.amadeus/p.png)')
    // 上一次挪单篇留下的 ../notes/… 写法,文件夹改名时照样跟上
    expect(await rebaseFileRefs('![](../notes/.amadeus/p.png)', 'other/a.md', 'other/a.md', under('notes', 'old'), disk('old/.amadeus/p.png')))
      .toBe('![](../old/.amadeus/p.png)')
  })

  it('CRLF 的行尾、Windows 分隔符的笔记路径', async () => {
    expect(await rebaseFileRefs('![](p.png)\r\n后文\r\n', 'notes\\a.md', 'other\\a.md', still, disk('notes/p.png'))).toBe('![](../notes/p.png)\r\n后文\r\n')
  })

  it('评审 1:链接里的单段文件名按文件名全库找,不是页相对 —— 不碰;改写结果也不许变成单段文件名 / 形似域名', async () => {
    // 负对照:去掉对链接的「形似域名」两处判断 → 红
    const has = disk('notes/d.pdf', 'a/d.pdf', 'archive/d.pdf', 'my.dir/d.pdf', 'notes/p.png')
    // 文件夹改名:`./d.pdf` 仍指着夹里那份 —— 不动(改成 d.pdf 会按文件名全库找,先命中 a/d.pdf)
    expect(await rebaseFileRefs('[doc](./d.pdf)', 'notes/n.md', 'archive/n.md', under('notes', 'archive'), has)).toBe('[doc](./d.pdf)')
    // 挪单篇:原来就是单段文件名的链接不动(它本来就不看位置);图片的单段文件名是页相对的,要改
    expect(await rebaseFileRefs('[doc](d.pdf) ![](p.png)', 'notes/n.md', 'other/n.md', still, has)).toBe('[doc](d.pdf) ![](../notes/p.png)')
    // 挪进文件所在的文件夹:规范写法是单段文件名 → 链接补 ./,图片不用
    expect(await rebaseFileRefs('[doc](../a/d.pdf) ![](../a/d.pdf)', 'notes/n.md', 'a/n.md', still, has)).toBe('[doc](./d.pdf) ![](d.pdf)')
    // 挪到库根,第一段带点:不补 ./ 会被当成域名补上 https://
    expect(await rebaseFileRefs('[doc](../my.dir/d.pdf)', 'notes/n.md', 'n.md', still, has)).toBe('[doc](./my.dir/d.pdf)')
    // 原文就形似域名的链接(点击时走外链):不接手
    expect(await rebaseFileRefs('[x](my.dir/d.pdf)', 'n.md', 'notes/n.md', still, has)).toBe('[x](my.dir/d.pdf)')
  })

  it('评审 2:没变的那几段连同原来的编码原样留下(%2520、%23、%E5…);新拼上去的目录名编码得还原得回来', async () => {
    // 负对照:改回「整条解码再 encodeDest」→ 红
    const has = disk('notes/p%20.png', 'notes/d#v.pdf', 'notes/图.png', 'a%20b #c/x.png')
    expect(await rebaseFileRefs('![](p%2520.png)', 'notes/n.md', 'other/n.md', still, has)).toBe('![](../notes/p%2520.png)')
    expect(await rebaseFileRefs('[doc](./d%23v.pdf)', 'notes/n.md', 'other/n.md', still, has)).toBe('[doc](../notes/d%23v.pdf)')
    expect(await rebaseFileRefs('![](%E5%9B%BE.png)', 'notes/n.md', 'other/n.md', still, has)).toBe('![](../notes/%E5%9B%BE.png)')
    // 目录名里有 % # 空格:写出去的地址解码回来必须还是它(图片从 a%20b #c/ 下的笔记挪到库根)
    const out = await rebaseFileRefs('![](x.png)', 'a%20b #c/n.md', 'n.md', still, has)
    expect(out).toBe('![](a%2520b%20%23c/x.png)')
    expect(decodeURIComponent(/\]\(([^)]+)\)/.exec(out)![1])).toBe('a%20b #c/x.png')
  })

  it('评审 3 / 5:认不准的地址不碰 —— 裸括号(截断了会认成另一个文件)、解码后带反斜杠的段', async () => {
    // 负对照:去掉 `dest.includes("(")` → 第一句红;去掉「解码后带 \\ 或 / 的段」→ 第二句红
    const moved = under('notes', 'archive')
    expect(await rebaseFileRefs('[doc](../x/a(b.pdf).pdf)', 'notes/n.md', 'archive/sub/n.md', still, () => true)).toBe('[doc](../x/a(b.pdf).pdf)')
    expect(await rebaseFileRefs('[doc](../x/a%5Cb.pdf)', 'notes/n.md', 'deep/er/n.md', moved, () => true)).toBe('[doc](../x/a%5Cb.pdf)')
  })

  it('评审 4:比对交换写冲突后的重试(trustWorking)—— 现文里已经按新位置写对的引用不再拿旧目录解释一遍;还断着的照修', async () => {
    // 负对照:重试时不带 trustWorking → 第一句红(改指库根的另一张图)
    const has = disk('notes/.amadeus/p.png', '.amadeus/p.png', 'notes/q.png')
    const written = '![](../.amadeus/p.png)\nnew text\n![](q.png)\n' // 别的写者按 notes/deep/ 存的:第一张已经指对,第三行还是老写法
    expect(await rebaseFileRefs(written, 'notes/a.md', 'notes/deep/a.md', still, has, { trustWorking: true }))
      .toBe('![](../.amadeus/p.png)\nnew text\n![](../q.png)\n')
    // 第一遍(知道正文是按旧目录写的)照规矩来:同一行会被改
    expect(await rebaseFileRefs('![](../.amadeus/p.png)', 'notes/a.md', 'notes/deep/a.md', still, has)).toBe('![](../../.amadeus/p.png)')
  })

  it('评审 6:跨行的行内代码 —— 一段里有没配上对的反引号,到下一个空行为止整段不碰;空行之后照常', async () => {
    // 负对照:去掉这条「整段跳过」→ 红
    const md = '`example\n[doc](../assets/d.pdf)\nend`\n\n[doc](../assets/d.pdf)\n'
    expect(await rebaseFileRefs(md, 'notes/n.md', 'deep/er/n.md', still, disk('assets/d.pdf')))
      .toBe('`example\n[doc](../assets/d.pdf)\nend`\n\n[doc](../../assets/d.pdf)\n')
  })

  it('评审 7:失配的超长行不拖成平方级(30 万字的一行,第一版 12 秒)', async () => {
    // 负对照:地址长度不封顶 → 第二条输入超时
    for (const line of ['[a '.repeat(100000) + '](<x.png>)', '[](a'.repeat(80000), '](x.png) '.repeat(60000) + '[']) {
      const t0 = Date.now()
      expect(await rebaseFileRefs(line, 'notes/n.md', 'other/n.md', still, () => true)).toBe(line)
      expect(Date.now() - t0).toBeLessThan(1500)
    }
  })

  it('链接的 #锚 原样接回;图片地址里的 # 是文件名的一部分', async () => {
    // 负对照:链接不拆 # → 第一句红
    const has = disk('notes/sub/d.pdf', 'notes/c#1.png')
    expect(await rebaseFileRefs('[p3](sub/d.pdf#page=3)', 'notes/n.md', 'x/n.md', still, has)).toBe('[p3](../notes/sub/d.pdf#page=3)')
    expect(await rebaseFileRefs('![](c#1.png)', 'notes/n.md', 'x/n.md', still, has)).toBe('![](../notes/c#1.png)')
  })

  it('一行多条、图片套在链接里:各改各的', async () => {
    const has = disk('notes/a.png', 'notes/sub/b.pdf')
    expect(await rebaseFileRefs('前 ![a](a.png) 中 [b](sub/b.pdf "标题") 后 [![a](a.png)](sub/b.pdf)', 'notes/n.md', 'other/n.md', still, has))
      .toBe('前 ![a](../notes/a.png) 中 [b](../notes/sub/b.pdf "标题") 后 [![a](../notes/a.png)](sub/b.pdf)')
  })
})
