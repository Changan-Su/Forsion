/**
 * 插件「本程建的」账本(2026-11-16,ctx.app.renamePath / movePath 的边界):这一程里某个插件经 ctx.app 新建的路径
 * (writeFile / writeBytes 落到原本不存在的路径、createFolder 真建出来的那几层)。插件改名 / 挪动它自己建的东西不问用户,
 * 别的(工作文件夹以外)一律先问。
 *
 * 只在内存里,不落盘:换一程(重启)就清空 —— 「本程建的」是用户定的口径,跨程的身份认不准(同名文件可能早换了人)。
 * 按库根分账:同一个相对路径在另一个库里是别人的文件。
 * 精确匹配:建了文件夹不等于夹里的东西都归它(用户自己挪进去的笔记照样要问)。
 * 跟着现实走:任何改名 / 挪动(onNotePathGone,含用户在树上做的、.fd 级联)把条目改指到新路径;删除(应用内同一条广播
 * to=null,外部删除走 vaultEvents 的 delete)把条目摘掉 —— 否则删了之后用户在原位新建的同名文件会被当成插件的。
 * 外部删除整个文件夹不在 vaultEvents 里(它只报文件),这一处残余:同名文件夹被用户重建后,插件仍可不问就改它的名。
 *
 * 下一包(笔记出生钩子)经 markPluginCreated 把它替用户建的笔记记进来。
 */
import { onNotePathGone, usePageStore } from '../store/pageStore'
import { subscribeVaultEvents } from './vaultEvents'

/** 库根 → 插件 id → 路径(vault 相对、`/` 分隔、无首尾斜杠)。 */
const ledgers = new Map<string, Map<string, Set<string>>>()
let wired = false

/** 只归一分隔符与首尾斜杠,**不修空白**(同 ctx.app.trash:`Foo` 与 `Foo ` 是两个文件)。 */
export const normCreatedPath = (p: unknown): string => String(p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')

const currentRoot = (): string | null => usePageStore.getState().vaultRoot || null

function wire(): void {
  if (wired) return
  wired = true
  onNotePathGone((from, kind, to) => followCreatedPath(from, kind, to))
  subscribeVaultEvents((events) => {
    for (const e of events) if (e.kind === 'delete') followCreatedPath(e.path, 'file', null)
  })
}

/** 记一条「这个插件这一程建了它」。没有库 / 空路径 = 不记。 */
export function markPluginCreated(pluginId: string, path: string, root: string | null = currentRoot()): void {
  const p = normCreatedPath(path)
  if (!pluginId || !p || !root) return
  wire()
  let byPlugin = ledgers.get(root)
  if (!byPlugin) ledgers.set(root, (byPlugin = new Map()))
  let set = byPlugin.get(pluginId)
  if (!set) byPlugin.set(pluginId, (set = new Set()))
  set.add(p)
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
  for (const set of byPlugin.values()) {
    for (const p of Array.from(set)) {
      const hit = kind === 'file' ? p === f : p === f || p.startsWith(`${f}/`)
      if (!hit) continue
      set.delete(p)
      if (t) set.add(kind === 'file' ? t : t + p.slice(f.length))
    }
  }
}

/** 测试用:清空账本。 */
export function resetPluginCreatedForTests(): void {
  ledgers.clear()
}
