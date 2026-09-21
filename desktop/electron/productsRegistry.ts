/**
 * Creations(造物)Space 的产物注册表 —— 托管根(~/Forsion/Project)的每个直接子目录 = 一个产物。
 * 身份落在项目目录里的 sidecar(`.forsion-product.json`)而**不在路径里**:改文件夹名 / 挪位置之后,
 * 桌面快捷方式与预览的稳定源都还认得同一个产物。
 *
 * 无 Electron 依赖(纯 node fs/path/crypto),宿主只负责 IPC 信任;containment 在这里,
 * 渲染层给的目录参数一律先过 `containedName`,落盘 entry 一律先过 `insideProject`。
 */
import { existsSync, promises as fs, type Dirent, type Stats } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { PRODUCT_SIDECAR, type ProductKind, type ProductSummary } from '../shared/products'

/** 存在即「经 Forsion Connect 发布过」。 */
const CONNECT_MARKER = '.forsion-connect.json'
/** 身份文件 / 插件清单就几百字节;更大的当作没有,别在每次扫描里 slurp 一坨东西。 */
const MAX_JSON_BYTES = 1024 * 1024
const MAX_NAME = 100
/**
 * 找入口 html 的浅搜预算:深度(根的直接子项算 1)、**读过的目录数**、以及目录项总数的硬顶。
 * ⚠️预算记在目录上而不是目录项上:记在目录项上时,根目录下几百个 a0000.txt 就能在进第一个子目录
 * 之前把额度烧光,一个只有 `zapp/index.html` 的项目会被判成 unknown(点不开,还不给理由)。
 * 目录项那一档只是防一棵超大的树把扫描拖住,正常项目碰不到。
 */
const WALK_DEPTH = 3
const WALK_DIRS = 400
const WALK_ENTRIES = 20_000
/** 点开头的目录(含 .git)已被点名规则挡掉,这里只列不带点的。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out'])
const HTML = /\.html?$/i
const KINDS: readonly ProductKind[] = ['web', 'plugin', 'unknown']
/** macOS / Windows 的卷默认大小写不敏感:`<root>/DEMO` 打开的就是磁盘上的 `demo`。 */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32'

export function isProductId(v: unknown): v is string {
  return typeof v === 'string' && /^p_[0-9a-f]{12}$/.test(v)
}

const isKind = (v: unknown): v is ProductKind => KINDS.includes(v as ProductKind)
const newId = (): string => `p_${randomBytes(6).toString('hex')}`

/** 目录出生时间;有的文件系统不给 birthtime(0),退回 ctime。 */
const birthOf = (st: Stats): number => (Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs)

