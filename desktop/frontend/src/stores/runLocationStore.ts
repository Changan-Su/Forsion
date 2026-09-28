/**
 * 新会话的「在哪运行」(P1-K7a;规格 K7 §3.6,裁决 INTEGRATION R-21,缺省 K7 U3)。
 *
 * K6-S4 起**焦点 = 新会话建在哪**(send / createInWorkspace 建在焦点上并绑定;焦点那一侧的 Agent / 模型目录跟着换),所以草稿位置
 * 就是焦点:draftLocation() = focusRef(),setDraftLocation = setFocusTarget + 「用户亲手选的」记忆。不另起一套建会话路径。
 *
 * U3「记住上次的选择,且只在那台 ready 时生效」:
 *   - 用户亲手选(K8「在哪运行」弹层 / 设备分组)→ 记进 `forsion_run_location:<账号>`(与 K6 的焦点落盘分开 —— 焦点会被下面的
 *     对账临时改回云端,不能拿它当记忆);
 *   - 每份新草稿(activeId 从某个会话回到空白)**对账一次**:记住的是某台电脑且它此刻 ready → 焦点切过去;否则 → 云端。
 *     状态还是 checking(名册 / 探针没回来)就等下一轮刷新再对。用户在这份草稿里亲手选过 → 不对账(亲手选的永远赢)。
 *   - 一份草稿最多自动切一次:refocus 会清草稿的项目 / 模型选择,不能随 30s 的刷新来回跳。
 * 没有「记住」的老用户(K8 时代焦点已落盘成某台电脑)→ 把那份焦点当作记忆迁过来。
 *
 * 选择器本身(K8 的 UnitsSheet「在哪运行」,含首次确认流程)由宿主经 installRunLocationChooser 装进来;共享渲染层只画入口。
 */
import { create } from 'zustand'
import { forsionAccountId } from '../../../shared/forsionAccount'
import { cloudApiBase, focusRef, sameRef, setFocusTarget } from '../services/engine/targets'
import { formatRunLocation, HOME, parseRunLocation, type RunLocation } from '../services/runLocation'
import { runLocationsAvailable } from '../features/runtime'
import { useApp } from './appStore'
import { statusOfUnit, unitById, useDeviceSessions } from './deviceSessionsStore'

interface RunLocationState {
  /** 草稿代:activeId 从某个会话回到空白(新对话)就 +1。 */
  draftSeq: number
  /** 这一代草稿里用户亲手选过位置(= draftSeq 时成立)。 */
  explicitSeq: number | null
  /** 这一代草稿已经对过账(= draftSeq 时成立)。 */
  reconciledSeq: number | null
  /** 亲手选的切换正在进行(refocus 会先把 activeId 清空 = 新草稿):这期间不对账,免得把刚选的改回云端。 */
  explicitPending: boolean
  /** 宿主装的选择器入口(手机 = 打开 K8 的「在哪运行」弹层)。null = 这一端没有 → 药丸只读。 */
  chooser: (() => void) | null
}

export const useRunLocation = create<RunLocationState>(() => ({ draftSeq: 0, explicitSeq: null, reconciledSeq: null, explicitPending: false, chooser: null }))

/** 宿主装选择器入口(移动端 installUnitsEntry)。返回卸载函数。 */
export function installRunLocationChooser(open: () => void): () => void {
  useRunLocation.setState({ chooser: open })
  return () => { if (useRunLocation.getState().chooser === open) useRunLocation.setState({ chooser: null }) }
}

const KEY_PREFIX = 'forsion_run_location:'
function memoryKey(): string | null {
  const id = forsionAccountId(cloudApiBase(), useApp.getState().cfg?.token || '')
  return id ? `${KEY_PREFIX}${id}` : null
}

/** 记住的「上次亲手选的位置」;没有 → null。不可信串,过 parseRunLocation。 */
export function rememberedRunLocation(): RunLocation | null {
  const key = memoryKey()
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? null : parseRunLocation(raw)
  } catch { return null }
}

