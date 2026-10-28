/** 动效 token 的 TS 入口(8.11,DESIGN §3「动效 token」):el.animate(…) / framer 的时长与曲线从 :root 读,与 base.css 同一份,
 *  别再在 TS 里写字面量(check:motion 的 tsLiterals 棘轮钉着)。按名缓存,<html> 的属性一变(换主题 / 皮肤)清缓存重读;
 *  读不到(jsdom、样式还没进)用下面的兜底,兜底值与 base.css 一致。
 *    el.animate(kf, { duration: motion.ms('base'), easing: motion.css('surface') })
 *    transition={{ duration: motion.s('collapse'), ease: motion.bezier('drawer') }} */

export type MotionDuration = 'instant' | 'fast' | 'base' | 'slow' | 'collapse'
export type MotionEase = 'surface' | 'exit' | 'calm' | 'drawer' | 'collapse'

const DURATION_FALLBACK: Record<MotionDuration, number> = { instant: 100, fast: 150, base: 200, slow: 250, collapse: 200 }
const EASE_FALLBACK: Record<MotionEase, [number, number, number, number]> = {
  surface: [0.22, 1, 0.36, 1],
  exit: [0.4, 0, 1, 1],
  calm: [0.33, 1, 0.68, 1],
  drawer: [0.32, 0.72, 0, 1],
  collapse: [0.32, 0.72, 0, 1],
}

const cache = new Map<string, string>()
let watching = false
function read(name: string): string {
  if (typeof document === 'undefined') return ''
  if (!watching && typeof MutationObserver !== 'undefined') {
    watching = true
    new MutationObserver(() => cache.clear()).observe(document.documentElement, { attributes: true })
  }
  let v = cache.get(name)
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    cache.set(name, v)
  }
  return v
}

function ms(name: MotionDuration): number {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(read(name === 'collapse' ? '--collapse-duration' : `--duration-${name}`))
  return m ? parseFloat(m[1]) * (m[2] === 's' ? 1000 : 1) : DURATION_FALLBACK[name]
}

function bezier(name: MotionEase): [number, number, number, number] {
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(read(name === 'collapse' ? '--collapse-ease' : `--ease-${name}`))
  const n = m ? m[1].split(',').map(Number) : []
  return n.length === 4 && n.every(Number.isFinite) ? (n as [number, number, number, number]) : EASE_FALLBACK[name]
}

export const motion = {
  /** WAAPI / setTimeout 用的毫秒 */
  ms,
  /** framer 用的秒 */
  s: (name: MotionDuration): number => ms(name) / 1000,
  /** framer 用的 [x1, y1, x2, y2] */
  bezier,
  /** WAAPI / 内联样式用的 cubic-bezier(…) 字符串 */
  css: (name: MotionEase): string => `cubic-bezier(${bezier(name).join(', ')})`,
}