/** 含控制字符(含 NUL)。用 charCodeAt 判而不是写 \u 转义 —— 源码里不留真控制字节。 */
const hasControl = (v: string): boolean => [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

/**
 * 含 Unicode 双向覆写字符:U+202A-U+202E、U+2066-U+2069、U+200E、U+200F。
 * 产物名会被 productShortcut 原样当**落盘文件名**用,一个 U+202E 就能把桌面上的 `x.lnk` 渲染成
 * `x.png`(LNK-RTLO 伪装);名字可以来自导入 / 下载来的项目目录里的 sidecar,不是只有 IPC 改名那条路。
 * 只剥这一小撮 Cf,不碰 ZWJ / VS16(组合 emoji 还得活着)。同样用码点判,源码里不留不可见字符。
 */
const hasBidi = (v: string): boolean => [...v].some((c) => {
  const code = c.charCodeAt(0)
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x200e || code === 0x200f
})

/** entry 的语法闸(不含存在性):相对、正斜杠、不出目录、无控制字符。 */
function safeEntry(v: string): boolean {
  return !!v && !/[\\:]/.test(v) && !hasControl(v) && !v.startsWith('/') && v.split('/').every((part) => !!part && part !== '.' && part !== '..')
}

/** 末端必须是真文件 —— lstat,软链不认。 */
async function isFile(file: string): Promise<boolean> {
  try { return (await fs.lstat(file)).isFile() } catch { return false }
}

/**
 * entry 的落盘闸:`safeEntry` 只看字符串,`isFile` 只 lstat **末端** —— 中间那几段要是软链
 * (`esc/ -> ~/.ssh`),两道闸都看不见,`esc/id_rsa.html` 就是一条任意读的口子。
 * realpath 之后必须仍在项目目录里。写(updateProduct)与读(summarize)两条路都要过:
 * 手工塞进项目里的 sidecar 从来不经过 updateProduct。
 */
async function insideProject(root: string, entry: string): Promise<boolean> {
  try {
    const base = await fs.realpath(root)
    const real = await fs.realpath(path.join(root, entry))
    return real === base || real.startsWith(base + path.sep)
  } catch { return false }
}

// ── sidecar 读写 ───────────────────────────────────────────────────────────────

interface Sidecar { [key: string]: unknown; version: number; id: string; createdAt: number }

/** 读一个 JSON 对象;读不到 / 不是对象 / 太大 → null。绝不抛,更不删用户文件。 */
async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const st = await fs.lstat(file)
    if (!st.isFile() || st.size > MAX_JSON_BYTES) return null
    const raw: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch { return null }
}

const readRaw = (dir: string): Promise<Record<string, unknown> | null> => readJsonObject(path.join(dir, PRODUCT_SIDECAR))

/**
 * 原文里的身份是否齐全。不齐 = 当作没身份重铸,但**其余字段照样保留**(用户/别的模块写进去的东西不该被抹掉)。
 * ⚠️version 只判「是不是个 ≥1 的数」,不钉死 1:一份 `version: 2` 的 sidecar 是**能解析、有 id** 的,
 * 重铸它等于把产物的身份销毁 —— 所有 `forsion://open?...&id=` 快捷方式当场断头,预览的 pinned token
 * 换新 origin,产物自己的 localStorage 全丢。重铸只留给解析不了 / 根本没 id 的那种。
 */
const identified = (raw: Record<string, unknown> | null): raw is Sidecar =>
  !!raw && typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 1
  && isProductId(raw.id) && typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) && raw.createdAt > 0

/** 铸一个新身份。重铸 = 新产物身份,createdAt 一并刷新;未知字段沿用。 */
const mint = (base: Record<string, unknown> | null): Sidecar => ({ ...(base ?? {}), version: 1, id: newId(), createdAt: Date.now() })

/** 原子写:同目录 tmp + rename(半截文件不会被下次扫描读到)。不是密文,不需要 0600。 */
async function writeSidecar(dir: string, sidecar: Sidecar): Promise<void> {
  const tmp = path.join(dir, `${PRODUCT_SIDECAR}.${randomBytes(3).toString('hex')}.tmp`)
  try {
    await fs.writeFile(tmp, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: 'wx' })
    await fs.rename(tmp, path.join(dir, PRODUCT_SIDECAR))
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

// ── 判型 ──────────────────────────────────────────────────────────────────────

/**
 * 浅搜入口 html:根 index.html 优先,其次深度 ≤3 里的子目录 index.html,再其次字典序第一个 html。
 * 逐层(BFS)而不是一头扎到底 —— 见 WALK_DIRS 上那条注释,预算必须先够走到子目录。
 */
async function findHtml(dir: string): Promise<string | null> {
  if (await isFile(path.join(dir, 'index.html'))) return 'index.html'
  const found: { rel: string; depth: number }[] = []
  let dirs = 0
  let entries = 0
  let level = ['']
  for (let depth = 1; depth <= WALK_DEPTH && level.length && entries < WALK_ENTRIES; depth++) {
    const next: string[] = []
    for (const rel of level) {
      if (++dirs > WALK_DIRS || entries >= WALK_ENTRIES) break
      let items: Dirent[]
      try { items = await fs.readdir(path.join(dir, rel), { withFileTypes: true }) } catch { continue }
      for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++entries > WALK_ENTRIES) break
        if (item.name.startsWith('.') || item.isSymbolicLink()) continue // 软链不跟随
        const child = rel ? `${rel}/${item.name}` : item.name
        if (item.isDirectory()) {
          if (depth < WALK_DEPTH && !SKIP_DIRS.has(item.name.toLowerCase())) next.push(child)
          continue
        }
        if (item.isFile() && HTML.test(item.name)) found.push({ rel: child, depth })
      }
    }
    if (dirs > WALK_DIRS) break
    level = next
  }
  found.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel))
  return (found.find((f) => f.rel.toLowerCase().endsWith('/index.html')) ?? found[0])?.rel ?? null
}

