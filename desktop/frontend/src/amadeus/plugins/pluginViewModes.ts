/**
 * `ctx.ui.setViewModes(el, …)`(2026-10-19+,视图模式标准方案 A):插件视图报「有哪几种看法、现在是哪种」,
 * 宿主把胶囊画在这个视图头行的最左,位置、⌥⌘V、命令面板、窄宽变形、手机顶栏都由宿主管(同原生视图的 useViewModes)。
 * 句柄的 `actions` 是头行右边的一块空位:插件把自己栏里的按钮挪进来,整行只有一条 32px 的头。
 *
 * 只认插件视图宿主(PluginViewHost)那颗挂载点里的元素;同一个视图再调一次 = 覆盖上一份(上一份的句柄作废)。
 * 这里不依赖 pluginStore / pluginViews(两边都引它,避免成环)。
 */
export interface PluginViewModeOption {
  id: string
  label: string
  /** 英文界面用的名字;缺省两种语言都用 label。 */
  labelEn?: string
  /** 插件图标词表里的名字(同 ViewContribution.icon);窄时只留图标要每种都给了且都认得。 */
  icon?: string
}
export interface PluginViewModesSpec {
  modes: PluginViewModeOption[]
  value: string
  /** 用户切了(点胶囊、⌥⌘V、命令面板):插件换内容。插件自己调 `set()` 不会回调这里。 */
  onChange?(id: string): void
}
export interface PluginViewModesHandle {
  /** 插件自己切(比如点了某一句跳到转写):只改胶囊,不回调 onChange。 */
  set(id: string): void
  update(patch: Partial<PluginViewModesSpec>): void
  /** 头行右边那块(插件放自己的按钮);dispose 后从页面上摘掉。 */
  readonly actions: HTMLElement
  dispose(): void
}

export const PLUGIN_VIEW_HOST_ATTR = 'data-plugin-view-host'

export interface PluginViewModesEntry {
  spec: Readonly<PluginViewModesSpec>
  actions: HTMLElement
  /** 宿主侧的切换:先改值再回调插件。 */
  select(id: string): void
  /** 被同一视图的下一次 setViewModes 顶掉 / 视图卸载:旧句柄从此不起作用。 */
  retire(): void
}

const entries = new Map<HTMLElement, PluginViewModesEntry>()
const subs = new Set<() => void>()
const changed = (): void => { for (const f of subs) f() }
export const subscribePluginViewModes = (cb: () => void): (() => void) => { subs.add(cb); return () => { subs.delete(cb) } }
export const pluginViewModesOf = (host: HTMLElement | null): PluginViewModesEntry | null => (host ? entries.get(host) ?? null : null)

function checkSpec(spec: PluginViewModesSpec): PluginViewModesSpec {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.modes)) throw new TypeError('setViewModes needs { modes: [...], value }')
  if (spec.modes.length < 2 || spec.modes.length > 4) throw new RangeError('setViewModes takes 2–4 modes (more than 4 belongs in tabs)')
  const ids = new Set<string>()
  const modes = spec.modes.map((m) => {
    if (!m || typeof m.id !== 'string' || !m.id || typeof m.label !== 'string') throw new TypeError('each mode needs { id, label } strings')
    if (ids.has(m.id)) throw new TypeError(`duplicate mode id "${m.id}"`)
    ids.add(m.id)
    return { id: m.id, label: m.label, ...(typeof m.labelEn === 'string' ? { labelEn: m.labelEn } : {}), ...(typeof m.icon === 'string' ? { icon: m.icon } : {}) }
  })
  const value = ids.has(spec.value) ? spec.value : modes[0].id
  return { modes, value, onChange: typeof spec.onChange === 'function' ? spec.onChange : undefined }
}

