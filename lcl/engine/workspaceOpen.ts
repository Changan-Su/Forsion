/**
 * 统一打开入口 `workspace.open(target, { layer, form })`(2026-11-08,LCL 表面规范方案 B 第三期;
 * 方案页 docs/ToBeImproved/LCL表面规范方案_2026-11-07/ §6「接口草案」、§7「替你定的细节」)。
 *
 * 位置(layer)和样子(form)分开写:
 *   - `{ dock: 'main' | 'left' | 'right' | 'bottom' }`  停靠在工作台里 = 今天的 openView(样子由位置定:左右 = side)。
 *   - `{ float: 'desktop', pin? }`                      系统小窗:form 'mini' = 今天的 Mini(按实体复用、可多开),
 *                                                        'main' = 今天的 Floating Panel。壳层经 setDesktopOpener 接上;
 *                                                        没接(网页 / 手机)= 降成窗口作用域(§7)。
 *   - `{ float: 'view' | 'space' | 'window', anchor? }` 窗口里的浮层(floatLayer.openFloat),里面挂这个 View
 *                                                        (缺省它的 Mini 样子)。View 作用域要给 host(浮在哪个元素里)。
 *
 * 回落规则全在 planOpen(纯函数,单测只打它),插件手册照抄这一段:
 *   1. View 没声明 forms = 什么样子都行(今天的行为)。声明了:没列出的样子就是不支持。
 *   2. 停靠:位置的样子不支持 → 按梯子换位置(主区 → 右栏 → 底部;左 / 右 → 主区 → 底部;底部 → 右栏 → 主区);
 *      这扇窗没有底部面板(手机、卫星窗)→ 底部当右栏。一个停靠样子都不支持(只有 Mini)→ 开成当前 Space 的浮层;
 *      连 Mini 也不支持 → unsupported。
 *      停靠时传的 form 不看:位置说了算。
 *   3. 浮起来:form 缺省 'mini';'side' / 'bottom' 当 'main'(浮着的面板没有边)。mini 不支持 → main;main(View 本身)
 *      不支持 → mini。
 *   4. Mini 里显示什么:forms.mini.view(紧凑视图;没注册就用 View 本身)→ 某个 Space 的 mini.mainView 正是它 →
 *      走那个 Space(桌面 Mini 的实体键就是 space:<id>,和 ⌘⇧M / 命令面板开的同一扇)→ View 本身。
 *      紧凑视图只认同一个主人(ownerOf):插件 P 的视图不落到插件 Q 的紧凑视图上。
 *   5. 桌面:没有 Mini 接缝 → 窗口作用域的浮层(手机上是半屏抽屉);没有 Floating Panel 接缝 → 停靠主区
 *      (手机上占满一屏的面板就是主区)。Mini 恒置顶(pin:false 留到下一步),Floating Panel 缺省不置顶、pin:true 置顶。
 *   6. 这扇窗没挂浮层宿主(Mini 窗、Floating Panel 窗)→ View / Space / 窗口作用域打不开,回 { ok:false, reason:'unavailable' }。
 *
 * 浮层里的 View 是合成 leaf 渲染的(同 SpacePeek / FloatingViewSurface / MiniColumnHost 的先例):不进布局、不进
 * singleton 计数、切 Space 跟着藏(Space 作用域)、View 类型反注册(插件停用)就收掉。位置只记用户拖到的锚点(本机,
 * 按 View + key),跟 Space 布局一起记 / 重启后还原是下一步。
 */
import { getView, subscribeViews } from './viewRegistry'
import { useWorkspace } from './workspaceStore'
import { useSpaceStore } from './spaceRegistry'
import { openFloat, FLOAT_ANCHORS, type FloatAnchor, type FloatHandle } from './floatLayer'
import { IS_MINI_PANEL, UI_MODE } from './uiMode'
import type { Leaf, ViewDefinition, ViewForm, ViewForms, ViewLocation } from './types'

export type FloatOpenScope = 'view' | 'space' | 'window'
export type OpenLayer =
  | { dock: ViewLocation }
  | { float: 'desktop'; pin?: boolean }
  | { float: FloatOpenScope; anchor?: FloatAnchor; host?: HTMLElement; space?: string }