/** 判型表:插件 → web → unknown。新种类在这里加一行。任何 IO 错都落 unknown,**不抛**(判型不该拖垮列表)。 */
export async function detectKind(dir: string): Promise<{ kind: ProductKind; entry: string | null; pluginId?: string }> {
  const manifest = await readJsonObject(path.join(dir, 'manifest.json'))
  // ⚠️PWA 的清单也叫 manifest.json:必须 main + apiVersion + id 三项齐全才算 Forsion 插件,
  //   只看文件名会把一个普通 web app 判成插件(判错了「继续编辑」就变成「加载插件」)。
  if (manifest
    && typeof manifest.main === 'string' && manifest.main
    && typeof manifest.apiVersion === 'number' && Number.isFinite(manifest.apiVersion)
    && typeof manifest.id === 'string' && manifest.id) {
    return { kind: 'plugin', entry: null, pluginId: manifest.id }
  }
  const entry = await findHtml(dir)
  return entry ? { kind: 'web', entry } : { kind: 'unknown', entry: null }
}

// ── 索引(一遍扫全表)───────────────────────────────────────────────────────────

interface Indexed { root: string; name: string; sidecar: Sidecar; updatedAt: number }

/** 同一个目录只喊一次,别让每次 products:list 都往日志里刷同一行。 */
const warned = new Set<string>()
function warnOnce(key: string, message: string, detail: unknown): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(message, detail)
}

/** 托管根 → realpath;不存在 / 不是目录一律抛。 */
async function realRoot(projectsRoot: string): Promise<string> {
  const real = await fs.realpath(projectsRoot)
  if (!(await fs.stat(real)).isDirectory()) throw new Error('Projects root is not a directory')
  return real
}

/**
 * containment(信任边界 —— 深链与 IPC 参数直达这里):必须是托管根 realpath 后的**直接子目录**,
 * 自己是真目录且**不是软链**(lstat),名字不以 '.' 开头。不合格一律抛,绝不读写目录之外。
 */
async function containedName(rootReal: string, dir: string): Promise<string> {
  const abs = path.resolve(dir)
  const name = path.basename(abs)
  if (!name || name.startsWith('.')) throw new Error(`Not a managed project: ${dir}`)
  // 父目录 realpath 后必须正是托管根 —— `<root>/a/b`、`<root>/../x`、别处的绝对路径全落在外面。
  const parent = await fs.realpath(path.dirname(abs)).catch(() => null)
  if (parent !== rootReal) throw new Error(`Not a managed project: ${dir}`)
  const st = await fs.lstat(path.join(rootReal, name)).catch(() => null)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new Error(`Not a managed project directory: ${dir}`)
  return name
}

/**
 * 名字闸(读写同一把):trim 后 1..100、无控制字符、无双向覆写字符。
 * 合格返回 trim 过的名字,不合格返回该抛的话。
 */
function nameIssue(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > MAX_NAME) return `Product name must be 1-${MAX_NAME} characters`
  if (hasControl(name)) return 'Product name must not contain control characters'
  if (hasBidi(name)) return 'Product name must not contain bidirectional control characters'
  return null
}

