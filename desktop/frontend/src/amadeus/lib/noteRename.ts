// 笔记改名的渲染端编排器:文件树行内改名与插件 ctx.app.renamePath 共用(同 dbFileOps.renameDb 之于 .db)。
import { useWorkspace } from '@lcl/engine'
import { amadeus } from '../api'
import { cascadeFdAfterRename, flushAllScopes, remapScopePaths, usePageStore } from '../store/pageStore'
import { retireUnifiedPath } from '../unified/lifecycle'

/** 改名后重定向所有开着旧路径的编辑器 leaf(Codex 终审 P1):unified 实例已被退休,
 *  不换 leaf 参数的话那个标签就永远卡在不存在的旧路径上、输入不再保存。
 *  移动端单列壳 api 恒 null → 跳过(单 leaf 场景由 onRenamed/自身导航兜)。 */
export function retargetEditorLeaves(oldPath: string, newPath: string): void {
  const w = useWorkspace.getState()
  for (const p of w.api?.panels ?? []) {
    const params = (p.params ?? {}) as { __type?: string; notePath?: string }
    if (params.__type === 'amadeus-editor' && params.notePath === oldPath) {
      w.navigateLeaf(p.id, 'amadeus-editor', { ...params, notePath: newPath })
    }
  }
}

/** 把某页改名:纯路径链(flush → renamePageFile 物理移动+全库引用重写 → 各面板跟队 → .fd 级联)。
 *  ⚠️ 不许走「loadPage + renamePage」老路(Codex P0):loadPage 会把 v4/外来 md 灌进 v3 编译管线,
 *  renamePage 落盘时就把它改写成 v3 格式(注 amadeus_page+块标记)= 毁档;纯移动对 v3 同样正确
 *  (noteViewStore.renameNote 就是这条链)。
 *  返回新 vault 相对路径(名字没变 = 原路径);失败原样抛,提示与刷新目录由调用方负责。 */
export async function renameNoteFile(path: string, newName: string): Promise<string> {
  await flushAllScopes()
  const newPath = await amadeus.renamePageFile(path, newName)
  if (newPath !== path) {
    retireUnifiedPath(path, 'file', newPath) // 开着这页的 unified 实例停写旧路径(防幽灵文件);带新路径 = 未落盘的字存成新路径草稿(G2-03)
    remapScopePaths(path, newPath, 'file')
    await cascadeFdAfterRename(path, newPath)
    retargetEditorLeaves(path, newPath)
    // 某个面板正开着这页(v3):remap 换了 activePage 但 manifest.title 还是旧名 → 重载对齐。
    const st = usePageStore.getState()
    if (st.activePage === newPath) void st.loadPage(newPath)
  }
  return newPath
}
