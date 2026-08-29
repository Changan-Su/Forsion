import { describe, expect, it } from 'vitest'
import { noteRefInsert, remarkWiki, splitWiki, wikiLabel } from './wikiChat'
import { parsePdfLinkInner } from '@amadeus-shared/pdfLink'

describe('noteRefInsert ↔ splitWiki 往返契约(Composer 插入 → 气泡渲染)', () => {
  it('插入 [[绝对路径|名字]],切分后 label=名字、target=绝对路径', () => {
    const ins = noteRefInsert('/Users/x/vault', 'dir/我的 笔记.md')
    expect(ins).toBe('[[/Users/x/vault/dir/我的 笔记.md|我的 笔记]] ')
    const [p] = splitWiki(ins.trim())
    expect(p.wiki?.label).toBe('我的 笔记')
    expect(p.wiki?.target).toBe('/Users/x/vault/dir/我的 笔记.md')
  })
})

describe('splitWiki', () => {
  it('无双链 → 单段原文', () => {
    expect(splitWiki('plain text')).toEqual([{ text: 'plain text' }])
  })
  it('切出双链并保留前后文', () => {
    const p = splitWiki('见 [[Note]] 和 [[b/Two|二]]。')
    expect(p.map((x) => x.text)).toEqual(['见 ', '[[Note]]', ' 和 ', '[[b/Two|二]]', '。'])
    expect(p[1].wiki).toEqual({ inner: 'Note', label: 'Note', target: 'Note' })
    expect(p[3].wiki).toEqual({ inner: 'b/Two|二', label: '二', target: 'b/Two' })
  })
  it('⚠️Composer 契约:[[绝对路径|名字]] → 显示名字、target=路径(agent 读路径,气泡只见名字)', () => {
    const [p] = splitWiki('[[/Users/x/vault/dir/Note.md|Note]]')
    expect(p.wiki).toEqual({ inner: '/Users/x/vault/dir/Note.md|Note', label: 'Note', target: '/Users/x/vault/dir/Note.md' })
  })
  it('label 回退:空 alias 用整段内文;#heading 不进 target', () => {
    expect(wikiLabel('Name|')).toBe('Name|')
    const [p] = splitWiki('[[Name#h2]]')
    expect(p.wiki?.target).toBe('Name')
  })
})

describe('remarkWiki', () => {
  const run = (tree: any) => {
    remarkWiki()(tree)
    return tree
  }
  it('text 节点里的 [[x]] → link(#wiki=inner)', () => {
    const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: '看 [[A|甲]] 吧' }] }] }
    const kids = run(tree).children[0].children
    expect(kids.map((k: any) => k.type)).toEqual(['text', 'link', 'text'])
    expect(kids[1].url).toBe('#wiki=' + encodeURIComponent('A|甲'))
    expect(kids[1].children[0].value).toBe('甲')
  })
  it('⚠️code/inlineCode 一字不动(代码里的 [[ ]] 是字面量,变链接=毁示例)', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'code', value: 'x = [[1]]' },
        { type: 'paragraph', children: [{ type: 'inlineCode', value: '[[y]]' }] },
      ],
    }
    const out = run(tree)
    expect(out.children[0].value).toBe('x = [[1]]')
    expect(out.children[1].children[0]).toEqual({ type: 'inlineCode', value: '[[y]]' })
  })
})

describe('PDF 引用 [[书.pdf#page=N]](read_document 教 agent 写的引用形态)', () => {
  it('subpath 带 & 也照样切成双链——正则挡下就等于引用条永不出现', () => {
    const [p] = splitWiki('[[book.pdf#page=18&annot=x]]')
    expect(p.wiki?.inner).toBe('book.pdf#page=18&annot=x')
    expect(parsePdfLinkInner(p.wiki!.inner)).toEqual({ target: 'book.pdf', loc: { page: 18, annot: 'x' } })
  })
  it('⚠️target/linkTarget 砍掉 #page=,页码只能从原始 inner 取', () => {
    const [p] = splitWiki('[[book.pdf#page=18]]')
    expect(p.wiki?.target).toBe('book.pdf') // 页码已丢
    expect(parsePdfLinkInner(p.wiki!.inner)?.loc?.page).toBe(18)
  })
  it('remarkWiki 把它变成 #wiki= 链接(Markdown.tsx 据此挂 ChatWikiLink)', () => {
    const tree: any = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: '见 [[book.pdf#page=18]]' }] }] }
    remarkWiki()(tree)
    const link = tree.children[0].children[1]
    expect(link.type).toBe('link')
    expect(decodeURIComponent(link.url.slice('#wiki='.length))).toBe('book.pdf#page=18')
  })
})