function validName(value: unknown): string {
  const issue = nameIssue(value)
  if (issue) throw new Error(issue)
  return (value as string).trim()
}

/**
 * sidecar 里的名字走**同一把闸**再用,不合格就退回文件夹名。
 * ⚠️读这条路比 IPC 改名那条更需要闸:项目目录是用户从别处克隆 / 下载来的,sidecar 里可以是任意串,
 *   而这个名字下游会直接当桌面快捷方式的文件名落盘。
 */
const readName = (value: unknown, fallback: string): string => (nameIssue(value) ? fallback : (value as string).trim())

/**
 * 扫一遍托管根:合法产物目录 + 身份。缺 sidecar 的当场补(老项目就是这样拿到身份的),
 * 重复 id 判一个赢家、输家重铸。**只读 sidecar,不判型** —— 判型走 summarize,别让每次 IPC 都去遍历目录树。
 *
 * ponytail: 串行 fs 调用就够了(托管根下最多几百个目录),不做并发 / 不缓存 —— 用户在访达里改了东西
 * 就该立刻看见,缓存的失效逻辑比这几毫秒贵。
 */
async function index(rootReal: string): Promise<Indexed[]> {
  const dirents = await fs.readdir(rootReal, { withFileTypes: true })
  interface Found { root: string; name: string; raw: Record<string, unknown> | null; sidecar: Sidecar | null; updatedAt: number; birth: number }
  const found: Found[] = []
  for (const entry of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || !entry.isDirectory() || entry.isSymbolicLink()) continue
    const root = path.join(rootReal, entry.name)
    try {
      const st = await fs.lstat(root)
      if (st.isSymbolicLink() || !st.isDirectory()) continue // 软链项目一律不认,绝不跟随
      const raw = await readRaw(root)
      // ⚠️先 stat 再补 sidecar:写 sidecar 会顶起目录 mtime,updatedAt 要的是补写**之前**那个,
      //   否则首次扫描会把整个栅格按「刚才补了谁」重排。
      found.push({ root, name: entry.name, raw, sidecar: identified(raw) ? raw : null, updatedAt: st.mtimeMs, birth: birthOf(st) })
    } catch { /* 单个项目坏掉(权限/竞态删除)不拖垮整张表 */ }
  }

  // 重复 id = 用户在访达里整个复制了一份项目(sidecar 连 createdAt 一起被复制,两边完全相同)。
  // 判据落在目录 birthtime:老的留着 id,新的重铸。必须确定,且**绝不两边都铸**(否则快捷方式两头落空)。
  const byId = new Map<string, Found[]>()
  for (const f of found) {
    if (!f.sidecar) continue
    const group = byId.get(f.sidecar.id)
    if (group) group.push(f)
    else byId.set(f.sidecar.id, [f])
  }
  const losers = new Set<Found>()
  for (const group of byId.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => a.birth - b.birth || a.name.localeCompare(b.name)) // birthtime 也相同时按名字兜底,保证可重复
    for (const loser of group.slice(1)) losers.add(loser)
  }

  const indexed: Indexed[] = []
  for (const f of found) {
    let sidecar = f.sidecar
    try {
      if (!sidecar || losers.has(f)) {
        sidecar = mint(f.raw)
        await writeSidecar(f.root, sidecar)
      }
      indexed.push({ root: f.root, name: f.name, sidecar, updatedAt: f.updatedAt })
    } catch (e) {
      // 写不进 sidecar(只读盘/权限):跳过,别给出一个落盘上不存在的临时身份。
      // ponytail: 行为不改(这一行就是会从栅格里消失),但**至少喊一声** —— 否则用户看到的是产物凭空没了,
      // 日志里一点线索都没有;预览那边还会静默退到一个一次性 origin。
      warnOnce(f.root, `[products] 写不进产物身份(只读或无权限?),该项目不会出现在列表里:${f.root}`, e)
    }
  }
  return indexed
}

