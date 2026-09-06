/**
 * Agent 面:模型能看见/能执行的那一小块界面能力。三端共用(desktop / web / mobile 同一份渲染层)。
 *
 * 两条独立的面,刻意不合并:
 * - **设置面**(`applyUiSetting`)—— 闭集 11 项,值域在此校验。设置项比命令更需要严格值域,
 *   而命令表里的设置类命令又全是 toggle/cycle(见 lcl `CommandInvoke` 头注),所以走独立通道。
 * - **命令面**(`buildCommandCatalog` / `runAgentCommand`)—— 开放式,靠命令自己声明 `invoke` opt-in。
 *
 * ⚠️ 绝不裸写 localStorage:每一项都有 setter 之外的副作用(主题要过 applyTheme + syncWindowMaterial,
 *    字体 writeFont 之后必须 applyUiFonts,ui_zoom 要 dispatch 事件让浮层重算位置)。裸写的后果是
 *    「重启才生效」。所以下表一律调 setter,不碰存储。
 *
 * ⚠️ setter **本身不校验参数**(setModePref/setSkin/setLocaleGlobal 都把脏字符串直接写进
 *    document.documentElement)。G1 校验闸就在这里,不能省。
 *
 * 安全边界:web 与移动端的云 run 根本不经过审批闸(引擎 approvals.ts 对 execMode!=='host' 直接
 * approve)。**这张表的内容就是那两端的全部安全性** —— 加项前先过 08-19 canon 的危险类判据。
 */
import { currentLocale, setLocaleGlobal, type Locale } from './i18n'
import { useTheme } from './stores/themeStore'
import { listSkins, listLanguages } from './theme/registry'
import { readFont, writeFont, applyUiFonts, type FontSlot } from './uiFont'
import { listFonts } from './fontPresets'
import { getUiZoom, setUiZoom, resetUiZoom } from './uiZoom'
import { isSmoothCaretOn, setSmoothCaretEnabled } from './smoothCaret'
import { SMOOTH_CARET_KEY } from './types'
import { useCommandStore } from '@lcl/engine/commandRegistry'

export interface UiActionResult {
  ok: boolean
  /** 失败原因,英文(回给模型)。 */
  error?: string
  /** 成功时的新状态,让模型不必再问一次。 */
  state?: string
  /** setter 在 APPLY_SETTLE_MS 内没落地(被节流的隐藏窗口):不报 state,回执也不带设置快照 —— 宁可少说,不把切换前的值当新值写进引擎。 */
  pending?: boolean
}

interface SettingSpec {
  /** 合法值;动态的(主题包/插件字体可上盘)就现算。 */
  values: () => string[]
  /** 返回 promise 的 setter = 落地是异步的(明暗切换走 View Transition),applyUiSetting 会等它再读 state。 */
  apply: (v: string) => void | Promise<void>
  state: () => string
}

/** 等 setter 落地的上限。隐藏窗口**不是**触发点(被 skip 的过渡仍在 ~2ms 内跑回调,评审实测),只有 ≥2s 的主线程卡顿
 *  才会撞上;撞上就回 pending(不报 state),别让引擎干等 8s 超时。 */
const APPLY_SETTLE_MS = 2000

const FONT_SLOTS: Record<string, FontSlot> = { font_ui: 'ui', font_body: 'body', font_mono: 'mono' }

/** 字体档:走 listFonts(slot) —— 它已按 slots 过滤且含插件字体;'theme' = 跟随主题(写空串即移除该键)。 */
function fontSpec(key: string): SettingSpec {
  const slot = FONT_SLOTS[key]
  return {
    values: () => [...listFonts(slot).map((f) => f.id), 'theme'],
    apply: (v) => { writeFont(slot, v === 'theme' ? '' : v); applyUiFonts() },
    state: () => readFont(slot) || 'theme',
  }
}

const ZOOM_MIN = 0.8
const ZOOM_MAX = 1.5

/**
 * agent 面可选的配色 id。
 * ⚠️ **必须剔掉 `custom`** —— `listSkins()` 是把它算在内的(registry.ts:94)。custom 不是一种颜色,
 *    它骑的是已存的 `forsion_theme_seed` / `forsion_theme_bg_seed`,那是一个模型**看不见也给不了**
 *    的任意 hex,会经 `root.style.setProperty` 直接落到舞台上 —— 设过去等于把界面交给一个残留值,
 *    黑底黑字也是可能的结果。种子色本身更不许进白名单(它是无约束的 setProperty 入口)。
 */
function agentSkinIds(): string[] {
  return listSkins().map((s) => s.id).filter((id) => id !== 'custom')
}

