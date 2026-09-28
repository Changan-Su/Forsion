/**
 * 按目标的 host 文件只读面(P1-K6 §3.7)。形状与桌面契约 `window.tangu.readHostFile / listDir / statPath` 逐字一致
 * (设备页 web/src/unitShim.ts 也是同一形状),会话作用域的文件读者据此换成「这个会话所在的那台电脑」:
 *   local / unitPage → window.tangu 上现成的三件(没有就 null);
 *   unit             → `GET {unitBase}/unit/hostfile|hostdir|hoststat`(经 hub,unitWeb 侧 realpath 钳制、隧道读上限 4MB);
 *   cloud            → null(云网关没有 host FS)。
 * 错误语义同桌面:readHostFile 失败抛;listDir 失败 = [];statPath 失败 = null。
 */
import type { EngineTarget } from './target'
import { focusRef, homeVia, targetForSession, unitFetch } from './targets'

type Tangu = NonNullable<Window['tangu']>
export interface HostFs {
  readHostFile(filePath: string): ReturnType<NonNullable<Tangu['readHostFile']>>
  listDir(dirPath: string): ReturnType<NonNullable<Tangu['listDir']>>
  statPath(p: string): ReturnType<NonNullable<Tangu['statPath']>>
}

function windowHostFs(): HostFs | null {
  const w = typeof window !== 'undefined' ? window.tangu : undefined
  if (!w?.readHostFile) return null
  return {
    readHostFile: (p) => w.readHostFile!(p),
    listDir: async (p) => (w.listDir ? w.listDir(p) : []),
    statPath: async (p) => (w.statPath ? w.statPath(p) : null),
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
  }
}

export function hostFs(t: EngineTarget): HostFs | null {
  switch (t.via) {
    case 'local':
    case 'unitPage':
      return windowHostFs()
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
    return via === 'local' || via === 'unitPage' ? windowHostFs() : null
  }
  return hostFs(targetForSession(sessionId))
}
