/** Excalidraw 画板(`.excalidraw.md`)渲染端 store:key = `![[ ]]` 的 ref 原文 → 同一画板的多处嵌入
 *  命中同一 entry,数据共享、写穿互见(照 dbStore 先例)。
 *  比 dbStore 简单:<Excalidraw> 自己持有编辑态,这里只管「初次读盘」+「防抖写回」,不存活场景。
 *  写回 = 在**文件原文**上只换 Drawing 段(见 shared/amadeus/excalidraw/format),
 *  frontmatter / 文本段 / 元素链接段原样保留 —— 抹了就是在 Obsidian 那边毁档。
 *
 *  跨端同步(桌面云端镜像 ↔ web)三件套 —— 白板曾是「整文件后写胜」,两端同时开着就互相覆盖:
 *  1. save() 按 lastSceneJson 去重:视口/选择级 onChange 与合并回声不再写盘;
 *  2. onExternalChange(桌面=watcher/引擎拉回,web=SSE)→ 元素级合并进打开中的画布(appliers);
 *  3. persist 写前预读:文件被别的端改过 → mergeScenes 后再写,不盲盖。 */
import { create } from 'zustand'
import type { ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import { parseDrawing, withSceneJson, isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { readBoard, writeBoard, DEFAULT_BOARD, type BoardSettings } from '@amadeus-shared/excalidraw/board'
import { mergeScenes, type SceneLike } from '@amadeus-shared/excalidraw/reconcile'
import { amadeus } from '../api'

export interface DrawEntry {
  status: 'loading' | 'ok' | 'missing' | 'corrupt'
  /** ok/corrupt 时为解析出的 vault 相对路径(写回/reveal 用)。 */
  path: string | null
  /** 文件原文;每次写回都在它之上换载荷。 */
  source: string | null
  /** 解析好的场景对象 = 新挂载画布的 initialData 种子。载入时产出,**每次落盘后跟进到最新**:
   *  已挂载的画布自持编辑态不看它,但**下一次挂载**全靠它 —— 不跟进就是「白板关掉重开回到旧内容」
   *  (load 对 ok 态幂等跳过),旧种子上再画一笔还会把磁盘上的新内容盖回去。 */
  scene: ExcalidrawInitialDataState | null
  /** 纸张 + 网格,来自 frontmatter(见 shared/amadeus/excalidraw/board)。每次 source 推进都跟着重读。 */
  settings: BoardSettings
}

interface DrawStoreState {
  entries: Record<string, DrawEntry>
  /** 幂等加载:已 ok 的 ref 跳过(多处嵌入共用一次载入)。 */
  load(pagePath: string, ref: string): Promise<void>
  /** 强制重读(missing/corrupt 态「重试」)。 */
  reload(pagePath: string, ref: string): Promise<void>
  /** 记下最新场景并防抖落盘;非 ok 态 no-op(损坏文件绝不回写)。 */
  save(ref: string, sceneJson: string): void
  /** 新挂载画布的种子:优先取还没落盘的 pendingScene(关了秒开、防抖窗内的竞态),否则 entry.scene。 */
  seedFor(ref: string): ExcalidrawInitialDataState | null
  /** 立即冲刷单个画板(画布卸载时调):清防抖计时器,pending 场景即刻落盘。 */
  flush(ref: string): Promise<void>
  flushAll(): Promise<void>
  /** 改纸张/网格:写 frontmatter,**不碰 Drawing 段**。
   *  收的是**增量**而不是整份快照:面板连点两下(先改纸张、紧接着开网格)时,第二下手里的 settings
   *  还是没落盘的旧值,传整份就会把第一下带回去。增量落在「刚读到的盘面」上合并,两下都留得住。 */
  setSettings(ref: string, patch: Partial<BoardSettings>): Promise<void>
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** ref → 待落盘的场景 JSON(只留最后一次)。 */
const pendingScene = new Map<string, string>()
/** ref → 最近一次「与盘面一致」的场景 JSON(load/persist/外部合并时推进)。save 去重基线。 */
const lastSceneJson = new Map<string, string>()
/** 画板的 onChange 是鼠标级高频(拖一根线就几十次)→ 比 dbStore 的 500ms 更宽。 */
const SAVE_DELAY = 800

/** 活画布的「远端场景应用器」:由 ExcalidrawCanvas 注册(合并逻辑在 lazy chunk 内,
 *  这里绝不 import @excalidraw/excalidraw)。同一画板多处嵌入 → 多个应用器。 */
export type DrawingRemoteApplier = (remote: SceneLike) => void
const appliers = new Map<string, Set<DrawingRemoteApplier>>()
export function registerDrawingApplier(ref: string, fn: DrawingRemoteApplier): () => void {
  let set = appliers.get(ref)
  if (!set) {
    set = new Set()
    appliers.set(ref, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (!set.size) appliers.delete(ref)
  }
}

const fanoutRemote = (ref: string, remote: SceneLike): void => {
  for (const fn of appliers.get(ref) ?? []) {
    try {
      fn(remote)
    } catch {
      /* 画布侧异常不打断 store */
    }
  }
}

const tryParseScene = (json: string): SceneLike | null => {
  try {
    return JSON.parse(json) as SceneLike
  } catch {
    return null
  }
}

/** 外部变更(watcher/SSE,自写回声已在事件源过滤)→ 重读文件,元素级合并进内存态与活画布。
 *  同一路径可能挂多个 ref(独立视图用全路径、笔记嵌入用 `![[X.excalidraw]]` 原文)→ 逐个处理。 */
async function applyExternal(rawPath: string): Promise<void> {
  const p = rawPath.replace(/\\/g, '/')
  if (!isDrawingPath(p)) return
  const s = useDrawStore.getState()
  for (const [ref, e] of Object.entries(s.entries)) {
    if (!e.path || e.path.replace(/\\/g, '/') !== p) continue
    if (e.status !== 'ok') {
      void s.reload(p, ref) // corrupt/missing 的文件被外部修好了 → 直接重读
      continue
    }
    try {
      const r = await amadeus.readDrawing(e.path, e.path)
      if (r.status !== 'ok') continue // 删除/移动交给 structureChange/树
      const parsed = parseDrawing(r.source)
      const remote = parsed ? tryParseScene(parsed.sceneJson) : null
      if (!parsed || !remote) continue // 对面写了坏档:本端保持现状
      const localSeed = (s.seedFor(ref) ?? e.scene ?? {}) as SceneLike
      const merged = mergeScenes(localSeed, remote)
      // 远端落盘态成为去重基线:本端无增量时,画布应用合并后的 onChange 回声不再写盘。
      lastSceneJson.set(ref, parsed.sceneJson)
      // 防抖窗内有未落盘笔画:计划中的那次写升级为合并结果(画布活着时其 onChange 会再覆盖,等价)。
      if (pendingScene.has(ref)) pendingScene.set(ref, JSON.stringify(merged))
      useDrawStore.setState((st) => {
        const cur = st.entries[ref]
        return cur
          ? { entries: { ...st.entries, [ref]: { ...cur, source: r.source, scene: merged as ExcalidrawInitialDataState, settings: readBoard(r.source) } } }
          : st
      })
      fanoutRemote(ref, remote)
    } catch {
      /* 读失败:保持现状,下次事件再试 */
    }
  }
}

/** 同一份文件的写必须排队。防抖 persist 与 setSettings 是两条独立的「读-改-写」:计时器已清、
 *  pendingScene 已被取走之后,flush() 察觉不到「有一次 persist 正在飞」,两边各自基于旧原文整文件写回
 *  → 后落地的那次把对方抹掉(丢笔画或丢设置)。
 *  按**解析出的 path** 排队而非 ref:同一份画板可能被独立视图(全路径)与笔记内嵌(`![[X]]` 原文)
 *  两个 ref 同时打开。ponytail: 进程内串行足够(写的是本机文件);跨进程/跨端的竞态仍靠 persist 的读-合并-写。 */
const writeChain = new Map<string, Promise<unknown>>()
function serialize<T>(ref: string, fn: () => Promise<T>): Promise<T> {
  const key = useDrawStore.getState().entries[ref]?.path ?? ref
  const prev = writeChain.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn) // 前一次失败也接着跑,别把队列卡死
  const tail = run.catch(() => {})
  writeChain.set(key, tail)
  void tail.then(() => {
    if (writeChain.get(key) === tail) writeChain.delete(key)
  })
  return run
}

const persist = (ref: string): Promise<void> => serialize(ref, () => persistNow(ref))

async function persistNow(ref: string): Promise<void> {
  const queued = pendingScene.get(ref)
  pendingScene.delete(ref)
  const e = useDrawStore.getState().entries[ref]
  if (queued === undefined || !e || e.status !== 'ok' || !e.path || !e.source) return
  let base = e.source
  let sceneJson = queued
  // 写前预读:打开期间文件可能被别的端改过(引擎拉回镜像/云端 seq 前进)。盲写=整文件盖掉对面的
  // 笔画;读-合并-写把竞态窗缩到毫秒级,web 侧还顺带对齐 CAS seq(readDrawing 会 noteSeq)。
  try {
    const fresh = await amadeus.readDrawing(e.path, e.path)
    if (fresh.status === 'ok') {
      base = fresh.source
      if (fresh.source !== e.source) {
        const rp = parseDrawing(fresh.source)
        const remote = rp ? tryParseScene(rp.sceneJson) : null
        const mine = remote ? tryParseScene(sceneJson) : null
        if (remote && mine) {
          sceneJson = JSON.stringify(mergeScenes(mine, remote))
          fanoutRemote(ref, remote) // 活画布同步吃到远端笔画,别等下一个事件
        }
      }
    }
  } catch {
    /* 预读失败(离线/瞬时):按原样写,旧行为 */
  }
  const next = withSceneJson(base, sceneJson)
  if (!next) return // 定位不到 Drawing 段 → 拒写,绝不把一个不认识的文件覆盖成画板
  try {
    await amadeus.writeDrawing(e.path, next)
    lastSceneJson.set(ref, sceneJson)
    // 原文与场景种子一起推进:source 供下次换段,scene 供下一次挂载定种(见字段注释)。
    const scene = tryParseScene(sceneJson)
    useDrawStore.setState((s) => {
      const cur = s.entries[ref]
      return cur
        ? { entries: { ...s.entries, [ref]: { ...cur, source: next, scene: (scene as ExcalidrawInitialDataState | null) ?? cur.scene, settings: readBoard(next) } } }
        : s
    })
  } catch {
    /* 磁盘错误:内存态保留,下次编辑再试 */
  }
}

export const useDrawStore = create<DrawStoreState>((set, get) => ({
  entries: {},

  async load(pagePath, ref) {
    const cur = get().entries[ref]
    if (cur && cur.status !== 'missing') return
    await get().reload(pagePath, ref)
  },

  async reload(pagePath, ref) {
    set((s) => ({ entries: { ...s.entries, [ref]: { status: 'loading', path: null, source: null, scene: null, settings: DEFAULT_BOARD } } }))
    let entry: DrawEntry = { status: 'missing', path: null, source: null, scene: null, settings: DEFAULT_BOARD }
    lastSceneJson.delete(ref)
    try {
      const r = await amadeus.readDrawing(pagePath, ref)
      if (r.status === 'ok') {
        const parsed = parseDrawing(r.source)
        // 段能定位 ≠ 里面是合法 JSON(手改坏的、被别的工具截断的)→ 一并算 corrupt,只读保护。
        const scene = parsed ? (tryParseScene(parsed.sceneJson) as ExcalidrawInitialDataState | null) : null
        const settings = readBoard(r.source)
        entry = scene
          ? { status: 'ok', path: r.path, source: r.source, scene, settings }
          : { status: 'corrupt', path: r.path, source: r.source, scene: null, settings }
        if (scene && parsed) lastSceneJson.set(ref, parsed.sceneJson)
      }
    } catch {
      /* 保持 missing */
    }
    set((s) => ({ entries: { ...s.entries, [ref]: entry } }))
  },

  save(ref, sceneJson) {
    const e = get().entries[ref]
    if (!e || e.status !== 'ok') return
    // 与盘面一致 → 不写。杀掉两类空转:选择/视口级 onChange(serializeAsJSON 会剪掉瞬时态,
    // 序列化结果不变),以及远端合并应用后画布回声的 onChange(无本地增量时)。
    if (lastSceneJson.get(ref) === sceneJson) return
    pendingScene.set(ref, sceneJson)
    const t = saveTimers.get(ref)
    if (t) clearTimeout(t)
    saveTimers.set(ref, setTimeout(() => { saveTimers.delete(ref); void persist(ref) }, SAVE_DELAY))
  },

  seedFor(ref) {
    const pending = pendingScene.get(ref)
    if (pending !== undefined) {
      try {
        return JSON.parse(pending)
      } catch {
        /* 回落 entry.scene */
      }
    }
    return get().entries[ref]?.scene ?? null
  },

  async flush(ref) {
    const t = saveTimers.get(ref)
    if (t) {
      clearTimeout(t)
      saveTimers.delete(ref)
    }
    await persist(ref)
  },

  async flushAll() {
    const refs = [...saveTimers.keys()]
    for (const t of saveTimers.values()) clearTimeout(t)
    saveTimers.clear()
    await Promise.all(refs.map((r) => persist(r)))
  },

  async setSettings(ref, patch) {
    await get().flush(ref) // 待写的场景先落盘:下面这次写基于 flush 后的原文,不会把笔画倒回去
    return serialize(ref, async () => {
      const e = get().entries[ref]
      if (!e || e.status !== 'ok' || !e.path || !e.source) return
      let base = e.source
      try {
        const fresh = await amadeus.readDrawing(e.path, e.path)
        if (fresh.status === 'ok') base = fresh.source // 与 persist 同款预读:别盲盖别的端的改动
      } catch {
        /* 预读失败:按内存原文写 */
      }
      // 增量合到**刚读到的盘面**上,而不是调用方手里那份可能已过期的快照
      const src = writeBoard(base, { ...readBoard(base), ...patch })
      if (src === base) return // 值没变 / 源没有 frontmatter(writeBoard 原样返回)→ 无可写
      try {
        await amadeus.writeDrawing(e.path, src)
        set((s) => {
          const cur = s.entries[ref]
          return cur ? { entries: { ...s.entries, [ref]: { ...cur, source: src, settings: readBoard(src) } } } : s
        })
      } catch {
        /* 磁盘错误:内存态保留,面板上再点一次即重试 */
      }
    })
  },
}))

// 外部变更 → 热合并(桌面=chokidar watcher/引擎拉回镜像;web=SSE onPageChange;
// 两端事件源都已过滤自写回声:自写账本 / clientId+seq)。dbStore 同款模块级订阅。
amadeus?.onExternalChange?.((p) => {
  // amadeus 也可能整个 undefined(web harness/无桥环境),方法级 ?. 拦不住
  void applyExternal(p)
})

// 退出前 best-effort 冲刷(与 dbStore/pageStore 同级的既有丢尾窗口,尽力缩小)。
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { void useDrawStore.getState().flushAll() })
}