export interface OpenTarget { type: string; params?: Record<string, unknown> }
export interface OpenOptions {
  /** 缺省 { dock: 'main' }。 */
  layer?: OpenLayer
  form?: ViewForm
  /** 同一个 View 里区分「哪一个」(桌面 Mini 与浮层按它复用:同 View 同 key 再开 = 叫出那一份、换参数)。 */
  key?: string
  /** Mini / Floating Panel / 浮层卡片的标题;缺省 = View 的名字。 */
  title?: string
  /** 宿主用:Mini / 浮层里「在主面板显示」开哪个视图,同时表示 target 本身就是紧凑视图(旧 openMiniPanel 的 mainViewId)。
   *  插件走 forms,插件 ctx 不给这个口子。 */
  mainView?: OpenTarget
  /** 停靠主区时的开法(新标签 / 分屏),原样交给 openView。 */
  dock?: { newTab?: boolean; split?: boolean }
  /** Floating Panel 的窗口尺寸。 */
  size?: { width?: number; height?: number; minWidth?: number; minHeight?: number }
}
export type ResolvedLayer = { dock: ViewLocation } | { float: 'desktop' | FloatOpenScope }
export type OpenFailure = 'unknown-view' | 'unsupported' | 'unavailable' | 'limit'
export type OpenResult =
  /** 浮层卡:`close` 对同一张卡恒为同一个函数,`closed` 在卡收掉时(谁收的都算)resolve —— 插件宿主据此只记一笔账、卡没了就划掉。 */
  | { ok: true; layer: ResolvedLayer; form: ViewForm; leaf?: Leaf; close?(): void; closed?: Promise<void> }
  | { ok: false; reason: OpenFailure; limit?: number }

/** 壳层接上的系统小窗(桌面 = window.tangu.openMini / openFloatingPanel;网页只有 panel = 页内浮层)。 */
export interface DesktopOpener {
  mini?(req: { view: OpenTarget; mainView: OpenTarget; spaceId?: string; params?: Record<string, unknown>; key?: string; title?: string }):
    Promise<{ ok: true } | { ok: false; reason: 'limit'; limit: number } | undefined>
  panel?(req: { view: OpenTarget; title: string; pin: boolean; key?: string; size?: OpenOptions['size'] }): void
}
let desktop: DesktopOpener | null = null
export function setDesktopOpener(opener: DesktopOpener | null): void { desktop = opener }

/** planOpen 看到的这扇窗。 */
export interface OpenEnv {
  getDef(type: string): Pick<ViewDefinition, 'forms'> | undefined
  /** 哪个 Space 的 mini 以这个视图为主视图(supportsMiniPanel 的那几个)。 */
  spaceMiniOf(type: string): { spaceId: string; view: OpenTarget } | null
  desktopMini: boolean
  desktopPanel: boolean
  bottom: boolean
  floats: boolean
  mobile: boolean
}

export type OpenPlan =
  | { kind: 'dock'; loc: ViewLocation; form: ViewForm }
  | { kind: 'mini'; view: OpenTarget; mainView: OpenTarget; spaceId?: string }
  | { kind: 'panel'; pin: boolean }
  | { kind: 'float'; scope: FloatOpenScope; form: 'mini' | 'main'; view: OpenTarget; mainView: OpenTarget; sheet: boolean }
  | { kind: 'none'; reason: Exclude<OpenFailure, 'limit'> }

/** 视图类型归谁:插件视图 = 插件 id,宿主视图 = ''。紧凑视图只认同一个主人的(插件 P 打开自己的视图,不该落到插件 Q 的紧凑视图上)。 */
const ownerOf = (type: string): string => (type.startsWith('plugin:') ? type.split(':')[1] ?? '' : '')

const dockForm = (loc: ViewLocation): ViewForm => (loc === 'main' ? 'main' : loc === 'bottom' ? 'bottom' : 'side')
const supports = (forms: ViewForms | undefined, f: ViewForm): boolean => !forms || (f === 'mini' ? !!forms.mini : forms[f] === true)
/** 浮层里的「main」= View 本身,停靠样子有一个能用就行。 */
const supportsSelf = (forms: ViewForms | undefined): boolean => supports(forms, 'main') || supports(forms, 'side') || supports(forms, 'bottom')

/** 停靠回落:要的位置不支持就按梯子换;一个都不行 = null。 */
export function dockFallback(forms: ViewForms | undefined, want: ViewLocation, hasBottom: boolean): ViewLocation | null {
  const ladders: Record<ViewLocation, ViewLocation[]> = {
    main: ['main', 'right', 'bottom'],
    left: ['left', 'main', 'bottom'],
    right: ['right', 'main', 'bottom'],
    bottom: ['bottom', 'right', 'main'],
  }
  return ladders[want].map((l) => (l === 'bottom' && !hasBottom ? 'right' : l)).find((l) => supports(forms, dockForm(l))) ?? null
}

