/**
 * sketch 卡片的宿主包装文档 + 主题桥(单测钉住安全边界 —— sketchWrapper.test.ts)。
 * 隔离配方(2026-08-21 真 Chromium 实证,勿凭 spec 推理改动):
 * - iframe sandbox **仅 allow-scripts**:绝不加 allow-same-origin(加了=模型 HTML 跑进宿主
 *   origin,拿到 DOM/localStorage);不加 allow-forms/allow-popups/allow-top-navigation。
 * - 裸 sandbox 挡不住网络:宿主 CSP 有 connect-src/img-src https:,srcdoc 继承之,卡内可以
 *   fetch 任意 https —— 必须注入内层 CSP default-src 'none' 才真断网,且 meta 须是 head 首元素。
 * - 刻意不给 'unsafe-eval':桌面宿主 CSP 有它而 web/mobile 没有,统一禁掉三端行为才一致。
 * - srcdoc 的 event.origin 是字符串 "null":高度消息只认 event.source === iframe.contentWindow。
 * - 包装脚本放 <head>(模型 HTML 之前):残缺的模型标记吞不掉它。
 *
 * 主题桥(08-21 二轮):把宿主的语义 token 以 --fs-* 注进卡内。首帧走 srcdoc 内联(无闪),
 * 之后换肤走 postMessage 就地改 documentElement.style —— **不重建 srcdoc**,否则 iframe 重载、
 * 卡内交互状态全丢。⚠️token 值来自磁盘主题包/自定义配色 = 半可信输入,拼进 srcdoc 前必须过 sanitizeVar。
 * ⚠️--fs-* 名字与引擎 `tangu-agent/src/tools/builtin/sketch.ts` 的描述**逐字一致**(跨仓两份,
 * 改一边就得改另一边),否则模型照描述写的变量在卡里解析不出来。
 */

import sketchCss from './sketch.css?raw'
import sketchRuntime from './sketchRuntime.js?raw'
import sketchFigures from './sketchFigures.js?raw'
import { serializeSketchState } from './sketchState'

/** 内层 CSP:inline JS/CSS 可跑;无网络、无 eval、无外链资源;图片/媒体/字体仅 data:/blob:。 */
export const SKETCH_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:"
export const SKETCH_SANDBOX = 'allow-scripts'
export const SKETCH_MIN_H = 40
export const SKETCH_MAX_H = 2400
/** iframe 初始高度:内容高度上报前的占位(定值防 ChatView 贴底 ResizeObserver 抖滚动)。 */
export const SKETCH_INITIAL_H = 220

/** 不随主题换色的卡内变量。透明画布直接透出 Chat View 所在面,主区/Side Panel 不必猜底色。 */
export const SKETCH_STATIC_VARS = { '--fs-bg': 'transparent' } as const

/** 卡内变量 → 宿主语义 token。顺序即注入顺序;只增不改(改名破坏已画出的历史卡)。 */
export const SKETCH_VARS: ReadonlyArray<readonly [string, string]> = [
  // Sketch 画布透明；只有卡内信息面板继续通过 --fs-surface 跟随宿主层级。
  ['--fs-surface', '--overlay-subtle'],
  ['--fs-text', '--text'],
  ['--fs-muted', '--text-muted'],
  ['--fs-faint', '--text-faint'],
  ['--fs-border', '--border'],
  ['--fs-rule', '--overlay-medium'],
  ['--fs-accent', '--accent-ink'],
  ['--fs-accent-soft', '--accent-light'],
  ['--fs-green', '--green'],
  ['--fs-danger', '--danger'],
  ['--fs-radius', '--radius-sm'],
  ['--fs-font', '--font-ui'],
  ['--fs-mono', '--font-mono'],
]

/** token 值是半可信输入(磁盘主题包/自定义配色):掐掉能提前闭合 <style>/开标签的字符。 */
function sanitizeVar(v: string): string {
  return String(v).replace(/[<>]/g, '').trim()
}

/** 从**卡片元素**读实时 token(不是 documentElement:作用域覆盖如 .tangu-lovable 才能继承到)。 */
export function readSketchTheme(el: Element): Record<string, string> {
  const cs = getComputedStyle(el)
  const out: Record<string, string> = { ...SKETCH_STATIC_VARS }
  for (const [into, from] of SKETCH_VARS) {
    const v = sanitizeVar(cs.getPropertyValue(from))
    if (v) out[into] = v
  }
  out['color-scheme'] = document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light'
  return out
}

/** 换肤/明暗/扁平切换通知(单例 observer + 监听表,不给每张卡各挂一个)。 */
type ThemeListener = () => void
const themeListeners = new Set<ThemeListener>()
let themeObserver: MutationObserver | null = null

export function subscribeThemeChange(fn: ThemeListener): () => void {
  themeListeners.add(fn)
  if (!themeObserver && typeof MutationObserver !== 'undefined') {
    themeObserver = new MutationObserver(() => { for (const l of themeListeners) l() })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-skin', 'data-bg', 'data-mode', 'data-flat', 'data-glass', 'class'],
    })
  }
  return () => {
    themeListeners.delete(fn)
    if (!themeListeners.size && themeObserver) { themeObserver.disconnect(); themeObserver = null }
  }
}

/** 数据序列梯:s1=强调(焦点值),s2..s5 是正文色的递减不透明版 —— 单强调 + 单色阶,
 *  换任何配色都自动成立,也不会出现「五种饱和色打架」。用 color-mix 而非硬编码 alpha。 */
const SKETCH_SERIES_CSS =
  ':root{--fs-s1:var(--fs-accent);' +
  '--fs-s2:color-mix(in srgb,var(--fs-text) 62%,transparent);' +
  '--fs-s3:color-mix(in srgb,var(--fs-text) 42%,transparent);' +
  '--fs-s4:color-mix(in srgb,var(--fs-text) 26%,transparent);' +
  '--fs-s5:color-mix(in srgb,var(--fs-text) 14%,transparent)}'

function varsBlock(vars: Record<string, string>): string {
  const body = Object.entries(vars)
    .map(([k, v]) => `${k.replace(/[^a-z-]/gi, '')}:${sanitizeVar(v)}`)
    .join(';')
  return body ? `:root{${body}}` : ''
}

/** 模型 HTML → 完整 srcdoc 文档:CSP 置顶 + 主题变量 + 基础排版 + 高度上报 + 锚点导航拦截。 */
export function buildSketchDoc(html: string, vars: Record<string, string> = {}, state: unknown = null, nonce = ''): string {
  // State is data, including when it contains HTML or a closing script tag.
  const initial = (serializeSketchState(state) ?? 'null')
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  // nonce 是宿主生成的随机串(ask / copy 的授权令牌,见 sketchRuntime.js 头注);只允许 [A-Za-z0-9-],拼不出提前闭合的引号
  const runtime = sketchRuntime.replace('__SKETCH_INITIAL_STATE__', () => initial).replace('__SKETCH_NONCE__', () => nonce.replace(/[^A-Za-z0-9-]/g, ''))
  return '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${SKETCH_CSP}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${varsBlock(vars)}${SKETCH_SERIES_CSS}${sketchCss}</style>` +
    `<script>${runtime};\n${sketchFigures}</script>` +
    `</head><body>${html}</body></html>`
}
