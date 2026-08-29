// Genesis custom-skin runtime. It began as a Forsion-LCL/tanguData.ts snapshot, but Genesis now
// owns the dual-axis contract (see repository DESIGN.md): independent background seeds, semantic
// accent pairs, and WCAG guards live here. The archived LCL study must not overwrite this file.

type RGB = [number, number, number]
function hexToRgb(hex: string): RGB {
  const m = hex.replace('#', '')
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  return [parseInt(n.slice(0, 2), 16) || 0, parseInt(n.slice(2, 4), 16) || 0, parseInt(n.slice(4, 6), 16) || 0]
}
const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
const BLACK: RGB = [0, 0, 0]
const WHITE: RGB = [255, 255, 255]

function mixRgb(c: RGB, t: RGB, k: number): RGB {
  return [
    clamp(c[0] + (t[0] - c[0]) * k),
    clamp(c[1] + (t[1] - c[1]) * k),
    clamp(c[2] + (t[2] - c[2]) * k),
  ]
}

function rgbCss(c: RGB): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

function relativeLuminance(c: RGB): number {
  const channel = (v: number): number => {
    const x = v / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2])
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Preserve the seed hue as far as possible, then move only enough toward black/white for AA text. */
function readableInk(seed: RGB, surfaces: RGB[], dark: boolean): RGB {
  const minContrast = (c: RGB): number => Math.min(...surfaces.map((surface) => contrast(c, surface)))
  if (minContrast(seed) >= 4.5) return seed
  const target = dark ? WHITE : BLACK
  let low = 0
  let high = 1
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2
    if (minContrast(mixRgb(seed, target, mid)) >= 4.5) high = mid
    else low = mid
  }
  return mixRgb(seed, target, high)
}

/** `--on-accent` is paired with the raw accent fill; choose by actual WCAG contrast, not RGB brightness. */
function readableOnAccent(accent: RGB): string {
  return contrast(accent, WHITE) >= contrast(accent, BLACK) ? '#ffffff' : '#000000'
}

/** Hover is still a filled surface paired with `--on-accent`; never darken/lighten it past AA. */
function readableFillVariant(seed: RGB, target: RGB, amount: number, onAccent: string): string {
  const candidate = mixRgb(seed, target, amount)
  return rgbCss(contrast(candidate, hexToRgb(onAccent)) >= 4.5 ? candidate : seed)
}

const LIGHT_SURFACES: [RGB, RGB, RGB] = [[248, 247, 246], [242, 241, 239], [253, 253, 252]]
const DARK_SURFACES: [RGB, RGB, RGB] = [[42, 41, 43], [50, 50, 53], [53, 53, 56]]
const LIGHT_FAINT: RGB = [114, 108, 103]
const DARK_FAINT: RGB = [163, 158, 152]

/**
 * 主题色与背景色是两根**独立**的轴,所以自定义强调色不知道自己会落在哪块底上。
 * 于是不按「自己那套底」算 ink,而按全部背景选项里**最不利**的那一面算:
 * - 浅色最不利 = 薰衣草侧栏 #e5d5ef(预设里最暗的浅色面);自定义背景更亮 —— readableSurfaces 会把它
 *   收敛到弱信息文字仍 AA 的区间(L≥0.94),必在此之上。
 * - 暗色最不利 = #363639(readableSurfaces 在暗色下能产出的**最亮**面);各预设暗色卡面都比它暗。
 * 结论:对任意 主题色 × 背景色 组合,--accent-ink 都不会掉到 4.5:1 以下(代价是浅底上稍微再压深一点)。
 */
const LIGHT_WORST_SURFACE: RGB = [229, 213, 239]
const DARK_WORST_SURFACE: RGB = [54, 54, 57]

/**
 * A custom background is a hue seed, not permission to silently invert the selected mode.
 * Keep as much of the chosen color as possible, then move the three surfaces together toward
 * the neutral mode baseline until even the weakest informational text remains AA-readable.
 */
