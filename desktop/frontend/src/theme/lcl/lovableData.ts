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

/** Accent + ambiance vars from a seed color (applied inline on the custom skin); neutrals stay from the CSS base. Pure. */
export function customSkinVars(color: string, dark: boolean): Record<string, string> {
  const [r, g, b] = hexToRgb(color)
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const onAccent = lum < 0.62 ? '#ffffff' : '#161018'
  const c: RGB = [r, g, b]
  const rgb = `${r},${g},${b}`
  if (dark) {
    return {
      '--accent': color,
      '--accent-hover': mix(c, [255, 255, 255], 0.18),
      '--accent-light': `rgba(${rgb},0.16)`,
      '--accent-rgb': rgb,
      '--on-accent': onAccent,
      '--user-bg': `rgba(${rgb},0.16)`,
      '--bg': mix(c, [26, 26, 28], 0.93), // graphite faintly tinted by the seed
      '--sidebar-bg': mix(c, [33, 33, 36], 0.92),
      '--bg-card': mix(c, [41, 41, 44], 0.94),
    }
  }
  return {
    '--accent': color,
    '--accent-hover': mix(c, [0, 0, 0], 0.14),
    '--accent-light': `rgba(${rgb},0.10)`,
    '--accent-rgb': rgb,
    '--on-accent': onAccent,
    '--user-bg': `rgba(${rgb},0.10)`,
    '--bg': mix(c, [246, 246, 247], 0.96), // near-white with a hint of the seed
    '--sidebar-bg': mix(c, [238, 238, 240], 0.94),
    '--bg-card': mix(c, [252, 252, 253], 0.975),
  }
}

/** Keys customSkinVars emits — used by the theme loader to clear inline vars when leaving custom. */
export const CUSTOM_SKIN_VAR_KEYS: string[] = Object.keys(customSkinVars('#888888', false))
