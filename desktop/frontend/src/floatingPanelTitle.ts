import type { FloatingPanelBuiltin, FloatingPanelOpenOptions } from '../../shared/floatingPanel'

/** 内置浮窗的标题 key:渲染期按当前语言求值。开窗方传来的 target.title 是开窗那一刻的语言,切语言后不会跟着变。 */
const BUILTIN_TITLE_KEYS: Record<FloatingPanelBuiltin, string> = {
  settings: 'settings.title',
  market: 'market.title',
  achievements: 'achievements.title',
  feedback: 'feedback.title',
  btw: 'btw.title',
}

/** 浮窗标题:内置面板按 key 现译;视图面板(插件等)用开窗方给的标题。 */
export function floatingPanelTitle(target: Pick<FloatingPanelOpenOptions, 'builtin' | 'title'>, t: (key: string) => string): string {
  return target.builtin ? t(BUILTIN_TITLE_KEYS[target.builtin]) : target.title
}
