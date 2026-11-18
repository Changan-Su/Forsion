/**
 * Android App 的 Forsion 插件宿主(2026-10-02):应用级插件目录,**不在任何笔记库里**(云端库 / 本地库两种模式同一份)。
 *
 *   <Data>/plugins/<slug>/{manifest.json, main.js, README.md, CHANGELOG.md, icon.png}   ← 市场装进来(mobileMarket.ts)
 *   <Data>/plugins-data/<id>.json + <id>.json.alt                                        ← ctx.loadData / ctx.saveData
 *   <Data>/plugins-data/.ext-tombstones.json + .alt                                      ← 已卸载插件声明过的文件后缀(见 fileExtensions)
 *
 * 契约 = 桌面主进程 electron/amadeus/ipc.ts 的 listPlugins / uninstallPlugin / readPluginData / writePluginData:
 * 同一套 id 规则(effectivePluginId)、同一个门禁(gatePluginManifest)、同一份 manifest 映射(installedPluginFields)、
 * 同口径的图标校验(isValidPluginIconPng)。差异只有三处,都是「手机上做不到」:
 *   · manifest `isDesktopOnly: true` → 列出为 blocked:'desktopOnly',代码不读不发;
 *   · 不清点 bundle(内嵌引擎插件 / Agent / 技能在手机上没有消费者;报了 bundle,市场装完会去叫云端引擎重扫);
 *   · 没有可见插件目录 → hostCaps.pluginsFolder=false(设置页不渲染「打开文件夹 / 创建示例」两个死键)。
 * 包里带的 **Space**(`spaces/<slug>/space.json`)手机上有消费者(底部导航栏):listSpaces = 桌面 `spaces:list`
 * 里插件那一半,同一形状,渲染层的 userSpaces.loadUserSpaces 不改一行就认。2026-10-09 之前漏了这条 ——
 * 商店里的插件大多把 Space 写在包里,装上以后命令 / 视图都在,唯独 Space 不出现。
 *
 * 本模块不 import Capacitor(经 PluginFs 接缝),单测见 mobile/scripts/plugin-host.test.cjs。
 */
import { gatePluginManifest, type ExternalPluginSource, type SupersededInstall } from '../../../desktop/shared/amadeus/ipc'
import { installedPluginFields, type InstalledPluginManifest } from '../../../desktop/shared/amadeus/pluginSource'
import { bindRecipeToPlugin, effectivePluginId } from '../../../desktop/shared/products'
import { supersededPlainInstalls } from '../../../desktop/shared/pluginAliases'
import { isSafeSlug, safeEntryPath } from '../../../desktop/shared/marketPackage'
import { isSafePluginExt } from '../../../desktop/shared/amadeus/pluginFiles'
import { PLUGIN_ICON_MAX_BYTES, isValidPluginIconPng } from '../../../desktop/shared/pluginIcon'
import { spaceIconFileOf, spaceIconMaxBytes, spaceIconMime } from '../../../desktop/shared/spaceIcon'
import { bytesToBase64, readText, readTextOr, withPluginDirLock, writeText, type PluginFs } from './pluginFs'

export const PLUGINS_DIR = 'plugins'
export const PLUGIN_DATA_DIR = 'plugins-data'
const DOC_CAP = 65536

/** 一份插件 Space 配方(形状 = 桌面 preload 的 spacesList 条目;`plugin` = 所属插件的生效 id)。 */
export interface PluginSpaceRecipe { slug: string; json: string; plugin: string; iconUrl?: string }

export interface MobilePluginHost {
  listPlugins(): Promise<ExternalPluginSource[]>
  listSpaces(): Promise<PluginSpaceRecipe[]>
  /** 「磁盘上是 .md、内容归插件管」的文件后缀(小写、排好序):库这一层据此把它们排出笔记列表。
   *  来源 = 每个已安装插件 manifest 的 fileExtensions(**不看**门禁 / 仅桌面 / 用户关没关)+ 已卸载插件留下的墓碑。 */
  fileExtensions(): Promise<string[]>
  /** withSuperseded:目标是商店安装时,被它取代的旧普通目录一起删(桌面同名选项;否则卸完旧副本立刻重新运行)。 */
  uninstallPlugin(id: string, opts?: { withSuperseded?: boolean; dir?: string }): Promise<void>
  readPluginData(pluginId: string): Promise<string | null>
  /** opts.backup:写之前先把当前那槽另存成 <槽>.replaced-<时间>(另存失败就不写、抛出去)。同桌面同名选项。 */
  writePluginData(pluginId: string, text: string, opts?: { backup?: boolean }): Promise<void>
}

