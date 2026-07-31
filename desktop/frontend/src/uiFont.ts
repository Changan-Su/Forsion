/**
 * 界面字体自定义(设置 → 外观)。三档:界面 / 正文 / 等宽,分别盖住
 * --font-ui(+ Amadeus soft 基座的 --font)、--font-body、--font-mono(+ --mono)。
 *
 * 默认「跟随主题」= 不存值 = 一条声明都不出,主题自带的字体栈原样生效。想要系统字体就选预设里的
 * `system-ui` / `ui-monospace` —— CSS 原生的系统字体关键字,不必自己拼一长串栈。
 *
 * ⚠ 为什么是 !important + 枚举类名:主题在 `.tangu-lovable[data-skin='qbird']` 这类**更高特异性**的
 *   选择器上重定义 --font-ui,只写 :root 会被子树整个遮住。选择器必须点到那几个真正重定义字体变量的
 *   元素,再用 !important 压过 [data-skin] 变体。以后新增会重定义字体变量的类名 → 补进 SCOPES。
 *
 * ⚠ 值最终拼进 CSS 文本,localStorage 是可被改写的输入 → 本文件是信任边界:sanitizeFont 只放行
 *   字母/数字/空格/逗号/引号/点/下划线/连字符,`;` `}` `/*` 之类一概剔除。纯函数便于 vitest 覆盖。
 */
import { FONT_UI_KEY, FONT_BODY_KEY, FONT_MONO_KEY } from './types'

export type FontSlot = 'ui' | 'body' | 'mono'

const STORAGE_KEY: Record<FontSlot, string> = { ui: FONT_UI_KEY, body: FONT_BODY_KEY, mono: FONT_MONO_KEY }

/** 每档要盖的变量。--font / --mono 是 Amadeus soft 基座自己的词汇(有 17 处直接 var() 消费)。 */
const VARS: Record<FontSlot, string[]> = {
  ui: ['--font-ui', '--font'],
  body: ['--font-body'],
  mono: ['--font-mono', '--mono'],
}

/** 真正重定义过字体变量的元素(grep `--font-ui:` / `--font:` 得来)。 */
const SCOPES = ':root, .am-app, .tangu-lovable, .tangu-soft'

const STYLE_ID = 'forsion-ui-font'
const UNSAFE = /[^\p{L}\p{N} ,'"._-]/gu

/** 净化用户输入的 font-family。返回 '' 表示「没有可用值」→ 按跟随主题处理。 */
export function sanitizeFont(raw: string | null | undefined): string {
  return String(raw ?? '').replace(UNSAFE, '').trim().slice(0, 200)
}

export function readFont(slot: FontSlot): string {
  try { return sanitizeFont(localStorage.getItem(STORAGE_KEY[slot])) } catch { return '' }
}

export function writeFont(slot: FontSlot, raw: string): void {
  const v = sanitizeFont(raw)
  try {
    if (v) localStorage.setItem(STORAGE_KEY[slot], v)
    else localStorage.removeItem(STORAGE_KEY[slot]) // 清空 = 回到跟随主题
  } catch { /* private mode */ }
}

/** 三档当前值 → 要注入的 CSS。全部跟随主题时返回 ''(不留空规则)。纯函数,单测入口。 */
export function buildFontCss(fonts: Partial<Record<FontSlot, string>>): string {
  const decls = (Object.keys(VARS) as FontSlot[]).flatMap((slot) => {
    const v = sanitizeFont(fonts[slot])
    return v ? VARS[slot].map((name) => `${name}: ${v} !important;`) : []
  })
  return decls.length ? `${SCOPES} { ${decls.join(' ')} }` : ''
}

/** 读 localStorage → 刷新注入的 <style>。改设置后调用即刻生效。 */
export function applyUiFonts(): void {
  const css = buildFontCss({ ui: readFont('ui'), body: readFont('body'), mono: readFont('mono') })
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!css) { el?.remove(); return }
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el) // 末位追加:同特异性时也赢在源序
  }
  el.textContent = css
}
