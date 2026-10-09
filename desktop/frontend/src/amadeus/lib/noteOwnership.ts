/**
 * 编辑器面板拿到一条路径时先问:这条 .md 是笔记,还是归插件管的文件(amadeusViews 的 AmadeusEditor 用)。
 *
 * 库这一层(桌面主进程 / 手机本地库 / 云端库桥)把「磁盘上是 .md、内容归插件管」的文件(插件 manifest 声明的
 * fileExtensions,如 `.deck.md`;外加白板)列在 files 里、不列在 pages 里。对应插件在跑的时候,打开它的各个入口
 * 早就改道去了插件视图;走到编辑器面板的,是插件没装 / 被关掉 / 被门禁拦下 / 已卸载的那些 —— 进了笔记读写管线,
 * 编辑器一存就是按笔记的写法重排,插件的格式当场坏。
 *
 *   'plugin'  → 只显示一页说明,不挂任何编辑器;
 *   'pending' → 文件列表还在路上(刚打开 / 刚切库,pageStore.filesPendingFor),这条 .md 又不在页面列表里:
 *               归属没确认之前不挂编辑器(否则冷启动时恢复出来的旧标签有一小段时间是可写的);
 *   'note'    → 其余,照常。
 *
 * ⚠️ 后缀判定**区分大小写**,与库这一层的 isPagePath 同一个口径:`README.MD` 在库那边本来就列在 files 里,
 *    却一直能当笔记打开(文件树按不分大小写的 .md 送进编辑器)—— 这里不分大小写的话,它就被说成「归插件管理」。
 */
export type NoteOwnership = 'note' | 'plugin' | 'pending'

export function noteOwnership(
  notePath: string | null | undefined,
  s: { pages: string[]; files: string[]; vaultRoot: string | null; filesPendingFor: string | null },
): NoteOwnership {
  if (!notePath || !notePath.endsWith('.md') || s.pages.includes(notePath)) return 'note'
  if (s.filesPendingFor != null && s.filesPendingFor === s.vaultRoot) return 'pending'
  const n = notePath.replace(/\\/g, '/')
  return s.files.some((f) => f.replace(/\\/g, '/') === n) ? 'plugin' : 'note'
}
