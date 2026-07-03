/** 工作区文件「打开预览标签页」统一门面(替代原 chatbox 上方的浮层预览,浮层暂时停用)。
 *  - 有本机路径(target.path)→ 参数只存 {path,name},随布局持久化,重启可恢复;同路径已开则聚焦。
 *  - 无路径(云沙箱/对话内联,load 是闭包不可序列化)→ 存进内存注册表,params 只带注册键;
 *    重启后注册表为空 → WsFileView 显示「内容已过期」占位,从来源重新打开即可。 */
import { useWorkspace } from '../engine'
import type { PreviewTarget } from '../components/WorkspaceFilePreview'
import { b64ToBytes } from '../services/fileKinds'

interface PanelLike { id: string; params?: Record<string, unknown> }

/** 在途写盘登记:MdFileEditor 的(冲刷)保存挂在这里,读端先等同路径的写完成再读,
 *  防「关标签/收侧栏重挂 → 冲刷未落盘就重读 → 编辑器拿到陈旧内容」的写读竞态。 */
export const pendingWrites = new Map<string, Promise<unknown>>()

/** 本机路径 → PreviewTarget(主进程 readHostFile;download=在文件管理器显示)。 */
export function hostTargetFor(path: string, name: string): PreviewTarget {
  return {
    name,
    path,
    load: async () => {
      const pending = pendingWrites.get(path)
      if (pending) await pending.catch(() => {})
      const r = await window.tangu?.readHostFile?.(path)
      if (!r) return null
      if (r.tooLarge) return { tooLarge: true, size: r.size }
      return { mimeType: r.mimeType, bytes: b64ToBytes(r.content), size: r.size, mtimeMs: r.mtimeMs }
    },
    download: () => { void window.tangu?.revealHostPath?.(path) },
  }
}

const transient = new Map<string, PreviewTarget>()
let seq = 0

export function getTransientTarget(key: string): PreviewTarget | undefined {
  return transient.get(key)
}

export function openWsFile(target: PreviewTarget): void {
  const ws = useWorkspace.getState()
  const api = (ws as unknown as { api?: { panels: PanelLike[] } }).api
  if (target.path) {
    const hit = api?.panels.find((p) => p.params?.__type === 'wsfile' && p.params?.path === target.path)
    if (hit) { ws.activateLeaf(hit.id); return }
    ws.openView('wsfile', { path: target.path, name: target.name }, 'main', { newTab: true })
    return
  }
  // 清掉不再被任何已开 panel 引用的瞬态目标(闭包可能持有整份文件字节,别让它随关闭的标签滞留)。
  const alive = new Set(api?.panels.map((p) => p.params?.tkey).filter(Boolean) ?? [])
  for (const k of transient.keys()) if (!alive.has(k)) transient.delete(k)
  const key = `t${++seq}`
  transient.set(key, target)
  ws.openView('wsfile', { tkey: key, name: target.name }, 'main', { newTab: true })
}
