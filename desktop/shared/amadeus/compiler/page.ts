// High-level page orchestration for the v3 single-file format. Pure of Node/Electron:
// all disk access goes through an injected CompilerIO (paths relative to the note's parent
// folder; the main process supplies a vault-clamped, atomic-write impl).
//
// A note is ONE `.md`: frontmatter (id + layout) + inline block content with `<!-- a id -->`
// markers. Save = write that one file. Load = parse it (no projection, no reconcile). Older
// formats (v1 sidecars, v2 folder bundle) are migrated to inline on first open.

import { compile } from './compile'
import { parseLayout } from './manifest'
import { parseBody } from './markers'
import {
  bumpNextId,
  generateColumnId,
  generatePageId,
  generateRowId,
  nextBlockId,
  pageFileName,
  stripPageBasename,
} from './names'
import { extractFrontmatterExtra, parseFrontmatter, schemaMajorOf, stripFrontmatter } from './split'
import {
  COMPILER_VERSION,
  PAGE_SCHEMA,
  type BlockId,
  type ColumnNode,
  type LoadedBlock,
  type LoadedPage,
  type PageManifest,
  type RowNode,
  type StackNode,
} from './types'

/** Disk surface, relative to the note's parent folder. Implemented in the main process. */
export interface CompilerIO {
  readFile(relPath: string): Promise<string>
  writeFile(relPath: string, data: string): Promise<void>
  deleteFile(relPath: string): Promise<void>
  exists(relPath: string): Promise<boolean>
  /** File/dir names (not paths) in the given subfolder ('' / omitted = the note's parent folder). */
  listDir(relPath?: string): Promise<string[]>
  /** Recursively remove a subfolder (best-effort; optional — used by v2 migration cleanup). */
  removeDir?(relPath: string): Promise<void>
}

export interface SavePageOptions {
  contents: Record<BlockId, string>
}

const EMPTY_STACK: StackNode = { type: 'stack', children: [] }

/** Major version this compiler understands (from PAGE_SCHEMA 'amadeus.page/3'). */
const SCHEMA_MAJOR = 3

function normalizeWidths(cols: ColumnNode[]): ColumnNode[] {
  const sum = cols.reduce((s, c) => s + (c.width > 0 ? c.width : 0), 0)
  if (sum <= 0) {
    const w = 1 / Math.max(1, cols.length)
    return cols.map((c) => ({ ...c, width: w }))
  }
  return cols.map((c) => ({ ...c, width: (c.width > 0 ? c.width : 0) / sum }))
}

/** Make the layout consistent with the blocks actually present in the body: drop refs whose
 *  block is gone, and append any present-but-unplaced block as a trailing full-width row.
 *  Also rebuilds the full-width column when the frontmatter layout is missing entirely. */
function reconcileRoot(root: StackNode, present: Set<BlockId>): StackNode {
  const placed = new Set<BlockId>()
  const children: RowNode[] = []

  for (const row of root.children) {
    const cols: ColumnNode[] = []
    for (const col of row.columns) {
      const kids = col.children.filter((ref) => {
        if (present.has(ref.ref)) {
          placed.add(ref.ref)
          return true
        }
        return false
      })
      if (kids.length) cols.push({ ...col, children: kids })
    }
    if (cols.length) children.push({ ...row, columns: normalizeWidths(cols) })
  }

  const missing = [...present].filter((id) => !placed.has(id))
  if (missing.length) {
    children.push({
      type: 'row',
      id: generateRowId(),
      columns: [{ id: generateColumnId(), width: 1, children: missing.map((id) => ({ ref: id })) }],
    })
  }
  return { type: 'stack', children }
}

/** Rewrite layout refs through an id remap (used by the one-time legacy-id cleanup). */
function remapLayout(root: StackNode, remap: Map<string, string>): StackNode {
  return {
    type: 'stack',
    children: root.children.map((row) => ({
      type: 'row',
      id: row.id,
      columns: row.columns.map((col) => ({
        id: col.id,
        width: col.width,
        children: col.children.map((ref) => ({ ref: remap.get(ref.ref) ?? ref.ref })),
      })),
    })),
  }
}

function hydrate(
  manifest: PageManifest,
  contents: Record<BlockId, string>,
): Record<BlockId, LoadedBlock> {
  const blocks: Record<BlockId, LoadedBlock> = {}
  for (const [id, entry] of Object.entries(manifest.blocks)) {
    blocks[id] = { id, type: entry.type, content: contents[id] ?? '' }
  }
  return blocks
}

