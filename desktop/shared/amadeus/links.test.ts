/** unescapeWikiOutsideFences:还原 remark 对 [[ 的转义,但代码围栏内逐字保留。 */
import { describe, it, expect } from 'vitest'
import { decodeCharRefs, resolvePageName, unescapeWikiOutsideFences, normalizeUrlLiterals } from './links'

describe('unescapeWikiOutsideFences', () => {
  it('围栏外的 \\[\\[ 还原为 [[(含 !\\[\\[ 嵌入)', () => {
    expect(unescapeWikiOutsideFences('去 \\[\\[目标页]] 看')).toBe('去 [[目标页]] 看')
    expect(unescapeWikiOutsideFences('!\\[\\[图.png]]')).toBe('![[图.png]]')
  })
  it('``` 围栏内逐字保留(用户真写的 \\[\\[)', () => {
    const md = '前 \\[\\[a]]\n```\n正则 \\[\\[b]] 示例\n```\n后 \\[\\[c]]'
    expect(unescapeWikiOutsideFences(md)).toBe('前 [[a]]\n```\n正则 \\[\\[b]] 示例\n```\n后 [[c]]')
  })
  it('~~~ 围栏同样跳过,且 ``` 与 ~~~ 不互相闭合', () => {
    const md = '~~~\n\\[\\[x]]\n```\n\\[\\[y]]\n~~~\n\\[\\[z]]'
    expect(unescapeWikiOutsideFences(md)).toBe('~~~\n\\[\\[x]]\n```\n\\[\\[y]]\n~~~\n[[z]]')
  })
  it('无 \\[\\[ 时原样快速返回', () => {
    const md = '普通 [[已成链]] 文本\n```\ncode\n```'
    expect(unescapeWikiOutsideFences(md)).toBe(md)
  })
})

describe('resolvePageName(name, pages, sourcePath?)', () => {
  // 调用方约定传排序后的清单(全库并列时字典序首个 = 历史行为)。
  const pages = ['Foo.md', 'Solo.md', 'a/Foo.md', 'b/Foo.md', 'dir/Foo.md', 'dir/Src.fd/Child.md', 'dir/Src.md']

  it('裸名、无上下文:全库字典序首个(= 历史行为)', () => {
    expect(resolvePageName('Foo', pages)).toBe('Foo.md')
    expect(resolvePageName('foo', pages)).toBe('Foo.md') // 大小写不敏感
    expect(resolvePageName('Child', pages)).toBe('dir/Src.fd/Child.md') // 唯一名到处可达
    expect(resolvePageName('Nowhere', pages)).toBeNull()
    expect(resolvePageName('  ', pages)).toBeNull()
  })

  it('裸名、有上下文:源同目录优先', () => {
    expect(resolvePageName('Foo', pages, 'dir/Src.md')).toBe('dir/Foo.md')
    expect(resolvePageName('Foo', pages, 'a/Whatever.md')).toBe('a/Foo.md')
    expect(resolvePageName('Foo', pages, 'elsewhere/X.md')).toBe('Foo.md') // 附近无 → 回全库首个
  })

  it('裸名、有上下文:源自己的 .fd 子笔记优先于全库', () => {
    const p = ['b/Foo.md', 'x/Owner.fd/Foo.md']
    expect(resolvePageName('Foo', p, 'x/Owner.md')).toBe('x/Owner.fd/Foo.md')
    expect(resolvePageName('Foo', p, 'x/Other.md')).toBe('b/Foo.md') // 别人的 .fd 不沾光
  })

  it('路径限定:精确匹配或 null,绝不回落 basename', () => {
    expect(resolvePageName('a/Foo', pages)).toBe('a/Foo.md')
    expect(resolvePageName('a/Foo.md', pages)).toBe('a/Foo.md')
    expect(resolvePageName('A/FOO', pages)).toBe('a/Foo.md') // 路径也大小写不敏感
    expect(resolvePageName('x/Foo', pages)).toBeNull() // 不绑到 a/Foo
    expect(resolvePageName('dir/Src.fd/Child', pages)).toBe('dir/Src.fd/Child.md')
  })

  it('Windows 反斜杠两侧归一', () => {
    expect(resolvePageName('a\\Foo', pages)).toBe('a/Foo.md')
    expect(resolvePageName('Foo', ['a\\Foo.md'], 'a\\Src.md')).toBe('a\\Foo.md') // 同目录判定穿透 \
  })
})

