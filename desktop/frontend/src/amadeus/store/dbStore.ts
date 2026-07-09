/** Database(.db 文件)渲染端共享 store:key = `![[ ]]` 的 ref 原文 → 同一 db 的多处嵌入
 *  (同页多块 / 多标签同页)命中同一 entry,数据共享、写穿互见,不互踩。
 *  写穿:mutate 纯函数换 data + per-ref 500ms 防抖落盘(照 pageStore 模块级 saveTimer 先例);
 *  外部改动经 watcher 的 onDbExternalChange → reloadByPath 热重载;missing/corrupt 态另有「重试」手动 reload。 */
import { create } from 'zustand'
import type { DbFile } from '@amadeus-shared/db/schema'
import { amadeus } from '../api'

export interface DbEntry {
  status: 'loading' | 'ok' | 'missing' | 'corrupt'
  /** ok/corrupt 时为解析出的 vault 相对路径(写回/reveal 用)。 */
  path: string | null
  data: DbFile | null
  message?: string
}

interface DbStoreState {
  entries: Record<string, DbEntry>
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

async function persist(ref: string): Promise<void> {
  const e = useDbStore.getState().entries[ref]
  if (!e || e.status !== 'ok' || !e.path || !e.data) return
  try {
    await amadeus.writeDatabase(e.path, e.data)
  } catch {
    /* 主进程校验拒写/磁盘错误:内存态保留,下次 mutate 再试 */
  }
}

export const useDbStore = create<DbStoreState>((set, get) => ({
  entries: {},

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
          ? { status: 'ok', path: r.path, data: r.data }
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
    await Promise.all(refs.map((ref) => get().reload(dbPath, ref)))
  },

  mutate(ref, fn) {
    const e = get().entries[ref]
    if (!e || e.status !== 'ok' || !e.data) return
    const next = fn(e.data)
    set((s) => ({ entries: { ...s.entries, [ref]: { ...e, data: next } } }))
    const t = saveTimers.get(ref)
    if (t) clearTimeout(t)
    saveTimers.set(ref, setTimeout(() => { saveTimers.delete(ref); void persist(ref) }, SAVE_DELAY))
  },

  async flushAll() {
    const refs = [...saveTimers.keys()]
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
