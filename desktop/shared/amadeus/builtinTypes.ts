// 内置文件类型占用的后缀 —— 生态硬规则:**插件不得认领,认领了也由宿主拒绝(内置优先)**。
//
// 这条规则原先只写在《生态内容制作指南》里,而且写的是「行为未定义」。2026-07-26 它就出事了:
// 一个装在库里的旧插件声明了与内置同名的后缀,在文件树点击链路(`findFileType` 先于内置判定)
// 和 `openFile` 里排在内置之前,于是内置视图根本打不开 —— 用户看到的现象是「XX 没有自己的 view」。
// 把规则变成代码,插件就再也遮蔽不了内置类型。
//
// 只列**内置真正认领的确切后缀**:裸 `.md` 不在列(那是笔记,插件的 `.<子类型>.md` 复合后缀
// 本来就该赢过笔记编辑器);`.excalidraw`(Obsidian 惯例省掉 .md 的嵌入写法)也算,嵌入目标
// `![[画板.excalidraw]]` 走的就是它。
//
// ⚠️ 往这个表里加后缀之前先问一句:**这件事非内置不可吗?** 「内置与外置的唯一区别是提前装好了」
// 是本项目的原则。`.mindmap.md` 曾经在这张表上,后来整套搬去了外置捆绑包(它需要的那点能力
// 补成了 ctx.app 的块表面 seam)—— 能补 seam 就补 seam,别往这张表上加。

export const BUILTIN_FILE_SUFFIXES = [
  '.excalidraw.md', // 白板
  '.excalidraw', // 同上:`![[x.excalidraw]]` 省略 .md 的嵌入/链接写法
  '.db', // 数据库 / 笔记视图
  '.pdf', // PDF 阅读器(含批注)
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico', // 图片视图
] as const

/** path(或一条扩展名声明,如 '.excalidraw.md')是否落在内置文件类型的地盘上。 */
export function isBuiltinFileType(p: string): boolean {
  const n = p.toLowerCase()
  return BUILTIN_FILE_SUFFIXES.some((ext) => n.endsWith(ext))
}

/** `.md` 目标是不是「笔记」(而不是某个文件类型)。
 *  判据 = **不在内置后缀表上**就是笔记。刻意不写「带两个点就不是笔记」那种形状启发式:
 *  `X.fd.md`(子笔记夹)、`ADR.001.md`(带版本号的名字)都是货真价实的笔记(Codex 评审 medium)。
 *  插件声明的复合后缀不用在这儿管 —— 两个调用点(embedLayer.classifyEmbed / BlockHost.embedFile)
 *  都已经先问过画板与插件 renderer 了,轮到本判据时剩下的就是笔记。
 *  2026-08-20 用户实报:`![[某笔记.md]]` 此前渲染成「📄 打开 ↗」文件卡,点了还去调系统默认程序。 */
export function isPlainNoteRef(target: string): boolean {
  const t = target.split('|')[0].split('#')[0].trim().toLowerCase()
  return /\.md$/.test(t) && !isBuiltinFileType(t)
}
