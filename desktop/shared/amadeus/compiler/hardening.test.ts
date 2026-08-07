// 2026-08-05 格式硬化三件套:连字符标记 id 自愈、块 id 高水位永不复用、schema 版本闸。
import { describe, expect, it } from 'vitest'
import { compile } from './compile'
import { bumpNextId, nextBlockId } from './names'
import { loadPage, parsePageSource, type CompilerIO } from './page'
import type { BlockId, LoadedPage } from './types'

const NOW = '2026-08-05T00:00:00.000Z'

function contentsOf(page: LoadedPage): Record<BlockId, string> {
  return Object.fromEntries(Object.entries(page.blocks).map(([id, b]) => [id, b.content]))
}

function v3Source(fmLines: string[], body: string[]): string {
  return ['---', 'amadeus_page: pg_test01', 'amadeus_schema: amadeus.page/3', ...fmLines, '---', '', ...body, ''].join('\n')
}

describe('连字符标记 id(agent 常写 ai-root 之类)', () => {
  it('parses hyphen ids as markers and heals them to clean numeric ids', () => {
    // 修复前:连字符 id 不匹配 BLOCK_MARKER_RE,44 个标记的笔记塌成 1 块(2026-07-26 实案)。
    const raw = v3Source([], ['<!-- a ai-root -->', '', '根节点', '', '<!-- a ai-what -->', '', '子节点'])
    const page = parsePageSource('note.md', raw, NOW)
    const blocks = Object.values(page.blocks)
    expect(blocks).toHaveLength(2)
    expect(Object.keys(page.blocks).sort()).toEqual(['1', '2']) // renumber 自愈成干净数字
    expect(blocks.map((b) => b.content)).toEqual(['根节点', '子节点'])
  })
})

/** 按 pageStore.deleteBlock 的同一套动作在 manifest 上删块(blocks + layout ref + 高水位)。 */
function deleteBlockOf(page: LoadedPage, id: BlockId): void {
  const m = page.manifest
  delete m.blocks[id]
  delete page.blocks[id]
  for (const row of m.root.children)
    for (const col of row.columns) col.children = col.children.filter((r) => r.ref !== id)
  m.root.children = m.root.children
    .map((row) => ({ ...row, columns: row.columns.filter((c) => c.children.length) }))
    .filter((row) => row.columns.length)
  m.nextId = bumpNextId(m.nextId, id)
}

describe('块 id 高水位(amadeus_next_id)', () => {
  it('nextBlockId respects the floor', () => {
    expect(nextBlockId(['1', '2'], 7)).toBe('7') // 最高号块被删过:不回落复用
    expect(nextBlockId(['1', '9'], 7)).toBe('10') // 现存更高:照常 max+1
    expect(nextBlockId(['1', '2'])).toBe('3') // 无高水位:现状语义不变
  })

  it('delete-highest → save → reload → insert does NOT reuse the retired id', () => {
    // Codex P1 场景 A:干净 1,2 笔记(无存量 floor),删 2 后必须记 3,否则下次插入原地复用 2。
    const page = parsePageSource('note.md', v3Source([], ['<!-- a 1 -->', '', '甲', '', '<!-- a 2 -->', '', '乙']), NOW)
    deleteBlockOf(page, '2')
    const md = compile(page.manifest, contentsOf(page))
    expect(md).toContain('amadeus_next_id: 3') // 删除抬升的水位落盘
    const reloaded = parsePageSource('note.md', md, NOW)
    expect(nextBlockId(Object.keys(reloaded.manifest.blocks), reloaded.manifest.nextId)).toBe('3') // 不是 '2'
  })

  it('allocate-at-floor → delete → allocate does NOT reuse either', () => {
    // Codex P1 场景 B:分配也要推进水位,否则「在 floor 上分到 7 → 删 7」后 floor 仍是 7。
    let nextId: number | undefined = 7
    const id1 = nextBlockId(['1'], nextId) // '7'
    nextId = bumpNextId(nextId, id1) // 分配即推进 → 8
    expect(nextBlockId(['1'], nextId)).toBe('8') // 删掉 7 之后再分配:8,不回落
  })

  it('compile writes the key only when it carries information, and it round-trips', () => {
    const raw = v3Source([], ['<!-- a 1 -->', '', '甲', '', '<!-- a 2 -->', '', '乙'])
    const page = parsePageSource('note.md', raw, NOW)
    // 可推导(= max+1):不写键,文件保持干净
    expect(compile(page.manifest, contentsOf(page))).not.toContain('amadeus_next_id')
    page.manifest.nextId = 7
    const md = compile(page.manifest, contentsOf(page))
    expect(md).toContain('amadeus_next_id: 7')
    const reparsed = parsePageSource('note.md', md, NOW)
    expect(reparsed.manifest.nextId).toBe(7)
    expect(reparsed.manifest.fmExtra ?? '').not.toContain('amadeus_next_id')
  })

  it('renumbering keeps the stored high-water mark instead of resetting it', () => {
    // Codex P1:夹带一个非数字 id 触发重编号,floor 100 不得归零。
    const raw = v3Source(['amadeus_next_id: 100'], ['<!-- a 1 -->', '', '甲', '', '<!-- a ai-x -->', '', '乙'])
    const page = parsePageSource('note.md', raw, NOW)
    expect(Object.keys(page.blocks).sort()).toEqual(['1', '2'])
    expect(page.manifest.nextId).toBe(100)
    expect(compile(page.manifest, contentsOf(page))).toContain('amadeus_next_id: 100')
  })
})

