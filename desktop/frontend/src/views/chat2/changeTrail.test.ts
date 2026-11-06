// 文件改动记录(11-06 方案 A + C):分轮、diff 正文解析、一删一加的字 / 词标记、工具行的真增减与按文件计数。
import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../../../../tangu-agent/src/contracts/clientTypes'
import { planTurns, splitPath, totals, isProsePath } from './changeTrail'
import { markPairs, parsePatch } from './FileDiff'
import { countFiles, describeTool, editStat } from '../../components/ToolGroup'

const msg = (id: string, role: 'user' | 'assistant', timestamp: number): UiMessage =>
  ({ id, role, timestamp, content: '', status: 'done' }) as unknown as UiMessage

describe('planTurns', () => {
  it('a turn runs from one user message to the next; the receipt sits on its last assistant message', () => {
    const p = planTurns([msg('u1', 'user', 100), msg('a1', 'assistant', 110), msg('a2', 'assistant', 120), msg('u2', 'user', 200), msg('a3', 'assistant', 210)])
    expect(p.bounds).toEqual([100, 200])
    expect(p.byMsg).toEqual({ a2: { since: 100, until: 200 }, a3: { since: 200, until: null } })
  })
  it('a timestamp that goes backwards does not start a new turn', () => {
    const p = planTurns([msg('u1', 'user', 100), msg('a1', 'assistant', 110), msg('u2', 'user', 90), msg('a2', 'assistant', 120)])
    expect(p.bounds).toEqual([100])
    expect(p.byMsg).toEqual({ a2: { since: 100, until: null } })
  })
  it('a turn without an assistant reply gets no receipt', () => {
    const p = planTurns([msg('u1', 'user', 100), msg('u2', 'user', 200), msg('a2', 'assistant', 210)])
    expect(p.byMsg).toEqual({ a2: { since: 200, until: null } })
  })
})

describe('parsePatch', () => {
  it('keeps the real line numbers on both sides', () => {
    const rows = parsePatch('@@ -10,3 +10,3 @@\n a\n-b\n+B\n c')
    expect(rows).toEqual([
      { k: 'hunk', line: 10 },
      { k: 'ctx', o: 10, n: 10, text: 'a' },
      { k: 'del', o: 11, text: 'b' },
      { k: 'add', n: 11, text: 'B' },
      { k: 'ctx', o: 12, n: 12, text: 'c' },
    ])
  })
  it('a created file starts at line 1 on the new side', () => {
    const rows = parsePatch('@@ -0,0 +1,2 @@\n+x\n+y')
    expect(rows.slice(1)).toEqual([{ k: 'add', n: 1, text: 'x' }, { k: 'add', n: 2, text: 'y' }])
  })
})

describe('markPairs', () => {
  it('marks only the changed word in code', () => {
    const rows = markPairs(parsePatch('@@ -1 +1 @@\n-const port = 3000\n+const port = 3001'), false)
    const del = rows[1] as { marks?: { text: string; on: boolean }[] }
    const add = rows[2] as { marks?: { text: string; on: boolean }[] }
    expect(del.marks?.filter((m) => m.on).map((m) => m.text)).toEqual(['3000'])
    expect(add.marks?.filter((m) => m.on).map((m) => m.text)).toEqual(['3001'])
  })
  it('marks characters in prose', () => {
    const rows = markPairs(parsePatch('@@ -1 +1 @@\n-我们明天开会\n+我们后天开会'), true)
    const add = rows[2] as { marks?: { text: string; on: boolean }[] }
    expect(add.marks?.filter((m) => m.on).map((m) => m.text).join('')).toBe('后')
  })
  it('a rewritten line (under half unchanged) is marked whole, not shredded', () => {
    const rows = markPairs(parsePatch('@@ -1 +1 @@\n-The quick brown fox\n+Completely different text here'), true)
    expect((rows[1] as { marks?: unknown }).marks).toBeUndefined()
    expect((rows[2] as { marks?: unknown }).marks).toBeUndefined()
  })
})

describe('tool line stats', () => {
  it('edit_file counts real line changes, not the length of both snippets', () => {
    const old = 'a\nb\nc\nd\n'
    const neu = 'a\nB\nc\nd\n'
    expect(editStat(old, neu)).toEqual({ adds: 1, dels: 1 })
    const d = describeTool({ id: '1', name: 'edit_file', arguments: JSON.stringify({ path: '/w/x.ts', old_string: old, new_string: neu }), done: true })
    expect([d.adds, d.dels]).toEqual([1, 1])
  })
  it('multi_edit sums the real changes', () => {
    const d = describeTool({ id: '1', name: 'multi_edit', arguments: JSON.stringify({ path: '/w/x.ts', edits: [{ old_string: 'a\nb', new_string: 'a\nc' }, { old_string: 'x', new_string: 'x\ny' }] }), done: true })
    expect([d.adds, d.dels]).toEqual([2, 1])
  })
  it('the summary counts files, not calls; a file written then edited counts once, as written', () => {
    const ev = (name: string, path: string) => describeTool({ id: path + name, name, arguments: JSON.stringify({ path, content: 'x', old_string: 'x', new_string: 'y' }), done: true })
    const descs = [ev('edit_file', '/w/a.ts'), ev('edit_file', '/w/a.ts'), ev('edit_file', '/w/b.ts'), ev('write_file', '/w/c.md'), ev('edit_file', '/w/c.md')]
    expect(countFiles(descs)).toEqual({ write: 1, edit: 2 })
  })
})

describe('helpers', () => {
  it('splitPath shows the folder relative to the session folder', () => {
    expect(splitPath('/w/src/a.ts', '/w')).toEqual({ name: 'a.ts', dir: 'src' })
    expect(splitPath('/w/a.ts', '/w')).toEqual({ name: 'a.ts', dir: '' })
    expect(splitPath('/Users/me/x/a.ts', '/w', '/Users/me')).toEqual({ name: 'a.ts', dir: '~/x' })
  })
  it('totals skip files that cannot be compared', () => {
    expect(totals([
      { path: 'a', kind: 'modified', adds: 3, dels: 1, runs: 1 },
      { path: 'b', kind: 'modified', adds: null, dels: null, reason: 'binary', runs: 1 },
    ])).toEqual({ adds: 3, dels: 1 })
  })
  it('prose files', () => {
    expect(isProsePath('/a/README.md')).toBe(true)
    expect(isProsePath('/a/x.ts')).toBe(false)
  })
})
