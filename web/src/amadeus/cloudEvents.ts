/**
 * 云端 vault 的变更推送(SSE,GET /vaults/:v/events):替代桌面的 chokidar watcher。
 * - EventSource 无法带 Header → token 走 ?token= 查询串;
 * - 断线自管理重连:指数退避 1s→30s + 抖动(不用 EventSource 自带的固定重试);
 * - 回声抑制:自己写的(origin.client === clientId)或已知 seq 之前的旧事件丢弃 —— 只抑制
 *   页面/.db 内容事件,结构事件永不抑制(设计要求;树刷新有 300ms 防抖 + 树缓存去重兜底);
 * - 断线补课:重连带 `?since=<已收到的最大 seq>`,服务端在 hello 之后按序重放缺口里的 change(与在线时同一条
 *   处理路径,开着的哪篇笔记都能收到自己那条);重放窗口不够(日志被剪)→ 服务端发 reset → 兜底:结构刷新 +
 *   开着的笔记逐篇 external-change(lastLoadedPage ∪ openPages:v4 笔记主要经 readTextFile 打开,**不保证**设
 *   lastLoadedPage(web 原地打开那条分支会设;移动端单列导航、分屏里的其余实例都不设)—— 只补它就漏补 v4,
 *   下一击键 409 后强写,盖掉别处的修改;评审 G2-01)。
 *   首连不带 since(restoreVault 刚拉过全量树),hello 只记起点。
 *
 * change 事件体(与服务端约定,宽容解析):{ path?, seq?, op?/kind?, origin?: { client? } }。
 * op/kind 含 create/delete/move/rename/folder/structure… 视为结构事件;write/modify 等视为内容事件;
 * 缺省(无法判断)按内容事件处理,结构一致性由 hello 缺口补课与手动刷新兜底。
 */

export interface CloudEventsCfg {
  signal?: AbortSignal
  /** 每次(重)连时求值 —— token 可能已轮换。 */
  url(): string
  clientId: string
  /** 本端已知的 path→seq(只由自己的 GET/PUT 更新;事件 seq <= 已知 = 回声/旧闻)。 */
  knownSeq(path: string): number | undefined
  lastLoadedPage(): string | null
  /** 兜底补课时一并回灌的开着的笔记(web/mobile = unified 生命周期里挂着的 v4 实例)。可选:缺省只补 lastLoadedPage。 */
  openPages?(): string[]
  onPageChange(path: string): void
  onDbChange(path: string): void
  /** 别处把文件改名/移走(op=move,带 newPath)。桥据此把开着的编辑器改指新路径,
   *  否则它下一次自动保存会按旧路径 404→baseSeq 0 把旧名文件**重新造出来**(2026-09-05 幽灵旧名空白页的真因)。 */
  onPageMoved?(from: string, to: string, fileSeq: number | null): void
  /** 别处删掉了文件(op=delete)。桥据此拒绝再往该路径写(编辑胜删除只对本端有未保存改动才成立,
   *  而那一步由用户显式重建,不该由自动保存偷偷完成)。 */
  onPageDeleted?(path: string): void
  /** 别处改名/移动了整个文件夹(op=rename-folder / move-folder,带 newPath):前缀下所有路径同上迁移。 */
  onFolderMoved?(from: string, to: string): void
  /** 别处删了整个文件夹(op=delete-folder)。 */
  onFolderDeleted?(path: string): void
  /** 已在此处 300ms 防抖。 */
  onStructureChange(): void
  /** P2 presence(可选):增量事件 / 连上时的全量名册。 */
  onPresence?(p: unknown): void
  onPresenceRoster?(list: unknown): void
}

interface ChangeRecord {
  path?: unknown
  seq?: unknown
  op?: unknown
  kind?: unknown
  newPath?: unknown
  fileSeq?: unknown
  origin?: { client?: unknown }
}

const STRUCTURAL_RE = /structure|create|delete|remove|move|rename|mkdir|rmdir|folder|binary|upload/

