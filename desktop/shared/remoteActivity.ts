/**
 * 引擎 GET /agent/remote/activity(+ /events)快照的形状镜像(设备能力 MCP 方案 P1 · K2 §3.2)。
 * 真身在 tangu-agent/src/services/remoteActivity.ts(引擎 rootDir 不含 desktop/,同 computerHistory 先例各留一份);
 * 两边各有一条测试钉字段(shared/remoteActivity.test.ts ↔ 引擎 remoteActivity.test.ts)。只增字段,不改名。
 */

export type RunCategory = 'remote' | 'channel' | 'unattended' | 'local'

export interface ActivityRun {
  runId: string
  sessionId: string
  category: RunCategory
  /** 仅 remote:来路 + 调用方(K1;callerName 是不可信串,显示前再净化)。 */
  remote?: { via?: 'tunnel' | 'p2p' | 'lan'; marked: boolean; callerUnit?: string; callerKind?: 'phone' | 'desktop'; callerName?: string }
  channel?: string
  unattended?: 'muse' | 'automation'
  agentSlug?: string
  startedAt: number
  /** 审批 + 计划拍板。 */
  pendingApprovals: number
  pendingInquiries: number
  taintedMidRun?: true
}

export interface ActivityProcess {
  id: string
  sessionId: string
  runId?: string
  origin: Exclude<RunCategory, 'local'>
  pid: number | null
  command: string
  startedAt: number
}

export interface ActivityLockState {
  locked: boolean
  source: 'file' | 'latch' | null
  at?: number
}

export interface ActivitySnapshot {
  v: 1
  bootId: string
  seq: number
  lock: ActivityLockState
  runs: ActivityRun[]
  processes: ActivityProcess[]
}

/** 急停路由的回包(引擎 routes/remote.ts EstopReport)。 */
export interface EstopReport {
  ok: true
  aborted: Array<{ runId: string; sessionId: string; category: RunCategory }>
  killedProcesses: number
  revertedEntries: number
  locked: boolean
}

/** 宽松解析 SSE / GET 回来的快照:形状不对 → null(调用方保留上一份)。 */
export function parseActivitySnapshot(v: unknown): ActivitySnapshot | null {
  const o = v as ActivitySnapshot
  if (!o || typeof o !== 'object' || o.v !== 1 || typeof o.bootId !== 'string' || typeof o.seq !== 'number') return null
  if (!Array.isArray(o.runs) || !Array.isArray(o.processes) || !o.lock || typeof o.lock !== 'object') return null
  const runs = o.runs.filter((r) => r && typeof r.runId === 'string' && typeof r.category === 'string')
  return { ...o, runs, processes: o.processes.filter((p) => p && typeof p.id === 'string') }
}