/** Build an in-memory page from a set of block ids + contents + a (possibly empty) layout. */
function buildPage(
  pagePath: string,
  id: string,
  layout: StackNode,
  blockTypes: Record<BlockId, string>,
  contents: Record<BlockId, string>,
  createdAt: string,
  now: string,
  fmExtra?: string,
  nextId?: number,
  order?: BlockId[],
): LoadedPage {
  // order = 源文档序。Object.keys 会把整数形键按数值升序枚举(JS 语义),缺布局时未放置块
  // 若按键序接尾行,正文顺序被静默重排(Codex #6)——调用方能给源序就给。
  const present = new Set(order ?? Object.keys(blockTypes))
  const manifest: PageManifest = {
    schema: PAGE_SCHEMA,
    id,
    title: stripPageBasename(pagePath),
    createdAt,
    updatedAt: now,
    compiler: { version: COMPILER_VERSION },
    root: reconcileRoot(layout, present),
    blocks: Object.fromEntries(Object.entries(blockTypes).map(([bid, t]) => [bid, { type: t }])),
    ...(fmExtra ? { fmExtra } : {}),
    ...(nextId && nextId > 0 ? { nextId } : {}),
  }
  return { manifest, blocks: hydrate(manifest, contents) }
}

export async function savePage(
  io: CompilerIO,
  pagePath: string,
  manifest: PageManifest,
  opts: SavePageOptions,
): Promise<void> {
  await io.writeFile(pageFileName(pagePath), compile(manifest, opts.contents))
}

/** Create a brand-new note with a single empty markdown block. */
export async function newPage(io: CompilerIO, pagePath: string, now: string): Promise<LoadedPage> {
  const id = nextBlockId([])
  const page = buildPage(pagePath, generatePageId(), EMPTY_STACK, { [id]: 'markdown' }, { [id]: '' }, now, now)
  await savePage(io, pagePath, page.manifest, { contents: { [id]: '' } })
  return page
}

/** A foreign / not-yet-Amadeus note (no `amadeus_page` frontmatter): load it in memory as a
 *  SINGLE markdown block (块只由 `<!-- a id -->` 标记切分,不按段落/空行拆分),preserving the
 *  raw body verbatim (no remark re-stringify) so Obsidian 等来源的 .md 原样呈现、不被拆成奇怪的多块。
 *  DO NOT write — only adopt to v3 on the first real edit. */
function importForeign(pagePath: string, raw: string, now: string): LoadedPage {
  const body = stripFrontmatter(raw).trim()
  const id = nextBlockId([])
  // 外来 fm(如 Obsidian properties)进 fmExtra,否则首次编辑落盘即被销毁。
  return buildPage(pagePath, generatePageId(), EMPTY_STACK, { [id]: 'markdown' }, { [id]: body }, now, now, extractFrontmatterExtra(raw))
}

/** A note whose `amadeus_schema` major is newer than this compiler: load it VERBATIM as a
 *  single read-only-ish block and flag it — compile() refuses to write flagged pages, so an
 *  old client can never "repair" (renumber + rewrite) a future-format note into v3. */
function futureSchemaPage(
  pagePath: string,
  raw: string,
  fm: Record<string, string>,
  now: string,
): LoadedPage {
  const page = importForeign(pagePath, raw, now)
  page.manifest.id = fm.amadeus_page
  page.manifest.schemaTooNew = true
  return page
}

/** Parse a v3 note: frontmatter (id + layout) + inline marker-delimited block content.
 *  `renumbered` is true when pathological blocks were healed — loadPage persists that
 *  one-time cleanup. 病理只有两类:无标记内容(id=null 的前导/游离段)与重复 id(不补号则
 *  后者静默覆盖前者,内容丢失)。合法且唯一的 id——含 agent/mindmap 插件写的字母 id——
 *  一律保号:layout 之外 frontmatter 里还有块 id 树(mindmap:/dashboard 键),那条链不在
 *  compiler 手里,重编号会把它们悄悄剪断(2026-08-13 前这里对任何非数字 id 全篇重编号)。 */
