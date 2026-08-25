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

/** Accent + ambiance vars from seed colors (applied inline on the custom skin); neutrals stay from the CSS base. Pure.
 *  配色拆成两个自由度:`color`=强调色 seed(accent 族),可选 `bg`=背景色 seed(bg 族)。
 *  不给 bg = 旧单色行为(背景由强调色微染,老用户零迁移);给 bg = 背景独立于强调色,但会保留当前
 *  亮/暗模式并自动收敛到弱信息文字仍满足 AA 的最接近色,避免背景 seed 把整套中性色反转。 */
export function customSkinVars(color: string, dark: boolean, bg?: string): Record<string, string> {
  const [r, g, b] = hexToRgb(color)
  const c: RGB = [r, g, b]
  const rgb = `${r},${g},${b}`
  const bc: RGB = bg ? hexToRgb(bg) : c
  const onAccent = readableOnAccent(c)
  const hoverTarget = onAccent === '#000000' ? WHITE : BLACK
  if (dark) {
    const [bgColor, sidebarColor, cardColor] = readableSurfaces([
      bg ? mixRgb(bc, [26, 26, 28], 0.88) : mixRgb(c, [26, 26, 28], 0.93),
      bg ? mixRgb(bc, [33, 33, 36], 0.88) : mixRgb(c, [33, 33, 36], 0.92),
      bg ? mixRgb(bc, [41, 41, 44], 0.88) : mixRgb(c, [41, 41, 44], 0.94),
    ], true)
    const accentInk = readableInk(c, [bgColor, sidebarColor, cardColor], true)
    return {
      '--accent': color,
      // 前景强调色必须同时压住舞台/侧栏/卡面;只有真实对比度不够时才向白色移动。
      '--accent-ink': rgbCss(accentInk),
      '--accent-hover': readableFillVariant(c, hoverTarget, 0.12, onAccent),
      '--accent-light': `rgba(${rgb},0.16)`,
      '--accent-rgb': rgb,
      '--on-accent': onAccent,
      '--on-accent-ink': readableOnAccent(accentInk),
      '--user-bg': `rgba(${rgb},0.16)`,
      // graphite faintly tinted by the (bg) seed
      '--bg': rgbCss(bgColor),
      '--sidebar-bg': rgbCss(sidebarColor),
      '--bg-card': rgbCss(cardColor),
    }
  }
  const [bgColor, sidebarColor, cardColor] = readableSurfaces([
    bg ? bc : mixRgb(c, [246, 246, 247], 0.96),
    bg ? mixRgb(bc, BLACK, 0.03) : mixRgb(c, [238, 238, 240], 0.94),
    bg ? mixRgb(bc, WHITE, 0.55) : mixRgb(c, [252, 252, 253], 0.975),
  ], false)
  const accentInk = readableInk(c, [bgColor, sidebarColor, cardColor], false)
  return {
    '--accent': color,
    // 同上:在三种常用表面上都保证 4.5:1,避免浅色/高饱和 seed 只靠经验阈值漏掉。
    '--accent-ink': rgbCss(accentInk),
    '--accent-hover': readableFillVariant(c, hoverTarget, 0.12, onAccent),
    '--accent-light': `rgba(${rgb},0.10)`,
    '--accent-rgb': rgb,
    '--on-accent': onAccent,
    '--on-accent-ink': readableOnAccent(accentInk),
    '--user-bg': `rgba(${rgb},0.10)`,
    // near-white with a hint of the seed; explicit bg 也会留在亮色可读区(card 提亮/sidebar 压深一档)
    '--bg': rgbCss(bgColor),
    '--sidebar-bg': rgbCss(sidebarColor),
    '--bg-card': rgbCss(cardColor),
  }
}

/** Keys customSkinVars emits — used by the theme loader to clear inline vars when leaving custom. */
export const CUSTOM_SKIN_VAR_KEYS: string[] = Object.keys(customSkinVars('#888888', false))
