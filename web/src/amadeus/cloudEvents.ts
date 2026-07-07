/**
 * 云端 vault 的变更推送(SSE,GET /vaults/:v/events):替代桌面的 chokidar watcher。
 * - EventSource 无法带 Header → token 走 ?token= 查询串;
 * - 断线自管理重连:指数退避 1s→30s + 抖动(不用 EventSource 自带的固定重试);
 * - 回声抑制:自己写的(origin.client === clientId)或已知 seq 之前的旧事件丢弃 —— 只抑制
 *   页面/.db 内容事件,结构事件永不抑制(设计要求;树刷新有 300ms 防抖 + 树缓存去重兜底);
 * - 断线补课:重连后 hello.seq 出现缺口、或服务端显式 reset → 触发一次结构刷新 +
 *   当前笔记 external-change(pageStore.reconcileExternal 走既有 LWW 通道)。
 *
 * change 事件体(与服务端约定,宽容解析):{ path?, seq?, op?/kind?, origin?: { client? } }。
 * op/kind 含 create/delete/move/rename/folder/structure… 视为结构事件;write/modify 等视为内容事件;
 * 缺省(无法判断)按内容事件处理,结构一致性由 hello 缺口补课与手动刷新兜底。
 */

export interface CloudEventsCfg {
  /** 每次(重)连时求值 —— token 可能已轮换。 */
  url(): string
  clientId: string
  /** 本端已知的 path→seq(只由自己的 GET/PUT 更新;事件 seq <= 已知 = 回声/旧闻)。 */
  knownSeq(path: string): number | undefined
  lastLoadedPage(): string | null
  onPageChange(path: string): void
  onDbChange(path: string): void
  /** 已在此处 300ms 防抖。 */
  onStructureChange(): void
}

interface ChangeRecord {
  path?: unknown
  seq?: unknown
  op?: unknown
  kind?: unknown
  origin?: { client?: unknown }
}

const STRUCTURAL_RE = /structure|create|delete|remove|move|rename|mkdir|rmdir|folder|binary|upload/

/** 启动 SSE 循环;返回停止函数。 */
export function startCloudEvents(cfg: CloudEventsCfg): () => void {
  let es: EventSource | null = null
  let stopped = false
  let backoff = 1000
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let structTimer: ReturnType<typeof setTimeout> | null = null
  /** 见过的最大事件序号(change.seq 与 hello.seq);hello 带缺口 = 断线期间漏事件。 */
  let lastSeq: number | null = null
  let hadSession = false

  const fireStructure = (): void => {
    if (structTimer) return
    structTimer = setTimeout(() => {
      structTimer = null
      cfg.onStructureChange()
    }, 300)
  }

  /** 断线补课 / reset:结构刷一次 + 当前笔记走 external-change(既有 LWW reconcile)。 */
  const recoverGap = (): void => {
    fireStructure()
    const lp = cfg.lastLoadedPage()
    if (lp) cfg.onPageChange(lp)
  }

  const handleChange = (raw: string): void => {
    let c: ChangeRecord
    try { c = JSON.parse(raw) as ChangeRecord } catch { return }
    const seq = typeof c.seq === 'number' ? c.seq : null
    if (seq !== null) lastSeq = Math.max(lastSeq ?? 0, seq)
    const path = typeof c.path === 'string' ? c.path : ''
    const opRaw = `${typeof c.op === 'string' ? c.op : ''} ${typeof c.kind === 'string' ? c.kind : ''}`.toLowerCase()
    // 结构事件:永不回声抑制(自己 move/delete 也要让别的面板刷树;防抖+缓存去重兜底)。
    if (!path || STRUCTURAL_RE.test(opRaw)) fireStructure()
    if (!path) return
    // 内容事件回声抑制:自己写的 / 已知 seq 之前的旧事件 → 丢弃。
    const own = typeof c.origin?.client === 'string' && c.origin.client === cfg.clientId
    const known = cfg.knownSeq(path)
    const stale = seq !== null && known !== undefined && seq <= known
    if (own || stale) return
    if (/\.md$/i.test(path)) cfg.onPageChange(path)
    else if (/\.db$/i.test(path)) cfg.onDbChange(path)
  }

  const connect = (): void => {
    if (stopped) return
    let src: EventSource
    try {
      src = new EventSource(cfg.url())
    } catch {
      scheduleRetry()
      return
    }
    es = src
    src.onopen = () => { backoff = 1000 }
    src.addEventListener('hello', (e) => {
      let seq: number | null = null
      try {
        const d = JSON.parse((e as MessageEvent).data as string) as { seq?: unknown }
        if (typeof d.seq === 'number') seq = d.seq
      } catch { /* hello 无体也接受 */ }
      // 重连后发现缺口 → 补课一次(首连不算:restoreVault 刚拉过全量树)。
      if (hadSession && seq !== null && lastSeq !== null && seq > lastSeq) recoverGap()
      if (seq !== null) lastSeq = Math.max(lastSeq ?? 0, seq)
      hadSession = true
    })
    src.addEventListener('change', (e) => handleChange((e as MessageEvent).data as string))
    src.addEventListener('reset', () => recoverGap())
    src.onerror = () => {
      src.close()
      if (es === src) es = null
      scheduleRetry()
    }
  }

  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return
    const delay = backoff + Math.random() * backoff * 0.3 // + 抖动,防羊群
    backoff = Math.min(backoff * 2, 30_000)
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delay)
  }

  connect()

  return () => {
    stopped = true
    es?.close()
    es = null
    if (retryTimer) clearTimeout(retryTimer)
    if (structTimer) clearTimeout(structTimer)
  }
}