describe('resolvePageName 路径限定形态(聊天标题锚点引用依赖)', () => {
  it('带 .md 扩展名的相对路径精确解析(大小写不敏感)', () => {
    const pages = ['dir/Note.md', 'other/Note.md', 'Top.md']
    expect(resolvePageName('dir/Note.md', pages)).toBe('dir/Note.md')
    expect(resolvePageName('dir/note.md', pages)).toBe('dir/Note.md')
    expect(resolvePageName('dir/Note', pages)).toBe('dir/Note.md')
    expect(resolvePageName('nope/Note.md', pages)).toBeNull() // 限定路径绝不回落 basename
  })
})

describe('normalizeUrlLiterals(2026-08-29:新写进去的 URL 被 gfm 转义 / 包成 <>)', () => {
  it('还原 `://`:嵌入形态与裸 URL(书签卡)两种都要', () => {
    expect(normalizeUrlLiterals('![[https\\://x.com/a]]')).toBe('![[https://x.com/a]]')
    expect(normalizeUrlLiterals('https\\://x.com/a')).toBe('https://x.com/a')
  })
  it('还原 `w` 后面那个点(gfm 的 before=[Ww] 规则,`overview.md` 也中招)', () => {
    expect(normalizeUrlLiterals('![[https\\://www\\.b.com]]')).toBe('![[https://www.b.com]]')
    expect(normalizeUrlLiterals('[[overview\\.md]]')).toBe('[[overview.md]]')
  })
  it('还原邮箱的 `@`', () => {
    expect(normalizeUrlLiterals('a\\@b.com')).toBe('a@b.com')
  })
  it('⚠️ 逐字逆运算:上下文对不上的反斜杠一律不动', () => {
    expect(normalizeUrlLiterals('句号\\. 与 x\\:y')).toBe('句号\\. 与 x\\:y')
    expect(normalizeUrlLiterals('转义星号 \\*不是链接\\*')).toBe('转义星号 \\*不是链接\\*')
  })
  it('围栏内逐字保留', () => {
    const md = 'https\\://a.com\n```\nhttps\\://b.com\n```\nhttps\\://c.com'
    expect(normalizeUrlLiterals(md)).toBe('https://a.com\n```\nhttps\\://b.com\n```\nhttps://c.com')
  })
  it('没有反斜杠时原样快速返回', () => {
    expect(normalizeUrlLiterals('![[a.md]]')).toBe('![[a.md]]')
  })
  it('脱掉链接节点序列化出的尖括号(Obsidian 解析不了 `![[<url>]]`)', () => {
    expect(normalizeUrlLiterals('![[<https://www.youtube.com/watch?v=x>]]')).toBe('![[https://www.youtube.com/watch?v=x]]')
    expect(normalizeUrlLiterals('<https://www.youtube.com/watch?v=x>')).toBe('https://www.youtube.com/watch?v=x')
  })
  it('⚠️ 只脱没有歧义的两处:句中的 `<url>` 不动(那是用户写的自动链接)', () => {
    expect(normalizeUrlLiterals('见 <https://a.com> 这里')).toBe('见 <https://a.com> 这里')
  })
})

describe('normalizeUrlLiterals × 行内代码(Codex 2026-08-29)', () => {
  it('⚠️ 反引号里的反斜杠是用户真写的字节,一律不动', () => {
    expect(normalizeUrlLiterals('转义示例 `https\\://host` 见上')).toBe('转义示例 `https\\://host` 见上')
    expect(normalizeUrlLiterals('`[[a\\.md]]` 是字面')).toBe('`[[a\\.md]]` 是字面')
  })
  it('同一行里代码外的照常还原', () => {
    expect(normalizeUrlLiterals('`x\\.y` 与 https\\://a.com')).toBe('`x\\.y` 与 https://a.com')
  })
  it('双反引号段同样跳过', () => {
    expect(normalizeUrlLiterals('``a\\.b`` 后 www\\.c.com')).toBe('``a\\.b`` 后 www.c.com')
  })
})

