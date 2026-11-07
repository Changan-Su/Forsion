/**
 * 对象注册表:LCL 的「对象」那一层(正典:Forsion 仓根 docs/ToBeImproved/LCL对象动作统一方案_2026-11-07)。
 *
 * LCL 原来只按「出口」登记(Ribbon 图标、命令、视图),动作挂在出口上,离开那个出口就没了:「删除 Space」只在
 * Ribbon 上有,收纳面板、主页、新标签页各写各的菜单。这里加两张表:
 *   - 对象类型:它是谁、叫什么、什么图标、怎么打开、执行前怎么核「还是不是那个」;
 *   - 动作:按类型登记一次,菜单、「⋯」、手机长按(以后还有命令面板、快捷键)都从这里取。
 * 界面只说「这里是谁」(`ObjectRef`)和本处特有的项(`placeSections`)。
 *
 * 纪律(Codex 评审定的,别改回):
 *   - `when` 只管「列不列」,不是授权。一切动作经 `executeAction`:菜单弹出时冻结目标,执行前重验、确认后再验;
 *     确认 / 失败上报 / 防连点都在这里,不靠各界面记得加。
 *   - `info` 只读缓存、同步;拿不到就回 undefined,由 `resolve` 批量补。
 *   - 按能力(`caps`)判,不按「是不是手机」判。
 *   - 注册都返回 dispose;同 id 先到先得,后来的不覆盖(插件不能盖掉宿主动作)。
 * 纯 TS(只用 React 的 createElement 造图标节点),node 可测。渲染在 objectMenu.tsx。
 */
import { createElement, type ComponentType } from 'react'
import type { SheetMenu, SheetMenuItem, SheetMenuSection } from './nativeSheetMenu'

export type ObjectIcon = ComponentType<{ size?: number }>

/** 对象引用:只带身份,不带显示。`scope` = 命名空间(库内文件的智库 id、主机文件的设备 id),同一串 id 在两个
 *  scope 里是两个对象;路径寻址的类型必须给。 */
export interface ObjectRef { type: string; id: string; scope?: string }

export interface ObjectInfo { title: string; icon?: ObjectIcon; missing?: boolean }

export type OpenMode = 'here' | 'newTab' | 'beside' | 'newWindow'

/** 菜单弹在哪:`kind` 是界面种类('ribbon' / 'organizer' / 'home-slot' / 'note-tree' …),`container` 是具体哪一个
 *  (哪个收纳夹、哪个列表)。动作的 `when` 可以按它排除。 */
export interface Place { kind: string; container?: string }

/** 宿主能力,弹菜单那一刻由宿主现算。按能力判,别按平台判(Android 也可能有窗口,桌面也可能是单列壳)。 */
export interface ObjectCaps {
  /** 能把 Space 开到它自己的 OS 窗口(桌面多窗)。 */
  openWindow: boolean
  /** 能在电脑桌面放快捷方式。 */
  desktopShortcut: boolean
  /** 能钉到手机主屏。 */
  pinHome: boolean
  /** 能在系统文件管理器里显示。 */
  revealFile: boolean
  /** 单列壳(手机布局)。 */
  singleColumn: boolean
}

export interface ObjectContext { place: Place; caps: ObjectCaps }

export type ActionResult = { ref: ObjectRef; ok: true } | { ref: ObjectRef; ok: false; reason: string }

/** 引擎自己产生的失败原因(宿主上报时翻成人话);类型 / 动作自己给的原因直接是给人看的文字。 */
export const OBJECT_REASON = { unavailable: 'unavailable', error: 'error', busy: 'busy', cancelled: 'cancelled' } as const

export interface ObjectTypeDefinition {
  type: string
  /** 类型名(「Space」「笔记」),渲染期求值、跟随语言。 */
  label(): string
  isValidId(id: string): boolean
  /** 只读缓存、同步、便宜:菜单标题、芯片、命令面板共用。拿不到 = undefined,界面先画占位。 */
  info(ref: ObjectRef): ObjectInfo | undefined
  /** 批量、可取消地把 info 缓存补上。 */
  resolve?(refs: ObjectRef[], signal: AbortSignal): Promise<void>
  /** 这类对象的名字 / 图标 / 存在性变了时回调。 */
  subscribe?(cb: () => void): () => void
  /** 支持哪几种打开;不在里面的打开方式不出现。 */
  openModes: readonly OpenMode[]
  /** = 点一下。窗口锁之类的规矩写在这里一次。抛错 = 失败(message 当原因)。 */
  open(ref: ObjectRef, how: OpenMode, cx: ObjectContext): void | Promise<void>
  /** 菜单弹出时记下的版本(路径寻址的对象:改名后旧路径可能被新文件占)。 */
  snapshot?(ref: ObjectRef): unknown
  /** 执行前重验:对象还在、还是弹菜单时那个。返回原因(给人看的) = 不执行;null = 通过。 */
  verify?(ref: ObjectRef, snap: unknown): string | null | Promise<string | null>
  /** forsion:// 链接;没有就不出「复制链接」。 */
  uri?(ref: ObjectRef): string | undefined
}

