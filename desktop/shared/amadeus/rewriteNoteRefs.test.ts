import { describe, expect, it } from 'vitest'
import { rewriteNoteRefs, type NoteRenamePlan } from './rewriteNoteRefs'

/** pairs + 操作前页面表 → plan(pagesAfter 由映射得出,与主进程 propagateRenames 同一算法)。 */
const plan = (pairs: Record<string, string>, pagesBefore: string[]): NoteRenamePlan => {
  const m = new Map(Object.entries(pairs))
  return {
    pairs: m,
    pagesBefore: [...pagesBefore].sort(),
    pagesAfter: pagesBefore.map((p) => m.get(p) ?? p).sort(),
  }
}

describe('rewriteNoteRefs — 改名', () => {
  const P = plan({ 'Foo.md': 'Bar.md' }, ['Foo.md', 'Other.md', 'S.md'])

  it('裸名/别名/锚点/嵌入全部跟随,别的引用不动', () => {
    expect(rewriteNoteRefs('见 [[Foo]] 与 [[Other]]', 'S.md', 'S.md', P)).toBe('见 [[Bar]] 与 [[Other]]')
    expect(rewriteNoteRefs('[[Foo|展示名]]', 'S.md', 'S.md', P)).toBe('[[Bar|展示名]]')
    expect(rewriteNoteRefs('[[Foo#标题]]', 'S.md', 'S.md', P)).toBe('[[Bar#标题]]')
    expect(rewriteNoteRefs('![[Foo#abc123]]', 'S.md', 'S.md', P)).toBe('![[Bar#abc123]]')
    expect(rewriteNoteRefs('![[Foo]]', 'S.md', 'S.md', P)).toBe('![[Bar]]')
  })

  it('断链/文件引用/本页锚不接手', () => {
    const src = '[[不存在]] ![[img.png|200]] [[#本页锚]] ![[#blockid]]'
    expect(rewriteNoteRefs(src, 'S.md', 'S.md', P)).toBe(src)
  })

  it('围栏代码块里的 [[Foo]] 不动,块外照改', () => {
    const src = '[[Foo]]\n```\n[[Foo]]\n```\n[[Foo]]'
    expect(rewriteNoteRefs(src, 'S.md', 'S.md', P)).toBe('[[Bar]]\n```\n[[Foo]]\n```\n[[Bar]]')
  })

  it('被改名页自己的自链接也跟随(srcBefore=旧路径,srcAfter=新路径)', () => {
    expect(rewriteNoteRefs('自引 [[Foo]]', 'Foo.md', 'Bar.md', P)).toBe('自引 [[Bar]]')
  })

  it('大小写不同的写法按解析命中', () => {
    expect(rewriteNoteRefs('[[foo]]', 'S.md', 'S.md', P)).toBe('[[Bar]]')
  })
})

describe('rewriteNoteRefs — 移动', () => {
  it('裸名跨移动自愈 → 不动;路径限定 → 跟到新路径', () => {
    const P = plan({ 'a/Foo.md': 'b/Foo.md' }, ['a/Foo.md', 'S.md'])
    expect(rewriteNoteRefs('[[Foo]]', 'S.md', 'S.md', P)).toBe('[[Foo]]')
    expect(rewriteNoteRefs('[[a/Foo]]', 'S.md', 'S.md', P)).toBe('[[b/Foo]]')
    expect(rewriteNoteRefs('![[a/Foo#x]]', 'S.md', 'S.md', P)).toBe('![[b/Foo#x]]')
  })

  it('移动后裸名会解析到别人 → 补路径限定', () => {
    // dir/S 的 [[Foo]] 原指同文件夹 dir/Foo;Foo 移走后裸名会落到排序靠前的 aaa/Foo → 必须限定
    const P = plan({ 'dir/Foo.md': 'zzz/Foo.md' }, ['aaa/Foo.md', 'dir/Foo.md', 'dir/S.md'])
    expect(rewriteNoteRefs('[[Foo]]', 'dir/S.md', 'dir/S.md', P)).toBe('[[zzz/Foo]]')
  })

  it('遮蔽防护:同名文件移进我的文件夹抢走裸名 → 原链接补路径限定', () => {
    // dir/S 的 [[Foo]] 原指 aaa/Foo(全库并列排序第一);另一个 other/Foo 移进 dir/ 后
    // 「同文件夹优先」会抢走这条裸名链接 → 必须补路径限定才仍指向 aaa/Foo
    const P = plan({ 'other/Foo.md': 'dir/Foo.md' }, ['aaa/Foo.md', 'dir/S.md', 'other/Foo.md'])
    expect(rewriteNoteRefs('[[Foo]]', 'dir/S.md', 'dir/S.md', P)).toBe('[[aaa/Foo]]')
  })

  it('源页自己被移动(文件夹操作):裸名同伴链接跟着走 → 不动;指向老位置的路径限定跟随', () => {
    const P = plan({ 'a/S.md': 'b/S.md', 'a/Peer.md': 'b/Peer.md' }, ['a/S.md', 'a/Peer.md', 'x.md'])
    expect(rewriteNoteRefs('[[Peer]]', 'a/S.md', 'b/S.md', P)).toBe('[[Peer]]')
    expect(rewriteNoteRefs('[[a/Peer]]', 'a/S.md', 'b/S.md', P)).toBe('[[b/Peer]]')
  })

  it('.fd 级联(renameFolder 第二遍):宿主页对子页的裸名链接自愈 → 不动', () => {
    // Foo→Bar 改名后第二遍级联 Foo.fd→Bar.fd;Bar.md 里的 [[X]] 全程无需改写
    const P = plan({ 'Foo.fd/X.md': 'Bar.fd/X.md' }, ['Bar.md', 'Foo.fd/X.md', 'S.md'])
    expect(rewriteNoteRefs('[[X]]', 'Bar.md', 'Bar.md', P)).toBe('[[X]]')
    // 第三方页的路径限定链接则必须跟随
    expect(rewriteNoteRefs('[[Foo.fd/X]]', 'S.md', 'S.md', P)).toBe('[[Bar.fd/X]]')
  })
})
