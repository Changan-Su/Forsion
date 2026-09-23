/**
 * 跨窗界面同步的 IPC 载荷。设置自 Floating Panel 化起住在**独立渲染进程**里,每个窗口各有一份
 * themeStore / 各自的 <html> 与 localStorage 视图 —— 在设置窗里改外观只改得动它自己(2.11.1 实报)。
 * 故任何用户显式的界面改动都广播一份给其余窗口原样重放。
 *
 * 两半各自可缺:换主题只发 `theme`,改字体/缩放/光标/语言只发 `prefs`。
 *
 * ⚠ 带值而不是让收方自己读 localStorage:localStorage 的跨进程可见性与 IPC 是两条管道,
 *   收方可能读到旧值 —— 那等于 bug 没修。收方仍要校验(见 themeStore / uiPrefsApply)。
 */
export interface ThemeAxes {
  lang: string
  skin: string
  bg: string
  /** 用户明暗**偏好**(可为 system);落地明暗由收方按本机系统/主题强制自行解析。 */
  modePref: 'light' | 'dark' | 'system'
  seed: string
  bgSeed: string
  glass: boolean
  /** Optional for older windows that do not yet expose the shadow preference. */
  flat?: boolean
}

export interface UiSyncPayload {
  theme?: ThemeAxes
  /** 渲染层本地偏好:localStorage 键 → 值(null = 删键 = 回到默认)。白名单在收方 uiPrefsApply。 */
  prefs?: Record<string, string | null>
}

const PREFS = new Set(['light', 'dark', 'system'])
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
/** 轴 id:内置配色 + 磁盘主题目录名。收方还会再按自己的 registry 查一遍,这里只管长度与字符。 */
const AXIS = /^[A-Za-z0-9._-]{1,64}$/
/** 偏好键:含主题可调参数那种 `theme.<id>.--<var>` 的点号与连字符。收方只认自己白名单里的。 */
const PREF_KEY = /^[A-Za-z0-9._-]{1,80}$/
const MAX_PREFS = 64
const MAX_PREF_LEN = 128
/** 颜色 seed:非法一律归成空串 —— 收方把空串读作「保留本窗现值」(bgSeed 的空串本就是「跟随主题色」)。 */
const color = (v: unknown): string => typeof v === 'string' && HEX.test(v) ? v : ''

function theme(raw: unknown): ThemeAxes | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const v = raw as Record<string, unknown>
  if (!AXIS.test(String(v.lang)) || !AXIS.test(String(v.skin)) || !AXIS.test(String(v.bg))) return undefined
  if (!PREFS.has(v.modePref as string)) return undefined
  if (typeof v.glass !== 'boolean') return undefined
  if (v.flat !== undefined && typeof v.flat !== 'boolean') return undefined
  return {
    lang: v.lang as string, skin: v.skin as string, bg: v.bg as string,
    modePref: v.modePref as ThemeAxes['modePref'],
    seed: color(v.seed), bgSeed: color(v.bgSeed), glass: v.glass,
    ...(typeof v.flat === 'boolean' ? { flat: v.flat } : {}),
  }
}

function prefs(raw: unknown): Record<string, string | null> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string | null> = {}
  let n = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PREFS || !PREF_KEY.test(k)) continue
    if (v === null) { out[k] = null; n++; continue }
    if (typeof v !== 'string' || v.length > MAX_PREF_LEN) continue
    out[k] = v
    n++
  }
  return n ? out : undefined
}

/**
 * 信任边界:`window.tangu.broadcastUi` 对插件也可见,而主进程会把载荷复制给**所有**窗口。
 * 故主进程只按本函数重建已知字段(多余属性、超长值、坏键一律丢弃),不转发原对象。
 */
export function normalizeUiSync(raw: unknown): UiSyncPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  const t = theme(v.theme)
  const p = prefs(v.prefs)
  return t || p ? { theme: t, prefs: p } : null
}