// 编辑器为了让 `**`/`~~` 往返,会把定界符旁的字写成数字字符引用(attentionFlanking)。索引读原文,
// 不解码的话「后面」搜不到 `**注意：**&#x540E;面`、`#项&#x76EE;` 被当成标签 `#项`。
describe('decodeCharRefs(给搜索 / 标签 / 双链看的解码副本)', () => {
  it('十六进制与十进制数字引用都解;emoji 按整码点', () => {
    expect(decodeCharRefs('**注意：**&#x540E;面')).toBe('**注意：**后面')
    expect(decodeCharRefs('*斜&#x4F53;***「注意」**')).toBe('*斜体***「注意」**')
    expect(decodeCharRefs('&#21518;面 &#X540e;')).toBe('后面 后')
    expect(decodeCharRefs('&#x1F600;')).toBe('\u{1F600}')
  })
  it('micromark 会解成 U+FFFD 的一律不解(原样留着)', () => {
    for (const ref of ['&#x0;', '&#x1;', '&#xB;', '&#x1F;', '&#x7F;', '&#x85;', '&#x9F;', '&#xD800;', '&#xDFFF;', '&#xFDD0;', '&#xFFFE;', '&#x1FFFF;', '&#x110000;', '&#x1234567;', '&#12345678;'])
      expect(decodeCharRefs(`a${ref}b`)).toBe(`a${ref}b`)
  })
  it('换行类引用解成空格:解码副本的行号必须与原文逐行对齐(搜索命中行号、@ 标记都靠行)', () => {
    const src = '一行~~完成了。&#xA0;~~&#xA;还是这一行&#xD;\n第二行'
    const out = decodeCharRefs(src)
    expect(out.split('\n')).toHaveLength(src.split('\n').length)
    expect(out).toBe('一行~~完成了。\u00A0~~ 还是这一行 \n第二行')
  })
  it('只解一遍:`&#x26;#x41;` 是字面的 `&#x41;`,不能再解成 A', () => {
    expect(decodeCharRefs('&#x26;#x41;')).toBe('&#x41;')
  })
  it('反斜杠转义的 `\\&#x41;` 是字面文本,不解;双反斜杠后面的照解', () => {
    expect(decodeCharRefs('\\&#x41;')).toBe('\\&#x41;')
    expect(decodeCharRefs('\\\\&#x41;')).toBe('\\\\A')
  })
  it('行内代码与围栏代码块里不解(那是用户写的字面源码)', () => {
    expect(decodeCharRefs('前 `&#x41;` 后 &#x42;')).toBe('前 `&#x41;` 后 B')
    expect(decodeCharRefs('``a `&#x41;` b`` &#x42;')).toBe('``a `&#x41;` b`` B')
    const fenced = ['&#x41;', '```js', 'const s = "&#x41;"', '```', '~~~', '&#x41;', '~~~', '&#x42;'].join('\n')
    expect(decodeCharRefs(fenced)).toBe(['A', '```js', 'const s = "&#x41;"', '```', '~~~', '&#x41;', '~~~', 'B'].join('\n'))
  })
  it('没有引用的文本原样返回(同一个串)', () => {
    const s = '普通 **加粗** #标签 [[双链]]'
    expect(decodeCharRefs(s)).toBe(s)
  })
})