export type ActionGroup = 'open' | 'edit' | 'organize' | 'share' | 'danger'
export const ACTION_GROUPS: readonly ActionGroup[] = ['open', 'edit', 'organize', 'share', 'danger']

export interface ConfirmRequest { title: string; body?: string; confirm: string; danger?: boolean }

export interface ObjectAction {
  /** 'space.addToDesktop';插件的由宿主加 plugin:<pid>: 前缀。 */
  id: string
  types: readonly string[]
  title(refs: ObjectRef[], cx: ObjectContext): string
  icon?: ObjectIcon
  group: ActionGroup
  order?: number
  /** 多选时出不出现,缺省不出。 */
  multi?: boolean
  /** 只管「列不列」,同步、便宜;抛错 = 不显示。不是授权。 */
  when?(refs: ObjectRef[], cx: ObjectContext): boolean
  /** 列出来但灰掉的原因(悬停看)。 */
  disabledReason?(refs: ObjectRef[], cx: ObjectContext): string | undefined
  /** 显式声明才进命令面板(第二期接)。 */
  palette?: boolean
  /** 要确认的给出确认框内容;执行层弹、执行层在确认后再验一次。 */
  confirm?(refs: ObjectRef[], cx: ObjectContext): ConfirmRequest | undefined
  /** 返回逐项结果;不返回 = 全部成功。抛错 = 全部失败。 */
  run(refs: ObjectRef[], cx: ObjectContext): void | ActionResult[] | Promise<void | ActionResult[]>
}

export interface ObjectHost {
  caps(): ObjectCaps
  confirm(req: ConfirmRequest): Promise<boolean>
  /** 只收失败项(取消、连点不报)。 */
  report(failures: ActionResult[], what: string): void
}

const NO_CAPS: ObjectCaps = { openWindow: false, desktopShortcut: false, pinHome: false, revealFile: false, singleColumn: false }
const defaultHost: ObjectHost = {
  caps: () => NO_CAPS,
  confirm: (req) => Promise.resolve(typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(req.body ? `${req.title}\n\n${req.body}` : req.title) : false),
  report: (failures, what) => { console.warn('[objects]', what, failures) },
}
let host: ObjectHost = defaultHost
/** 宿主装配期调一次;测试传 null 复位。 */
export function setObjectHost(h: Partial<ObjectHost> | null): void { host = h ? { ...defaultHost, ...h } : defaultHost }
export function objectCaps(): ObjectCaps {
  try { return { ...NO_CAPS, ...host.caps() } } catch { return NO_CAPS }
}

// ─────────────────────────────── 注册表 ───────────────────────────────

const types = new Map<string, ObjectTypeDefinition>()
const actions = new Map<string, { a: ObjectAction; seq: number }>()
let seq = 0
const listeners = new Set<() => void>()
const emit = (): void => { for (const l of [...listeners]) { try { l() } catch (e) { console.error('[objects] listener failed', e) } } }
export function subscribeObjects(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb) } }

/** 同 type 先到先得;返回 dispose(只摘自己那份)。 */
export function registerObjectType(def: ObjectTypeDefinition): () => void {
  if (types.has(def.type)) { console.error(`[objects] type "${def.type}" already registered; ignored`); return () => {} }
  types.set(def.type, def)
  emit()
  return () => { if (types.get(def.type) === def) { types.delete(def.type); emit() } }
}
export function getObjectType(type: string): ObjectTypeDefinition | undefined { return types.get(type) }

/** 同 id 先到先得(插件不能盖掉宿主的同名动作);返回 dispose。 */
export function registerObjectAction(a: ObjectAction): () => void {
  if (actions.has(a.id)) { console.error(`[objects] action "${a.id}" already registered; ignored`); return () => {} }
  const entry = { a, seq: seq++ }
  actions.set(a.id, entry)
  emit()
  return () => { if (actions.get(a.id) === entry) { actions.delete(a.id); emit() } }
}
export function getObjectAction(id: string): ObjectAction | undefined { return actions.get(id)?.a }

