/**
 * 插件「本程建的」账本(2026-11-16,ctx.app.renamePath / movePath 的边界):这一程里某个插件经 ctx.app 新建的路径
 * (writeFile / writeBytes 落到原本不存在的路径、createFolder 真建出来的那几层)。插件改名 / 挪动它自己建的东西不问用户,
 * 别的(工作文件夹以外)一律先问。
 *
 * 只在内存里,不落盘:换一程(重启)就清空 —— 「本程建的」是用户定的口径,跨程的身份认不准(同名文件可能早换了人)。
 * 按库根分账:同一个相对路径在另一个库里是别人的文件。
 * 精确匹配:建了文件夹不等于夹里的东西都归它(用户自己挪进去的笔记照样要问)。
 * 跟着现实走:任何改名 / 挪动(onNotePathGone,含用户在树上做的、.fd 级联)把条目改指到新路径;删除(应用内同一条广播
 * to=null)把条目摘掉;文件树清单刷新后不在里面的条目也摘掉(外部程序删的文件 / 文件夹)—— 否则删了之后用户在原位新建的
 * 同名东西会被当成插件的。刚记下 / 刚改指的条目有几秒宽限:清单刷新慢半拍,别把插件刚建的当成已删。
 * 摘错只会多问一次用户(安全的那一侧)。点开头的路径清单里永远没有,记了也会被摘掉 —— 改它们照样要问。
 *
 * 下一包(笔记出生钩子)经 markPluginCreated 把它替用户建的笔记记进来。
 */
import { onNotePathGone, usePageStore } from '../store/pageStore'

/** 库根 → 插件 id → 路径(vault 相对、`/` 分隔、无首尾斜杠)→ 记下 / 改指的时刻(清单比对的宽限从这里算)。 */
const ledgers = new Map<string, Map<string, Map<string, number>>>()
let wired = false
/** 清单刷新晚于记账的余量(主进程结构刷新有防抖,刷新在途时落下的清单可能还是写之前的)。 */
const LISTING_GRACE_MS = 5000

/** 只归一分隔符与首尾斜杠,**不修空白**(同 ctx.app.trash:`Foo` 与 `Foo ` 是两个文件)。 */
export const normCreatedPath = (p: unknown): string => String(p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

const currentRoot = (): string | null => usePageStore.getState().vaultRoot || null

function wire(): void {
  if (wired) return
  wired = true
  onNotePathGone((from, kind, to) => followCreatedPath(from, kind, to))
  usePageStore.subscribe((s, prev) => {
    if (s.pages === prev.pages && s.files === prev.files && s.folders === prev.folders) return
    if (!s.vaultRoot || s.filesPendingFor || s.vaultRoot !== prev.vaultRoot) return // 换库 / 清单没装完:没有可比的
    pruneAbsent(s.vaultRoot, [...s.pages, ...s.files, ...s.folders])
  })
}

/** 清单里没有的条目摘掉(宽限期内的不动)。 */
export function pruneAbsent(root: string, listing: string[], now = Date.now()): void {
  const byPlugin = ledgers.get(root)
  if (!byPlugin) return
  let present: Set<string> | null = null
  for (const entries of byPlugin.values()) {
    for (const [p, at] of Array.from(entries)) {
      if (now - at < LISTING_GRACE_MS) continue
      present ??= new Set(listing.map(normCreatedPath))
      if (!present.has(p)) entries.delete(p)
    }
  }
}

/** 记一条「这个插件这一程建了它」。没有库 / 空路径 = 不记。 */
export function markPluginCreated(pluginId: string, path: string, root: string | null = currentRoot()): void {
  const p = normCreatedPath(path)
  if (!pluginId || !p || !root) return
  wire()
  let byPlugin = ledgers.get(root)
  if (!byPlugin) ledgers.set(root, (byPlugin = new Map()))
  let entries = byPlugin.get(pluginId)
  if (!entries) byPlugin.set(pluginId, (entries = new Map()))
  entries.set(p, Date.now())
}

/** 这个插件这一程建过这个确切路径(当前库)? */
export function isPluginCreated(pluginId: string, path: string, root: string | null = currentRoot()): boolean {
  const p = normCreatedPath(path)
  return !!root && !!p && !!ledgers.get(root)?.get(pluginId)?.has(p)
}

/** 某路径(kind='prefix' 含子树)改名 / 挪到 to,或被删(to=null):所有插件的条目跟着改指 / 摘掉。幂等。 */
export function followCreatedPath(from: string, kind: 'file' | 'prefix', to: string | null, root: string | null = currentRoot()): void {
  const byPlugin = root ? ledgers.get(root) : undefined
  if (!byPlugin) return
  const f = normCreatedPath(from)
  const t = to == null ? null : normCreatedPath(to)
  if (!f || f === t) return
  const now = Date.now()
  for (const entries of byPlugin.values()) {
    for (const p of Array.from(entries.keys())) {
      const hit = kind === 'file' ? p === f : p === f || p.startsWith(`${f}/`)
      if (!hit) continue
      entries.delete(p)
      if (t) entries.set(kind === 'file' ? t : t + p.slice(f.length), now)
    }
  }
}

/** 测试用:清空账本。 */
export function resetPluginCreatedForTests(): void {
  ledgers.clear()
}