/** 读 manifest.json(必须是 JSON 对象);读不到 / 坏 → null。 */
/** manifest.requiresApp:这个插件依赖一个装在**电脑**上的应用(如 ActivityWatch;桌面在插件详情页给它一键安装 / 探测)。
 *  手机上没有这个应用可装,插件装上也只是个空壳 —— 与 isDesktopOnly 同一档处理:不给装,已在盘上的不读不跑。
 *  返回声明的应用 id;没声明(缺 / 空串 / 非字符串)= null。
 *  ponytail: 有声明一律算桌面专属;哪天依赖表(desktop/shared/knownApps.ts)里出现手机上也有的应用,改成查那张表。 */
export const requiredDesktopApp = (m: { requiresApp?: unknown } | null): string | null =>
  typeof m?.requiresApp === 'string' && m.requiresApp.trim() ? m.requiresApp.trim() : null

export async function readManifest(fs: PluginFs, dir: string): Promise<InstalledPluginManifest | null> {
  try {
    const m: unknown = JSON.parse(await readText(fs, `${dir}/manifest.json`))
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as InstalledPluginManifest) : null
  } catch {
    return null
  }
}

/** 要装载的插件目录:pluginDirNames 去掉被商店安装取代的普通目录(同一个包装了两份时只认商店那份;
 *  桌面 readExternalPlugins / readSpacesList 与引擎扫捆绑包同一条规则 supersededPlainInstalls)。卸载仍按全部目录找。 */
export async function loadablePluginDirNames(fs: PluginFs): Promise<string[]> {
  const names = await pluginDirNames(fs)
  const replaced = supersededPlainInstalls(await Promise.all(names.map(async (dir) => ({ dir, manifestId: (await readManifest(fs, `${PLUGINS_DIR}/${dir}`))?.id }))))
  return names.filter((name) => !replaced.has(name))
}

