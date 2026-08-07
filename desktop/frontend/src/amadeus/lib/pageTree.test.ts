import { describe, it, expect } from 'vitest'
import { buildTree, mergeFdNotes, pathTo, subtreeAt, type TreeNode } from './pageTree'

const names = (n: TreeNode): string[] => n.children.map((c) => `${c.kind}:${c.name}`)
const find = (n: TreeNode, name: string): TreeNode | undefined => n.children.find((c) => c.name === name)

describe('mergeFdNotes(Notion 式 .fd 合并)', () => {
  it('X.fd 文件夹隐藏,孩子挂到 X.md 文件节点', () => {
    const root = mergeFdNotes(
      buildTree(['Diary.md', 'Diary.fd/a.md', 'Diary.fd/b.db', 'Other.md'], ['Diary.fd']),
    )
    expect(names(root)).toEqual(['file:Diary.md', 'file:Other.md']) // 文件夹行没了
    const diary = find(root, 'Diary.md')!
    expect(names(diary)).toEqual(['file:a.md', 'file:b.db'])
    expect(diary.children.map((c) => c.path)).toEqual(['Diary.fd/a.md', 'Diary.fd/b.db']) // 子路径原封不动
  })

  it('孤儿 .fd(无同名 .md)保持普通文件夹;大小写不同名不合并', () => {
    const root = mergeFdNotes(buildTree(['diary.md', 'Orphan.fd/x.md'], ['Orphan.fd', 'Diary.fd']))
    expect(names(root)).toEqual(['folder:Diary.fd', 'folder:Orphan.fd', 'file:diary.md'])
  })

  it('.fd 套 .fd 递归合并', () => {
    const root = mergeFdNotes(
      buildTree(['Diary.md', 'Diary.fd/Sub.md', 'Diary.fd/Sub.fd/deep.md'], ['Diary.fd', 'Diary.fd/Sub.fd']),
    )
    const diary = find(root, 'Diary.md')!
    const sub = find(diary, 'Sub.md')!
    expect(names(sub)).toEqual(['file:deep.md'])
  })

  it('X.fd.md 与 X.fd.fd 成对,不与 X.fd 混淆', () => {
    const root = mergeFdNotes(buildTree(['X.fd.md', 'X.fd.fd/c.md'], ['X.fd.fd', 'X.fd']))
    expect(names(root)).toEqual(['folder:X.fd', 'file:X.fd.md'])
    expect(names(find(root, 'X.fd.md')!)).toEqual(['file:c.md'])
  })
})

describe('subtreeAt / pathTo(分享页折叠树)', () => {
  const build = (): TreeNode =>
    mergeFdNotes(
      buildTree(
        ['docs/agents/muse.md', 'docs/amadeus/dashboard.md', 'docs/README.md', 'docs/Diary.md', 'docs/Diary.fd/a.md'],
        ['docs/Diary.fd', 'docs/empty'],
      ),
    )

  it('subtreeAt 把分享根当顶层,空文件夹也在', () => {
    expect(names(subtreeAt(build(), 'docs'))).toEqual([
      'folder:agents', 'folder:amadeus', 'folder:empty', 'file:Diary.md', 'file:README.md',
    ])
  })

  it('subtreeAt 路径对不齐就停在走到的那层;空路径原样返回', () => {
    const root = build()
    expect(subtreeAt(root, 'docs/nope/deeper')).toBe(find(root, 'docs'))
    expect(subtreeAt(root, '')).toBe(root)
  })

  it('pathTo 给出祖先链,不含目标本身', () => {
    const top = subtreeAt(build(), 'docs')
    expect(pathTo(top, 'docs/amadeus/dashboard.md')).toEqual(['docs/amadeus'])
    expect(pathTo(top, 'docs/README.md')).toEqual([])
    expect(pathTo(top, 'docs/nothing.md')).toBeNull()
  })

  it('pathTo 走合并后的 .fd 容器 → 链上是 X.md 而非 X.fd', () => {
    expect(pathTo(subtreeAt(build(), 'docs'), 'docs/Diary.fd/a.md')).toEqual(['docs/Diary.md'])
  })
})
