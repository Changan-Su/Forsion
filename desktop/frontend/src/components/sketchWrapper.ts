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
      attributeFilter: ['data-theme', 'data-skin', 'data-mode', 'data-flat', 'data-glass', 'class'],
    })
  }
  return () => {
    themeListeners.delete(fn)
    if (!themeListeners.size && themeObserver) { themeObserver.disconnect(); themeObserver = null }
  }
}

/** 卡内基础排版:editorial 取向(细线优先于填充、数字等宽、留白撑节奏),全部走 --fs-*,
 *  所以模型即使一行样式都不写,卡也随宿主明暗/配色自适应。
 *
 * .fs-* 是给模型的「质量地板」,不是另一套主题:它们只组织字号/间距/导轨,颜色仍全部来自上面的
 * 语义 token。简单图表不再从「两行文字 + 一根粗条」开始,而是天然带结论层级、图场、导轨和来源行。 */
const SKETCH_BASE_CSS =
  'html,body{margin:0;padding:0}' +
  '*,*::before,*::after{box-sizing:border-box}' +
  'body{font-family:var(--fs-font);background:var(--fs-bg);color:var(--fs-text);' +
  'font-size:13.5px;line-height:1.58;padding:22px 24px 18px;overflow-x:auto;-webkit-font-smoothing:antialiased}' +
  'header,figure,figcaption,footer{margin:0}' +
  'h1,h2,h3,h4{margin:0 0 .5em;font-weight:650;line-height:1.18;letter-spacing:-.025em;text-wrap:balance}' +
  'h1{font-size:24px}h2{font-size:20px}h3{font-size:15px}h4{font-size:13px}' +
  'p{margin:0 0 .7em}p:last-child{margin-bottom:0}' +
  'small{font-size:11px;color:var(--fs-muted)}' +
  'a{color:var(--fs-accent)}' +
  'hr{border:0;border-top:1px solid var(--fs-rule);margin:16px 0}' +
  'code,pre,kbd{font-family:var(--fs-mono);font-size:12px}' +
  'pre{overflow-x:auto;background:var(--fs-surface);border-radius:var(--fs-radius);padding:10px}' +
  'table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}' +
  'th,td{text-align:left;padding:8px 12px 8px 0;border-bottom:1px solid var(--fs-rule);vertical-align:top}' +
  'th{font-weight:650;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--fs-muted)}' +
  'th:last-child,td:last-child{padding-right:0}' +
  'tr:last-child td{border-bottom:0}' +
  'svg{display:block;width:100%;max-width:100%;height:auto;overflow:visible}' +
  'svg text{font-family:var(--fs-font);fill:var(--fs-text)}' +
  'img{display:block;max-width:100%;height:auto}' +
  'button,input,select,textarea{font:inherit;color:inherit}' +
  'button{border:1px solid var(--fs-border);border-radius:var(--fs-radius);background:var(--fs-bg);padding:7px 11px;cursor:pointer}' +
  'button:hover{background:var(--fs-surface)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--fs-accent);outline-offset:2px}' +
  '.fs-header{display:grid;gap:5px;margin:0 0 20px}' +
  '.fs-eyebrow{font-size:9.5px;font-weight:700;line-height:1.3;letter-spacing:.12em;text-transform:uppercase;color:var(--fs-accent)}' +
  '.fs-title{margin:0;font-size:clamp(19px,3.8vw,25px);font-weight:700;line-height:1.12;letter-spacing:-.035em;text-wrap:balance}' +
  '.fs-subtitle{max-width:62ch;font-size:11.5px;line-height:1.55;color:var(--fs-muted)}' +
  '.fs-plot{position:relative;min-width:0;margin:0}' +
  '.fs-caption{margin-top:10px;font-size:11px;line-height:1.5;color:var(--fs-muted)}' +
  '.fs-source{margin-top:18px;padding-top:9px;border-top:1px solid var(--fs-rule);font-size:9px;font-weight:650;line-height:1.45;letter-spacing:.09em;text-transform:uppercase;color:var(--fs-faint)}' +
  '.fs-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));margin:4px 0 20px;border-block:1px solid var(--fs-rule)}' +
  '.fs-stat{display:grid;align-content:start;gap:2px;min-width:0;padding:13px 14px 12px 0}' +
  '.fs-stat+.fs-stat{padding-left:14px;border-left:1px solid var(--fs-rule)}' +
  '.fs-value{font-family:var(--fs-mono);font-size:clamp(20px,4.6vw,30px);font-weight:750;line-height:1;letter-spacing:-.05em;font-variant-numeric:tabular-nums}' +
  '.fs-label{font-size:10.5px;line-height:1.35;color:var(--fs-muted)}' +
  '.fs-panel{padding:14px 16px;border-radius:var(--fs-radius);background:var(--fs-surface)}' +
  '.fs-row{display:flex;align-items:center;gap:10px;min-width:0}' +
  '.fs-chip{display:inline-flex;align-items:center;min-height:22px;padding:3px 8px;border:1px solid var(--fs-border);border-radius:999px;font-size:10px;font-weight:650;color:var(--fs-muted)}' +
  '.fs-bar-track{height:9px;overflow:hidden;border-radius:999px;background:var(--fs-surface)}' +
  '.fs-bar-fill{height:100%;min-width:2px;border-radius:inherit;background:var(--fs-accent);transform-origin:left center}' +
  '::selection{background:var(--fs-accent-soft)}' +
  '@media(max-width:480px){body{padding:18px 16px 15px}.fs-header{margin-bottom:16px}.fs-stat{padding-right:9px}.fs-stat+.fs-stat{padding-left:9px}}' +
  '@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}'

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
export function buildSketchDoc(html: string, vars: Record<string, string> = {}): string {
  return '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${SKETCH_CSP}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${varsBlock(vars)}${SKETCH_SERIES_CSS}${SKETCH_BASE_CSS}</style>` +
    '<script>(function(){' +
    // 锚点导航=出网口(frame-src 允许的少数源仍可达),捕获期一律掐灭;交互让模型用 JS 写。
    'document.addEventListener("click",function(e){var n=e.target;while(n&&n!==document){if(n.tagName==="A"&&n.getAttribute("href")){e.preventDefault();return}n=n.parentNode}},true);' +
    // 换肤:父窗口就地改变量,不重建 srcdoc(重建=iframe 重载,卡内交互状态全丢)。只认 parent。
    'window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;' +
    'if(!d||d.type!=="sketch-theme"||!d.vars)return;var s=document.documentElement.style;' +
    'for(var k in d.vars){if(k.charAt(0)==="-")s.setProperty(k,String(d.vars[k]));else if(k==="color-scheme")s.colorScheme=String(d.vars[k])}});' +
    // 量 body 布局高而非 documentElement.scrollHeight:后者恒 ≥ iframe 视口高,小卡永远缩不回去(实测 220 占位就钉死在 220)。
    'var last=0;function post(){var b=document.body;var h=b?Math.ceil(b.getBoundingClientRect().height):0;if(h&&h!==last){last=h;parent.postMessage({type:"sketch-height",height:h},"*")}}' +
    'function arm(){if(window.ResizeObserver&&document.body){new ResizeObserver(post).observe(document.body)}post()}' +
    'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",arm);else arm();' +
    'window.addEventListener("load",post);' +
    '})()</script>' +
    `</head><body>${html}</body></html>`
}
