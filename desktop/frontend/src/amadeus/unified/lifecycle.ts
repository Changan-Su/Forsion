/** unified 实例的生命周期登记处(Codex 评审 P0,2026-08-13):
 *  UnifiedPage 的写盘管线是组件私有的,pageStore 的三道全局防线(flushAllScopes 换库前落盘 /
 *  删除清 saveTimer / remapScopePaths 改名跟队)全都看不见它 —— 换库时防抖写把旧库内容写进新库、
 *  删除/改名/移动后防抖写复活旧文件,全是这一个盲区。本模块是唯一登记点:
 *  - flushUnifiedScopes():换库/全局落盘前,所有 unified 实例待写先落地(pageStore.flushAllScopes 调)。
 *  - retireUnifiedPath(path):该路径(或其子树)的 unified 实例全部退休 —— 此后任何写盘一律跳过。
 *    删除/改名/移动的发起方在动文件**之前**调它。
 *  零依赖(被 pageStore 反向 import,不许在这里 import pageStore/UnifiedPage,否则模块环)。 */

export interface UnifiedPipeHandle {
  path: string
  flush: () => Promise<void>
  retire: () => void
  /** OS 拖入/上传按钮的文件走这里进 unified(存附件 + 光标处插 `![[base]]`);可选。 */
  insertFiles?: (files: File[]) => void
}

const handles = new Set<UnifiedPipeHandle>()

export function registerUnifiedPipe(h: UnifiedPipeHandle): () => void {
  handles.add(h)
  return () => handles.delete(h)
}

/** 全部 unified 实例待写落盘(单实例失败不拖累别家)。 */
export async function flushUnifiedScopes(): Promise<void> {
  await Promise.all([...handles].map((h) => h.flush().catch(() => {})))
}

/** 把文件递给 path 上活着的 unified 实例(宿主的 OS 拖入/上传按钮用);没有实例 → false。 */
export function insertFilesForPath(path: string, files: File[]): boolean {
  for (const h of handles) {
    if (h.path === path && h.insertFiles) {
      h.insertFiles(files)
      return true
    }
  }
  return false
}

/** 退休 path 上(kind='prefix' 时含子树)的全部实例:防「动完文件,防抖写复活旧路径」。 */
export function retireUnifiedPath(path: string, kind: 'file' | 'prefix' = 'file'): void {
  for (const h of handles) {
    if (kind === 'file' ? h.path === path : h.path === path || h.path.startsWith(`${path}/`)) h.retire()
  }
}
