/**
 * 动效收口(动效主题方案 2026-11-06「第 0 步」):动效归宿主管,磁盘主题(含商店主题)只管样子。
 *
 * 磁盘主题的 theme.css 是不可信的用户文件,registry.mergeDiskThemes 注入前统一过这里:
 * 1. **删掉动效 token 的声明**(任何选择器、任何层级都删 —— 写在 `.app` 上的同名变量照样会被
 *    `var(--menu-enter-duration)` 的消费方读到,只锁 :root 拦不住);`@property --<动效 token>` 整块删
 *    (inherits: false 会让子孙拿不到宿主 :root 的值)。
 * 2. **主题自己定义的 @keyframes 一律加前缀** `t-<主题 id>-`,并改写主题自己 animation / animation-name 里的引用:
 *    主题再也盖不掉宿主的同名关键帧(同名后定义的赢);引用宿主关键帧(主题没定义的名字)原样保留。
 *    已知缺口:经自定义属性转手的引用(`--a: fade 1s; animation: var(--a)`)不改写。
 * 3. **主题自己的 @layer 名一律加同样的前缀**:不许往宿主的 `forsion-guard` 层里塞规则。
 *
 * 系统「减少动态效果」在 base.css 的 `@layer forsion-guard` 里,这一层由 styles/layers.css 最先声明:
 * 层内 !important 压过任何不分层的 !important,主题写什么都压不过它。
 * 纯函数,无 DOM 依赖(vitest 覆盖:motionGuard.test.ts;真 Electron 台架:npm run check:motiontheme)。
 */

/** 动效 token:base.css 两块(--duration-* / --ease-* 与「动效 token」那块)+ calm.css 的两个时长。
 *  motionGuard.test.ts 从 base.css 读那块声明,钉住「宿主每个动效 token 都在这里」。 */
export const MOTION_TOKEN_RE = new RegExp('^--(?:' + [
  'duration-[a-z]+',
  'ease-[a-z-]+',
  'menu-(?:enter|exit)-(?:duration|ease)',
  'palette-enter-duration',
  'droplet-duration',
  'collapse-(?:duration|ease)',
  'tip-(?:delay|handoff|enter|exit)',
  'hovercard-(?:delay|enter|exit)',
  'press-(?:travel|recoil)-duration',
  'flash-duration',
  'roll-(?:enter|exit)-duration',
  'reader-(?:step|close)-duration',
  'canvas-switch-[a-z-]+',
  'switch-edge-(?:duration|lag)',
  'seg-edge-(?:duration|lag)', // 分段胶囊滑块两条边(#476)
  'pill-select-duration',
  'toast-(?:enter|exit)-duration',
  'draw-duration',
  'land-duration',
  'view-enter-duration',
  'frame-reveal-duration',
].join('|') + ')$')

export const isMotionToken = (name: string): boolean => MOTION_TOKEN_RE.test(name)

export interface MotionGuardReport {
  /** 被删掉的动效 token(去重,按出现顺序) */
  tokens: string[]
  /** 加了前缀的主题关键帧名(原名) */
  keyframes: string[]
}

const IDENT = '-?[A-Za-z_][A-Za-z0-9_-]*'
const safeId = (id: string): string => id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'

/** 去掉注释(字符串里的 `/*` 不算)。 */
function stripComments(css: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const c = css[i]
    if (c === '"' || c === "'") {
      const end = endOfString(css, i)
      out += css.slice(i, end)
      i = end
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 2
    } else {
      out += c
      i++
    }
  }
  return out
}

/** 从引号 i 起,返回字符串结束后的下标(转义照顾到;没闭合就到行尾)。 */
function endOfString(css: string, i: number): number {
  const q = css[i]
  let j = i + 1
  while (j < css.length) {
    if (css[j] === '\\') { j += 2; continue }
    if (css[j] === q || css[j] === '\n') return j + 1
    j++
  }
  return css.length
}

