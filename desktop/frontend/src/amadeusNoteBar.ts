/** 笔记顶栏 / 移动端胶囊共用的入口判据(评审 C-09)。
 *  「上传文件到本页」的门是 **barPath**(本 leaf 认领的笔记),不是 activePage:v4 统一页根本不设 activePage,
 *  按 activePage 判,桌面顶栏这颗按钮在每一篇 v4 笔记上都永远不显示(移动端胶囊早就改成 barPath)。
 *  锁定的笔记(C-07)不给上传 —— 上传 = 往正文里插引用。v4 源码模式没有编辑器实例接文件(insertFiles 回 false、
 *  v3 的 importToPage 又不适用),给了按钮就是点了没反应,也不给。两处调用同一个函数,别再各写各的。 */
export function canUploadToNote(barPath: string | null, lockOn: boolean, unifiedSource = false): boolean {
  return !!barPath && !lockOn && !unifiedSource
}
