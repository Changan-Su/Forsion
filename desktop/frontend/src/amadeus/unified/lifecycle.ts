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
  /** 当前正文(**不重新与编辑器同步**:上次保存那一刻的快照,≤800ms 陈旧,与只读面板的刷新
   *  节拍一致)。字数统计等只读面板用 —— v4 正文不进 pageStore,读 blocks 只会得空。 */
  bodyNow?: () => string
  /** 大纲:从 PM doc 现取标题(与渲染同源)。 */
  headings?: () => Array<{ level: number; text: string; pos: number }>
  /** 大纲跳转:把第 index 个标题滚进视野。⚠️ 这是**另一次**遍历(点击发生在渲染之后,期间文档
   *  可能已增删标题),故必须带上记录时的 text 复核:对不上就按文本找,再找不到就不跳 ——
   *  宁可不动,也不要静默跳到另一个标题上(Codex 评审 medium)。 */
  revealHeading?: (index: number, text: string) => void
  /** 外来 frontmatter 原文(插件的每页数据存这儿)。v3 那份在 manifest.fmExtra,v4 在 pipe.fm 里。
   *  **只读**:写口本轮不做(不带 bind 的块表面上零消费者,且 v4 fm 写要与结构键派生同场竞技,
   *  见 docs/ToBeImproved/块表面v4适配方案_2026-08-20.md §6.3)。 */
  fmNow?: () => string
  /** 往本篇插一段 markdown(块表面写口的 v4 后端)。落点见 UnifiedPage 的 insertMd:
   *  'cursor' = 光标所在**顶层块**之后(该块为空则原地替换)、'start' = 文首、'end' = 文末。
   *  实例退休(改名/删除/移动之后)一律 false —— 往幽灵路径写字比不写更糟。 */
  insertMarkdown?: (md: string, where: 'cursor' | 'start' | 'end') => boolean
}

const handles = new Set<UnifiedPipeHandle>()

// 实例集合的版本号:只读面板(大纲/字数)靠它知道「实例挂上来了/走了」。登记发生在 effect 里,
// 比面板首渲染晚 —— 没有这一声,打开 v4 笔记时大纲会一直停在「没有标题」直到下一次保存。
let gen = 0
const genListeners = new Set<() => void>()
function bumpGen(): void {
  gen++
  for (const f of genListeners) f()
}
export function unifiedGen(): number {
  return gen
}
export function subscribeUnified(f: () => void): () => void {
  genListeners.add(f)
  return () => genListeners.delete(f)
}

export function registerUnifiedPipe(h: UnifiedPipeHandle): () => void {
  handles.add(h)
  bumpGen()
  return () => {
    handles.delete(h)
    bumpGen()
  }
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

/** path 上是否有活着的 unified 实例(= 这篇按 v4 渲染且已挂载)。
 *  v3 的「装载完成」信号是 pageStore.activePage,v4 没有对应物,导航等待用它当就绪判据。 */
export function hasUnifiedInstance(path: string): boolean {
  for (const h of handles) if (h.path === path) return true
  return false
}

/** 只读面板问 path 上那篇的正文;没有 v4 实例 → null(调用方回落 v3 的 blocks)。 */
export function unifiedBody(path: string): string | null {
  for (const h of handles) if (h.path === path && h.bodyNow) return h.bodyNow()
  return null
}

/** 只读面板问 path 上那篇的大纲;没有 v4 实例 → null(调用方回落 v3 的 manifest/blocks)。 */
export function unifiedHeadings(path: string): Array<{ level: number; text: string; pos: number }> | null {
  for (const h of handles) if (h.path === path && h.headings) return h.headings()
  return null
}

/** 插件块表面问 path 上那篇的外来 frontmatter;没有 v4 实例 → null(调用方回落 v3 的 manifest)。 */
export function unifiedFm(path: string): string | null {
  for (const h of handles) if (h.path === path && h.fmNow) return h.fmNow()
  return null
}

/** 插件块表面往 path 上那篇插一段 markdown;没有实例 / 实例已退休 → false。 */
export function unifiedInsertMarkdown(path: string, md: string, where: 'cursor' | 'start' | 'end'): boolean {
  for (const h of handles) if (h.path === path && h.insertMarkdown) return h.insertMarkdown(md, where)
  return false
}

/** 大纲点击:让 path 上那篇把第 index 个标题(文本须为 text)滚进视野;没接住返回 false。 */
export function unifiedRevealHeading(path: string, index: number, text: string): boolean {
  for (const h of handles) {
    if (h.path === path && h.revealHeading) {
      h.revealHeading(index, text)
      return true
    }
  }
  return false
}
