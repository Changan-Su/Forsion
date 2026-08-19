/** 插件复合后缀改名的归一化(2026-08-14 评审 P2:标题入口与树入口各写一份、口径打架,
 *  用户手打 "Foo.canvas.md" 会叠出 Foo.canvas.md.canvas.md)。叶子模块零依赖,pageStore
 *  (动态 import 破环)与 amadeusViews 共用同一份。
 *
 *  语义:输入用户敲的任意名字,输出「不带 .md、带完整复合段」的基名 —— 主进程改名 IPC
 *  (renamePage/renamePageFile)只做「掐尾部 .md、无条件补 .md」,所以这里交出去的必须
 *  已经带 `.canvas` 段。仅支持 .md 类复合后缀('.X.md'):非 .md 插件后缀走不了这条 IPC
 *  (它恒产出 .md 路径),调用方应先 gate。 */
export function normalizePluginRename(rawName: string, ext: string): string {
  let base = rawName.trim()
  const lower = base.toLowerCase()
  const extLower = ext.toLowerCase() // '.canvas.md'
  const stem = ext.replace(/\.md$/i, '') // '.canvas'
  if (lower.endsWith(extLower)) return base.slice(0, base.length - 3) // 'Foo.canvas.md' → 'Foo.canvas'
  if (lower.endsWith(stem.toLowerCase())) return base // 'Foo.canvas' / 'Foo.CANVAS' → 原样
  if (lower.endsWith('.md')) base = base.slice(0, base.length - 3) // 'Bar.md' → 'Bar'
  return base + stem
}
