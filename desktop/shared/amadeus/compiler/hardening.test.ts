// 2026-08-05 格式硬化三件套:连字符标记 id、块 id 高水位永不复用、schema 版本闸。
// 2026-08-13 补号策略收窄:合法且唯一的 id(含字母 id)一律保号,只有无标记内容与重复 id
// 才补号——重编号会剪断 layout 之外的 fm id 树(mindmap:/dashboard),那是实测在雷区的路径。
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

describe('字母/连字符块 id(agent、mindmap 插件常写 ai-root 之类)', () => {
  it('parses hyphen ids as markers and keeps them verbatim (no renumber)', () => {
    // 字符集修复(2026-08-05)让它们成为合法标记;此前 44 个标记的笔记塌成 1 块(2026-07-26 实案)。
    // 2026-08-13 起合法唯一 id 一律保号:mindmap:/dashboard 等 fm id 树引用它们,重编号会剪树。
    const raw = v3Source([], ['<!-- a ai-root -->', '', '根节点', '', '<!-- a ai-what -->', '', '子节点'])
    const page = parsePageSource('note.md', raw, NOW)
    expect(Object.keys(page.blocks).sort()).toEqual(['ai-root', 'ai-what'])
    expect(Object.values(page.blocks).map((b) => b.content)).toEqual(['根节点', '子节点'])
  })

  it('loadPage does NOT rewrite a file whose ids are valid-but-alphabetic', async () => {
    // 「打开即落盘改写」正是地雷引信:mindmap 文件经 pageStore→loadPage 一开就会被剪树。
    const raw = v3Source([], ['<!-- a ai-root -->', '', '根节点'])
    const writes: string[] = []
    const io: CompilerIO = {
      readFile: async () => raw,
      writeFile: async (p) => void writes.push(p),
      deleteFile: async () => {},
      exists: async (p) => p === 'note.md',
      listDir: async () => [],
    }
    const page = await loadPage(io, 'note.md', NOW)
    expect(Object.keys(page.blocks)).toEqual(['ai-root'])
    expect(writes).toEqual([])
  })

  it('heals duplicate ids by re-numbering the LATER occurrence (both contents survive)', () => {
    const raw = v3Source([], ['<!-- a 3 -->', '', '甲', '', '<!-- a 3 -->', '', '乙'])
    const page = parsePageSource('note.md', raw, NOW)
    expect(Object.keys(page.blocks).sort()).toEqual(['3', '4'])
    expect(page.blocks['3'].content).toBe('甲')
    expect(page.blocks['4'].content).toBe('乙') // 修复前:干净路径后者覆盖前者,「甲」静默丢失
  })

  it('treats `__proto__` as pathological — a plain-object key would swallow the block (Codex #1)', () => {
    // {} 上给 __proto__ 赋值走原型访问器,不产生自有键 → Object.keys 看不见,整块内容消失。
    const raw = v3Source([], ['<!-- a __proto__ -->', '', '正文'])
    const page = parsePageSource('note.md', raw, NOW)
    expect(Object.keys(page.blocks)).toEqual(['1'])
    expect(page.blocks['1'].content).toBe('正文')
  })

  it('duplicate ids beyond MAX_SAFE_INTEGER still get a DISTINCT fresh id (float max+1 trap, Codex #4)', () => {
    const big = '9007199254740992' // 2^53:big+1 在浮点里仍等于 big
    const raw = v3Source([], [`<!-- a ${big} -->`, '', '甲', '', `<!-- a ${big} -->`, '', '乙'])
    const page = parsePageSource('note.md', raw, NOW)
    const ids = Object.keys(page.blocks)
    expect(ids).toHaveLength(2)
    expect(page.blocks[big].content).toBe('甲')
    const fresh = ids.find((i) => i !== big)!
    expect(page.blocks[fresh].content).toBe('乙')
  })

  it('keeps SOURCE order for unplaced blocks when the layout is missing (Codex #6)', () => {
    // Object.keys 对整数形键按数值升序枚举 —— 缺布局时不能让「2 在前 1 在后」的正文被重排。
    const raw = v3Source([], ['<!-- a 2 -->', '', '第二。', '', '<!-- a 1 -->', '', '第一。'])
    const page = parsePageSource('note.md', raw, NOW)
    const placed = page.manifest.root.children.flatMap((r) => r.columns.flatMap((c) => c.children.map((x) => x.ref)))
    expect(placed).toEqual(['2', '1'])
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

  it('healing a markerless preamble allocates ABOVE the stored high-water mark', () => {
    // 无标记前导内容是仅剩的补号病理之一;补出的号必须尊重 floor(100),不得复用退役号段。
    const raw = v3Source(['amadeus_next_id: 100'], ['前导内容(无标记)', '', '<!-- a 1 -->', '', '甲'])
    const page = parsePageSource('note.md', raw, NOW)
    expect(Object.keys(page.blocks).sort()).toEqual(['1', '100'])
    expect(page.blocks['1'].content).toBe('甲')
    expect(page.blocks['100'].content).toBe('前导内容(无标记)')
    // 补号把水位推到 101 == 可推导值(max+1)→ 键不再落盘,但重载后分配确实从 101 起。
    const md = compile(page.manifest, contentsOf(page))
    expect(md).not.toContain('amadeus_next_id')
    const reloaded = parsePageSource('note.md', md, NOW)
    expect(nextBlockId(Object.keys(reloaded.manifest.blocks), reloaded.manifest.nextId)).toBe('101')
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

  it('recognizes a QUOTED amadeus_schema KEY (legal YAML) — the gate must not be quote-bypassed (Codex #3)', () => {
    const quotedKey = ['---', 'amadeus_page: pg_q2', '"amadeus_schema": amadeus.page/5', '---', '', '未来正文', ''].join('\n')
    const page = parsePageSource('note.md', quotedKey, NOW)
    expect(page.manifest.schemaTooNew).toBe(true)
    expect(() => compile(page.manifest, contentsOf(page))).toThrow()
  })

  it('still parses v3 and malformed schema strings as before', () => {
    const v3 = parsePageSource('note.md', v3Source([], ['<!-- a 1 -->', '', '正文']), NOW)
    expect(v3.manifest.schemaTooNew).toBeUndefined()
    const weird = parsePageSource('note.md', v3Source(['amadeus_schema: garbage'], ['<!-- a 1 -->', '', '正文']).replace('amadeus_schema: amadeus.page/3\n', ''), NOW)
    expect(weird.manifest.schemaTooNew).toBeUndefined() // 解析不出 major → 按 v3 尽力而为
  })
})
