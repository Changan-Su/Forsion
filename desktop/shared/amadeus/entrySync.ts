/**
 * 按条目云同步的**跨端共用**判据:云端 Vault 标记文件 + 条目覆盖范围。
 * 消费者:主进程 entryRegistry/ipc(引擎 scope)、渲染端 entrySyncStore(UI 点亮)、
 * web/mobile cloudBridge(标记推导分区)。三处必须同判据,故住在 shared/。
 */

export type EntrySyncKind = 'page' | 'folder' | 'asset'

export interface EntrySyncEntry {
  /** vault 相对路径(POSIX、NFC)。 */
  path: string
  kind: EntrySyncKind
}

/**
 * 云端「同步 Vault 文件夹」标记:`<云名>/.forsion-vault.md`。点开头 → 三端树/搜索隐身。
 * ⚠️**扩展名必须是文本类**(.md):服务端 kindForPath 把无扩展名路径判为 binary,
 * 文本写端点 `PUT /vaults/:v/file` 直接 400 BINARY_PATH —— 标记写不上去 = web/移动端
 * 永远看不到「同步 Vault」分区(2026-08-03 实报的 bug 根因)。约束由 entrySync.test.ts 守。
 */
export const CLOUD_VAULT_MARKER = '.forsion-vault.md'

export const cloudVaultMarkerPath = (cloudName: string): string => `${cloudName}/${CLOUD_VAULT_MARKER}`

/** 从云端 tree 的路径清单推导「同步 Vault 文件夹」名(根级一段 + 标记)。 */
export function cloudVaultNamesFrom(paths: string[]): string[] {
  const re = new RegExp(`^([^/]+)/${CLOUD_VAULT_MARKER.replace(/\./g, '\\.')}$`)
  return [...new Set(paths.map((p) => re.exec(p)?.[1]).filter((x): x is string => !!x))].sort()
}

export const nfcRel = (s: string): string => s.replace(/\\/g, '/').normalize('NFC')

/** 条目覆盖的子树前缀(folder→自身子树;page→`<stem>.fd/` 子笔记树;asset→无)。 */
export function coverPrefix(e: EntrySyncEntry): string | null {
  const p = nfcRel(e.path)
  if (!p) return null
  if (e.kind === 'folder') return `${p}/`
  if (e.kind === 'page') return `${p.replace(/\.md$/i, '')}.fd/`
  return null
}

/**
 * rel 是否在同步范围内:精确条目 > exclude 子树 > 条目覆盖前缀(顺序即优先级——显式条目
 * 压过继承来的排除)。exclude = 用户在开启弹窗里取消勾选的子页面 / 对被覆盖路径点「关闭云同步」。
 */
export function coversPath(entries: EntrySyncEntry[], exclude: string[] | undefined, relRaw: string): boolean {
  const rel = nfcRel(relRaw)
  if (!rel) return false
  if (entries.some((e) => nfcRel(e.path) === rel)) return true
  for (const ex of exclude ?? []) {
    const x = nfcRel(ex)
    if (!x) continue
    // `.fd` 目录本身也要挡:只挡 `X.fd/…` 的话,被排除子页面的目录仍会过闸,在云端凭空建出空文件夹。
    const fd = `${x.replace(/\.md$/i, '')}.fd`
    if (rel === x || rel.startsWith(`${x}/`) || rel === fd || rel.startsWith(`${fd}/`)) return false
  }
  return entries.some((e) => {
    const pre = coverPrefix(e)
    return !!pre && rel.startsWith(pre)
  })
}

/** 路径前缀重写(改名/移动跟随);无变化返回 null。 */
export function rewritePath(pRaw: string, fromRaw: string, toRaw: string): string | null {
  const p = nfcRel(pRaw)
  const from = nfcRel(fromRaw)
  if (p === from) return nfcRel(toRaw)
  if (p.startsWith(`${from}/`)) return nfcRel(toRaw) + p.slice(from.length)
  return null
}

/** 路径清单跟随改名(exclude 用:漏了它 → 被排除的子页面一改名就悄悄开始上传)。 */
export function rewritePathList(list: string[], from: string, to: string): { changed: boolean; next: string[] } {
  let changed = false
  const next = list.map((p) => {
    const r = rewritePath(p, from, to)
    if (r === null) return p
    changed = true
    return r
  })
  return { changed, next }
}
