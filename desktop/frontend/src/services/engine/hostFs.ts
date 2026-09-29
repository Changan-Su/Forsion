/**
 * 按目标的 host 文件只读面(P1-K6 §3.7)。形状与桌面契约 `window.tangu.readHostFile / listDir / statPath` 逐字一致
 * (设备页 web/src/unitShim.ts 也是同一形状),会话作用域的文件读者据此换成「这个会话所在的那台电脑」:
 *   local / unitPage → window.tangu 上现成的三件(没有就 null);
 *   unit             → `GET {unitBase}/unit/hostfile|hostdir|hoststat`(经 hub,unitWeb 侧 realpath 钳制、隧道读上限 4MB);
 *   cloud            → null(云网关没有 host FS)。
 * 错误语义同桌面:readHostFile 失败抛;listDir 失败 = [];statPath 失败 = null。
 *
 * downloadHostFile(P1-DL,把文件交给用户):本机桌面 = 在文件管理器里显示(revealHostPath,行为不变);设备页 = unitShim 的
 * downloadHostFile;unit = `GET {unitBase}/unit/hostfile/download`(流式原文件,不受 hostfile 预览的 4MB 隧道上限)→ saveResponseAs。
 * 缺 = 这端给不了(调用方藏掉下载位,不留哑弹);失败抛(调用方进通知)。
 */
import type { EngineTarget } from './target'
import { focusRef, homeVia, targetForSession, unitFetch } from './targets'
import { hostDownloadError, saveResponseAs } from '../nativeDownload'

type Tangu = NonNullable<Window['tangu']>
export interface HostFs {
  readHostFile(filePath: string): ReturnType<NonNullable<Tangu['readHostFile']>>
  listDir(dirPath: string): ReturnType<NonNullable<Tangu['listDir']>>
  statPath(p: string): ReturnType<NonNullable<Tangu['statPath']>>
  /** 把这个文件交给用户(本机 = 在文件管理器里显示;远端 = 下载原文件)。缺 = 这端给不了。 */
  downloadHostFile?(path: string, name: string): Promise<void>
  /** 字节就在这台机器的本地盘上(Electron 本机):预览可按路径持久化(wsfile 恢复走 window.tangu.readHostFile)。
   *  设备页 / unit 恒 false —— 那条恢复路读不到对方的盘。 */
  local: boolean
}

function windowHostFs(local: boolean): HostFs | null {
  const w = typeof window !== 'undefined' ? window.tangu : undefined
  if (!w?.readHostFile) return null
  return {
    readHostFile: (p) => w.readHostFile!(p),
    listDir: async (p) => (w.listDir ? w.listDir(p) : []),
    statPath: async (p) => (w.statPath ? w.statPath(p) : null),
    downloadHostFile: w.revealHostPath ? async (p) => { await w.revealHostPath!(p) }
      : w.downloadHostFile ? (p, name) => w.downloadHostFile!(p, name)
      : undefined,
    local,
  }
}

function unitHostFs(t: EngineTarget): HostFs {
  const q = (p: string): string => `?path=${encodeURIComponent(p)}`
  return {
    readHostFile: async (p) => {
      const r = await unitFetch(t, `/unit/hostfile${q(p)}`, { timeoutMs: 30_000 })
      if (!r.ok) throw Object.assign(new Error(`hostfile HTTP ${r.status}`), { status: r.status })
      return r.json()
    },
    listDir: async (p) => {
      try {
        const r = await unitFetch(t, `/unit/hostdir${q(p)}`, { timeoutMs: 15_000 })
        if (!r.ok) return []
        return ((await r.json()) as { entries?: Awaited<ReturnType<HostFs['listDir']>> }).entries || []
      } catch { return [] }
    },
    statPath: async (p) => {
      try {
        const r = await unitFetch(t, `/unit/hoststat${q(p)}`, { timeoutMs: 15_000 })
        if (!r.ok) return null
        return r.json()
      } catch { return null }
    },
    // 不设超时:大文件的 body 要一路流完,超时会把下到一半的文件掐断
    downloadHostFile: async (p, name) => {
      const r = await unitFetch(t, `/unit/hostfile/download${q(p)}`)
      if (!r.ok) throw await hostDownloadError(r)
      await saveResponseAs(name, r)
    },
    local: false,
  }
}

export function hostFs(t: EngineTarget): HostFs | null {
  switch (t.via) {
    case 'local':
      return windowHostFs(true)
    case 'unitPage':
      return windowHostFs(false)
    case 'unit':
      return unitHostFs(t)
    case 'cloud':
      return null
  }
}

/** unit 目标那台电脑的家目录与默认工作区(unitWeb `/unit/config` 只读白名单里的两项,unitConfigFace.ts 的 UNIT_CONFIG_RO)。
 *  新会话落点要它:手机自己没有 homeDir / defaultWorkspaceDir,不拿对方的就只能建出沙箱会话。拿不到 → null。 */
export async function unitHostProfile(t: EngineTarget, signal?: AbortSignal): Promise<{ homeDir: string | null; defaultWorkspaceDir: string | null } | null> {
  if (t.via !== 'unit') return null
  try {
    const r = await unitFetch(t, '/unit/config', { timeoutMs: 15_000, ...(signal ? { signal } : {}) })
    if (!r.ok) return null
    const c = ((await r.json()) as { config?: Record<string, unknown> }).config || {}
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
    return { homeDir: str(c.homeDir), defaultWorkspaceDir: str(c.defaultWorkspaceDir) }
  } catch { return null }
}

/** 会话作用域的 host 文件面(S2:会话所在 = 焦点)。焦点在 home 时不铸目标、不要求宿主已装好(组件单测也能渲染):
 *  按端现算的来路 → 本机 / 设备页用 window.tangu 那三件,云端没有。 */
export function hostFsForSession(sessionId?: string): HostFs | null {
  if (focusRef().kind === 'home') {
    const via = homeVia()
    return via === 'local' || via === 'unitPage' ? windowHostFs(via === 'local') : null
  }
  return hostFs(targetForSession(sessionId))
}
