// Vendored from Forsion-LCL/src/tangu/tanguData.ts — DO NOT hand-edit.
// Tangu Desktop is the source of the lovable design language; the static skins (lovable/echo/
// qbird) live as theme folders, so the only runtime piece we need here is the `custom` skin's
// seed→vars function. Re-sync: copy the customSkinVars section (and its hex helpers) from
// Forsion-LCL/src/tangu/tanguData.ts. Source of truth = Forsion-LCL (shared design layer).

type RGB = [number, number, number]
function hexToRgb(hex: string): RGB {
  const m = hex.replace('#', '')
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  return [parseInt(n.slice(0, 2), 16) || 0, parseInt(n.slice(2, 4), 16) || 0, parseInt(n.slice(4, 6), 16) || 0]
}
const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
/** Blend color c toward t by k (k=1 → t). Returns an rgb() string. */
function mix(c: RGB, t: RGB, k: number): string {
  return `rgb(${clamp(c[0] + (t[0] - c[0]) * k)}, ${clamp(c[1] + (t[1] - c[1]) * k)}, ${clamp(c[2] + (t[2] - c[2]) * k)})`
}

/** Accent + ambiance vars from seed colors (applied inline on the custom skin); neutrals stay from the CSS base. Pure.
 *  配色拆成两个自由度:`color`=强调色 seed(accent 族),可选 `bg`=背景色 seed(bg 族)。
 *  不给 bg = 旧单色行为(背景由强调色微染,老用户零迁移);给 bg = 背景独立于强调色(亮色 --bg 即原色)。 */
export function customSkinVars(color: string, dark: boolean, bg?: string): Record<string, string> {
  const [r, g, b] = hexToRgb(color)
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const onAccent = lum < 0.62 ? '#ffffff' : '#161018'
  const c: RGB = [r, g, b]
  const rgb = `${r},${g},${b}`
  const bc: RGB = bg ? hexToRgb(bg) : c
  if (dark) {
    return {
      '--accent': color,
      // 可读强调色:accent 作前景(文字/图标/选中高亮/聚焦边)时用;过深 seed 在暗底自动提亮,正常色恒等于 accent。
      '--accent-ink': lum < 0.35 ? mix(c, [255, 255, 255], 0.5) : color,
      '--accent-hover': mix(c, [255, 255, 255], 0.18),
      '--accent-light': `rgba(${rgb},0.16)`,
      '--accent-rgb': rgb,
      '--on-accent': onAccent,
      '--user-bg': `rgba(${rgb},0.16)`,
      // graphite faintly tinted by the (bg) seed
      '--bg': bg ? mix(bc, [26, 26, 28], 0.88) : mix(c, [26, 26, 28], 0.93),
      '--sidebar-bg': bg ? mix(bc, [33, 33, 36], 0.88) : mix(c, [33, 33, 36], 0.92),
      '--bg-card': bg ? mix(bc, [41, 41, 44], 0.88) : mix(c, [41, 41, 44], 0.94),
    }
  }
  return {
    '--accent': color,
    // 同上:过浅 seed(如纸白)在亮底自动压深,免得选中文字/高亮与背景融为一体。
    '--accent-ink': lum > 0.72 ? mix(c, [0, 0, 0], 0.5) : color,
    '--accent-hover': mix(c, [0, 0, 0], 0.14),
    '--accent-light': `rgba(${rgb},0.10)`,
    '--accent-rgb': rgb,
    '--on-accent': onAccent,
    '--user-bg': `rgba(${rgb},0.10)`,
    // near-white with a hint of the seed; explicit bg seed is used verbatim (card 提亮/sidebar 压深一档)
    '--bg': bg || mix(c, [246, 246, 247], 0.96),
    '--sidebar-bg': bg ? mix(bc, [0, 0, 0], 0.03) : mix(c, [238, 238, 240], 0.94),
    '--bg-card': bg ? mix(bc, [255, 255, 255], 0.55) : mix(c, [252, 252, 253], 0.975),
  }
}

/** Keys customSkinVars emits — used by the theme loader to clear inline vars when leaving custom. */
export const CUSTOM_SKIN_VAR_KEYS: string[] = Object.keys(customSkinVars('#888888', false))