/** Mini 样子显示什么(规则 4)。explicitMain = 调用方说了 target 就是紧凑视图。 */
function compactOf(target: OpenTarget, def: Pick<ViewDefinition, 'forms'>, env: OpenEnv, explicitMain?: OpenTarget): { view: OpenTarget; mainView: OpenTarget; spaceId?: string } {
  const self = { type: target.type, params: target.params }
  if (explicitMain) return { view: self, mainView: explicitMain }
  const m = def.forms?.mini
  if (m && typeof m === 'object') {
    if (env.getDef(m.view.type) && ownerOf(m.view.type) === ownerOf(target.type)) return { view: { type: m.view.type, params: { ...m.view.params, ...target.params } }, mainView: self }
    return { view: self, mainView: self }
  }
  const space = env.spaceMiniOf(target.type)
  if (space && ownerOf(space.view.type) === ownerOf(target.type)) return { view: { type: space.view.type, params: { ...space.view.params, ...target.params } }, mainView: self, spaceId: space.spaceId }
  return { view: self, mainView: self }
}

/** 映射 + 回落(见文件头的六条)。只读 env,不碰任何状态。 */
export function planOpen(target: OpenTarget, opts: OpenOptions, env: OpenEnv): OpenPlan {
  const def = env.getDef(target.type)
  if (!def) return { kind: 'none', reason: 'unknown-view' }
  const forms = def.forms
  const layer = opts.layer ?? { dock: 'main' }
  const floatIn = (scope: FloatOpenScope, form: 'mini' | 'main'): OpenPlan => {
    if (!env.floats) return { kind: 'none', reason: 'unavailable' }
    const c = compactOf(target, def, env, opts.mainView)
    const view = form === 'mini' ? c.view : { type: target.type, params: target.params }
    return { kind: 'float', scope, form, view, mainView: form === 'mini' ? c.mainView : view, sheet: env.mobile && form === 'mini' && scope !== 'view' }
  }
  if ('dock' in layer) {
    const loc = dockFallback(forms, layer.dock, env.bottom)
    if (loc) return { kind: 'dock', loc, form: dockForm(loc) }
    return supports(forms, 'mini') ? floatIn('space', 'mini') : { kind: 'none', reason: 'unsupported' }
  }
  // 浮起来(规则 3):缺省 mini;side / bottom 当 main。opts.mainView 在 = 调用方点名了紧凑视图,不再按 forms 换样子
  let form: 'mini' | 'main' = opts.form == null || opts.form === 'mini' ? 'mini' : 'main'
  if (!opts.mainView) {
    if (form === 'mini' && !supports(forms, 'mini')) form = 'main'
    if (form === 'main' && !supportsSelf(forms)) {
      if (!supports(forms, 'mini')) return { kind: 'none', reason: 'unsupported' }
      form = 'mini'
    }
  }
  if (layer.float !== 'desktop') return floatIn(layer.float, form)
  if (form === 'mini') {
    if (env.desktopMini) { const c = compactOf(target, def, env, opts.mainView); return { kind: 'mini', ...c } }
    return floatIn('window', 'mini') // §7:网页 / 手机没有桌面作用域,降成窗口作用域(手机上 = 半屏抽屉)
  }
  if (env.desktopPanel) return { kind: 'panel', pin: layer.pin === true }
  const loc = dockFallback(forms, 'main', env.bottom)
  if (loc) return { kind: 'dock', loc, form: dockForm(loc) }
  return supports(forms, 'mini') ? floatIn('window', 'mini') : { kind: 'none', reason: 'unsupported' }
}

// ── 浮层里挂的 View(FloatViews.tsx 渲染)──────────────────────────────────────────────

export interface FloatViewRec {
  readonly id: string
  readonly ident: string
  /** 调用方要开的那个视图(身份按它算;它或渲染的紧凑视图任一反注册,卡就收)。 */
  readonly targetType: string
  readonly scope: FloatOpenScope
  readonly form: 'mini' | 'main'
  readonly handle: FloatHandle
  readonly sheet: boolean
  view: OpenTarget
  mainView: OpenTarget
  title: string
  /** 再开同一份时 +1:卡片据此换成新参数。 */
  gen: number
  /** 再开同一份时 +1:卡片轻跳一下。 */
  nudge: number
  /** 收卡(同一张卡恒为同一个函数,幂等)。 */
  readonly close: () => void
  /** 卡收掉时 resolve(不管谁收的)。 */
  readonly closed: Promise<void>
}

const recs = new Map<string, FloatViewRec>()
const listeners = new Set<() => void>()
let snapshot: readonly FloatViewRec[] = []
let seq = 0
const hostIds = new WeakMap<HTMLElement, number>()
let renderers = 0
let unsubViews: (() => void) | null = null