/** 从 i(值的起点)往后找声明的结尾:深度 0 的 `;`(含)或 `}`(不含)。返回 [值结束, 删除结束]。 */
function endOfValue(css: string, i: number): [number, number] {
  let depth = 0
  let j = i
  while (j < css.length) {
    const c = css[j]
    if (c === '"' || c === "'") { j = endOfString(css, j); continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
    else if (c === '}') {
      if (depth === 0) return [j, j]
      depth--
    } else if (c === ';' && depth === 0) return [j, j + 1]
    j++
  }
  return [css.length, css.length]
}

/** 从 `{` 起找配对的 `}`,返回其后的下标。 */
function endOfBlock(css: string, open: number): number {
  let depth = 0
  for (let j = open; j < css.length; j++) {
    const c = css[j]
    if (c === '"' || c === "'") { j = endOfString(css, j) - 1; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return j + 1
  }
  return css.length
}

/** 声明开头:前面(跳过空白)是 `{`、`;` 或文件开头。 */
function atDeclStart(css: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && /\s/.test(css[j])) j--
  return j < 0 || css[j] === '{' || css[j] === ';'
}

export function guardThemeCss(source: string, themeId: string): { css: string; report: MotionGuardReport } {
  const prefix = `t-${safeId(themeId)}-`
  const tokens: string[] = []
  const note = (name: string) => { if (!tokens.includes(name)) tokens.push(name) }
  let css = stripComments(source)

  // 1a. @property --<动效 token> { … } 整块删
  const propRe = /@property\s+(--[A-Za-z0-9_-]+)\s*\{/g
  for (let m = propRe.exec(css); m; m = propRe.exec(css)) {
    if (!isMotionToken(m[1])) continue
    note(m[1])
    css = css.slice(0, m.index) + css.slice(endOfBlock(css, m.index + m[0].length - 1))
    propRe.lastIndex = m.index
  }

  // 1b. 动效 token 的声明:任何选择器、任何层级
  const declRe = /--[A-Za-z0-9_-]+\s*:/g
  let out = ''
  let last = 0
  for (let m = declRe.exec(css); m; m = declRe.exec(css)) {
    const name = m[0].slice(0, m[0].indexOf(':')).trim()
    if (!isMotionToken(name) || !atDeclStart(css, m.index)) continue
    const [, cut] = endOfValue(css, m.index + m[0].length)
    note(name)
    out += css.slice(last, m.index)
    last = cut
    declRe.lastIndex = cut
  }
  css = out + css.slice(last)

  // 2. 主题自己定义的关键帧:加前缀,并改写主题自己的引用
  const defined: string[] = []
  css = css.replace(new RegExp(`(@(?:-webkit-)?keyframes\\s+)(?:(${IDENT})|"([^"]+)"|'([^']+)')`, 'g'), (_m, head: string, a?: string, b?: string, c?: string) => {
    const name = (a ?? b ?? c) as string
    if (!defined.includes(name)) defined.push(name)
    return `${head}${prefix}${safeId(name)}`
  })
  if (defined.length) {
    const names = new Set(defined)
    css = css.replace(/((?:-webkit-)?animation(?:-name)?\s*:)([^;{}]*)/g, (_m, head: string, value: string) =>
      head + value.replace(new RegExp(`(^|[\\s,])(${IDENT}|"[^"]+"|'[^']+')(?=$|[\\s,!])`, 'g'), (t, sep: string, tok: string) => {
        const bare = tok.replace(/^["']|["']$/g, '')
        return names.has(bare) ? `${sep}${prefix}${safeId(bare)}` : t
      }))
  }

  // 3. 主题自己的层名加前缀(`@layer a, b;` 与 `@layer a {`;匿名层不动)
  css = css.replace(/@layer\s+([^{;]+)([{;])/g, (_m, names: string, end: string) =>
    `@layer ${names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.split('.').map((p) => prefix + safeId(p)).join('.')).join(', ')} ${end}`)

  return { css, report: { tokens, keyframes: defined } }
}