/** 闭集设置表。key 与引擎侧 `set_ui_setting` 的 enum **必须逐字一致**(契约测试钉住)。 */
export const UI_SETTINGS: Record<string, SettingSpec> = {
  locale: {
    values: () => ['zh', 'en'],
    apply: (v) => setLocaleGlobal(v as Locale),
    state: () => currentLocale(),
  },
  color_mode: {
    values: () => ['light', 'dark', 'system'],
    // ⚠️ 当前设计语言锁死配色方案时(如 genesis-glass 强制 system),setModePref **静默返回**。
    //    照旧报 modePref 会变成「返回 ok+dark、界面还是亮的」。这里如实抛,让模型说得出真话
    //    (Codex 评审 P2-9)。
    apply: (v) => {
      const th = useTheme.getState()
      if (th.modeLocked) {
        throw new Error(`the current design language ("${th.lang}") locks the colour scheme; change theme_lang first`)
      }
      // ⚠️ 必须 return:setModePref 的落地在 View Transition 回调里(下一帧),不等它就会把切换前的
      //    mode 当新状态回给模型(2026-09-05 实报,agentCommandsApply.test.ts 钉住)。
      return th.setModePref(v as 'light' | 'dark' | 'system')
    },
    // 报**实际生效**的明暗(mode),不是偏好(modePref)——用户看到的是前者。
    state: () => useTheme.getState().mode,
  },
  accent: {
    values: agentSkinIds,
    apply: (v) => useTheme.getState().setSkin(v),
    state: () => useTheme.getState().skin,
  },
  background: {
    values: agentSkinIds,
    apply: (v) => useTheme.getState().setBg(v),
    state: () => useTheme.getState().bg,
  },
  theme_lang: {
    values: () => listLanguages().map((e) => e.manifest.id),
    apply: (v) => useTheme.getState().setLang(v),
    state: () => useTheme.getState().lang,
  },
  flat: {
    values: () => ['on', 'off'],
    apply: (v) => useTheme.getState().setFlat(v === 'on'),
    state: () => (useTheme.getState().flat ? 'on' : 'off'),
  },
  font_ui: fontSpec('font_ui'),
  font_body: fontSpec('font_body'),
  font_mono: fontSpec('font_mono'),
  ui_zoom: {
    values: () => ['reset', '0.8', '0.9', '1', '1.1', '1.2', '1.3', '1.4', '1.5'],
    apply: (v) => { if (v === 'reset') resetUiZoom(); else setUiZoom(Number(v)) },
    state: () => String(getUiZoom()),
  },
  smooth_caret: {
    values: () => ['on', 'off'],
    // ⚠️ setSmoothCaretEnabled 只动模块态与 DOM,**不落盘**(设置页是另外单独写的 key)。
    //    少了这一行:视觉上开了、state() 读盘仍报 off、重启又变回去(Codex 评审 P2-8)。
    //    这是本文件唯一一处 setItem —— 因为这一项的 setter 天生只做一半。
    apply: (v) => {
      const on = v === 'on'
      try { localStorage.setItem(SMOOTH_CARET_KEY, on ? '1' : '0') } catch { /* private mode */ }
      setSmoothCaretEnabled(on)
    },
    state: () => (isSmoothCaretOn() ? 'on' : 'off'),
  },
}

export const UI_SETTING_KEYS = Object.keys(UI_SETTINGS)

/**
 * G1 值域闸 + 应用。ui_zoom 的数值档单独夹边界:setUiZoom 自己只夹到 0.5–2,而 0.5 是可读性
 * 锁死(用户看不清就没法自己改回来),所以 agent 面收窄到 0.8–1.5。
 */
export async function applyUiSetting(key: unknown, value: unknown): Promise<UiActionResult> {
  const k = typeof key === 'string' ? key : ''
  // 自有键查找:`UI_SETTINGS['constructor']` / `['toString']` 走原型链能拿到函数,下面 spec.values() 就炸在 try 之外 → 不回执、引擎干等 8s。
  const spec = Object.prototype.hasOwnProperty.call(UI_SETTINGS, k) ? UI_SETTINGS[k] : undefined
  if (!spec) return { ok: false, error: `unknown setting "${k}". Known: ${UI_SETTING_KEYS.join(', ')}` }
  const v = typeof value === 'string' ? value : String(value ?? '')
  if (k === 'ui_zoom' && v !== 'reset') {
    const n = Number(v)
    if (!Number.isFinite(n) || n < ZOOM_MIN || n > ZOOM_MAX) {
      return { ok: false, error: `ui_zoom must be "reset" or a number between ${ZOOM_MIN} and ${ZOOM_MAX}` }
    }
  } else if (!spec.values().includes(v)) {
    return { ok: false, error: `invalid value "${v}" for ${k}. Allowed: ${spec.values().join(', ')}` }
  }
  let settled = false
  try {
    // 等 setter 真正落地再读 state()(同步 setter 这里零开销)。超过 APPLY_SETTLE_MS 仍没落地就按 pending 回:
    // 此时读 state() 拿到的正是切换前的值 —— 本次要修的病,不能换个出口再犯一次。
    await Promise.race([
      Promise.resolve(spec.apply(v)).then(() => { settled = true }),
      new Promise<void>((r) => setTimeout(r, APPLY_SETTLE_MS)),
    ])
  } catch (e) {
    return { ok: false, error: `failed to apply ${k}: ${String((e as Error)?.message || e)}` }
  }
  return settled ? { ok: true, state: spec.state() } : { ok: true, pending: true }
}

