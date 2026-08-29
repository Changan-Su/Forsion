/**
 * 界面字体自定义(设置 → 外观)。三档:界面 / 正文 / 等宽,分别盖住
 * --font-ui(+ Amadeus soft 基座的 --font)、--font-body、--font-mono(+ --mono)。
 *
 * **存的是预设 id,不是字面字体名**(2026-08-28 改)。旧版存的是用户手输的 font-family,于是
 * 「预设」实为系统字体名,装没装全看本机;现在 id 经 fontPresets 解析成一条**自带中文兜底的内置字体栈**。
 * 解析不出来(旧脏值 / 预设被删 / 插件被禁)→ 一条声明都不出 = 跟随主题。这一条路同时兜住三种情况。
 *
 * 默认「跟随主题」= 不存值 = 一条声明都不出,主题自带的字体栈原样生效。
 *
 * ⚠ 为什么是 !important + 枚举类名:主题在 `.tangu-lovable[data-skin='qbird']` 这类**更高特异性**的
 *   选择器上重定义 --font-ui,只写 :root 会被子树整个遮住。选择器必须点到那几个真正重定义字体变量的
 *   元素,再用 !important 压过 [data-skin] 变体。以后新增会重定义字体变量的类名 → 补进 SCOPES。
 *
 * ⚠ 值最终拼进 CSS 文本。id 来自 localStorage(可被改写)、栈可能来自插件 → 本文件仍是信任边界:
 *   sanitizeFont 只放行字母/数字/空格/逗号/引号/点/下划线/连字符,`;` `}` `/*` 之类一概剔除。
 *   **解析之后仍要过一遍**,别因为「id 是我们自己的」就跳过 —— 插件给的 stack 不是我们自己的。
 */
import { FONT_UI_KEY, FONT_BODY_KEY, FONT_MONO_KEY } from './types'
import { getFont, migrateLegacyValue, subscribeFonts } from './fontPresets'

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

/** 净化拼进 CSS 的 font-family 栈。返回 '' 表示「没有可用值」→ 按跟随主题处理。 */
export function sanitizeFont(raw: string | null | undefined): string {
  return String(raw ?? '').replace(UNSAFE, '').trim().slice(0, 200)
}

/** 预设 id → 字体栈。未知 id → ''(跟随主题)。 */
export function resolveFontStack(id: string | null | undefined): string {
  const preset = getFont(String(id ?? '').trim())
  return preset ? sanitizeFont(preset.stack) : ''
}

/** 读当前档位存的**预设 id**。老版本存的字面值在这里顺手迁移成 id。 */
export function readFont(slot: FontSlot): string {
  let raw = ''
  try { raw = String(localStorage.getItem(STORAGE_KEY[slot]) ?? '').trim() } catch { return '' }
  if (!raw) return ''
  if (getFont(raw)) return raw
  const migrated = migrateLegacyValue(raw)
  if (migrated) {
    // 就地写回:迁移只发生一次,之后都是命中 getFont 的快路。
    try { localStorage.setItem(STORAGE_KEY[slot], migrated) } catch { /* private mode */ }
    return migrated
  }
  return '' // 认不出 → 跟随主题
}

export function writeFont(slot: FontSlot, id: string): void {
  const v = getFont(String(id ?? '').trim()) ? String(id).trim() : ''
  try {
    if (v) localStorage.setItem(STORAGE_KEY[slot], v)
    else localStorage.removeItem(STORAGE_KEY[slot]) // 清空 = 回到跟随主题
  } catch { /* private mode */ }
}

/** 三档当前值(预设 id) → 要注入的 CSS。全部跟随主题时返回 ''(不留空规则)。纯函数,单测入口。 */
export function buildFontCss(fonts: Partial<Record<FontSlot, string>>): string {
  const decls = (Object.keys(VARS) as FontSlot[]).flatMap((slot) => {
    const stack = resolveFontStack(fonts[slot])
    return stack ? VARS[slot].map((name) => `${name}: ${stack} !important;`) : []
  })
  return decls.length ? `${SCOPES} { ${decls.join(' ')} }` : ''
}

/** 注册表变化(插件装/卸)后要重算一遍 —— 外置插件是异步装的,启动那趟 applyUiFonts 早跑完了。
 *  首次 applyUiFonts 时挂上,之后由 fontPresets 反向通知(codex 评审 2026-08-28)。 */
let subscribed = false

/** 读 localStorage → 刷新注入的 <style>。改设置后调用即刻生效。 */
export function applyUiFonts(): void {
  if (!subscribed) {
    subscribed = true
    subscribeFonts(() => applyUiFonts())
  }
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
