/**
 * 新对话项目药丸在「运行位置 = 别的电脑」时列哪些项目(桌面作为调用方,2026-10-14)。
 *
 * 桌面把运行位置放到别的电脑上时,这台电脑的本地文件夹 / 笔记库 / 云端项目都不是那台的,列出来选了就是「拿这台电脑的路径
 * 去那台当项目目录」—— 改列**那台**的:它的默认工作区、它的会话里出现过的项目目录(设备分组现拉的那份,只在内存)、
 * 「不在项目中工作」。那台上没开过会话的目录这里选不到(没有远端选目录框)。每一项都带那台的 unitId —— appStore.setNewChatWs
 * 靠它区分「那台的项目」与别处塞进来的这台电脑的文件夹(后者会把运行位置带回这台电脑)。
 * 运行位置在这台电脑上 → null(调用方照旧用 workspaces())。手机 / 网页版恒 null(那里本端 = 云端,workspaces() 本来就没有本机路径)。
 */
import { useMemo } from 'react'
import { DEFAULT_LOCAL_WORKSPACE_KEY, type WorkspaceDescriptor } from '../types'
import { useEngineFocus } from '../services/engine/targets'
import { currentPlatform } from '../services/platform'
import { useApp } from './appStore'
import { rootlessWs } from '@tangu/ui/tangu/store/tanguSlice'
import { useDeviceSessions } from './deviceSessionsStore'

export function useRemoteNewChatWorkspaces(): WorkspaceDescriptor[] | null {
  const focus = useEngineFocus((s) => s.ref)
  const unitId = currentPlatform() === 'desktop' && focus.kind === 'unit' ? focus.unitId : null
  const dirs = useApp((s) => s.focusDirs)
  const tr = useApp((s) => s.tr)
  const rows = useDeviceSessions((s) => (unitId ? s.byUnit[unitId]?.sessions : undefined))
  return useMemo(() => {
    if (!unitId) return null
    const def = dirs?.defaultWsDir || dirs?.homeDir || null
    const list: WorkspaceDescriptor[] = [{
      key: def || DEFAULT_LOCAL_WORKSPACE_KEY, name: tr('app.defaultWorkspace'), kind: 'local', path: def, system: true, isDefault: true, sessionKeys: def ? [def] : [], unitId,
    }]
    const seen = new Set<string>(def ? [def] : [])
    for (const r of rows || []) {
      const p = typeof r.project_path === 'string' ? r.project_path : ''
      if (!p || r.projectless || seen.has(p) || seen.size >= 50) continue
      seen.add(p)
      list.push({ key: p, name: (typeof r.project_name === 'string' && r.project_name) || p.split(/[\\/]/).filter(Boolean).pop() || p, kind: 'local', path: p, unitId })
    }
    list.push({ ...rootlessWs(tr), unitId }) // 带上 unitId:选它不是「回这台电脑」(见 appStore.setNewChatWs)
    return list
  }, [unitId, dirs, tr, rows])
}
