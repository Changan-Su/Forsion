/**
 * 插件引导卡 = 可实测的检查单(2026-09-21 重做;桌面壳侧,vendored pluginStore 不知道引导这回事)。
 *
 *  - **只有 manifest `onboarding.requires` 非空的才是「闸」**:宿主实测每一条,有未满足的才弹卡 / 挂「待引导」
 *    徽标 / 投一次 Inbox。没有 requires 的 onboarding 只是使用说明,在详情页里安静地展示(见 AmadeusPluginsTab),
 *    不弹、不挂徽标、不提醒 —— 原来 25 个插件 24 张卡、大半是用法说明和励志句,用户读成了摆设。
 *  - **状态全由实测派生**,没有「用户点过完成」这回事。原来的 `__setupDone` 是纯自证标志:点一下就算完成,
 *    宿主从不检查设没设 —— 卡片因此沦为打勾。现在后来撤了授权 / 清空了设置,徽标会自己回来。
 *  - **三态** ok / unmet / unknown。unknown(插件没启用、离线、本端没有这项能力、检查超时)永远不算 unmet:
 *    算了的话 web / 手机 / Unit 设备页上每张卡都会永久卡住,断网时还会谎报「服务端没配」。
 *  - **时机**:setting / permission 纯本地,启动与设置页随时算;check 可能打远端(通话的令牌探测吃频控配额)
 *    或拉起进程,只在注意力在场时算 —— 打开卡、点「重新检查」、手动启用、市场装完。
 *  - 一次性 Inbox 提醒 `plugin.<id>.__setupNudged` 保留;version 计数器让徽标随实测结果即时重渲。
 *  - **结果不跨窗同步,是有意的**:它不是持久状态,而是「此刻测出来的」—— 每个窗口在插件列表挂载、
 *    打开检查卡、手动启用时各自重测一遍,拿到的都是当下的真值。真去广播结果反而会把一个窗口的陈旧
 *    快照推给另一个窗口。代价:两个窗口同时开着插件列表时,徽标可能短暂不一致,直到各自下一次重测。
 */
import { create } from 'zustand'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { requirementKey, type PluginRequirement } from '@amadeus-shared/ipc'
import type { AmadeusPlugin, ReadinessState } from '@amadeus/plugins/types'
import type { DesktopPermissionId, DesktopPermissionsSnapshot, DesktopPermissionState } from '../../../shared/desktopPermissions'
import { useApp } from './appStore'
import { postInboxMessage } from '../services/backendService'
import { hasDesktopPermissions } from '../components/DesktopPermissions'

export interface RequirementResult {
  state: ReadinessState
  /** 为什么(插件 check 回的一句话,或宿主判定的原因键)。 */
  detail?: string
}

const nudgedKey = (id: string): string => `plugin.${id}.__setupNudged`
/** 插件 check 的上限;超时按 unknown(卡着不回的检查不能让卡片一直转圈,也不能谎报未满足)。 */
export const CHECK_TIMEOUT_MS = 8000

/** 被门禁挡下的插件不参与引导(它压根激活不了)。 */
export const requirementsOf = (p: AmadeusPlugin): PluginRequirement[] => (p.blocked ? [] : p.onboarding?.requires ?? [])
/** 是不是闸:只看 requires。没有 requires 的 onboarding 是使用说明。 */
export const isGate = (p: AmadeusPlugin): boolean => requirementsOf(p).length > 0

/**
 * setting 类:「已填」= 用户写过、非空白、且不等于声明的默认值。
 * ⚠ SettingRow 在值回到默认时**删键**,所以 null 只代表「生效值 = 默认」,不代表没碰过;
 *   而默认值常是占位(「示例大日子 2026-12-31」「每日习惯」),只判非空会永远通过。
 * 插件没启用(setup 没跑,拿不到 def)→ unknown。
 */
export function settingState(pluginId: string, key: string): ReadinessState {
  const def = usePluginStore.getState().settings.find((o) => o.pluginId === pluginId && o.item.key === key)?.item
  if (!def) return 'unknown'
  let raw: string | null
  try { raw = localStorage.getItem(`plugin.${pluginId}.${key}`) } catch { return 'unknown' }
  const v = (raw ?? '').trim()
  return v && v !== String(def.default).trim() ? 'ok' : 'unmet'
}