describe('schema 版本闸(旧客户端绝不「修复」未来格式)', () => {
  const futureRaw = ['---', 'amadeus_page: pg_future1', 'amadeus_schema: amadeus.page/4', 'amadeus_v4_stuff: x', '---', '', '未来格式正文(无标记)。', ''].join('\n')

  it('loads a newer-schema note verbatim, never writes, and compile refuses', async () => {
    const writes: string[] = []
    const io: CompilerIO = {
      readFile: async () => futureRaw,
      writeFile: async (p) => void writes.push(p),
      deleteFile: async () => {},
      exists: async (p) => p === 'note.md',
      listDir: async () => [],
    }
    const page = await loadPage(io, 'note.md', NOW)
    expect(page.manifest.schemaTooNew).toBe(true)
    expect(page.manifest.id).toBe('pg_future1')
    expect(Object.values(page.blocks)).toHaveLength(1) // 原样单块,不按 v3 切
    expect(writes).toEqual([]) // 载入绝不回写(否则 renumber 会把 v4 改写回 v3)
    expect(() => compile(page.manifest, contentsOf(page))).toThrow(/amadeus_schema/)
  })

  it('gates parsePageSource too, verbatim(trimmed) and quoted YAML included', () => {
    // Codex:web 源码模式走 parsePageSource;YAML 合法的带引号写法也必须被认出。
    const quoted = ['---', 'amadeus_page: pg_q', 'amadeus_schema: "amadeus.page/5"', '---', '', '未来正文 A', '', '未来正文 B', ''].join('\n')
    const page = parsePageSource('note.md', quoted, NOW)
    expect(page.manifest.schemaTooNew).toBe(true)
    const blocks = Object.values(page.blocks)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].content).toBe('未来正文 A\n\n未来正文 B') // 原样保留(仅首尾 trim)
    expect(() => compile(page.manifest, contentsOf(page))).toThrow()
  })

  it('gate runs BEFORE stale v1/v2 sidecar migration (migration must not rewrite a v4 note)', async () => {
    // Codex P1:残留旧 sidecar 时 migrate 会直接重写 main.md,必须被闸拦下。
    const writes: string[] = []
    const io: CompilerIO = {
      readFile: async (p) => (p === 'note.md' ? futureRaw : '{}'),
      writeFile: async (p) => void writes.push(p),
      deleteFile: async () => {},
      exists: async (p) => p === 'note.md' || p === '.note.amadeus.json', // 残留 v1 sidecar
      listDir: async () => [],
    }
    const page = await loadPage(io, 'note.md', NOW)
    expect(page.manifest.schemaTooNew).toBe(true)
    expect(writes).toEqual([])
  })

  it('still parses v3 and malformed schema strings as before', () => {
    const v3 = parsePageSource('note.md', v3Source([], ['<!-- a 1 -->', '', '正文']), NOW)
    expect(v3.manifest.schemaTooNew).toBeUndefined()
    const weird = parsePageSource('note.md', v3Source(['amadeus_schema: garbage'], ['<!-- a 1 -->', '', '正文']).replace('amadeus_schema: amadeus.page/3\n', ''), NOW)
    expect(weird.manifest.schemaTooNew).toBeUndefined() // 解析不出 major → 按 v3 尽力而为
  })
})