/**
 * 当前全部设置的**值**(不带值域):随回执上送,引擎据此刷新 run 内快照。
 * 只回被改的那一个键不够 —— 一次 set 可能连带改别的键(换设计语言会锁死/改写明暗)。
 * 值域 run 内不变,不重复上送(它是这份载荷里唯一无上界的部分:插件字体可上盘)。
 */
export function readUiValues(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, spec] of Object.entries(UI_SETTINGS)) {
    try { out[k] = spec.state() } catch { /* 某端缺该能力就跳过 */ }
  }
  return out
}

/**
 * 读当前全部设置的**值 + 本端合法值**,随目录一起上送。
 * ⚠️ 合法值必须从这里给:主题包与插件字体是可上盘的,引擎侧写死一份枚举保证会漂,
 *    而漂了的表现是模型照着提示发一个必被拒的值(Codex 评审 P2-11)。
 */
export function readUiSettings(): Record<string, { value: string; allowed?: string[] }> {
  const out: Record<string, { value: string; allowed?: string[] }> = {}
  for (const [k, spec] of Object.entries(UI_SETTINGS)) {
    try { out[k] = { value: spec.state(), allowed: spec.values() } } catch { /* 某端缺该能力就跳过,别让整份目录挂掉 */ }
  }
  return out
}

export interface CommandCatalogEntry {
  id: string
  description: string
  params?: Record<string, unknown>
  state?: string
}

/**
 * 命令目录 = 命令表里**声明了 `invoke`** 的那些(存在即白名单)。
 * 随每次 run 请求体上送,不进 system prompt(前缀缓存纪律)。
 *
 * ⚠️ 目录随端而异是**正确行为**,不是 bug:插件命令在 web/移动端根本不注册
 *    (两端的 listPlugins 都返回 []),host 门控命令同理。模型在手机上看到的目录本就该更短。
 */
export function buildCommandCatalog(): CommandCatalogEntry[] {
  const out: CommandCatalogEntry[] = []
  for (const c of useCommandStore.getState().commands) {
    const inv = c.invoke
    if (!inv?.description) continue
    let state: string | undefined
    try { state = inv.state?.() } catch { /* 探针坏了不该拖垮整份目录 */ }
    out.push({ id: c.id, description: inv.description, ...(inv.params ? { params: inv.params } : {}), ...(state ? { state } : {}) })
  }
  return out
}

/**
 * 按命令自己声明的 `params` schema 做一层**浅校验**:只放行声明过的键,并核对基础类型。
 *
 * ⚠️ 为什么宿主必须做这件事:`invoke` 是插件自声明的,插件同时控制 opt-in 与 handler ——
 *    文档里写「危险类不许 opt-in」是纪律,不是强制。宿主至少要保证「模型只能送出插件声明过的
 *    参数形状」,否则一个没写防御的 handler 会收到它从没设想过的键/类型(Codex 评审 P1-6)。
 *    深校验(嵌套/format/enum)不做:ponytail —— 顶层键与基础类型已经挡掉绝大多数误用,
 *    真需要严格 schema 时再上 ajv。
 */
function checkArgs(params: Record<string, unknown> | undefined, args: Record<string, unknown>): string | null {
  if (!params) return Object.keys(args).length ? `this command takes no arguments` : null
  const props = (params.properties && typeof params.properties === 'object' ? params.properties : {}) as Record<string, { type?: string }>
  const required = Array.isArray(params.required) ? params.required.filter((x): x is string => typeof x === 'string') : []
  for (const k of Object.keys(args)) {
    if (!(k in props)) return `unknown argument "${k}". Declared: ${Object.keys(props).join(', ') || '(none)'}`
  }
  for (const k of required) {
    if (args[k] === undefined || args[k] === null || args[k] === '') return `missing required argument "${k}"`
  }
  for (const [k, v] of Object.entries(args)) {
    const want = props[k]?.type
    if (!want) continue
    const got = Array.isArray(v) ? 'array' : typeof v
    const ok = want === 'number' ? got === 'number'
      : want === 'integer' ? got === 'number' && Number.isInteger(v)
      : want === got
    if (!ok) return `argument "${k}" must be ${want}, got ${got}`
  }
  return null
}

/** 派发一条 agent 命令。未声明 invoke 的命令一律拒绝——目录之外的 id 不可达。 */
export async function runAgentCommand(id: unknown, args?: Record<string, unknown>): Promise<UiActionResult> {
  const cid = typeof id === 'string' ? id : ''
  const cmd = useCommandStore.getState().commands.find((c) => c.id === cid)
  if (!cmd) return { ok: false, error: `no such command "${cid}" on this client` }
  if (!cmd.invoke?.description) return { ok: false, error: `command "${cid}" is not exposed to agents` }
  const bad = checkArgs(cmd.invoke.params, args || {})
  if (bad) return { ok: false, error: bad }
  try {
    if (cmd.invoke.run) await cmd.invoke.run(args || {})
    else await cmd.run(args)
  } catch (e) {
    return { ok: false, error: `command failed: ${String((e as Error)?.message || e)}` }
  }
  let state: string | undefined
  try { state = cmd.invoke.state?.() } catch { /* ignore */ }
  return { ok: true, ...(state ? { state } : {}) }
}
