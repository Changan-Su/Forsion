/**
 * 演示舞台(插件的 ctx.stage)的参数、结果与错误码:渲染层的插件入口和主进程(electron/pluginStage.ts)共用。纯函数,单测钉。
 * 方案:仓根 docs/ToBeImproved/沙箱开放给插件方案_2026-11-20(A 舞台 + B 脚本回放引擎,11-20 用户选「A 和 B 一起做」)。
 *
 * 舞台 = 按需另起的一份隔离 Forsion(和插件沙箱同一套进程 / 目录隔离,见 pluginSandbox.ts),只装演示库和点名的插件,不登录、
 * 不碰用户的笔记库和插件数据;插件按步骤操作它、拍全分辨率截图、录视频。
 */

export type StageEngine = 'none' | 'scripted'
export interface StageTheme { mode: 'light' | 'dark'; lang?: string; skin?: string; bg?: string }
export interface StageWindow { width: number; height: number; scale: number }

/** 清洗过的 open() 参数。 */
export interface StageOptions {
  /** 插件包里的目录(相对插件根):vault/ 拷进舞台智库,engine.json 给脚本回放。不给 = 空库。 */
  fixture?: string
  /** 一起装进舞台的已安装插件 id(只拷插件包,不带插件数据)。 */
  plugins: string[]
  /** 调用方插件自己也进舞台(缺省不进:演示插件是导演,不是被拍的)。 */
  includeSelf: boolean
  theme: StageTheme
  locale: 'zh' | 'en'
  window: StageWindow
  /** 舞台里的「现在」,本地时间 `YYYY-MM-DDTHH:mm[:ss]`;时间照常往前走,只是起点定住。 */
  clock?: string
  engine: StageEngine
}

/** 主进程带给舞台子进程的那份(FORSION_SANDBOX_INFO.stage)。 */
export interface StageChildInfo {
  plugins: string[]
  window: StageWindow
  clock?: string
  engine: StageEngine
}

export const STAGE_LIMITS = {
  minWidth: 640, maxWidth: 3840, minHeight: 480, maxHeight: 2400,
  minScale: 1, maxScale: 3,
  maxPlugins: 12,
  /** 一段录像最长多久;到点自动停,stop() 照样拿得到。 */
  maxRecordMs: 120_000,
  minFps: 1, maxFps: 60,
} as const

export const STAGE_DEFAULT_WINDOW: StageWindow = { width: 1440, height: 900, scale: 2 }

/** 失败一律带 code(reject 的 Error 上挂 code,和 ctx.ui.capture 一个风格)。 */
export type StageErrorCode =
  | 'unsupported' // 不是桌面版 / 没声明 stage 能力
  | 'invalid' // 参数不对
  | 'denied' // 用户在确认框里点了不允许
  | 'busy' // 舞台槽位被别的插件占着
  | 'fixture-invalid' // fixture 目录不在插件包里 / 不存在 / engine.json 读不出
  | 'plugin-missing' // 点名的插件没装,或在舞台里没装载起来
  | 'timeout'
  | 'closed' // 舞台已经关了(闲置自停 / 插件停用 / 被关)
  | 'error'

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
// market-<uuid> 是商店装的插件的目录名身份,也认
const PLUGIN_REF = /^(?:[a-z0-9][a-z0-9-]{0,63}|market-[0-9a-f-]{36})$/
const THEME_TOKEN = /^[a-z0-9][a-z0-9-]{0,39}$/
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/

export function isStagePluginRef(v: unknown): v is string { return typeof v === 'string' && PLUGIN_REF.test(v) }

/** fixture 只收插件包里的相对路径:不能是绝对路径、不能有 `..`、不能以 `.` 开头的段(.git / .forsion)。 */
export function isStageFixturePath(v: unknown): v is string {
  if (typeof v !== 'string' || !v || v.length > 300) return false
  if (v.startsWith('/') || v.startsWith('\\') || /^[a-zA-Z]:/.test(v)) return false
  const parts = v.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 && parts.every((p) => p !== '..' && !p.startsWith('.') && !/[\0]/.test(p))
}