describe('PDF 引用的单括号兜底(模型写丢一层括号)', () => {
  it('`【[/abs/书.pdf#page=32]】` 照样切成引用', () => {
    const p = splitWiki('见【[/Users/x/Downloads/书 (2020).pdf#page=32]】。')
    expect(p.map((x) => x.text)).toEqual(['见【', '[/Users/x/Downloads/书 (2020).pdf#page=32]', '】。'])
    expect(p[1].wiki?.inner).toBe('/Users/x/Downloads/书 (2020).pdf#page=32')
  })
  it('双括号仍走原路,不被兜底那条抢去半截', () => {
    const [p] = splitWiki('[[资料/研究.pdf#page=8]]')
    expect(p.wiki?.inner).toBe('资料/研究.pdf#page=8')
  })
  it('同一段里两种形态并存都认', () => {
    const p = splitWiki('A [[a.pdf#page=1]] B [/b.pdf#page=2] C').filter((x) => x.wiki)
    expect(p.map((x) => x.wiki!.inner)).toEqual(['a.pdf#page=1', '/b.pdf#page=2'])
  })
  it('形态不像 PDF 定位的普通方括号不动它', () => {
    for (const t of ['见[表 1]', '[a.pdf] 没页码', '[a.pdf#page=x]', '[脚注][1]']) {
      expect(splitWiki(t).some((x) => x.wiki)).toBe(false)
    }
  })
  it('remarkWiki 也吃单括号形态', () => {
    const tree: any = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: '见 [/x/书.pdf#page=7]' }] }] }
    remarkWiki()(tree)
    expect(tree.children[0].children[1].type).toBe('link')
  })
})

describe('行号引用的单括号兜底(锚点是长路径,模型会写丢一层括号)', () => {
  it('`[src/a.ts#L42]` 与绝对路径范围形态都切成引用', () => {
    const p = splitWiki('见 [src/lib/a.ts#L42] 与 [/Users/x/proj/b.py#L7-L9]。').filter((x) => x.wiki)
    expect(p.map((x) => x.wiki!.inner)).toEqual(['src/lib/a.ts#L42', '/Users/x/proj/b.py#L7-L9'])
  })
  it('双括号行号锚仍走原路,不被兜底抢半截', () => {
    const [p] = splitWiki('[[/abs/dir/file.rs#L100-L120]]')
    expect(p.wiki?.inner).toBe('/abs/dir/file.rs#L100-L120')
  })
  it('形态不像行号引用的普通方括号不动它(负对照)', () => {
    for (const t of ['见 [#L42]', '[见 #L42]', '[a.ts] 没行号', '[a.ts#L]', '[脚注][1]', '[TODO#L42]']) {
      expect(splitWiki(t).some((x) => x.wiki)).toBe(false)
    }
  })
})

describe('LINE_CITE_RE 尾部纪律(Codex 评审:尾随散文不许吞)', () => {
  it('`[a.ts#L42 详见下文]`/英文尾随都原样留在正文里', () => {
    for (const t of ['[src/app.ts#L42 for details]', '[src/app.ts#L42 详见下文]', '[a.ts#L42, see below]']) {
      expect(splitWiki(t).some((x) => x.wiki)).toBe(false)
    }
  })
  it('`|别名` 合法形态照常认', () => {
    const [p] = splitWiki('[src/app.ts#L42|入口]')
    expect(p.wiki?.inner).toBe('src/app.ts#L42|入口')
  })
})

describe('LINE_CITE_RE 路径头纪律(Codex 二审:前导散文不许吞)', () => {
  it('前导散文(英文/中文/裸文件名)原样留在正文里', () => {
    for (const t of ['[see src/app.ts#L42]', '[详见 src/app.ts#L42]', '[see app.ts#L42]']) {
      const p = splitWiki(t)
      expect(p.some((x) => x.wiki)).toBe(false)
      expect(p.map((x) => x.text).join('')).toBe(t) // 括号一个字符都不吃
    }
  })
  it('绝对路径含空格是合法引用,不受路径头校验误伤', () => {
    const [p] = splitWiki('[/Users/x/My Docs/util.ts#L3]')
    expect(p.wiki?.inner).toBe('/Users/x/My Docs/util.ts#L3')
  })
})
