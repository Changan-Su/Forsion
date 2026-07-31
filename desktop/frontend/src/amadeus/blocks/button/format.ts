/** 「按钮」块的落盘格式(纯函数,无 React —— 编辑器只需要 BLANK_BUTTON_BLOCK,不该被拖进组件树)。
 *
 * 整个 Amadeus 块**恰好**是一个围栏代码块:
 * ```forsion-button
 * {"v":1,"label":"整理今天的笔记","icon":"✨","triggerId":"w-a1b2c3"}
 * ```
 * 纯 markdown、可 diff、别的编辑器打开就是一段代码(不会毁档)。
 * JSON 坏了 → parse 返回 null,BlockHost 回落成普通代码块把源码原样露出来:**绝不自动重写**
 * 用户改坏的那段(改写=悄悄吞掉他刚打错的一个引号,连同里面的配置)。 */

export interface ButtonSpec {
  /** 格式版本;将来加字段时老客户端据此决定「原样保留还是拒绝渲染」。 */
  v: number
  label: string
  /** emoji 或单字符;不做图标库(一个 emoji 就够,还能跟着 markdown 走)。 */
  icon?: string
  /** 引用的 manual 自动化规则 id;空 = 还没配过。 */
  triggerId?: string
  /** 非空 = 点击后先要一次就地确认(Notion 的 Show confirmation)。 */
  confirm?: string
}

const FENCE_RE = /^```forsion-button[ \t]*\r?\n([\s\S]*?)\r?\n?```$/

/** 整块恰是一个 forsion-button 围栏 → 解析出配置;不是/JSON 坏了 → null(调用方回落普通块)。 */
export function parseButtonBlock(content: string): ButtonSpec | null {
  const m = FENCE_RE.exec((content ?? '').trim())
  if (!m) return null
  try {
    const o = JSON.parse(m[1] || '{}')
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    return {
      v: Number(o.v) || 1,
      label: typeof o.label === 'string' ? o.label.slice(0, 60) : '',
      icon: typeof o.icon === 'string' && o.icon ? o.icon.slice(0, 4) : undefined,
      triggerId: typeof o.triggerId === 'string' && o.triggerId ? o.triggerId : undefined,
      confirm: typeof o.confirm === 'string' && o.confirm.trim() ? o.confirm.trim().slice(0, 200) : undefined,
    }
  } catch {
    return null
  }
}

export function serializeButtonBlock(s: ButtonSpec): string {
  const o: Record<string, unknown> = { v: 1, label: s.label }
  if (s.icon) o.icon = s.icon
  if (s.triggerId) o.triggerId = s.triggerId
  if (s.confirm) o.confirm = s.confirm
  return `\`\`\`forsion-button\n${JSON.stringify(o)}\n\`\`\``
}

/** `/按钮` 插入的初始块(未配置态:点一下开构建器)。 */
export const BLANK_BUTTON_BLOCK = serializeButtonBlock({ v: 1, label: '' })
