/** Database(.db 文件)渲染端共享 store:key = `![[ ]]` 的 ref 原文 → 同一 db 的多处嵌入
 *  (同页多块 / 多标签同页)命中同一 entry,数据共享、写穿互见,不互踩。
 *  写穿:mutate 纯函数换 data + per-ref 500ms 防抖落盘(照 pageStore 模块级 saveTimer 先例);
 *  外部改动经 watcher 的 onDbExternalChange → reloadByPath 热重载;missing/corrupt 态另有「重试」手动 reload。 */
import { create } from 'zustand'
import type { DbFile } from '@amadeus-shared/db/schema'
import { stampUpdatedRows } from '@amadeus-shared/db/stamp'
import { amadeus } from '../api'
import { kickAutomation } from './automationKick'

export interface DbEntry {
  status: 'loading' | 'ok' | 'missing' | 'corrupt'
  /** ok/corrupt 时为解析出的 vault 相对路径(写回/reveal 用)。 */
  path: string | null
  data: DbFile | null
  message?: string
  /** 读到这份数据时的磁盘票据(宿主支持比对交换写才有;见 ipc.ts DbReadResult.version)。 */
  version?: string
}

interface DbStoreState {
  entries: Record<string, DbEntry>
  /** 缓存代次:**整片作废**时 +1(目前只有切库,见 dbAggregateStore 末尾的 vaultRoot 订阅)。
   *  存在的理由:消费者的加载 effect 依赖的是 `[pagePath, ref]`,清空 entries 不会让它们重跑 ——
   *  于是「启动时 vault 还没打开就挂上的多维表」被清成 undefined 后**永远**停在「读取数据库…」
   *  (用户实报:一进 ERP Space 就一直显示在加载)。把 gen 写进 deps,清空即重读。
   *  **重读必然读得到**:清空是 restoreVault/switchSide 那一次 `set({ vaultRoot })` 触发的,而那时
   *  IPC 早已返回 —— 主进程的 root 在 activateRoot 里就设好了。所以 gen 触发的这一发不会再撞空根。 */
  gen: number
  /** 幂等加载:已 ok 的 ref 跳过(多个嵌入共用一次载入)。 */
  load(pagePath: string, ref: string): Promise<void>
  /** 强制重读(missing/corrupt 态「重试」)。 */
  reload(pagePath: string, ref: string): Promise<void>
  /** 外部改了某 vault 相对路径的 .db(如 agent 直连磁盘)→ 重读所有解析到该路径的已载条目。 */
  reloadByPath(dbPath: string): Promise<void>
  /** 纯函数换 data + 防抖写穿;非 ok 态 no-op(损坏文件绝不回写)。 */
  mutate(ref: string, fn: (d: DbFile) => DbFile): void
  flushAll(): Promise<void>
  /** 文件改名后清场:清 timer + 删所有解析到该路径的条目,不落盘(防 stale entry 把数据写回旧路径)。 */
  dropByPath(dbPath: string): void
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const SAVE_DELAY = 500

/** 未落盘的纯函数改动(按 ref 累积,落盘成功即清)。
 *  存在的理由:防抖窗口里别人(引擎的自动化动作 / 另一个进程)改了同一个 .db,我们不能拿旧快照
 *  盖回去,也不能把用户刚敲的东西丢掉 —— 唯一两全的办法是**重读磁盘 + 把这些改动重放上去**。
 *  能这么做全靠 mutate 的入参本来就是纯函数 `(d) => d`。 */
const pendingOps = new Map<string, ((d: DbFile) => DbFile)[]>()

/** per-ref 单飞:persist 是异步的,没有它两次落盘会并发跑,第二次可能把第一次已提交的 op 再应用一遍
 *  (append 类 op 重复应用 = 凭空多一行)。 */
const inFlight = new Set<string>()

/** 只删**本次真正提交进去**的那些 op(按前缀 ack)。整队列 delete 会把 CAS 等待期间用户新加的
 *  改动一起丢掉 —— 那些 op 还没被写进任何一次提交。 */
function ackOps(ref: string, committed: ((d: DbFile) => DbFile)[]): void {
  const cur = pendingOps.get(ref)
  if (!cur) return
  const rest = cur.slice(committed.length)
  if (rest.length) pendingOps.set(ref, rest)
  else pendingOps.delete(ref)
}

/** 冲突重试上限:每次都重读最新再重放,3 次还撞说明有人在狂写,交给下一次 mutate。 */
const MAX_CAS_RETRY = 3

function applyOps(data: DbFile, ops: ((d: DbFile) => DbFile)[]): DbFile {
  return ops.reduce((d, fn) => fn(d), data)
}

async function persist(ref: string, attempt = 0): Promise<void> {
  if (attempt === 0) {
    if (inFlight.has(ref)) return // 上一次落盘还在飞;它结束时若还有余量会被下一次 mutate 的 timer 接走
    inFlight.add(ref)
  }
  try {
    await persistInner(ref, attempt)
  } finally {
    if (attempt === 0) inFlight.delete(ref)
  }
}

async function persistInner(ref: string, attempt: number): Promise<void> {
  const e = useDbStore.getState().entries[ref]
  if (!e || e.status !== 'ok' || !e.path || !e.data) return
  const ops = [...(pendingOps.get(ref) ?? [])] // 快照:CAS 等待期间用户可能又 mutate,那些不属于本批
  try {
    // 宿主没有比对交换写(云端 / 移动端桥),或这份数据没有票据 → 老路无条件写。
    if (!amadeus.writeDatabaseCas || !e.version) {
      await amadeus.writeDatabase(e.path, e.data)
      ackOps(ref, ops)
      return
    }
    const r = await amadeus.writeDatabaseCas(e.path, e.data, e.version)
    if (r.ok) {
      ackOps(ref, ops)
      set0(ref, (cur) => ({ ...cur, version: r.version }))
      kickAutomation() // 让盯这张表的 db_changed 规则 ~2s 内看到,而不是等下一个巡检周期
      // 提交期间用户又改了 → 还有余量,立刻再排一次(否则要等下一次按键才落盘)
      if (pendingOps.get(ref)?.length) arm(ref)
      return
    }
    // 冲突:磁盘上已是别人的新版本。重读 → 把本地这批改动重放上去 → 再写。
    if (attempt >= MAX_CAS_RETRY) { arm(ref); return } // 重试耗尽:重新武装 timer,别把改动困在内存里
    await useDbStore.getState().reload(e.path, ref)
    const fresh = useDbStore.getState().entries[ref]
    if (!fresh || fresh.status !== 'ok' || !fresh.data) return
    // 重放**当前全部** pending(含等待期间新加的),而不是本批快照 —— 重读已经把内存态换成磁盘版了。
    set0(ref, (cur) => ({ ...cur, data: applyOps(fresh.data as DbFile, pendingOps.get(ref) ?? []) }))
    await persistInner(ref, attempt + 1)
  } catch {
    // 主进程校验拒写/磁盘错误:内存态与 pendingOps 都保留,并重新武装 timer
    // (只靠「下次 mutate 再试」的话,用户停手不动这批改动就永远不落盘)。
    arm(ref)
  }
}

/** 武装/重排防抖落盘。 */
function arm(ref: string): void {
  const t = saveTimers.get(ref)
  if (t) clearTimeout(t)
  saveTimers.set(ref, setTimeout(() => { saveTimers.delete(ref); void persist(ref) }, SAVE_DELAY))
}

/** 就地改一个 entry(不动其余)。 */
function set0(ref: string, fn: (e: DbEntry) => DbEntry): void {
  useDbStore.setState((s) => {
    const cur = s.entries[ref]
    return cur ? { entries: { ...s.entries, [ref]: fn(cur) } } : s
  })
}

export const useDbStore = create<DbStoreState>((set, get) => ({
  entries: {},
  gen: 0,

  async load(pagePath, ref) {
    const cur = get().entries[ref]
    if (cur && cur.status !== 'missing') return
    await get().reload(pagePath, ref)
  },

  async reload(pagePath, ref) {
    set((s) => ({ entries: { ...s.entries, [ref]: { status: 'loading', path: null, data: null } } }))
    try {
      const r = await amadeus.readDatabase(pagePath, ref)
      const entry: DbEntry =
        r.status === 'ok'
          ? { status: 'ok', path: r.path, data: r.data, version: r.version }
          : r.status === 'corrupt'
            ? { status: 'corrupt', path: r.path, data: null, message: r.message }
            : { status: 'missing', path: null, data: null }
      set((s) => ({ entries: { ...s.entries, [ref]: entry } }))
    } catch {
      set((s) => ({ entries: { ...s.entries, [ref]: { status: 'missing', path: null, data: null } } }))
    }
  },

  async reloadByPath(dbPath) {
    // entry.path 是 readDatabase 解析出的确切 vault 相对路径;传它作 pagePath 让 basename ref 也能正确重解析。
    const refs = Object.entries(get().entries)
      .filter(([, e]) => e.path === dbPath)
      .map(([ref]) => ref)
    await Promise.all(refs.map(async (ref) => {
      await get().reload(dbPath, ref)
      // 外部改动落地时,本地可能还有没落盘的改动(防抖窗口里)。重读会把它们冲掉 —— 重放回去,
      // 否则「自动化加了一行」会顺手吃掉用户此刻正在敲的那个格子。
      const ops = pendingOps.get(ref)
      const fresh = get().entries[ref]
      if (ops?.length && fresh?.status === 'ok' && fresh.data) {
        set0(ref, (cur) => ({ ...cur, data: applyOps(fresh.data as DbFile, ops) }))
      }
    }))
  },

  mutate(ref, fn) {
    const e = get().entries[ref]
    if (!e || e.status !== 'ok' || !e.data) return
    // `updated`(修改时间)列的盖章点:所有写口(setCell / 行操作 / 日历改期 / 看板拖动)都汇到这里。
    // 盖章包在 op **里面**而不是只盖一次结果:CAS 冲突重放 / 外部热重载重放的是 op,裸 fn 重放会把章丢掉。
    const op = (d: DbFile): DbFile => stampUpdatedRows(d, fn(d))
    const next = op(e.data)
    pendingOps.set(ref, [...(pendingOps.get(ref) ?? []), op]) // 冲突时按同样的顺序重放到最新磁盘数据上
    set((s) => ({ entries: { ...s.entries, [ref]: { ...e, data: next } } }))
    arm(ref)
  },

  async flushAll() {
    // 也要冲刷「有 pending 但 timer 已消失」的 ref(CAS 重试耗尽/异常路径),否则这批改动只留在内存。
    const refs = [...new Set([...saveTimers.keys(), ...pendingOps.keys()])]
    for (const t of saveTimers.values()) clearTimeout(t)
    saveTimers.clear()
    await Promise.all(refs.map((r) => persist(r)))
  },

  dropByPath(dbPath) {
    const refs = Object.entries(get().entries)
      .filter(([, e]) => e.path === dbPath)
      .map(([ref]) => ref)
    if (!refs.length) return
    for (const ref of refs) {
      const t = saveTimers.get(ref)
      if (t) clearTimeout(t)
      saveTimers.delete(ref)
      pendingOps.delete(ref) // 改名清场:这些改动的落点已经不存在了,重放只会写回旧路径
    }
    set((s) => {
      const entries = { ...s.entries }
      for (const ref of refs) delete entries[ref]
      return { entries }
    })
  },
}))

// 退出前 best-effort 冲刷(与 pageStore 400ms 防抖同级的既有丢尾窗口,尽力缩小)。
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { void useDbStore.getState().flushAll() })
}
// 外部改 .db(如 agent 直连磁盘改日历)→ 热重载对应条目,Calendar/表格实时刷新。
if (typeof window !== 'undefined' && window.amadeus) {
  amadeus.onDbExternalChange?.((dbPath) => { void useDbStore.getState().reloadByPath(dbPath) })
}