function readableSurfaces(surfaces: [RGB, RGB, RGB], dark: boolean): [RGB, RGB, RGB] {
  const text = dark ? DARK_FAINT : LIGHT_FAINT
  const target = dark ? DARK_SURFACES : LIGHT_SURFACES
  const passes = (items: RGB[]): boolean => items.every((surface) => contrast(text, surface) >= 4.5)
  if (passes(surfaces)) return surfaces
  let low = 0
  let high = 1
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2
    const candidate = surfaces.map((surface, index) => mixRgb(surface, target[index], mid))
    if (passes(candidate)) high = mid
    else low = mid
  }
  return surfaces.map((surface, index) => mixRgb(surface, target[index], high)) as [RGB, RGB, RGB]
}

/** 自定义**主题色**:accent 家族(内联在 :root,压过 [data-skin] 块)。纯函数。
 *  ink 按 LIGHT/DARK_WORST_SURFACE 算 —— 背景色是另一根轴,这里不知道也不该知道它选了什么。 */
export function customAccentVars(color: string, dark: boolean): Record<string, string> {
  const [r, g, b] = hexToRgb(color)
  const c: RGB = [r, g, b]
  const rgb = `${r},${g},${b}`
  const onAccent = readableOnAccent(c)
  const hoverTarget = onAccent === '#000000' ? WHITE : BLACK
  const accentInk = readableInk(c, [dark ? DARK_WORST_SURFACE : LIGHT_WORST_SURFACE], dark)
  return {
    '--accent': color,
    '--accent-ink': rgbCss(accentInk),
    '--accent-hover': readableFillVariant(c, hoverTarget, 0.12, onAccent),
    '--accent-light': `rgba(${rgb},${dark ? '0.16' : '0.10'})`,
    '--accent-rgb': rgb,
    '--on-accent': onAccent,
    '--on-accent-ink': readableOnAccent(accentInk),
    '--user-bg': `rgba(${rgb},${dark ? '0.16' : '0.10'})`,
  }
}

/** 自定义**背景色**:三张表面(舞台/侧栏/卡面)。纯函数。
 *  `explicit=false` = 旧「背景跟随强调色」行为(seed 传当前强调色,微染),老用户零迁移;
 *  `explicit=true` = seed 就是背景色本身,但仍保留当前明暗并收敛到弱信息文字仍 AA 的最接近色,
 *  避免一个背景 seed 把整套中性色反转。 */
export function customBgVars(seed: string, dark: boolean, explicit: boolean): Record<string, string> {
  const c = hexToRgb(seed)
  const [bgColor, sidebarColor, cardColor] = dark
    ? readableSurfaces([
      explicit ? mixRgb(c, [26, 26, 28], 0.94) : mixRgb(c, [26, 26, 28], 0.93),
      explicit ? mixRgb(c, [33, 33, 36], 0.93) : mixRgb(c, [33, 33, 36], 0.92),
      explicit ? mixRgb(c, [41, 41, 44], 0.95) : mixRgb(c, [41, 41, 44], 0.94),
    ], true)
    : readableSurfaces([
      explicit ? c : mixRgb(c, [246, 246, 247], 0.96),
      explicit ? mixRgb(c, BLACK, 0.03) : mixRgb(c, [238, 238, 240], 0.94),
      explicit ? mixRgb(c, WHITE, 0.55) : mixRgb(c, [252, 252, 253], 0.975),
    ], false)
  return {
    '--bg': rgbCss(bgColor),
    '--sidebar-bg': rgbCss(sidebarColor),
    '--bg-card': rgbCss(cardColor),
  }
}

/** 两轴都取自定义时的合成(= 拆轴前的 customSkinVars 签名;检查脚本/单测仍按它逐组合验)。 */
export function customSkinVars(color: string, dark: boolean, bg?: string): Record<string, string> {
  return { ...customAccentVars(color, dark), ...customBgVars(bg || color, dark, !!bg) }
}

export const CUSTOM_ACCENT_VAR_KEYS: string[] = Object.keys(customAccentVars('#888888', false))
export const CUSTOM_BG_VAR_KEYS: string[] = Object.keys(customBgVars('#888888', false, true))
/** 两轴内联变量的并集 —— loader 离开 custom 时按轴分别清理。 */
export const CUSTOM_SKIN_VAR_KEYS: string[] = [...CUSTOM_ACCENT_VAR_KEYS, ...CUSTOM_BG_VAR_KEYS]
