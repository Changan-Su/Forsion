/** 编辑器面板的归属判定(noteOwnership)。整条链(库这一层 → 点开 → 文件一个字节不变)在 mobile 的 e2e:pluginfiles。 */
import { describe, expect, it } from 'vitest'
import { noteOwnership } from './noteOwnership'

const base = { pages: ['a.md', 'dir/b.md'], files: ['x.deck.md', 'dir\\y.mindmap.md', 'README.MD', 'pic.png'], vaultRoot: '/v', filesPendingFor: null }

describe('noteOwnership', () => {
  it('页面列表里的 → 笔记;空路径 / 非 .md → 不归这道闸管', () => {
    expect(noteOwnership('a.md', base)).toBe('note')
    expect(noteOwnership(null, base)).toBe('note')
    expect(noteOwnership('pic.png', base)).toBe('note')
  })

  it('不在页面列表、在文件列表里的 .md → 归插件管(路径分隔符两种写法都认)', () => {
    expect(noteOwnership('x.deck.md', base)).toBe('plugin')
    expect(noteOwnership('dir/y.mindmap.md', base)).toBe('plugin')
  })

  it('两个列表里都没有的 .md(刚建、列表还没刷到)→ 照常当笔记', () => {
    expect(noteOwnership('new.md', base)).toBe('note')
  })

  it('大写后缀的普通笔记(库那边列在 files 里)不被误伤 —— 后缀判定与库层同样区分大小写', () => {
    expect(noteOwnership('README.MD', base)).toBe('note')
  })

  it('文件列表还在路上:不在页面列表里的 .md 一律待确认;页面列表里的不受影响', () => {
    const loading = { ...base, files: [], filesPendingFor: '/v' }
    expect(noteOwnership('x.deck.md', loading)).toBe('pending')
    expect(noteOwnership('new.md', loading)).toBe('pending')
    expect(noteOwnership('a.md', loading)).toBe('note')
  })

  it('在途标记属于别的库根(切库后迟到的那份)→ 不算在途', () => {
    expect(noteOwnership('x.deck.md', { ...base, filesPendingFor: '/old' })).toBe('plugin')
  })
})