/** 启动 SSE 循环;返回停止函数。 */
export function startCloudEvents(cfg: CloudEventsCfg): () => void {
  let es: EventSource | null = null
  let stopped = cfg.signal?.aborted ?? false
  let backoff = 1000
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let structTimer: ReturnType<typeof setTimeout> | null = null
  /** 已**收到**的最大事件序号(change.seq;hello.seq 只在没有待重放的缺口时计入)—— 重连的 since 就用它。 */
  let lastSeq: number | null = null

  const fireStructure = (): void => {
    if (structTimer) return
    structTimer = setTimeout(() => {
      structTimer = null
      if (stopped) return
      cfg.onStructureChange()
    }, 300)
  }

  /** 兜底补课(重放不可用):结构刷一次 + 开着的笔记逐篇走 external-change(既有回灌通道)。 */
  const recoverGap = (): void => {
    if (stopped) return
    fireStructure()
    for (const p of new Set([cfg.lastLoadedPage(), ...(cfg.openPages?.() ?? [])])) if (p) cfg.onPageChange(p)
  }

  const handleChange = (raw: string): void => {
    if (stopped) return
    let c: ChangeRecord
    try { c = JSON.parse(raw) as ChangeRecord } catch { return }
    const seq = typeof c.seq === 'number' ? c.seq : null
    if (seq !== null) lastSeq = Math.max(lastSeq ?? 0, seq)
    const path = typeof c.path === 'string' ? c.path : ''
    const opRaw = `${typeof c.op === 'string' ? c.op : ''} ${typeof c.kind === 'string' ? c.kind : ''}`.toLowerCase()
    // 结构事件:永不回声抑制(自己 move/delete 也要让别的面板刷树;防抖+缓存去重兜底)。
    if (!path || STRUCTURAL_RE.test(opRaw)) fireStructure()
    if (!path) return
    // 改名/删除的明细(同样不做回声抑制:自己这端别的面板也可能开着旧路径)。
    const op = typeof c.op === 'string' ? c.op : ''
    const newPath = typeof c.newPath === 'string' && c.newPath ? c.newPath : null
    // 改名/删除/文件夹事件到此为止,**不**再往下走旧路径的内容回灌:回灌 = reconcilePage → loadOrCreate 404 →
    // 重建 = 把别处刚挪走/删掉的页原地造回云端(v3 页「删了/改名了还会出现」的路径;Codex 终审 P0)。
    // 树刷新已由上面的结构事件负责;开着旧路径的编辑器由桥的 movedTo/everKnown 接管。
    if (op === 'move' && newPath) { cfg.onPageMoved?.(path, newPath, typeof c.fileSeq === 'number' ? c.fileSeq : null); return }
    if (op === 'delete') { cfg.onPageDeleted?.(path); return }
    if ((op === 'rename-folder' || op === 'move-folder') && newPath) { cfg.onFolderMoved?.(path, newPath); return }
    if (op === 'delete-folder') { cfg.onFolderDeleted?.(path); return }
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
    // 断线重连带上已收到的最大 seq(服务端 routes.ts `/vaults/:v/events`:hello 之后重放 (since, seq],窗口不够 → reset)。
    const since = lastSeq
    /** 本连接 hello 报的服务端 seq,仍有待重放的缺口时暂存(reset 兜底补完才算「已收到」)。 */
    let pendingHelloSeq: number | null = null
    let src: EventSource
    try {
      const u = cfg.url()
      src = new EventSource(since === null ? u : `${u}${u.includes('?') ? '&' : '?'}since=${since}`)
    } catch {
      scheduleRetry()
      return
    }
    es = src
    src.onopen = () => { if (!stopped) backoff = 1000 }
    src.addEventListener('hello', (e) => {
      if (stopped) return
      let seq: number | null = null
      try {
        const d = JSON.parse((e as MessageEvent).data as string) as { seq?: unknown }
        if (typeof d.seq === 'number') seq = d.seq
      } catch { /* hello 无体也接受 */ }
      if (since !== null && seq !== null) {
        // 带了 since:hello 先于重放到达,缺口里的 change 紧跟着就来(或 reset)—— 此刻既不补课也不推进 lastSeq,
        // 否则重放中途再断,下一次 since 会越过没收到的那几条。服务端 seq 倒退(库被重建)= 重放无从谈起,按 reset 兜底。
        if (seq < since) { lastSeq = seq; recoverGap() }
        else if (seq > since) pendingHelloSeq = seq
      } else if (seq !== null) {
        // 首连(或此前从没收到过 seq):restoreVault 刚拉过全量树,hello 只用来记起点。
        lastSeq = Math.max(lastSeq ?? 0, seq)
      }
    })
    src.addEventListener('change', (e) => handleChange((e as MessageEvent).data as string))
    src.addEventListener('reset', () => {
      recoverGap()
      if (pendingHelloSeq !== null) lastSeq = Math.max(lastSeq ?? 0, pendingHelloSeq)
      pendingHelloSeq = null
    })
    src.addEventListener('presence', (e) => {
      if (stopped) return
      try { cfg.onPresence?.(JSON.parse((e as MessageEvent).data as string)) } catch { /* ignore */ }
    })
    src.addEventListener('presence-roster', (e) => {
      if (stopped) return
      try { cfg.onPresenceRoster?.(JSON.parse((e as MessageEvent).data as string)) } catch { /* ignore */ }
    })
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

  const stop = () => {
    stopped = true
    es?.close()
    es = null
    if (retryTimer) clearTimeout(retryTimer)
    if (structTimer) clearTimeout(structTimer)
    cfg.signal?.removeEventListener('abort', stop)
  }
  cfg.signal?.addEventListener('abort', stop, { once: true })
  connect()
  return stop
}