export function parseStageClock(v: string): Date | null {
  if (!CLOCK.test(v)) return null
  const d = new Date(v) // 不带时区 = 本地时间(ES2015+)
  return Number.isFinite(d.getTime()) ? d : null
}

/** open() 的参数 → 清洗过的参数;不认的键忽略,认得但不对的报错。locale 缺省跟调用方的界面语言。 */
export function sanitizeStageOptions(raw: unknown, defaults: { locale: 'zh' | 'en' }): { ok: true; options: StageOptions } | { ok: false; error: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const fail = (error: string) => ({ ok: false as const, error })

  let fixture: string | undefined
  if (o.fixture != null) {
    if (!isStageFixturePath(o.fixture)) return fail('fixture must be a folder path relative to the plugin root, without ".." or hidden folders')
    fixture = o.fixture.split(/[\\/]+/).filter(Boolean).join('/')
  }

  const plugins: string[] = []
  if (o.plugins != null) {
    if (!Array.isArray(o.plugins)) return fail('plugins must be an array of plugin ids')
    for (const p of o.plugins) {
      if (!isStagePluginRef(p)) return fail(`"${String(p).slice(0, 80)}" is not a plugin id`)
      if (!plugins.includes(p)) plugins.push(p)
    }
    if (plugins.length > STAGE_LIMITS.maxPlugins) return fail(`at most ${STAGE_LIMITS.maxPlugins} plugins can join a stage`)
  }

  let theme: StageTheme = { mode: 'light' }
  if (o.theme != null) {
    const t = (typeof o.theme === 'string' ? { mode: o.theme } : o.theme) as Record<string, unknown>
    if (!t || typeof t !== 'object') return fail('theme must be "light", "dark" or { mode, lang?, skin?, bg? }')
    if (t.mode !== 'light' && t.mode !== 'dark') return fail('theme.mode must be "light" or "dark"')
    theme = { mode: t.mode }
    for (const k of ['lang', 'skin', 'bg'] as const) {
      if (t[k] == null) continue
      if (typeof t[k] !== 'string' || !THEME_TOKEN.test(t[k] as string)) return fail(`theme.${k} must be a theme id (a-z, 0-9, -)`)
      theme[k] = t[k] as string
    }
  }

  let locale = defaults.locale
  if (o.locale != null) {
    if (o.locale !== 'zh' && o.locale !== 'en') return fail('locale must be "zh" or "en"')
    locale = o.locale
  }

  let win: StageWindow = { ...STAGE_DEFAULT_WINDOW }
  if (o.window != null) {
    const w = (Array.isArray(o.window) ? { width: o.window[0], height: o.window[1], scale: o.window[2] } : o.window) as Record<string, unknown>
    if (!w || typeof w !== 'object') return fail('window must be { width, height, scale? } or [width, height, scale?]')
    const num = (v: unknown, d: number): number => (v == null ? d : typeof v === 'number' && Number.isFinite(v) ? v : NaN)
    const width = Math.round(num(w.width, STAGE_DEFAULT_WINDOW.width))
    const height = Math.round(num(w.height, STAGE_DEFAULT_WINDOW.height))
    const scale = Math.round(num(w.scale, STAGE_DEFAULT_WINDOW.scale) * 100) / 100
    if (!(width >= STAGE_LIMITS.minWidth && width <= STAGE_LIMITS.maxWidth)) return fail(`window.width must be ${STAGE_LIMITS.minWidth}–${STAGE_LIMITS.maxWidth}`)
    if (!(height >= STAGE_LIMITS.minHeight && height <= STAGE_LIMITS.maxHeight)) return fail(`window.height must be ${STAGE_LIMITS.minHeight}–${STAGE_LIMITS.maxHeight}`)
    if (!(scale >= STAGE_LIMITS.minScale && scale <= STAGE_LIMITS.maxScale)) return fail(`window.scale must be ${STAGE_LIMITS.minScale}–${STAGE_LIMITS.maxScale}`)
    win = { width, height, scale }
  }

  let clock: string | undefined
  if (o.clock != null) {
    if (typeof o.clock !== 'string' || !parseStageClock(o.clock)) return fail('clock must be a local time like "2026-11-20T10:00"')
    clock = o.clock
  }

  let engine: StageEngine = 'none'
  if (o.engine != null) {
    if (o.engine !== 'none' && o.engine !== 'scripted') return fail('engine must be "none" or "scripted"')
    engine = o.engine
    if (engine === 'scripted' && !fixture) return fail('engine "scripted" needs a fixture with an engine.json')
  }

  if (o.includeSelf != null && typeof o.includeSelf !== 'boolean') return fail('includeSelf must be true or false')
  return { ok: true, options: { ...(fixture ? { fixture } : {}), plugins, includeSelf: o.includeSelf === true, theme, locale, window: win, ...(clock ? { clock } : {}), engine } }
}