function parseV3(
  pagePath: string,
  raw: string,
  fm: Record<string, string>,
  now: string,
): { page: LoadedPage; renumbered: boolean } {
  const parsed = parseBody(stripFrontmatter(raw))
  const layout = parseLayout(fm.amadeus_layout)
  const fmExtra = extractFrontmatterExtra(raw)
  const fmNextId = Number.parseInt(fm.amadeus_next_id ?? '', 10)

  // 补号的分配池必须先装入全部现存 id(而非边扫边加):否则给前导内容补的号可能撞上
  // 文档后部尚未扫到的数字 id,把无辜块挤成「重复」。
  const present = new Set<BlockId>()
  for (const b of parsed) if (b.id != null) present.add(b.id)

  // 高水位超出安全整数按不存在处理:以它当 floor 分配会因浮点 +1 不动而撞号。
  let nextId: number | undefined = Number.isSafeInteger(fmNextId) && fmNextId > 0 ? fmNextId : undefined
  let healed = false
  const seenOnce = new Set<BlockId>()
  const blockTypes: Record<BlockId, string> = {}
  const contents: Record<BlockId, string> = {}
  const order: BlockId[] = []
  for (const b of parsed) {
    let id: BlockId
    // `__proto__` 是普通对象上的原型访问器:赋值不产生自有键,Object.keys 看不见,整块内容
    // 会从解析结果里消失(Codex #1)——按病理块补号,不保留。
    if (b.id != null && b.id !== '__proto__' && !seenOnce.has(b.id)) {
      seenOnce.add(b.id)
      id = b.id
    } else {
      // 补号同样尊重并推进高水位:绝不复用已退役号段(外部 `![[note#N]]` 会静默错绑)。
      id = nextBlockId(present, nextId)
      // 兜底闸:任何路径算出的「新」号若与现存同号,退回带后缀的字母 id(合法字符集,
      // 永不重编号)——补号绝不允许覆盖既有内容。
      for (let i = 2; present.has(id); i++) id = `${nextBlockId(present, nextId)}-${i}`
      present.add(id)
      nextId = bumpNextId(nextId, id)
      healed = true
    }
    blockTypes[id] = 'markdown'
    contents[id] = b.content
    order.push(id)
  }
  // 重复 id 的 layout ref 天然归首个保号块;补号块无 ref → buildPage 的 reconcileRoot
  // 把它们按源序接到尾部整宽行。
  return { page: buildPage(pagePath, fm.amadeus_page, layout, blockTypes, contents, now, now, fmExtra, nextId, order), renumbered: healed }
}

/** Open a note: migrate v1/v2 if present, else parse v3, else adopt a foreign note, else create new. */
export async function loadPage(io: CompilerIO, pagePath: string, now: string): Promise<LoadedPage> {
  const base = stripPageBasename(pagePath)
  const pageFile = pageFileName(pagePath)

  // 版本闸必须先于 v1/v2 迁移:残留的旧 sidecar/bundle 会让 migrate 直接重写 main.md,
  // 未来格式的笔记就这样被「修复」回 v3(Codex)。
  const raw = (await io.exists(pageFile)) ? await io.readFile(pageFile) : null
  if (raw != null) {
    const fm = parseFrontmatter(raw)
    const major = schemaMajorOf(fm)
    if (fm.amadeus_page && major != null && major > SCHEMA_MAJOR) {
      return futureSchemaPage(pagePath, raw, fm, now)
    }
  }

  if (await io.exists(`.${base}.amadeus.json`)) return migrateV1(io, pagePath, now)
  if (await io.exists(`${base}.amadeus/index.json`)) return migrateV2(io, pagePath, now)
  if (raw == null) return newPage(io, pagePath, now)

  const fm = parseFrontmatter(raw)
  if (!fm.amadeus_page) return importForeign(pagePath, raw, now)

  const { page, renumbered } = parseV3(pagePath, raw, fm, now)
  if (renumbered) {
    // Persist the one-time legacy-id cleanup so the file shows clean numbers too.
    const contents: Record<BlockId, string> = {}
    for (const [id, b] of Object.entries(page.blocks)) contents[id] = b.content
    await savePage(io, pagePath, page.manifest, { contents })
  }
  return page
}

/** Parse a full page-source string (frontmatter + `<!-- a id -->` marker body, or foreign
 *  markdown without markers) into an in-memory page — the inverse of compile(). Pure (no disk);
 *  used by the renderer's source-Markdown editor to round-trip raw edits back into the model. */