// 评审(09-18)实测:围栏状态一旦错位,后面整篇都不解 —— 正是本条要修的那个 bug 换个入口回来。
// 前两形是编辑器自己写出来的。口径:只有找得到配对收尾的才算围栏(宁可在代码里多解,也不能后文全不解)。
describe('decodeCharRefs × 围栏边界(评审实测)', () => {
  const TAIL = '**注意：**&#x540E;面 #项&#x76EE;'
  const WANT = '**注意：**后面 #项目'
  const lastLine = (md: string): string => decodeCharRefs(md).split('\n').pop() as string
  it('A 四反引号围栏里有一行 ``` (编辑器对含 ``` 的代码块就这么写)', () => {
    expect(lastLine(['````', '```', '````', TAIL].join('\n'))).toBe(WANT)
  })
  it('B 围栏里一行 ```js 不是收尾(收尾不许带信息串)', () => {
    const md = ['```', '```js', 'x &#x41;', '```', TAIL].join('\n')
    expect(decodeCharRefs(md).split('\n')).toEqual(['```', '```js', 'x &#x41;', '```', WANT])
  })
  it('C 列表项首个子块是代码块(`* ```js` + 缩进收尾,编辑器就这么写)', () => {
    const md = ['* ```js', '  code &#x41;', '  ```', TAIL].join('\n')
    expect(decodeCharRefs(md).split('\n')).toEqual(['* ```js', '  code &#x41;', '  ```', WANT])
  })
  it('D/E 行首是行内代码、或信息串带反引号的 ``` 行,都不是开围栏', () => {
    expect(lastLine(['```a``` 前 &#x41;', TAIL].join('\n'))).toBe(WANT)
    expect(decodeCharRefs('```a``` 前 &#x42;')).toBe('```a``` 前 B')
  })
  it('F `~~~~` 围栏里的 `~~~` 不是收尾(收尾至少同长)', () => {
    const md = ['~~~~', '~~~', 'x &#x41;', '~~~~', TAIL].join('\n')
    expect(decodeCharRefs(md).split('\n')).toEqual(['~~~~', '~~~', 'x &#x41;', '~~~~', WANT])
  })
  it('找不到收尾的「开围栏」不算围栏:后文照解', () => {
    expect(lastLine(['``` 没有收尾', TAIL].join('\n'))).toBe(WANT)
  })
  it('引用块里的围栏也认', () => {
    expect(decodeCharRefs(['> ```', '> &#x41;', '> ```', '&#x42;'].join('\n'))).toBe(['> ```', '> &#x41;', '> ```', 'B'].join('\n'))
  })
  it('转义的反引号不开行内代码', () => {
    expect(decodeCharRefs('\\` `x` ' + TAIL + ' `')).toBe('\\` `x` ' + WANT + ' `')
  })
})

// 存盘路径(normalizeSerializedMd)上的两个还原函数:围栏判断曾是「见到像围栏的行就翻转」,在编辑器
// 自己写出的形态上错位 → 后文整段被当成「围栏内」跳过 → 新打的 `[[链接]]` 按 `\\[\\[` 落盘成死链、
// URL 转义也留着(09-18 评审实测)。改用与 decodeCharRefs 同一套配对(mapOutsideFences)。
describe('存盘还原 × 围栏配对(09-18)', () => {
  const W = '去 \\[\\[目标页]] 看 https\\://a.com'
  const OK = '去 [[目标页]] 看 https://a.com'
  const save = (md: string): string => normalizeUrlLiterals(unescapeWikiOutsideFences(md))
  const shapes: [string, string[]][] = [
    ['A 四反引号块里有一行 ```(编辑器对含 ``` 的代码块就这么写)', ['````', '```', 'x \\[\\[in]] https\\://in.com', '````']],
    ['C 列表项首个子块是代码块(`* ```js` + 缩进收尾,编辑器就这么写)', ['* ```js', '  x \\[\\[in]] https\\://in.com', '  ```']],
    ['B 块里一行 ```js 不是收尾', ['```', '```js', 'x \\[\\[in]] https\\://in.com', '```']],
    ['F `~~~~` 块里的 `~~~` 不是收尾', ['~~~~', '~~~', 'x \\[\\[in]] https\\://in.com', '~~~~']],
  ]
  for (const [name, block] of shapes) {
    it(name, () => {
      const out = save([W, ...block, W].join('\n')).split('\n')
      expect(out[0]).toBe(OK) // 块前照常还原
      expect(out.slice(1, -1)).toEqual(block) // 块内逐字保留(用户真写的字节)
      expect(out[out.length - 1]).toBe(OK) // 块后必须还原 —— 修前这里留着 `\\[\\[`
    })
  }
  it('CRLF 文件的围栏同样认得(块内保留、块后还原)', () => {
    const md = [W, '```', 'x \\[\\[in]]', '```', W].join('\r\n')
    expect(unescapeWikiOutsideFences(md).split('\r\n')).toEqual(['去 [[目标页]] 看 https\\://a.com', '```', 'x \\[\\[in]]', '```', '去 [[目标页]] 看 https\\://a.com'])
    expect(decodeCharRefs(['```', '&#x41;', '```', '&#x42;'].join('\r\n'))).toBe(['```', '&#x41;', '```', 'B'].join('\r\n'))
  })
})