/** `own(dispose)` = 插件作用域登记(停用 / 重载时宿主替它 dispose),返回幂等的 dispose。 */
export function setPluginViewModes(el: HTMLElement, spec: PluginViewModesSpec, own: (dispose: () => void) => () => void, onError: (e: unknown) => void): PluginViewModesHandle {
  if (!(el instanceof HTMLElement)) throw new TypeError('setViewModes needs the element your view was mounted on (or one inside it)')
  const host = el.closest<HTMLElement>(`[${PLUGIN_VIEW_HOST_ATTR}]`)
  if (!host) throw new Error('setViewModes only works inside a plugin view (pass the element mount() received)')
  let cur = checkSpec(spec)
  const actions = document.createElement('div')
  actions.className = 'plugin-viewhead-actions'
  actions.style.cssText = 'display:flex;align-items:center;gap:2px;min-width:0'
  let alive = true
  let dispose = (): void => {}
  const entry: PluginViewModesEntry = {
    get spec() { return cur },
    actions,
    select(id) {
      if (!alive || id === cur.value || !cur.modes.some((m) => m.id === id)) return
      cur = { ...cur, value: id }
      changed()
      try { cur.onChange?.(id) } catch (e) { onError(e) }
    },
    // 覆盖 / 视图卸载都走完整的 dispose:插件作用域里那条登记一起放掉,不等整个插件停用
    retire() { dispose() },
  }
  entries.get(host)?.retire()
  entries.set(host, entry)
  changed()
  dispose = own(() => {
    alive = false
    actions.remove()
    if (entries.get(host) === entry) { entries.delete(host); changed() }
  })
  return {
    set(id) { if (alive && id !== cur.value && cur.modes.some((m) => m.id === id)) { cur = { ...cur, value: id }; changed() } },
    update(patch) { if (!alive || !patch || typeof patch !== 'object') return; cur = checkSpec({ ...cur, ...patch }); changed() },
    actions,
    dispose,
  }
}

/** 宿主卸载视图时清掉它那份(插件没 dispose 也不留孤儿)。 */
export function clearPluginViewModes(host: HTMLElement): void {
  entries.get(host)?.retire()
  heads.get(host)?.retire()
}

/** `ctx.ui.setViewHead`(2026-10-26+,走查续八 8.19):同一条 32px 头行,不必先有看法 —— 左边标题、右边插件的按钮。
 *  和 setViewModes 并存:胶囊在前、标题其次、两份按钮都在右端。`title` 是 PluginText,画的时候求值(PluginViewHost)。 */
export interface PluginViewHeadEntry { readonly title?: unknown; readonly actions: HTMLElement; retire(): void }
const heads = new Map<HTMLElement, PluginViewHeadEntry>()
export const pluginViewHeadOf = (host: HTMLElement | null): PluginViewHeadEntry | null => (host ? heads.get(host) ?? null : null)

export function setPluginViewHead(
  el: HTMLElement, opts: { title?: unknown; actions?: HTMLElement | HTMLElement[] } | undefined, own: (dispose: () => void) => () => void,
): { update(patch: { title?: unknown; actions?: HTMLElement | HTMLElement[] }): void; readonly actions: HTMLElement; dispose(): void } {
  if (!(el instanceof HTMLElement)) throw new TypeError('setViewHead needs the element your view was mounted on (or one inside it)')
  const host = el.closest<HTMLElement>(`[${PLUGIN_VIEW_HOST_ATTR}]`)
  if (!host) throw new Error('setViewHead only works inside a plugin view (pass the element mount() received)')
  const actions = document.createElement('div')
  actions.className = 'plugin-viewhead-actions'
  actions.style.cssText = 'display:flex;align-items:center;gap:2px;min-width:0'
  const put = (a: unknown): void => { for (const x of Array.isArray(a) ? a : a ? [a] : []) if (x instanceof HTMLElement) actions.append(x) }
  put(opts?.actions)
  let alive = true
  let dispose = (): void => {}
  // 每次 update 换一个新对象:PluginViewHost 拿 entry 身份当 useSyncExternalStore 的快照
  const make = (title: unknown): PluginViewHeadEntry => ({ title, actions, retire: () => dispose() })
  let entry = make(opts?.title)
  heads.get(host)?.retire()
  heads.set(host, entry)
  changed()
  dispose = own(() => {
    alive = false
    actions.remove()
    if (heads.get(host) === entry) { heads.delete(host); changed() }
  })
  return {
    update(patch) {
      if (!alive || !patch || typeof patch !== 'object') return
      if ('actions' in patch) { actions.replaceChildren(); put(patch.actions) }
      if ('title' in patch) { entry = make(patch.title); heads.set(host, entry); changed() }
    },
    actions,
    dispose,
  }
}
