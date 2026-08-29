/** unescapeWikiOutsideFences:还原 remark 对 [[ 的转义,但代码围栏内逐字保留。 */
import { describe, it, expect } from 'vitest'
import { resolvePageName, unescapeWikiOutsideFences, normalizeUrlLiterals } from './links'

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