function remember(loc: RunLocation): void {
  const key = memoryKey()
  if (!key) return
  try { localStorage.setItem(key, formatRunLocation(loc)) } catch { /* 隐私模式:只活在这一页 */ }
}

/** 新会话会建在哪(= 焦点,K6-S4)。appStore.send() 读的也是它。 */
export function draftLocation(): RunLocation {
  return focusRef()
}

/**
 * 设草稿位置。explicit = 用户亲手选的(弹层 / 设备分组):记住,且这份草稿不再被自动对账改掉。
 * 走 setFocusTarget(换焦点作用域的目录、回到空白新对话);那台解析不出来 → 抛 TARGET_UNSUPPORTED(调用方提示)。
 */
export async function setDraftLocation(loc: RunLocation, opts: { explicit: boolean; name?: string | null }): Promise<void> {
  if (!opts.explicit) { await setFocusTarget(loc, { name: opts.name ?? null }); return }
  remember(loc)
  useRunLocation.setState({ explicitPending: true })
  try {
    await setFocusTarget(loc, { name: opts.name ?? null })
  } finally {
    // refocus 把 activeId 清成 null(新草稿):等它做完再记「这一代是亲手选的」
    useRunLocation.setState((s) => ({ explicitSeq: s.draftSeq, explicitPending: false }))
  }
}

/**
 * 对账(见文件头 U3)。只在空白草稿、这份草稿没被亲手选过、也还没对过账时动;名册 / 状态还没到就等下一轮。
 * 返回 true = 这一轮对完了(切了或不必切)。
 */
export function reconcileDraftLocation(): boolean {
  if (!runLocationsAvailable()) return false
  const st = useRunLocation.getState()
  if (useApp.getState().activeId) return false
  if (st.explicitPending || st.explicitSeq === st.draftSeq || st.reconciledSeq === st.draftSeq) return false
  const focus = focusRef()
  let wanted = rememberedRunLocation()
  if (wanted === null && focus.kind === 'unit') { wanted = focus; remember(focus) } // K8 时代落盘的焦点 = 当时亲手选的
  let want: RunLocation = HOME
  let name: string | null = null
  if (wanted?.kind === 'unit') {
    if (useDeviceSessions.getState().units === null) return false // 名册还没到
    const u = unitById(wanted.unitId)
    if (u) {
      const status = statusOfUnit(u).status
      if (status === 'checking') return false // 还没探出来:等下一轮
      if (status === 'ready') { want = wanted; name = u.name }
    }
  }
  useRunLocation.setState({ reconciledSeq: st.draftSeq })
  if (!sameRef(want, focus)) void setFocusTarget(want, { name }).catch(() => {})
  return true
}

/** 设备状态多新才能拿来直接对账(再旧就先刷新一轮,刷新完成的订阅再对):免得拿 30s 前的「离线」把刚上线的电脑判成不可用。 */
export const RECONCILE_FRESH_MS = 10_000

// 草稿边界:activeId 从某个会话回到空白 = 新的一份草稿。状态够新就立刻对账,否则先刷新一轮(完成时下面的订阅再对)
let lastActive = useApp.getState().activeId
useApp.subscribe((s) => {
  if (s.activeId === lastActive) return
  const was = lastActive
  lastActive = s.activeId
  if (was && !s.activeId) {
    useRunLocation.setState((r) => ({ draftSeq: r.draftSeq + 1 }))
    const d = useDeviceSessions.getState()
    if (Date.now() - d.refreshedAt < RECONCILE_FRESH_MS) reconcileDraftLocation()
    else void d.refresh().catch(() => {})
  }
})
// 每一轮设备刷新完成 → 还没对过账的草稿再对一次
useDeviceSessions.subscribe((s, prev) => {
  if (s.refreshedAt !== prev.refreshedAt) reconcileDraftLocation()
})