export function objectInfo(ref: ObjectRef): ObjectInfo | undefined {
  try { return types.get(ref.type)?.info(ref) } catch { return undefined }
}

/** Map / Set 用的键(type 与 scope 都可能带冒号,用 JSON 免歧义)。 */
export const objectKey = (r: ObjectRef): string => JSON.stringify([r.type, r.scope ?? '', r.id])

const applies = (a: ObjectAction, refs: readonly ObjectRef[]): boolean =>
  refs.length > 0 && (refs.length === 1 || !!a.multi) && refs.every((r) => types.has(r.type) && a.types.includes(r.type))

const listed = (a: ObjectAction, refs: ObjectRef[], cx: ObjectContext): boolean => {
  if (!applies(a, refs)) return false
  if (!a.when) return true
  try { return !!a.when(refs, cx) } catch (e) { console.error(`[objects] when() of "${a.id}" threw`, e); return false }
}

/** 这次该列哪些动作:类型全都适用、多选要 multi、`when` 成立(抛错当不成立)。按组、order、登记序排。 */
export function objectActions(refs: ObjectRef[], cx: ObjectContext): ObjectAction[] {
  return [...actions.values()]
    .filter(({ a }) => listed(a, refs, cx))
    .sort((x, y) => ACTION_GROUPS.indexOf(x.a.group) - ACTION_GROUPS.indexOf(y.a.group) || (x.a.order ?? 0) - (y.a.order ?? 0) || x.seq - y.seq)
    .map(({ a }) => a)
}

// ─────────────────────────────── 执行层 ───────────────────────────────

/** 冻结的目标:弹菜单那一刻的引用 + 版本。 */
export interface FrozenRef { ref: ObjectRef; snap: unknown }
export function freezeRefs(refs: ObjectRef[]): FrozenRef[] {
  return refs.map((ref) => {
    let snap: unknown
    try { snap = types.get(ref.type)?.snapshot?.(ref) } catch { snap = undefined }
    return { ref, snap }
  })
}

const fail = (ref: ObjectRef, reason: string): ActionResult => ({ ref, ok: false, reason })
const reportable = (r: ActionResult): boolean => !r.ok && r.reason !== OBJECT_REASON.cancelled && r.reason !== OBJECT_REASON.busy

async function verifyAll(targets: FrozenRef[]): Promise<{ ok: FrozenRef[]; failed: ActionResult[] }> {
  const ok: FrozenRef[] = []
  const failed: ActionResult[] = []
  await Promise.all(targets.map(async (t) => {
    const type = types.get(t.ref.type)
    if (!type || !type.isValidId(t.ref.id)) { failed.push(fail(t.ref, OBJECT_REASON.unavailable)); return }
    let reason: string | null = null
    try { reason = (await type.verify?.(t.ref, t.snap)) ?? null } catch (e) { reason = e instanceof Error && e.message ? e.message : OBJECT_REASON.error }
    if (reason) failed.push(fail(t.ref, reason))
    else ok.push(t)
  }))
  // 保持调用方给的顺序
  const order = new Map(targets.map((t, i) => [t, i]))
  ok.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  return { ok, failed }
}

const inflight = new Set<string>()

/** 一切对象动作的唯一执行口:重验 → 确认 → 再验 → 执行 → 逐项结果,失败交给宿主上报。
 *  `targets` 传冻结的(菜单弹出时 freezeRefs 的结果);直接传 ObjectRef 视为当场冻结。 */