/**
 * 算通过的授权态。not-required = 本平台不需要(win32 的 CU 两项)。
 * ⚠ **'unverified' 不算通过**:主进程写得很明白 ——「A preflight success alone is not proof of usable
 *   ScreenCaptureKit access」(electron/desktopPermissions.ts:39),而且真验证过的绿 30 秒就回落成它
 *   (同文件 :110「Never keep a green badge indefinitely」)。把它算 ok 就是假绿。
 *   但它也不是「没授权」—— computerScreen 在被动轮询下的稳态就是它,判 unmet 会永远催一个已经授过权的人。
 *   所以归 unknown:不打勾、不催,卡片里嵌的授权面板给用户一个「验证」按钮去拿确证。 */
const PERMISSION_OK = new Set<DesktopPermissionState>(['granted', 'not-required'])
const PERMISSION_UNMET = new Set<DesktopPermissionState>(['denied', 'not-determined', 'restricted'])
const COMPUTER_IDS = new Set<DesktopPermissionId>(['computerAccessibility', 'computerScreen'])

export function permissionResult(snap: DesktopPermissionsSnapshot | null, id: DesktopPermissionId): RequirementResult {
  if (!snap) return { state: 'unknown' } // 本端没有这项能力(web / 手机 / Unit 设备页),或读失败
  const state = snap.permissions[id]
  if (COMPUTER_IDS.has(id)) {
    if (!snap.computerUseAvailable) return { state: 'unknown' }
    // helper 还没装:授权是给 helper 的,它不在就一定还没授 —— 算未满足,卡片里的「安装」按钮会先装再请求。
    // 装了但没在跑:读数是 unknown,判断不了(不能当未授权去催)。
    if (!snap.helperInstalled && snap.platform === 'darwin') return { state: 'unmet', detail: 'helperMissing' }
  }
  if (PERMISSION_OK.has(state)) return { state: 'ok' }
  if (PERMISSION_UNMET.has(state)) return { state: 'unmet' }
  return { state: 'unknown' } // unknown / unavailable(本平台没有这个概念)
}

async function readPermissions(): Promise<DesktopPermissionsSnapshot | null> {
  try {
    if (!hasDesktopPermissions()) return null
    return (await window.tangu!.desktopPermissionsStatus!()) ?? null
  } catch { return null } // 读失败 = 判断不了,不是「没授权」
}