function emit(): void { snapshot = [...recs.values()]; listeners.forEach((l) => l()) }
export function subscribeFloatViews(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }
export function floatViewsSnapshot(): readonly FloatViewRec[] { return snapshot }
/** FloatViews 挂上 / 卸下时登记:没人渲染的窗口(Mini、Floating Panel)不开 View 浮层。 */
export function registerFloatViewRenderer(): () => void {
  renderers++
  return () => { renderers-- }
}

function watchUnregister(): void {
  if (unsubViews) return
  // 插件停用 → 它的视图类型反注册 → 挂着它的浮层收掉(同工作台里的 leaf 先关再反注册)
  unsubViews = subscribeViews(() => { for (const r of [...recs.values()]) if (!getView(r.view.type) || !getView(r.targetType)) r.close() })
}

function displayTitle(type: string): string {
  const n = getView(type)?.displayName
  return typeof n === 'function' ? n() : n || type
}

function openViewFloat(targetType: string, plan: Extract<OpenPlan, { kind: 'float' }>, opts: OpenOptions, layer: OpenLayer): FloatViewRec {
  const fl = 'float' in layer && layer.float !== 'desktop' && layer.float === plan.scope ? layer : undefined
  const host = plan.scope === 'view' ? fl?.host : undefined
  let hostId = ''
  if (host) { hostId = String(hostIds.get(host) ?? ++seq); hostIds.set(host, Number(hostId)) }
  const space = plan.scope === 'space' ? (fl?.space ?? useSpaceStore.getState().activeSpaceId) : ''
  const key = opts.key ?? ''
  // 身份按调用方要开的视图算(不按渲染的紧凑视图:两个视图共用一个紧凑视图时各是各的卡)
  const ident = `${plan.scope}|${space || hostId}|${targetType}|${key}`
  const title = opts.title || displayTitle(plan.mainView.type)
  const prev = recs.get(ident)
  // 换了样子(mini ↔ main、抽屉与否)= 换一张卡:尺寸、卡头、视图拿到的 surface 都不一样,原地改不干净
  if (prev && !prev.handle.closed && (prev.form !== plan.form || prev.sheet !== plan.sheet || prev.view.type !== plan.view.type)) prev.close()
  if (prev && !prev.handle.closed) {
    prev.view = plan.view
    prev.mainView = plan.mainView
    prev.title = title
    prev.gen++
    prev.nudge++
    emit()
    return prev
  }
  const handle = openFloat({
    scope: plan.scope, host, space: space || undefined, label: title,
    anchor: plan.sheet ? 'bottom-center' : fl?.anchor ?? 'bottom-end',
    // 抽屉不记锚点(恒在底边);别的按「作用域 + View + key」记用户拖到哪
    id: plan.sheet ? undefined : `open:${plan.scope}:${targetType}${key ? `#${key}` : ''}`,
  })
  handle.el.dataset.viewFloat = plan.form
  if (plan.sheet) handle.el.dataset.sheet = ''
  let settle!: () => void
  const closed = new Promise<void>((r) => { settle = r })
  const rec: FloatViewRec = {
    id: `float-view:${++seq}`, ident, targetType, scope: plan.scope, form: plan.form, handle, sheet: plan.sheet,
    view: plan.view, mainView: plan.mainView, title, gen: 0, nudge: 0, closed,
    close: () => {
      handle.close()
      settle()
      if (recs.get(ident) !== rec) return
      recs.delete(ident)
      emit()
    },
  }
  recs.set(ident, rec)
  watchUnregister()
  emit()
  return rec
}

const DOCKS: readonly ViewLocation[] = ['main', 'left', 'right', 'bottom']
const FORMS: readonly ViewForm[] = ['main', 'side', 'bottom', 'mini']
const FLOATS = ['desktop', 'view', 'space', 'window'] as const