export async function executeAction(actionId: string, targets: Array<FrozenRef | ObjectRef>, cx: ObjectContext): Promise<ActionResult[]> {
  const frozen = targets.map((t) => ('ref' in t ? t : freezeRefs([t])[0]))
  const refs = frozen.map((f) => f.ref)
  const a = actions.get(actionId)?.a
  if (!a || !listed(a, refs, cx)) {
    const out = refs.map((r) => fail(r, OBJECT_REASON.unavailable))
    host.report(out, actionId)
    return out
  }
  const key = actionId + '\u0000' + refs.map(objectKey).join('\u0001')
  if (inflight.has(key)) return refs.map((r) => fail(r, OBJECT_REASON.busy))
  inflight.add(key)
  const failures: ActionResult[] = []
  try {
    let { ok, failed } = await verifyAll(frozen)
    failures.push(...failed)
    if (ok.length && a.confirm) {
      let req: ConfirmRequest | undefined
      try { req = a.confirm(ok.map((t) => t.ref), cx) } catch (e) { console.error(`[objects] confirm() of "${a.id}" threw`, e) }
      if (req) {
        let yes = false
        try { yes = await host.confirm(req) } catch { yes = false }
        if (!yes) return [...ok.map((t) => fail(t.ref, OBJECT_REASON.cancelled)), ...failures]
        ;({ ok, failed } = await verifyAll(ok)) // 确认框开着的时候对象可能被改名 / 删掉了
        failures.push(...failed)
      }
    }
    let results: ActionResult[] = []
    if (ok.length) {
      const live = ok.map((t) => t.ref)
      try {
        const r = await a.run(live, cx)
        results = Array.isArray(r) ? r : live.map((ref) => ({ ref, ok: true as const }))
      } catch (e) {
        const reason = e instanceof Error && e.message ? e.message : OBJECT_REASON.error
        results = live.map((ref) => fail(ref, reason))
      }
    }
    const all = [...results, ...failures]
    const bad = all.filter(reportable)
    if (bad.length) host.report(bad, actionId)
    return all
  } finally {
    inflight.delete(key)
  }
}

/** 打开一个对象(= 点一下):重验后交给类型的 open。窗口锁这类规矩在类型里,所有入口都走这里。 */
export async function openObject(ref: ObjectRef, how: OpenMode = 'here', place: Place = { kind: 'api' }): Promise<ActionResult> {
  const type = types.get(ref.type)
  const cx: ObjectContext = { place, caps: objectCaps() }
  const done = (r: ActionResult): ActionResult => { if (reportable(r)) host.report([r], `open:${ref.type}`); return r }
  if (!type || !type.isValidId(ref.id) || !type.openModes.includes(how)) return done(fail(ref, OBJECT_REASON.unavailable))
  const { failed } = await verifyAll(freezeRefs([ref]))
  if (failed.length) return done(failed[0])
  try { await type.open(ref, how, cx); return { ref, ok: true } } catch (e) { return done(fail(ref, e instanceof Error && e.message ? e.message : OBJECT_REASON.error)) }
}

// ─────────────────────────────── 菜单 ───────────────────────────────

export interface ObjectMenuRequest {
  refs: ObjectRef[]
  place: Place
  /** 本处特有的项(移出收纳夹、主位放哪个 Space…),排在「整理」与「分享」之间;不走对象动作表。 */
  placeSections?: SheetMenuSection[]
  title?: string
}

/** 把对象动作 + 本处项排成一份菜单(web 与 Android 原生半屏共用同一份 SheetMenu)。目标在这一刻冻结。
 *  顺序:打开 → 编辑 → 整理 → 本处 → 分享 → 危险;每组一节,空组不出。 */
export function buildObjectMenu(req: ObjectMenuRequest): SheetMenu {
  const cx: ObjectContext = { place: req.place, caps: objectCaps() }
  const frozen = freezeRefs(req.refs)
  const listedActions = req.refs.length ? objectActions(req.refs, cx) : []
  const section = (g: ActionGroup): SheetMenuSection => ({
    items: listedActions.filter((a) => a.group === g).map((a): SheetMenuItem => {
      let label = a.id
      try { label = a.title(req.refs, cx) } catch (e) { console.error(`[objects] title() of "${a.id}" threw`, e) }
      let reason: string | undefined
      try { reason = a.disabledReason?.(req.refs, cx) } catch { reason = undefined }
      return {
        id: a.id,
        label,
        ...(a.icon ? { icon: createElement(a.icon, { size: 13 }) } : {}),
        ...(g === 'danger' ? { danger: true } : {}),
        ...(reason ? { disabled: true, detail: reason } : {}),
        act: a.id,
        run: () => { void executeAction(a.id, frozen, cx) },
      }
    }),
  })
  const sections = [
    section('open'), section('edit'), section('organize'),
    ...(req.placeSections ?? []),
    section('share'), section('danger'),
  ].filter((s) => s.items.length > 0)
  return { ...(req.title ? { title: req.title } : {}), sections }
}

export const menuHasItems = (m: SheetMenu): boolean => m.sections.some((s) => s.items.length > 0)

/** 测试用:清空注册表与在途标记。 */
export function __resetObjectsForTest(): void { types.clear(); actions.clear(); inflight.clear(); listeners.clear(); host = defaultHost; seq = 0 }