/** check 类:调插件注册的就绪检查。没注册(插件没启用 / 旧版插件)、抛错、超时一律 unknown。 */
export async function checkResult(pluginId: string, id: string): Promise<RequirementResult> {
  const reg = usePluginStore.getState().readiness.find((o) => o.pluginId === pluginId && o.item.id === id)?.item
  if (!reg) return { state: 'unknown' }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const out = await Promise.race([
      Promise.resolve().then(() => reg.check()),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), CHECK_TIMEOUT_MS) }),
    ])
    if (out === 'timeout') return { state: 'unknown', detail: 'timeout' }
    const state = typeof out === 'string' ? out : out?.state
    if (state !== 'ok' && state !== 'unmet' && state !== 'unknown') return { state: 'unknown' }
    const detail = typeof out === 'object' && typeof out?.detail === 'string' ? out.detail.slice(0, 300) : undefined
    return detail ? { state, detail } : { state }
  } catch {
    return { state: 'unknown' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface OnboardingState {
  /** 正在展示检查卡的插件 id;null=关着。 */
  pluginId: string | null
  /** 每个插件每条前置条件的最近实测结果(key = requirementKey)。 */
  results: Record<string, Record<string, RequirementResult>>
  /** 正在跑 check 的插件(卡片按钮转圈)。 */
  checking: Record<string, boolean>
  /** 实测结果变更计数(徽标订阅它重渲)。 */
  version: number
  open(id: string): void
  close(): void
  /** 实测一个插件。checks=true 才调插件的 check(见文件头「时机」);permissions 传入则不再读一遍
   *  (检查卡里嵌的授权行每 3 秒自己轮询,拿它的快照省一次 IPC)。 */
  evaluate(id: string, opts?: { checks?: boolean; permissions?: DesktopPermissionsSnapshot | null }): Promise<void>
}

/** 每个插件一路单调序号:只有最新一轮能提交结果(慢 check 不许盖掉它跑起来之后用户改出的新状态)。 */
const revisions = new Map<string, number>()
/** 每个插件在途的 check 轮数(>0 才显示「检查中」;先结束的那轮不许提前把它清掉)。 */
const inflight = new Map<string, number>()

export const usePluginOnboarding = create<OnboardingState>((set, get) => ({
  pluginId: null,
  results: {},
  checking: {},
  version: 0,
  open: (id) => set({ pluginId: id }),
  close: () => set({ pluginId: null }),
  evaluate: async (id, opts) => {
    const store = usePluginStore.getState()
    const p = store.plugins.find((x) => x.id === id)
    if (!p || !isGate(p)) return
    const reqs = requirementsOf(p)
    const active = store.activeIds.includes(id)
    const perms = !active || !reqs.some((r) => r.kind === 'permission') ? null
      : opts?.permissions !== undefined ? opts.permissions : await readPermissions()
    const withChecks = active && !!opts?.checks && reqs.some((r) => r.kind === 'check')
    const rev = (revisions.get(id) ?? 0) + 1
    revisions.set(id, rev)
    if (withChecks) {
      inflight.set(id, (inflight.get(id) ?? 0) + 1)
      set((s) => ({ checking: { ...s.checking, [id]: true } }))
    }
    try {
      const prev = get().results[id] ?? {}
      const entries = await Promise.all(reqs.map(async (req): Promise<[string, RequirementResult]> => {
        const k = requirementKey(req)
        if (!active) return [k, { state: 'unknown' }] // 停用的插件不挂徽标
        if (req.kind === 'setting') return [k, { state: settingState(id, req.key) }]
        if (req.kind === 'permission') return [k, permissionResult(perms, req.id)]
        // check 只在注意力在场时跑;平时沿用上一次结果(没跑过就是 unknown)。
        return [k, withChecks ? await checkResult(id, req.id) : prev[k] ?? { state: 'unknown' }]
      }))
      // ⚠ 本轮在 await 之前就取了 active / 权限快照 / setting 值:慢 check 期间用户可能已经填好设置、
      //   授权轮询也可能刚回新值,甚至插件被停用又启用。过期的一轮整张表写回去 = 徽标倒退回旧状态。
      if (revisions.get(id) === rev) {
        set((s) => ({ results: { ...s.results, [id]: Object.fromEntries(entries) }, version: s.version + 1 }))
      }
    } finally {
      if (withChecks) {
        const left = (inflight.get(id) ?? 1) - 1
        inflight.set(id, Math.max(0, left))
        if (left <= 0) set((s) => ({ checking: { ...s.checking, [id]: false } }))
      }
    }
  },
}))

/** 该插件此刻有没有**实测为未满足**的前置条件。render 期同步谓词:只读 store 里的结果,不发 IPC。 */
export function needsOnboarding(p: AmadeusPlugin): boolean {
  const res = usePluginOnboarding.getState().results[p.id]
  return !!res && requirementsOf(p).some((req) => res[requirementKey(req)]?.state === 'unmet')
}

/** 注意力在场的入口(手动启用 / 市场装完):连 check 一起实测,确有未满足才弹卡。返回是否弹了。 */
export async function promptIfPending(id: string): Promise<boolean> {
  await usePluginOnboarding.getState().evaluate(id, { checks: true })
  const { plugins, activeIds } = usePluginStore.getState()
  const p = plugins.find((x) => x.id === id)
  if (!p || !activeIds.includes(id) || !needsOnboarding(p)) return false
  usePluginOnboarding.getState().open(id)
  return true
}

/** 一次性 Inbox 提醒(启动期实测出未满足 / 用户跳过检查卡)。幂等:发过一次永不再发。 */
export function nudgeOnboardingOnce(p: AmadeusPlugin): void {
  if (!needsOnboarding(p)) return
  try {
    if (localStorage.getItem(nudgedKey(p.id)) === '1') return
    localStorage.setItem(nudgedKey(p.id), '1')
  } catch { return }
  const { cfg, tr } = useApp.getState()
  void postInboxMessage(cfg, {
    title: tr('plugin.onboarding.nudgeTitle', { name: p.name }),
    body: tr('plugin.onboarding.nudgeBody', { name: p.name }),
    sender_id: `plugin:${p.id}`,
  }).catch(() => { /* 后端不在(如纯 web)则安静放弃;徽标仍在 */ })
}

/** 启动期:只实测本地的两类(不跑 check),确有未满足才投那一次 Inbox。 */
export async function evaluateAndNudge(p: AmadeusPlugin): Promise<void> {
  if (!isGate(p)) return
  await usePluginOnboarding.getState().evaluate(p.id)
  const current = usePluginStore.getState().plugins.find((x) => x.id === p.id)
  if (current) nudgeOnboardingOnce(current)
}