/** 参数不对同步抛 TypeError(调用方的 bug,别静默);和 openFloat 同一口径。 */
export function checkOpenOptions(opts: OpenOptions): void {
  if (opts == null || typeof opts !== 'object') throw new TypeError('open options must be an object')
  if (opts.form != null && !FORMS.includes(opts.form)) throw new TypeError(`form must be one of ${FORMS.join(', ')}`)
  const layer = opts.layer
  if (layer == null) return
  if (typeof layer !== 'object') throw new TypeError('layer must be { dock } or { float }')
  if ('dock' in layer) {
    if (!DOCKS.includes(layer.dock)) throw new TypeError(`layer.dock must be one of ${DOCKS.join(', ')}`)
    return
  }
  if (!('float' in layer) || !(FLOATS as readonly string[]).includes(layer.float)) throw new TypeError(`layer must be { dock } or { float: ${FLOATS.join(' | ')} }`)
  if (layer.float === 'desktop') return
  if (layer.anchor != null && !(FLOAT_ANCHORS as readonly string[]).includes(layer.anchor)) throw new TypeError(`layer.anchor must be one of ${FLOAT_ANCHORS.join(', ')}`)
  if (layer.float === 'view' && !(layer.host instanceof HTMLElement && layer.host.isConnected)) throw new TypeError("layer { float: 'view' } needs a connected host element")
}

function liveEnv(): OpenEnv {
  return {
    getDef: getView,
    spaceMiniOf: (type) => {
      for (const s of useSpaceStore.getState().spaces) {
        const m = s.mini
        if (m && m.mainView.type === type && m.view.type !== type && getView(m.view.type)) return { spaceId: s.id, view: m.view }
      }
      return null
    },
    desktopMini: !!desktop?.mini,
    desktopPanel: !!desktop?.panel,
    // 单列 store 没有 bottomVisible 这一位(同 pluginViews.hasBottomPanel);Mini / 卫星窗的单列也一样
    bottom: 'bottomVisible' in useWorkspace.getState(),
    floats: renderers > 0,
    // 原生手机包里 UI_MODE 恒为 desktop(engineSwap 只换了 store):按「这扇窗是不是单列壳」判,同 viewModes.inSingleColumnShell
    // (不 import 它:那边带 React / CSS,引擎这层保持轻)
    mobile: !IS_MINI_PANEL && (UI_MODE === 'mobile' || 'activeMainId' in useWorkspace.getState()),
  }
}

/** workspace.open:按 planOpen 落到 openView / 桌面接缝 / 浮层。参数不对**同步**抛(不是 reject);打不开回 { ok: false, reason }。 */
export function workspaceOpen(target: OpenTarget, opts: OpenOptions = {}): Promise<OpenResult> {
  if (!target || typeof target !== 'object' || typeof target.type !== 'string' || !target.type) throw new TypeError('open target needs a view type')
  checkOpenOptions(opts)
  return run(target, opts)
}

async function run(target: OpenTarget, opts: OpenOptions): Promise<OpenResult> {
  const plan = planOpen(target, opts, liveEnv())
  const params = target.params ?? {}
  switch (plan.kind) {
    case 'none':
      return { ok: false, reason: plan.reason }
    case 'dock': {
      const leaf = useWorkspace.getState().openView(target.type, params, plan.loc, plan.loc === 'main' ? opts.dock : undefined)
      if (!leaf) return { ok: false, reason: 'unavailable' }
      return { ok: true, layer: { dock: plan.loc }, form: plan.form, leaf, close: () => leaf.close() }
    }
    case 'mini': {
      // params 照旧 openMiniPanel 的口径:顶层也带一份(Mini 应用目标时它盖在视图参数之上;Space 那条路只认它)
      // 标题缺省 = 主视图的名字(紧凑视图的名字是实现细节;走 Space 那条路时 Mini 自己用 Space 的 mini 名)
      const title = opts.title || (plan.spaceId ? undefined : displayTitle(plan.mainView.type))
      const r = await desktop!.mini!({ view: plan.view, mainView: plan.mainView, spaceId: plan.spaceId, params: target.params, key: opts.key, title })
      if (r && !r.ok) return { ok: false, reason: 'limit', limit: r.limit }
      return { ok: true, layer: { float: 'desktop' }, form: 'mini' }
    }
    case 'panel':
      desktop!.panel!({ view: { type: target.type, params: target.params }, title: opts.title || displayTitle(target.type), pin: plan.pin, key: opts.key, size: opts.size })
      return { ok: true, layer: { float: 'desktop' }, form: 'main' }
    case 'float': {
      const rec = openViewFloat(target.type, plan, opts, opts.layer ?? { dock: 'main' })
      return { ok: true, layer: { float: plan.scope }, form: plan.form, close: rec.close, closed: rec.closed }
    }
  }
}

/** 方案页的写法:`workspace.open(target, { layer, form })`。 */
export const workspace = { open: workspaceOpen }

/** 测试用:收掉全部 View 浮层、拆掉接缝。 */
export function resetWorkspaceOpenForTest(): void {
  for (const r of [...recs.values()]) r.close()
  recs.clear(); snapshot = []
  unsubViews?.(); unsubViews = null
  desktop = null
  renderers = 0
}
