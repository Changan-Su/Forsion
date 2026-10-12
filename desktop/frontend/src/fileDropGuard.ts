/**
 * 全局 OS 文件拖放守卫。
 *
 * 症结:把 Finder/资源管理器里的文件拖到任何没有 drop 处理的工作区表面(Space 视图、空白面板、
 * 侧栏背景、标签栏…),浏览器默认行为会把当前窗口导航到 `file:///…`,整个 SPA 被冲掉且不恢复
 * (Electron 主进程也没有 will-navigate 兜底)。
 *
 * 做法:在 document 根兜底拦截。真正想接文件的表面(编辑器、文件树、聊天框…)在更内层先
 * `preventDefault`——React 事件在根容器上派发、先于 document 冒泡,故这里看 `e.defaultPrevented`
 * 就能只兜底"没人要"的那些拖放,不抢内层已认领的。内部拖拽(Dockview 标签、文件树重排)用的是
 * 自定义 MIME,`types` 不含 'Files',天然被 hasFiles 排除。
 *
 * 这里不画任何提示:原来那层圈住整个工作区的虚线遮罩(body[data-file-drag])2026-10-12 去掉了 ——
 * 接不住文件的地方它也一起圈;真正能接的表面(聊天区、编辑器、文件树)各自给落点提示。
 */
function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

export function installFileDropGuard(): () => void {
  const onOver = (e: DragEvent): void => {
    if (!hasFiles(e) || e.defaultPrevented) return // 内层已认领 → 放行
    e.preventDefault() // 没人要 → 允许 drop 事件触发(下面吞掉),但禁止默认导航
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
  }
  const onDropBubble = (e: DragEvent): void => {
    if (hasFiles(e) && !e.defaultPrevented) e.preventDefault() // 没人要 → 吞掉,别导航走
  }

  document.addEventListener('dragover', onOver)
  document.addEventListener('drop', onDropBubble)
  return () => {
    document.removeEventListener('dragover', onOver)
    document.removeEventListener('drop', onDropBubble)
  }
}
