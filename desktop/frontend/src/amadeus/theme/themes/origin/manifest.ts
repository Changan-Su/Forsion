import type { ThemeManifest } from '../../engine'
import { hexToRgb, mix, onAccent } from '../../color'
import { registerMessages, translate } from '../../../../i18n'

registerMessages({
  'themeOrigin.label': { zh: 'Origin · 本源', en: 'Origin' },
})

// Custom accent: the seed becomes --primary; --bg/--bg-alt/--surface take a faint graphite
// tint of it (Origin stays paper-restrained — neutrals/text/border keep the theme base).
function custom(seed: string, dark: boolean): Record<string, string> {
  const c = hexToRgb(seed)
  if (dark) {
    return {
      '--primary': seed,
      '--primary-2': mix(c, [255, 255, 255], 0.18),
      '--on-primary': onAccent(c),
      '--bg': mix(c, [28, 26, 22], 0.93),
      '--bg-alt': mix(c, [33, 30, 24], 0.92),
      '--surface': mix(c, [38, 34, 25], 0.94),
    }
  }
  return {
    '--primary': seed,
    '--primary-2': mix(c, [0, 0, 0], 0.14),
    '--on-primary': onAccent(c),
    '--bg': mix(c, [247, 244, 237], 0.96),
    '--bg-alt': mix(c, [243, 239, 231], 0.94),
    '--surface': mix(c, [254, 253, 249], 0.975),
  }
}

const manifest: ThemeManifest = {
  id: 'origin',
  // 取值器而非字面量:THEMES 在模块加载期就冻结成数组,写死的 label 切语言不会更新;
  // ThemeManifest.label 的类型是 string(engine.ts 共用,不改),accessor 正好满足且每次读都重算。
  get label() {
    return translate('themeOrigin.label')
  },
  swatch: '#1c1c1c',
  order: 0,
  custom,
}
export default manifest