// 注册表按托管根串行。首启补 sidecar 时,渲染层的 products:list 会和预览那条 ensureProduct 撞在同一个
// 目录上:两边都看不到 sidecar → 各铸一个 id → 后一次 rename 赢,另一边手里的 id 落盘上根本不存在
// (快捷方式与稳定源当场作废)。键用 realpath 后的根,不是原始字符串。
const chains = new Map<string, Promise<unknown>>()
async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
  chains.set(key, next)
  try { return await next } finally { if (chains.get(key) === next) chains.delete(key) }
}

/** 一条索引 → 对外的 ProductSummary(判型在这一步,只读)。 */
async function summarize(record: Indexed): Promise<ProductSummary> {
  const sidecar = record.sidecar
  const detected = await detectKind(record.root)
  const kind = isKind(sidecar.kind) ? sidecar.kind : detected.kind
  // 显式存下的 entry 赢过判型;但它要是被删了 / 改了名 / 靠软链指到了项目外面,就退回判型 ——
  // 别让产物永远打不开,也别把项目外的文件当成入口交出去。
  const stored = typeof sidecar.entry === 'string' && safeEntry(sidecar.entry)
    && await isFile(path.join(record.root, sidecar.entry))
    && await insideProject(record.root, sidecar.entry)
    ? sidecar.entry
    : null
  return {
    id: sidecar.id,
    kind,
    name: readName(sidecar.name, record.name),
    root: record.root,
    entry: stored ?? (kind === 'web' ? detected.entry : null),
    createdAt: sidecar.createdAt,
    updatedAt: record.updatedAt,
    published: existsSync(path.join(record.root, CONNECT_MARKER)),
    // pluginId 跟**生效后的** kind 走:sidecar 把 kind 改成 web 就不该再挂着插件 id,
    // 反过来一个没有清单的目录被标成 plugin 也变不出 id(那种 patch 已在 updateProduct 挡掉)。
    ...(kind === 'plugin' && detected.pluginId ? { pluginId: detected.pluginId } : {}),
    // ⚠️devLoad **不从 sidecar 读**:sidecar 在不可信的项目目录里,而 devLoad = 「把这个目录的代码当插件执行」。
    // 授权住在宿主家目录(electron/devLoadStore.ts),由 IPC 层叠加进 summary;这里读了就等于把钥匙交给克隆来的文件夹。
  }
}

// ── 对外 API ──────────────────────────────────────────────────────────────────