export function parsePageSource(pagePath: string, raw: string, now: string): LoadedPage {
  const fm = parseFrontmatter(raw)
  if (!fm.amadeus_page) return importForeign(pagePath, raw, now)
  const major = schemaMajorOf(fm)
  if (major != null && major > SCHEMA_MAJOR) return futureSchemaPage(pagePath, raw, fm, now)
  return parseV3(pagePath, raw, fm, now).page
}

/** Migrate an old v1 page (`.<base>.amadeus.json` manifest + `.<base>.b_*.md` sidecars) inline. */
async function migrateV1(io: CompilerIO, pagePath: string, now: string): Promise<LoadedPage> {
  const base = stripPageBasename(pagePath)
  const oldName = `.${base}.amadeus.json`
  const old = JSON.parse(await io.readFile(oldName)) as {
    id?: string
    createdAt?: string
    root?: StackNode
    blocks?: Record<string, { type?: string; file?: string }>
  }
  const blockTypes: Record<BlockId, string> = {}
  const contents: Record<BlockId, string> = {}
  const remap = new Map<string, string>()
  let allRead = true
  let i = 0
  for (const [oldId, entry] of Object.entries(old.blocks ?? {})) {
    const id = String(++i) // migrate straight to clean numeric ids
    remap.set(oldId, id)
    blockTypes[id] = entry.type ?? 'markdown'
    try {
      contents[id] = await io.readFile(entry.file ?? `.${base}.${oldId}.md`)
    } catch {
      contents[id] = ''
      allRead = false
    }
  }
  // 迁移会立刻重写 main.md——外来 frontmatter(Obsidian properties)必须先捞出来,否则一次打开即销毁。
  let fmExtra = ''
  try {
    fmExtra = extractFrontmatterExtra(await io.readFile(pageFileName(pagePath)))
  } catch { /* v1 可能没有 main.md 投影 */ }
  const page = buildPage(pagePath, old.id ?? generatePageId(), remapLayout(old.root ?? EMPTY_STACK, remap), blockTypes, contents, old.createdAt ?? now, now, fmExtra)
  await savePage(io, pagePath, page.manifest, { contents })
  if (allRead) {
    try {
      for (const n of await io.listDir()) {
        if (n === oldName || n.startsWith(`.${base}.b_`)) await io.deleteFile(n)
      }
    } catch {
      /* best-effort cleanup */
    }
  }
  return page
}

/** Migrate a v2 folder bundle (`<base>.amadeus/index.json` + `<id>.block.md` files) inline. */
async function migrateV2(io: CompilerIO, pagePath: string, now: string): Promise<LoadedPage> {
  const base = stripPageBasename(pagePath)
  const folder = `${base}.amadeus`
  const idx = JSON.parse(await io.readFile(`${folder}/index.json`)) as {
    ownerId?: string
    createdAt?: string
    blocks?: Record<string, { type?: string }>
  }
  let layout: StackNode = EMPTY_STACK
  let fmExtra = ''
  try {
    const raw = await io.readFile(pageFileName(pagePath))
    layout = parseLayout(parseFrontmatter(raw).amadeus_layout)
    fmExtra = extractFrontmatterExtra(raw) // 迁移即重写文件,外来 fm 必须保留
  } catch {
    layout = EMPTY_STACK
  }
  const blockTypes: Record<BlockId, string> = {}
  const contents: Record<BlockId, string> = {}
  const remap = new Map<string, string>()
  let allRead = true
  let i = 0
  for (const [oldId, entry] of Object.entries(idx.blocks ?? {})) {
    const id = String(++i) // migrate straight to clean numeric ids
    remap.set(oldId, id)
    blockTypes[id] = entry.type ?? 'markdown'
    try {
      contents[id] = await io.readFile(`${folder}/${oldId}.block.md`)
    } catch {
      contents[id] = ''
      allRead = false
    }
  }
  const page = buildPage(pagePath, idx.ownerId ?? generatePageId(), remapLayout(layout, remap), blockTypes, contents, idx.createdAt ?? now, now, fmExtra)
  await savePage(io, pagePath, page.manifest, { contents })
  if (allRead) {
    try {
      if (io.removeDir) await io.removeDir(folder)
      else for (const n of await io.listDir(folder)) await io.deleteFile(`${folder}/${n}`)
    } catch {
      /* best-effort cleanup */
    }
  }
  return page
}