/** 插件目录下的子目录名(跳过点目录;根不存在 = 一个都没装)。按名排序:同 id 两份时先到先得要确定。 */
export async function pluginDirNames(fs: PluginFs): Promise<string[]> {
  try {
    return (await fs.list(PLUGINS_DIR))
      .filter((e) => e.type === 'directory' && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

// ── 安装切换的中断恢复 ────────────────────────────────────────────────────────────────────
// 市场安装(mobileMarket.ts)不直接往 plugins/<slug> 里写:新版先完整写进暂存目录,再「旧 → 备份、暂存 → 正式、删备份」。
// 两个目录名都以点开头:pluginDirNames 本来就跳过点目录,所以它们**永远不会被当成插件列出来**;slug 是 kebab
// (isSafeSlug 要求字母数字开头),不可能与它们撞名。
export const STAGING_PREFIX = '.staging-'
export const BACKUP_PREFIX = '.backup-'
export const stagingDirOf = (slug: string): string => `${PLUGINS_DIR}/${STAGING_PREFIX}${slug}`
export const backupDirOf = (slug: string): string => `${PLUGINS_DIR}/${BACKUP_PREFIX}${slug}`

/**
 * 收拾上一次没走完的安装(进程在切换中途被杀 / 改名失败)。调用方必须持有 withPluginDirLock。
 * 不变量:**备份目录还在 = 切换没有确认完成**。按现场三种情况处理 ——
 *   · 备份在、正式目录不在                → 旧版挪回去(刚把旧版挪走就没了下文);
 *   · 备份在、正式目录在、暂存目录也在     → 「暂存 → 正式」走的是复制 + 删源的非原子分支,且没走完:正式目录是半截,
 *                                            删掉、旧版挪回去;
 *   · 备份在、正式目录在、暂存目录不在     → 切换已完成,只差删备份:删掉备份,保留新版。
 * 之后所有暂存目录一律删掉(没切换成功的新版不保留,下次重装)。
 * 做不到的边角(只在非原子改名分支上):全新安装「暂存 → 正式」复制到一半被杀,与「暂存刚写完、旧版还在原地」
 * 在盘面上无法区分 → 保守地保留正式目录;半截目录缺 manifest / main 时 listPlugins 本来就不列。
 */
export async function recoverPluginDirs(fs: PluginFs): Promise<void> {
  let names: string[]
  try {
    names = (await fs.list(PLUGINS_DIR)).filter((e) => e.type === 'directory').map((e) => e.name)
  } catch {
    return // 插件根还不存在
  }
  const slugOf = (name: string, prefix: string): string | null => {
    const slug = name.startsWith(prefix) ? name.slice(prefix.length) : ''
    return isSafeSlug(slug) ? slug : null
  }
  for (const name of names) {
    const slug = slugOf(name, BACKUP_PREFIX)
    if (!slug) continue
    const final = `${PLUGINS_DIR}/${slug}`
    try {
      const hasFinal = !!(await fs.stat(final))
      if (hasFinal && !names.includes(`${STAGING_PREFIX}${slug}`)) {
        await fs.removeDir(backupDirOf(slug))
      } else {
        if (hasFinal) await fs.removeDir(final)
        await fs.rename(backupDirOf(slug), final)
      }
    } catch (e) {
      console.warn(`[plugins] 恢复插件 "${slug}" 的中断安装失败,下次启动再试`, e)
    }
  }
  for (const name of names) {
    const slug = slugOf(name, STAGING_PREFIX)
    if (slug) await fs.removeDir(stagingDirOf(slug)).catch(() => {})
  }
}

/** 暂存目录(写完整的新版)换进 plugins/<slug>:旧 → 备份、暂存 → 正式、删备份。调用方必须持有 withPluginDirLock。
 *  Android 的 rename 不覆盖已存在的目标,所以旧版必须先挪开;改名失败 / 进程被杀 → recoverPluginDirs 把旧版挪回去
 *  (这里当场做一次,下次清点 / 安装时还会再做)。市场安装与核心插件更新(coreUpdates.ts)共用。 */
export async function commitStagedDir(fs: PluginFs, slug: string): Promise<void> {
  const dir = `${PLUGINS_DIR}/${slug}`
  const backup = backupDirOf(slug)
  try {
    if (await fs.stat(dir)) await fs.rename(dir, backup)
    await fs.rename(stagingDirOf(slug), dir)
  } catch (e) {
    await recoverPluginDirs(fs).catch(() => {})
    throw e
  }
  // 新版已就位。备份删不掉不算失败:recoverPluginDirs 看到「备份在、正式在、暂存不在」会补删。
  await fs.removeDir(backup).catch(() => {})
}

/** manifest 里的 main(缺省 main.js)→ 包内安全相对路径;越界 / 绝对路径 → null(当作读不到 main)。 */
export function mainRelOf(main: unknown): string | null {
  if (main === undefined || main === null || main === '') return 'main.js'
  return typeof main === 'string' ? safeEntryPath(main, '') : null
}

async function readIcon(fs: PluginFs, dir: string): Promise<string | undefined> {
  try {
    const st = await fs.stat(`${dir}/icon.png`)
    if (!st || st.type !== 'file' || st.size > PLUGIN_ICON_MAX_BYTES) return undefined // 先看大小,超重的不读进内存
    const bytes = await fs.readBytes(`${dir}/icon.png`)
    return isValidPluginIconPng(bytes) ? `data:image/png;base64,${bytesToBase64(bytes)}` : undefined
  } catch {
    return undefined
  }
}

/** 一份 Space 配方的体积上限(真实配方几百字节)与一个插件最多带几个 Space —— 都只为挡住坏包,不是产品规格。 */
const SPACE_RECIPE_MAX_BYTES = 64 * 1024
const SPACES_PER_PLUGIN = 16

/** space.json 的 `iconFile` → data URL。查找次序同桌面(electron/spaceIcon.ts):Space 自己的目录 → 插件包根,
 *  所以 `"iconFile": "icon.png"` 且自己目录里没放图 = 直接用插件图标。读不到 / 不合规 → undefined(渲染层回落 `icon`)。 */
async function readSpaceIcon(fs: PluginFs, json: string, dirs: string[]): Promise<string | undefined> {
  const name = spaceIconFileOf(json)
  if (!name) return undefined
  for (const dir of dirs) {
    try {
      const st = await fs.stat(`${dir}/${name}`)
      if (!st || st.type !== 'file' || st.size > spaceIconMaxBytes(name)) continue // 先看大小,超重的不读进内存
      const bytes = await fs.readBytes(`${dir}/${name}`)
      const mime = spaceIconMime(name, bytes)
      if (mime) return `data:${mime};base64,${bytesToBase64(bytes)}`
    } catch { /* 这一层没有 → 试下一层 */ }
  }
  return undefined
}

// ── 插件私有数据:双槽 + 序号信封 ──────────────────────────────────────────────────────────
// 桌面是「写临时文件 → rename 覆盖」;Android 的 Filesystem.rename 不覆盖已存在的目标(且 move 的实现可能是
// 复制 + 删除),沿用那一套要么写不进去、要么在「删旧 → 改名」之间被杀留下一个都没有的窗口。这里换成:
//   · 两个槽 <id>.json / <id>.json.alt,每次写**较旧(或坏)的那一槽**,最新的有效槽永远不碰;
//   · 槽内容是信封 {"forsionPluginData":1,"seq":N,"text":"…"} —— JSON 对象的任何真前缀都不是合法 JSON,
//     写到一半被杀 = 那一槽解析失败,读取方自动落到另一槽(上一次成功写入的版本);
//   · 读 = 两槽里 seq 最大的有效信封。
// 不需要 rename、不依赖覆盖语义,也不存在「两份都不在」的瞬间。
// 一个有效槽都没有时(2026-11-17 起,读失败 ≠ 没写过):
//   · 两槽都不存在,或只有槽 0 且是半截(第一次写到一半被杀:从没成功存过)→ 没写过,null,与桌面同一出口;
//   · 其余(文件在却读不出来、两槽都坏)→ 读失败,抛出去,ctx.loadData 跟着 reject,插件不该按默认值往下走;
//     这时插件若仍要写:先把每个坏槽原样另存成 .unreadable-<时间>(有槽连字节都读不出来就拒写),
//     再写(优先写进不存在的那槽);序号用当前毫秒数,比任何残留槽的写入计数都大,残留槽以后读得出来也盖不住这次写。
interface DataEnvelope { forsionPluginData: 1; seq: number; text: string }
const slotPaths = (id: string): [string, string] => [`${PLUGIN_DATA_DIR}/${id}.json`, `${PLUGIN_DATA_DIR}/${id}.json.alt`]

const parseEnvelope = (raw: string): DataEnvelope | null => {
  try {
    const v = JSON.parse(raw) as Partial<DataEnvelope> | null
    if (v && v.forsionPluginData === 1 && Number.isSafeInteger(v.seq) && typeof v.text === 'string') return v as DataEnvelope
  } catch { /* 写到一半 */ }
  return null
}

/** 另存原件的文件名:<槽>.<unreadable|replaced>-<时间>-<序号>。写按插件串行,序号在本进程里递增 ——
 *  同一毫秒里同一槽另存两次(连着几次要求另存,槽轮回来)也不撞名、不互相盖掉。 */
let dataBackupSeq = 0
const dataBackupPath = (slot: string, kind: 'unreadable' | 'replaced'): string =>
  `${slot}.${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${++dataBackupSeq}`
const isJsonText = (t: string): boolean => { try { JSON.parse(t); return true } catch { return false } }

/** 一槽的状态:不存在 / 半截(信封解析不了)/ 读出错(在,但读不出字节)/ 有效。 */
type SlotState = { kind: 'missing' } | { kind: 'partial' } | { kind: 'unreadable' } | { kind: 'ok'; env: DataEnvelope }

async function readSlotState(fs: PluginFs, path: string): Promise<SlotState> {
  let raw: string
  try {
    raw = await readText(fs, path)
  } catch {
    // readBytes 不存在也抛:用 stat 分开「不存在」和「读出错」(stat 自己出错也算读出错)
    const st = await fs.stat(path).catch(() => undefined)
    return st === null ? { kind: 'missing' } : { kind: 'unreadable' }
  }
  const env = parseEnvelope(raw)
  return env ? { kind: 'ok', env } : { kind: 'partial' }
}

interface DataSlots {
  states: [SlotState, SlotState]
  /** 最新的有效槽;一个都没有 → null */
  latest: { slot: 0 | 1; env: DataEnvelope } | null
  /** 读失败:有一槽在却读不出字节(哪怕另一槽有效 —— 读不出来的那槽可能才是最新的),
   *  或者没有有效槽、又不是「没写过」 */
  unreadable: boolean
}

/** 读失败的错误:code 与渲染层 pluginLocalData 同名,reason 区分「字节读不出来」和「信封坏了」(插件可按它分支)。 */
const unreadableError = (r: DataSlots): Error =>
  Object.assign(new Error('plugin-data-unreadable'), {
    code: 'plugin-data-unreadable',
    reason: r.states.some((s) => s.kind === 'unreadable') ? 'read-failed' : 'invalid-json',
  })

async function readDataSlots(fs: PluginFs, id: string): Promise<DataSlots> {
  const [a, b] = slotPaths(id)
  const states = await Promise.all([readSlotState(fs, a), readSlotState(fs, b)]) as [SlotState, SlotState]
  const [sa, sb] = states
  const ea = sa.kind === 'ok' ? sa.env : null
  const eb = sb.kind === 'ok' ? sb.env : null
  const latest = ea && (!eb || ea.seq >= eb.seq) ? { slot: 0 as const, env: ea } : eb ? { slot: 1 as const, env: eb } : null
  const neverSaved = sb.kind === 'missing' && (sa.kind === 'missing' || sa.kind === 'partial')
  return { states, latest, unreadable: states.some((s) => s.kind === 'unreadable') || (!latest && !neverSaved) }
}

// ── 文件后缀的墓碑 ────────────────────────────────────────────────────────────────────────
// 插件卸载以后,它建过的 `.deck.md` 之类还留在库里。后缀豁免跟着 manifest 一起消失的话,这些文件就掉回笔记列表,
// 被索引 / 改名重写 / 笔记编辑器按笔记的写法改写(桌面同一件事:electron/amadeus/ipc.ts 的 plugins-ext-tombstones.json)。
// 存法沿用上面的双槽信封;槽名以点开头,不是合法的插件 id,撞不上任何插件的私有数据。只增不减。
const TOMBSTONE_SLOT = '.ext-tombstones'

/** manifest 声明的后缀里合规的那些(小写)。宿主只认专属后缀:裸 `.md` / `.txt` 这类一律不认(isSafePluginExt)。 */
const safeExtsOf = (m: InstalledPluginManifest | null): string[] =>
  Array.isArray(m?.fileExtensions) ? m.fileExtensions.filter(isSafePluginExt).map((x) => x.trim().toLowerCase()) : []

/** 墓碑的一槽。「没写过」与「写到一半的坏槽」= null(读取方落到另一槽);**文件在却读不出来** = 抛出去 ——
 *  把读失败当成「没有墓碑」的话,下一次卸载会拿一份缩水的名单盖上去,之前记下的后缀永久丢保护(Codex 评审 P1)。
 *  (插件私有数据 2026-11-17 起同一个口径,见 readDataSlots。) */
async function readTombstoneSlot(fs: PluginFs, path: string): Promise<DataEnvelope | null> {
  if (!(await fs.stat(path))) return null
  const raw = await readText(fs, path)
  try {
    const v = JSON.parse(raw) as Partial<DataEnvelope> | null
    if (v && v.forsionPluginData === 1 && Number.isSafeInteger(v.seq) && typeof v.text === 'string') return v as DataEnvelope
  } catch { /* 写到一半的槽:当它不存在 */ }
  return null
}

/** 最新的有效墓碑槽 + 里面的名单。读失败抛出去(见上)。 */
async function readTombstones(fs: PluginFs): Promise<{ slot: 0 | 1 | null; seq: number; exts: string[] }> {
  const [a, b] = slotPaths(TOMBSTONE_SLOT)
  const [ea, eb] = [await readTombstoneSlot(fs, a), await readTombstoneSlot(fs, b)]
  const pick = ea && (!eb || ea.seq >= eb.seq) ? { slot: 0 as const, env: ea } : eb ? { slot: 1 as const, env: eb } : null
  if (!pick) return { slot: null, seq: 0, exts: [] }
  let list: unknown = []
  try { list = JSON.parse(pick.env.text) } catch { /* 信封完好、正文不是 JSON:只可能是别人写的,当空 */ }
  return { slot: pick.slot, seq: pick.env.seq, exts: Array.isArray(list) ? list.filter(isSafePluginExt) : [] }
}

/** 卸载前调用(调用方持有 withPluginDirLock,还没删目录):把这个插件声明过的后缀记进墓碑。
 *  读不出现有墓碑 / 写不下去 → 抛,调用方不删目录(下次再卸):宁可卸载失败,也不让它的文件掉回笔记列表。 */
export async function tombstoneExtensions(fs: PluginFs, dir: string): Promise<void> {
  const claimed = safeExtsOf(await readManifest(fs, dir))
  if (!claimed.length) return
  const cur = await readTombstones(fs)
  const merged = [...new Set([...cur.exts, ...claimed])].sort()
  if (merged.length === cur.exts.length) return // 都记过了:不写
  const env: DataEnvelope = { forsionPluginData: 1, seq: cur.seq + 1, text: JSON.stringify(merged) }
  await writeText(fs, slotPaths(TOMBSTONE_SLOT)[cur.slot === 0 ? 1 : 0], JSON.stringify(env))
}

export function createPluginHost(fs: PluginFs, opts: { appVersion: () => string | null }): MobilePluginHost {
  // 同一个插件的写串行化:两次 saveData 交错时,都读到同一个「最新槽」再各写各的,后写的会盖掉先写的那槽里更新的数据。
  const chains = new Map<string, Promise<unknown>>()
  const serial = <T>(id: string, job: () => Promise<T>): Promise<T> => {
    const run = (chains.get(id) ?? Promise.resolve()).then(job, job)
    const tail = run.catch(() => {})
    chains.set(id, tail)
    void tail.then(() => { if (chains.get(id) === tail) chains.delete(id) })
    return run
  }

  return {
    // 整段持锁:先收拾中断的安装,再清点 —— 不与进行中的安装 / 卸载交错(见 withPluginDirLock)。
    listPlugins: () => withPluginDirLock(fs, async () => {
      await recoverPluginDirs(fs)
      const out: ExternalPluginSource[] = []
      const seen = new Set<string>()
      // 商店目录 → 它取代的旧普通目录(设置页注记 / 「旧的安装」一节;桌面 readExternalPlugins 同口径,取排在前面的那份)
      const all = await pluginDirNames(fs)
      const replaced = supersededPlainInstalls(await Promise.all(all.map(async (dir) => ({ dir, manifestId: (await readManifest(fs, `${PLUGINS_DIR}/${dir}`))?.id }))))
      const supersededBy = new Map<string, string>()
      for (const [plain, store] of replaced) if (!supersededBy.has(store)) supersededBy.set(store, plain) // all 已按名排序
      const supersededInfo = async (store: string): Promise<SupersededInstall | undefined> => {
        const plain = supersededBy.get(store)
        const om = plain ? await readManifest(fs, `${PLUGINS_DIR}/${plain}`) : null
        const oid = plain && om ? effectivePluginId(plain, om.id) : null
        if (!plain || !om || !oid) return undefined
        const text = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)
        return { id: oid, dir: plain, version: text(om.version, 40) ?? '0.0.0', name: text(om.name, 120) ?? oid, ...(text(om.nameEn, 120) ? { nameEn: text(om.nameEn, 120) } : {}) }
      }
      for (const name of all.filter((n) => !replaced.has(n))) { // = loadablePluginDirNames,这里顺手要用到取代对照
        const dir = `${PLUGINS_DIR}/${name}`
        try {
          const m = await readManifest(fs, dir)
          if (!m) continue // manifest 缺 / 坏 = 不是插件(或装到一半:manifest 最后落盘)
          const id = effectivePluginId(name, m.id)
          if (!id) {
            console.warn(`[plugins] 插件目录 "${name}" 的 manifest id 与目录名均非法(须 kebab-case),拒载`)
            continue
          }
          if (seen.has(id)) continue
          // 门禁:apiVersion / minAppVersion 与桌面同一个函数;再加手机独有的一档 —— 声明了只能在桌面跑,
          // 或依赖一个装在电脑上的应用(requiresApp)。
          const blocked = gatePluginManifest(m, opts.appVersion()) ?? (m.isDesktopOnly === true || requiredDesktopApp(m) ? 'desktopOnly' : null)
          let code = ''
          if (!blocked) {
            const rel = mainRelOf(m.main)
            if (!rel) continue
            code = await readText(fs, `${dir}/${rel}`) // 读不到 main = 整个跳过(桌面同口径:坏插件不伪装成已启用的空壳)
          }
          const [readme, changelog, iconUrl] = await Promise.all([
            readTextOr(fs, `${dir}/README.md`).then((s) => s?.slice(0, DOC_CAP)),
            readTextOr(fs, `${dir}/CHANGELOG.md`).then((s) => s?.slice(0, DOC_CAP)),
            readIcon(fs, dir),
          ])
          seen.add(id)
          const supersedes = await supersededInfo(name)
          out.push({ id, ...installedPluginFields(m, name, id), iconUrl, code, readme, changelog, blocked: blocked ?? undefined, ...(supersedes ? { supersedes } : {}) })
        } catch {
          /* skip malformed plugin */
        }
      }
      return out
    }),

    // 各插件包里的 Space 配方。装不起来的插件(版本门禁 / 声明了仅桌面)不贡献 Space:它的视图不会注册,
    // 一份只摆内置视图的配方却照样过得了渲染层的校验 —— 插件没在跑,它的 Space 不该单独冒出来。
    // 「用户关掉的插件」不在这里筛:那是渲染层的偏好(readDisabledPluginIds),loadUserSpaces 自己会跳过。
    listSpaces: () => withPluginDirLock(fs, async () => {
      await recoverPluginDirs(fs)
      const out: PluginSpaceRecipe[] = []
      const seen = new Set<string>()
      for (const name of await loadablePluginDirNames(fs)) {
        const dir = `${PLUGINS_DIR}/${name}`
        const m = await readManifest(fs, dir)
        const id = m ? effectivePluginId(name, m.id) : null
        // 同一个 id 装了两份:只认排在前面的那一份(listPlugins 同口径);它被拦下,后一份的配方也不顶上来。
        if (!m || !id || seen.has(id)) continue
        seen.add(id)
        if (gatePluginManifest(m, opts.appVersion()) || m.isDesktopOnly === true || requiredDesktopApp(m)) continue
        let slugs: string[]
        try {
          slugs = (await fs.list(`${dir}/spaces`)).filter((e) => e.type === 'directory' && !e.name.startsWith('.')).map((e) => e.name).sort()
        } catch {
          continue // 没有 spaces/ = 这个插件不带 Space
        }
        for (const slug of slugs.slice(0, SPACES_PER_PLUGIN)) {
          const sdir = `${dir}/spaces/${slug}`
          // 先看大小:配方每次启动都经 base64 桥整份读进内存,包里塞一份几十 MB 的 space.json 会把启动拖垮。
          const st = await fs.stat(`${sdir}/space.json`).catch(() => null)
          if (!st || st.type !== 'file' || st.size > SPACE_RECIPE_MAX_BYTES) continue
          const raw = await readTextOr(fs, `${sdir}/space.json`)
          if (raw === undefined) continue
          // 商店装的插件按 market-<UUID> 注册视图,配方却写的是 manifest id:改到运行身份(桌面 readSpacesList 同一步),
          // 否则配方要的视图一个都对不上,这个 Space 在手机上永远不出现。
          const json = bindRecipeToPlugin(raw, m.id, id)
          const iconUrl = await readSpaceIcon(fs, json, [sdir, dir])
          out.push({ slug, json, plugin: id, ...(iconUrl ? { iconUrl } : {}) })
        }
      }
      return out
    }),

    // 只读 manifest、不过任何闸:被门禁拦下的、声明了仅桌面的、main.js 读不出来的、用户关掉的插件,它们的文件
    // 照样不是笔记。从「正在跑的插件注册了什么」推这份名单正是原来的口子(仪器:npm run e2e:pluginfiles)。
    fileExtensions: () => withPluginDirLock(fs, async () => {
      await recoverPluginDirs(fs)
      const exts = new Set((await readTombstones(fs)).exts) // 读失败 → 抛:调用方保留手上的名单,不拿缩水的顶上
      for (const name of await pluginDirNames(fs)) {
        for (const x of safeExtsOf(await readManifest(fs, `${PLUGINS_DIR}/${name}`))) exts.add(x)
      }
      return [...exts].sort()
    }),

    // 按**生效 id** 定位目录(市场的 installSlug 可以 ≠ manifest id,与桌面 uninstallPlugin 同一条扫描规则)。
    // 插件私有数据(plugins-data)刻意保留:与桌面一致,重装后设置还在。原因码由渲染层 ipcErrorText 译。
    async uninstallPlugin(id, opts) {
      if (!isSafeSlug(id)) throw new Error('invalid-plugin-id')
      await withPluginDirLock(fs, async () => {
        await recoverPluginDirs(fs) // 先恢复:否则卸掉的可能是半截新版,备份里的旧版下次启动又被挪回来
        const names = await pluginDirNames(fs)
        for (const name of names) {
          if (opts?.dir && name !== opts.dir) continue // 同 id 多份时指名卸哪一份(桌面同名选项);生效 id 照样要对上
          const m = await readManifest(fs, `${PLUGINS_DIR}/${name}`)
          if (effectivePluginId(name, m?.id) === id) {
            // 被这份商店安装取代的旧普通目录:宿主自己按 supersededPlainInstalls 判,不收调用方递来的目录名
            const old = opts?.withSuperseded === true
              ? [...supersededPlainInstalls(await Promise.all(names.map(async (dir) => ({ dir, manifestId: (await readManifest(fs, `${PLUGINS_DIR}/${dir}`))?.id }))))]
                .filter(([, store]) => store === name).map(([plain]) => plain)
              : []
            for (const dir of [name, ...old]) await tombstoneExtensions(fs, `${PLUGINS_DIR}/${dir}`) // 先记墓碑再删:记不下来就不删(抛出去)
            await fs.removeDir(`${PLUGINS_DIR}/${name}`)
            for (const dir of old) await fs.removeDir(`${PLUGINS_DIR}/${dir}`)
            return
          }
        }
        throw new Error('plugin-not-found')
      })
    },

    async readPluginData(pluginId) {
      if (!isSafeSlug(pluginId)) return null // id 直接拼进文件名:`../` 就是任意读
      return serial(pluginId, async () => {
        const r = await readDataSlots(fs, pluginId)
        if (r.unreadable) throw unreadableError(r) // 读失败 ≠ 没写过(见上)
        return r.latest?.env.text ?? null
      })
    },

    async writePluginData(pluginId, text, opts) {
      if (!isSafeSlug(pluginId)) throw new Error('invalid-plugin-id')
      const body = String(text ?? '')
      await serial(pluginId, async () => {
        const r = await readDataSlots(fs, pluginId)
        const paths = slotPaths(pluginId)
        let target: 0 | 1 = r.latest ? (r.latest.slot === 0 ? 1 : 0) : 0
        let seq = (r.latest?.env.seq ?? 0) + 1
        // 写之前要原样另存的槽。另存失败(读不出字节 / 写不进去)→ 抛出去,不写
        const keep: Array<[0 | 1, 'unreadable' | 'replaced']> = []
        if (opts?.backup === true && r.latest) {
          // 渲染层同步要拉云端那份盖「读失败后插件按默认值存下的」本机数据:当前那槽(最新的内容)先原样另存。
          // 另一槽不算备份 —— 这次写不碰当前槽,但下一次写就轮到它。和有没有坏槽无关:另一槽恰好读出错、走下面那条路时也照样存。
          keep.push([r.latest.slot, 'replaced'])
        }
        if (r.unreadable) {
          // 读失败:原件不能被这次或以后的写盖掉(见上)。**每一个**坏槽(半截 / 读不出字节)都先原样另存 ——
          // 只存要盖的那槽的话,下一次普通写会落到另一个坏槽上,而那槽可能才是较新的原件。
          // 有槽连字节都读不出来:不写,抛出去(同桌面拷不出原件就拒写)。
          for (const i of [0, 1] as const) {
            const k = r.states[i].kind
            if (k === 'partial' || k === 'unreadable') keep.push([i, 'unreadable'])
          }
          // 没有有效槽时优先写进不存在的那槽;有有效槽时照常写另一槽(已另存过)
          if (!r.latest) target = r.states[0].kind === 'missing' ? 0 : r.states[1].kind === 'missing' ? 1 : 0
          seq = Math.max(seq, Date.now())
        }
        // 要盖的那槽里有东西、却不算一份可用的内容,盖之前也先另存:只有槽 0 且是半截(按没写过处理,但也可能是
        // 唯一一份写坏的原件);信封完好、里面不是合法 JSON(宿主当有效槽、渲染层判读失败,不另存的话两次写就轮掉了)
        const t = r.states[target]
        if (!keep.some(([i]) => i === target) && ((t.kind === 'partial' && !r.latest) || (t.kind === 'ok' && !isJsonText(t.env.text)))) {
          keep.push([target, 'unreadable'])
        }
        // 先把要另存的原件全读出来,有一份读不出字节就整次不写;读齐了再写备份 —— 重试不会攒下一堆一样的备份
        const originals: Array<[0 | 1, 'unreadable' | 'replaced', Uint8Array]> = []
        for (const [i, kind] of keep) originals.push([i, kind, await fs.readBytes(paths[i])])
        for (const [i, kind, bytes] of originals) await fs.writeBytes(dataBackupPath(paths[i], kind), bytes)
        const env: DataEnvelope = { forsionPluginData: 1, seq, text: body }
        await writeText(fs, paths[target], JSON.stringify(env))
      })
    },
  }
}
