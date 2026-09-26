import { useEffect, type ReactNode } from 'react'
import { useApp } from '../stores/appStore'
import { isProjectIconFile } from '../types'

/** 项目图标:settings.icon 是 emoji → 文字;是导入的图片 → <img>(图没拉到前先显示 fallback);没设 → fallback。
 *  侧栏组头与 PROJECT 详情共用,默认项与图片都走 store 缓存(连上引擎后按需拉一次)。 */
export function ProjectIcon({ path, fallback, className }: { path: string; fallback: ReactNode; className?: string }) {
  const icon = useApp((a) => a.projectSettingsByPath[path]?.icon)
  const url = useApp((a) => a.projectIconUrls[path])
  // ensureProjectSettings 在引擎没就绪时返回 null 且不缓存 —— 只依赖 path 的话,侧栏比引擎先挂载就永远不再拉。
  const ready = useApp((a) => a.connState === 'ok')
  const image = isProjectIconFile(icon)
  useEffect(() => { if (ready) void useApp.getState().ensureProjectSettings(path) }, [path, ready])
  useEffect(() => { if (ready && image) void useApp.getState().loadProjectIcon(path) }, [path, ready, image])
  if (image) return url ? <img className={className} src={url} alt="" draggable={false} /> : <>{fallback}</>
  if (icon) return <span className={className} aria-hidden="true">{icon}</span>
  return <>{fallback}</>
}
