import { describe, it, expect } from 'vitest'
import { codexPatchToUnified, toolDiffText } from './toolDiff'

const args = (o: unknown) => JSON.stringify(o)

describe('toolDiffText', () => {
  it('edit_file → old/new 各成 -/+ 行,带文件头', () => {
    const d = toolDiffText('edit_file', args({ path: '/a/b.ts', old_string: 'foo\nbar', new_string: 'foo\nbaz' }))
    expect(d).toBeTruthy()
    expect(d).toContain('--- /a/b.ts')
    expect(d).toContain('-bar')
    expect(d).toContain('+baz')
  })

  it('write_file → 全为新增', () => {
    const d = toolDiffText('write_file', args({ path: 'x.txt', content: 'l1\nl2\n' }))!
    expect(d).toContain('+l1')
    expect(d).toContain('+l2')
    expect(d).not.toMatch(/^-l/m)
  })

  it('multi_edit → 每个 edit 一个文件块,标 #序号', () => {
    const d = toolDiffText('multi_edit', args({ path: 'x.ts', edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' },
    ] }))!
    expect(d).toContain('x.ts · #1')
    expect(d).toContain('x.ts · #2')
    expect(d).toContain('-c')
    expect(d).toContain('+d')
  })

  it('apply_patch → 标准 unified diff 透传,codex 方言走翻译', () => {
    const unified = '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y\n'
    expect(toolDiffText('apply_patch', args({ patch: unified }))).toBe(unified)
    const d = toolDiffText('apply_patch', args({ patch: '*** Begin Patch\n*** Update File: f.ts\n ctx\n-x\n+y\n*** End Patch' }))!
    expect(d).toContain('--- f.ts')
    expect(d).toContain('-x')
    expect(d).toContain('+y')
  })

  describe('codexPatchToUnified', () => {
    it('Update:@@ 切 hunk、计数正确、无前缀行按上下文', () => {
      const d = codexPatchToUnified([
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@ class Foo',
        ' ctx1',
        '-old',
        '+new1',
        '+new2',
        '@@ class Bar',
        'naked-context',
        '-gone',
        '*** End Patch',
      ].join('\n'))!
      expect(d).toContain('@@ -1,2 +1,3 @@ class Foo')
      expect(d).toContain('@@ -1,2 +1,1 @@ class Bar')
      expect(d).toContain(' naked-context')
    })

    it('Add / Delete / Move to', () => {
      const d = codexPatchToUnified([
        '*** Begin Patch',
        '*** Add File: new.txt',
        '+l1',
        '+l2',
        '*** Update File: old.ts',
        '*** Move to: renamed.ts',
        '-a',
        '+b',
        '*** Delete File: gone.txt',
        '*** End Patch',
      ].join('\n'))!
      expect(d).toContain('--- /dev/null\n+++ new.txt\n@@ -0,0 +1,2 @@')
      expect(d).toContain('--- old.ts\n+++ renamed.ts')
      expect(d).toContain('--- gone.txt\n+++ /dev/null')
    })

    it('非方言文本 → null', () => {
      expect(codexPatchToUnified('just some text')).toBeNull()
      expect(codexPatchToUnified('')).toBeNull()
    })
  })

  it('非文件工具 / 坏 JSON / 空参数 / 超大内容 → null', () => {
    expect(toolDiffText('run_bash', args({ command: 'ls' }))).toBeNull()
    expect(toolDiffText('edit_file', '{oops')).toBeNull()
    expect(toolDiffText('edit_file', undefined)).toBeNull()
    expect(toolDiffText('edit_file', args({ path: 'x', old_string: '', new_string: '' }))).toBeNull()
    expect(toolDiffText('write_file', args({ path: 'x', content: 'a'.repeat(300_000) }))).toBeNull()
  })
})