/** 舞台首屏写进 localStorage 的主题键:明暗 + 可选的语言 / 主题色 / 背景;玻璃一律关(macOS 的玻璃是窗口透明 + 系统模糊,截图里会透出桌面)。 */
export function stageThemeStorage(theme: StageTheme): Record<string, string> {
  return {
    forsion_theme_pref: theme.mode,
    forsion_theme: theme.mode,
    forsion_glass: 'off',
    ...(theme.lang ? { forsion_theme_lang: theme.lang } : {}),
    ...(theme.skin ? { forsion_theme_skin: theme.skin } : {}),
    ...(theme.bg ? { forsion_theme_bg: theme.bg } : {}),
  }
}

/** 截图区域(CSS 像素,舞台窗口内):整数、非负、不为空。 */
export function sanitizeStageRect(v: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const n = (k: string): number => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? Math.round(r[k] as number) : NaN)
  const x = n('x'), y = n('y'), width = n('width'), height = n('height')
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 1 || height < 1) return null
  return { x, y, width, height }
}

/** 录像参数。 */
export function sanitizeStageRecord(v: unknown): { fps: number; cursor: boolean; maxMs: number; format: 'mp4' | 'webm' } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const fps = typeof o.fps === 'number' && Number.isFinite(o.fps) ? Math.min(STAGE_LIMITS.maxFps, Math.max(STAGE_LIMITS.minFps, Math.round(o.fps))) : 30
  const maxMs = typeof o.maxMs === 'number' && Number.isFinite(o.maxMs) ? Math.min(STAGE_LIMITS.maxRecordMs, Math.max(1000, Math.round(o.maxMs))) : STAGE_LIMITS.maxRecordMs
  // format 原先在这里被丢掉,要 webm 也录成 mp4(11-26 评审抓到)
  return { fps, cursor: o.cursor !== false, maxMs, format: o.format === 'webm' ? 'webm' : 'mp4' }
}

/** FORSION_SANDBOX_INFO.stage → 舞台参数;形状不对就当不是舞台(父进程那边已清洗过,这里只防坏数据)。 */
export function parseStageInfo(v: unknown): StageChildInfo | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const w = (o.window && typeof o.window === 'object' ? o.window : {}) as Record<string, unknown>
  const num = (x: unknown, lo: number, hi: number): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null)
  const width = num(w.width, 320, 7680), height = num(w.height, 240, 4320), scale = num(w.scale, 0.5, 4)
  if (width == null || height == null || scale == null) return undefined
  const plugins = Array.isArray(o.plugins) ? o.plugins.filter((x): x is string => typeof x === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(x)).slice(0, 32) : []
  return { plugins, window: { width: Math.round(width), height: Math.round(height), scale }, ...(typeof o.clock === 'string' ? { clock: o.clock.slice(0, 40) } : {}), engine: o.engine === 'scripted' ? 'scripted' : 'none' }
}

export { ID as STAGE_ID_PATTERN }