/** 托管根下的全部产物,updatedAt 倒序。缺 sidecar 的顺手补上;根不存在 / 单个项目坏掉都只是少一行,不抛。 */
export async function scanProducts(projectsRoot: string): Promise<ProductSummary[]> {
  const rootReal = await realRoot(projectsRoot).catch(() => null)
  if (!rootReal) return [] // 托管根还没建 → 空表,不是错误
  const records = await serialized(rootReal, () => index(rootReal)).catch(() => [] as Indexed[])
  const products: ProductSummary[] = []
  for (const record of records) {
    try { products.push(await summarize(record)) } catch { /* 同上:一个坏项目不该清空列表 */ }
  }
  return products.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

/** 按 id 取;id 形状不对 / 找不到 → null。 */
export async function getProduct(projectsRoot: string, id: string): Promise<ProductSummary | null> {
  if (!isProductId(id)) return null
  const rootReal = await realRoot(projectsRoot).catch(() => null)
  if (!rootReal) return null
  const records = await serialized(rootReal, () => index(rootReal)).catch(() => [] as Indexed[])
  const record = records.find((r) => r.sidecar.id === id)
  return record ? summarize(record) : null
}

/** 给一个目录拿到(必要时铸出)它的产物身份。containment 不过一律抛;目录必须已经存在,这里不负责创建。 */
export async function ensureProduct(projectsRoot: string, dir: string): Promise<ProductSummary> {
  const rootReal = await realRoot(projectsRoot)
  const name = await containedName(rootReal, dir)
  // 走整张表而不是只补这一个目录:复制来的项目要在这里就把重复 id 判掉,否则稳定源先按旧 id 起、
  // 等某次 scan 重铸后又换一个源 —— 预览里存的本地数据会凭空消失。
  const records = await serialized(rootReal, () => index(rootReal))
  // ⚠️先精确匹配,再在大小写不敏感的卷上放宽:`<root>/DEMO` 在 APFS / NTFS 上 lstat 得到的是磁盘上的
  //   `demo`,containedName 放行、索引里却按 dirent 的 `demo` 记名,精确匹配会在这里假性失败 ——
  //   调用方(previewOriginFor)吞掉这一抛就退到一次性 origin,产物的 localStorage 活不到「启动」。
  //   顺序不能反:卷要真是大小写敏感的、`demo` 与 `DEMO` 同时存在时,精确的那个才是对的。
  const record = records.find((r) => r.name === name)
    ?? (CASE_INSENSITIVE_FS ? records.find((r) => r.name.toLowerCase() === name.toLowerCase()) : undefined)
  if (!record) throw new Error(`Product directory is unavailable: ${name}`)
  return summarize(record)
}

/** 改产物的名字 / 入口 / 种类。字段一律校验,非法就抛(参数来自渲染层)。devLoad 不归这里管(见 devLoadStore)。 */
export async function updateProduct(
  projectsRoot: string,
  id: string,
  patch: { name?: string; entry?: string | null; kind?: ProductKind },
): Promise<ProductSummary> {
  if (!isProductId(id)) throw new Error('Invalid product id')
  const rootReal = await realRoot(projectsRoot)
  const record = await serialized(rootReal, async () => {
    const hit = (await index(rootReal)).find((r) => r.sidecar.id === id)
    if (!hit) throw new Error(`Unknown product: ${id}`)
    const next: Sidecar = { ...hit.sidecar } // 展开旧对象 = 未知字段原样留下
    if (patch.name !== undefined) next.name = validName(patch.name)
    if (patch.entry === null) next.entry = null
    else if (patch.entry !== undefined) next.entry = await validEntry(hit.root, patch.entry)
    if (patch.kind !== undefined) {
      if (!isKind(patch.kind)) throw new Error(`Invalid product kind: ${String(patch.kind)}`)
      // pluginId 只能来自真清单:放任一个没有 manifest.json 的目录标成 plugin,summary 里就会出现
      // 一个**没有 pluginId 的插件**,下游按 kind 分支的代码统统拿到 undefined。
      if (patch.kind === 'plugin' && (await detectKind(hit.root)).kind !== 'plugin') {
        throw new Error('Product kind must not be plugin without a plugin manifest')
      }
      next.kind = patch.kind
    }
    // 一个字段都没变(空 patch = 渲染层一次没带字段的往返)就别写:原子写会换掉 inode、顶起目录 mtime,
    // 于是这一行在 updatedAt 倒序的栅格里凭空跳到最前面 —— 什么都没改,位置却动了。
    if (JSON.stringify(next) === JSON.stringify(hit.sidecar)) return hit
    await writeSidecar(hit.root, next)
    // 写完目录 mtime 变了,updatedAt 重新取一次,别让刚改完的产物在栅格里排到旧位置。
    const updatedAt = await fs.stat(hit.root).then((st) => st.mtimeMs).catch(() => hit.updatedAt)
    return { ...hit, sidecar: next, updatedAt }
  })
  return summarize(record)
}

async function validEntry(root: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || !safeEntry(value)) throw new Error(`Product entry must be a relative path inside the project: ${String(value)}`)
  if (!(await isFile(path.join(root, value)))) throw new Error(`Product entry is not a file in the project: ${value}`)
  if (!(await insideProject(root, value))) throw new Error(`Product entry must stay inside the project: ${value}`)
  return value
}
