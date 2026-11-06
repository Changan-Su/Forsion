/**
 * 动效收口(动效主题方案 2026-11-06「第 0 步」):动效 token、宿主关键帧和「减少动态效果」归宿主管。
 *
 * 磁盘主题(含商店主题)的 theme.css 是不可信的用户文件,registry.mergeDiskThemes 注入前统一过这里。
 * 按 CSS Syntax 3 切成 token 再改(不是正则扫文本):转义(`--\6d enu-…`)、大写 at 规则(`@LAYER`)、
 * 嵌套规则后面的声明、字符串 / 注释里长得像声明的字都按 CSS 自己的读法处理;没改的地方原文照抄(注释也留着)。
 * 1. **删掉动效 token 的声明**(任何选择器、任何层级;只锁 :root 拦不住写在 `.shell` 上的同名变量),
 *    `@property --<动效 token>` 整块删(inherits: false 会让子孙拿不到宿主 :root 的值)。
 * 2. **主题自己定义的 @keyframes 加前缀** `t-<主题 id>-`(大小写照原样),并改写主题自己 animation / animation-name 里的引用:
 *    主题盖不掉宿主的同名关键帧。简写里和关键字同名的词(linear、infinite、none…)一律当关键字、不改写 ——
 *    关键帧别起这种名字(定义照样加前缀,只是简写里引用不到)。关键帧块里的动效 token 同样删(自定义属性能被关键帧动画改写)。
 *    已知缺口:经自定义属性转手的引用(`--a: fade 1s; animation: var(--a)`)不改写。
 * 3. **主题自己的 @layer 名加同样的前缀**:塞不进宿主的 `forsion-guard` 层。
 * 4. **`@import` 一律删**:外部样式绕过上面所有处理(`@import … layer(forsion-guard)` 能直接进宿主的护栏层)。
 *    主题要谷歌字体走 theme.json 的 `fonts.google`(宿主自己加载)。
 * 结构按 CSS Syntax 3 的读法(§5「consume a stylesheet / block's contents / declaration / qualified rule」):
 *    顶层只有规则,声明只在块里;声明值整段不透明(自定义属性值里的 `{…}` / `@import` 是数据);
 *    非自定义属性的值里带顶层 `{}` → 不是声明,按嵌套规则重读(`a:hover { … }`)。先按 §3.3 预处理(CR / FF → LF,NUL → U+FFFD)。
 * 5. **浏览器再读一遍(verifyGuardedCss)**:registry 拿收口后的文本让浏览器自己解析(和真正应用它的是同一个解析器),
 *    还剩动效 token / 宿主层名 / 没前缀的关键帧,整套主题的样式就不加载 —— 解析器以后再有没想到的写法,也是关着失败。
 * 不管的:主题直接在宿主元素上写 transition / animation 属性(和改任何样子一样,属于主题的地盘);
 * 系统「减少动态效果」照样压过它们 —— 那条规则在 base.css 的 @layer forsion-guard 里,这一层由 styles/layers.css 最先声明,
 * 层内 !important 压过任何不分层的 !important。
 * guardThemeCss 是纯函数,无 DOM 依赖(vitest:motionGuard.test.ts);verifyGuardedCss 要浏览器(真 Electron:npm run check:motiontheme)。
 */

/** 宿主的动效 token。motionGuard.test.ts 扫宿主全部样式表(desktop / lcl / mobile):值是时长、缓动或引用动效 token 的变量,
 *  名字必须在这里 —— 新加一个动效 token 忘了登记,测试就红。 */
export const MOTION_TOKEN_RE = new RegExp('^--(?:' + [
  'duration-[a-z]+', 'dur-[a-z]+', 'ease-[a-z-]+',
  'menu-(?:enter|exit)-(?:duration|ease)', 'palette-enter-duration',
  'droplet-duration', 'stretch-open-duration',
  'collapse-(?:duration|ease)',
  'tip-(?:delay|handoff|enter|exit)', 'hovercard-(?:delay|enter|exit)',
  'press-(?:travel|recoil)-duration', 'flash-duration', 'roll-(?:enter|exit)-duration', 'reader-(?:step|close)-duration',
  'canvas-switch-[a-z-]+',
  '(?:switch|seg)-edge-(?:duration|lag)',
  'pill-select-duration', 'pill-size-motion',
  'toast-(?:enter|exit)-duration', 'draw-duration', 'land-duration',
  'view-enter-duration', 'frame-reveal-duration',
  'mb-(?:dur|ease)', 'lcl-land', 'lcl-drop-(?:in|out|ease|enter|leave|fade)', 'space-ease', 'reset-stagger',
].join('|') + ')$')

export const isMotionToken = (name: string): boolean => MOTION_TOKEN_RE.test(name)

export interface MotionGuardReport {
  /** 被删掉的动效 token(去重,按出现顺序) */
  tokens: string[]
  /** 被删掉的 @import(原样的前导部分) */
  imports: string[]
  /** 加了前缀的主题关键帧名(原名) */
  keyframes: string[]
}

// ── tokenizer(CSS Syntax 3 的子集,够分清声明 / 规则 / 字符串 / 转义就行) ──────────────────────────────
type TokType = 'ws' | 'comment' | 'string' | 'badstring' | 'ident' | 'function' | 'at' | 'hash' | 'number' | 'url' | 'delim' | 'cdo' | 'cdc' | '{' | '}' | '(' | ')' | '[' | ']' | ';' | ':' | ','
interface Tok { type: TokType; start: number; end: number; value: string }

const isName = (c: string): boolean => /[A-Za-z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80
const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80
const isHex = (c: string): boolean => /[0-9a-fA-F]/.test(c)
const validEscape = (s: string, i: number): boolean => s[i] === '\\' && i + 1 < s.length && s[i + 1] !== '\n'
/** CSS Syntax 3 §3.3 预处理:CR / CRLF / FF → LF,NUL → U+FFFD(浏览器先做这一步再切 token;不做的话 `\64<CR>` 这类转义会对不上)。 */
const preprocess = (s: string): string => s.replace(/\r\n?|\f/g, '\n').replace(/\0/g, '\uFFFD')

function tokenize(s: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  /** 从 i 读一个转义(i 指着反斜杠),返回 [字符, 结束下标] */
  const escape = (j: number): [string, number] => {
    j++
    if (isHex(s[j])) {
      let h = ''
      while (h.length < 6 && j < s.length && isHex(s[j])) h += s[j++]
      if (/[ \t\n]/.test(s[j] ?? '')) j++
      const cp = parseInt(h, 16)
      return [cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp), j]
    }
    return [s[j] ?? '�', j + 1]
  }
  const name = (j: number): [string, number] => {
    let v = ''
    while (j < s.length) {
      if (isName(s[j])) v += s[j++]
      else if (validEscape(s, j)) { const [c, k] = escape(j); v += c; j = k }
      else break
    }
    return [v, j]
  }
  const identStarts = (j: number): boolean => {
    if (s[j] === '-') return isNameStart(s[j + 1] ?? '') || s[j + 1] === '-' || validEscape(s, j + 1)
    return isNameStart(s[j] ?? '') || validEscape(s, j)
  }
  const push = (type: TokType, start: number, end: number, value = ''): void => { out.push({ type, start, end, value }) }
  while (i < s.length) {
    const c = s[i], st = i
    if (/[ \t\n]/.test(c)) { while (i < s.length && /[ \t\n]/.test(s[i])) i++; push('ws', st, i); continue }
    if (c === '<' && s.startsWith('!--', i + 1)) { i += 4; push('cdo', st, i); continue }
    if (c === '-' && s.startsWith('->', i + 1)) { i += 3; push('cdc', st, i); continue }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; push('comment', st, i); continue }
    if (c === '"' || c === "'") {
      let v = ''
      i++
      while (i < s.length && s[i] !== c && s[i] !== '\n') {
        if (s[i] === '\\') { if (s[i + 1] === '\n') { i += 2; continue } const [ch, k] = escape(i); v += ch; i = k } else v += s[i++]
      }
      // 遇到换行没收尾 = bad-string(规范 §4.3.5):不是合法的名字,原样留着
      if (s[i] === c) { i++; push('string', st, i, v) } else push(i < s.length ? 'badstring' : 'string', st, i, v)
      continue
    }
    if (c === '@' && identStarts(i + 1)) { const [v, j] = name(i + 1); i = j; push('at', st, i, v); continue }
    if (c === '#' && i + 1 < s.length && (isName(s[i + 1]) || validEscape(s, i + 1))) { const [v, j] = name(i + 1); i = j; push('hash', st, i, v); continue }
    if (/[0-9]/.test(c) || ((c === '.' || c === '+' || c === '-') && /[0-9]/.test(s[i + 1] ?? '')) || ((c === '+' || c === '-') && s[i + 1] === '.' && /[0-9]/.test(s[i + 2] ?? ''))) {
      if (c === '+' || c === '-') i++
      while (/[0-9]/.test(s[i] ?? '')) i++
      if (s[i] === '.' && /[0-9]/.test(s[i + 1] ?? '')) { i++; while (/[0-9]/.test(s[i] ?? '')) i++ }
      if (/[eE]/.test(s[i] ?? '') && (/[0-9]/.test(s[i + 1] ?? '') || (/[+-]/.test(s[i + 1] ?? '') && /[0-9]/.test(s[i + 2] ?? '')))) {
        i += /[+-]/.test(s[i + 1]) ? 2 : 1
        while (/[0-9]/.test(s[i] ?? '')) i++
      }
      // value = 单位(小写):'' 纯数字、'%'、'ms' / 's' …
      if (s[i] === '%') { i++; push('number', st, i, '%') } else if (identStarts(i)) { const [u, j] = name(i); i = j; push('number', st, i, u.toLowerCase()) } else push('number', st, i, '')
      continue
    }
    if (identStarts(i)) {
      const [v, j] = name(i)
      i = j
      if (s[i] === '(') {
        let q = i + 1
        while (/[ \t\n]/.test(s[q] ?? '')) q++
        if (v.toLowerCase() === 'url' && s[q] !== '"' && s[q] !== "'") { // 不带引号的 url(…):整段一个 token(空白不限长)
          i++
          while (i < s.length && s[i] !== ')') i += validEscape(s, i) ? 2 : 1
          i = Math.min(s.length, i + 1)
          push('url', st, i, v)
        } else { i++; push('function', st, i, v) }
        continue
      }
      push('ident', st, i, v)
      continue
    }
    if (c === '\\' && !validEscape(s, i)) { i++; push('delim', st, i, c); continue }
    if ('{}()[];:,'.includes(c)) { i++; push(c as TokType, st, i, c); continue }
    i++
    push('delim', st, i, c)
  }
  return out
}

// ── 结构(CSS Syntax 3 §5,只记位置) ────────────────────────────────────────────────────────────────
interface Decl { name: string; nameIdx: number; vStart: number; vEnd: number; end: number }
interface AtRule { name: string; idx: number; pStart: number; pEnd: number; end: number; block: boolean }
const CLOSER: Partial<Record<TokType, TokType>> = { '{': '}', '(': ')', '[': ']', function: ')' }
/** 顶层时块里是规则表的分组规则 */
const RULE_LIST_AT = new Set(['media', 'supports', 'layer', 'container', 'scope', 'starting-style', 'document', '-moz-document'])

function structure(T: Tok[]): { decls: Decl[]; ats: AtRule[] } {
  const N = T.length
  const decls: Decl[] = [], ats: AtRule[] = []
  const quiet = (j: number): boolean => T[j].type === 'ws' || T[j].type === 'comment'
  /** 跳过一个成分值:块 / 函数整段(只认配对的那个收尾符,别的收尾符是普通 token);返回其后的下标。迭代,不怕深嵌套。 */
  const skipCV = (j: number): number => {
    const c = CLOSER[T[j].type]
    if (!c) return j + 1
    const stack: TokType[] = [c]
    j++
    while (j < N && stack.length) {
      const t = T[j].type
      if (t === stack[stack.length - 1]) stack.pop()
      else { const c2 = CLOSER[t]; if (c2) stack.push(c2) }
      j++
    }
    return j
  }
  /** j 指着 `{`:读块里的内容(声明 + 嵌套规则),返回块后的下标。 */
  const block = (j: number): number => {
    const after = skipCV(j)
    const close = T[after - 1]?.type === '}' && after - 1 > j ? after - 1 : after
    contents(j + 1, close)
    return after
  }
  /** j 指着 `{`:块里只有规则(顶层分组规则)。 */
  const ruleListBlock = (j: number): number => {
    const after = skipCV(j)
    const close = T[after - 1]?.type === '}' && after - 1 > j ? after - 1 : after
    rules(j + 1, close)
    return after
  }
  const atRule = (j: number, end: number, nested: boolean): number => {
    const idx = j
    j++
    const pStart = j
    while (j < end) {
      const t = T[j].type
      if (t === ';') { ats.push({ name: T[idx].value, idx, pStart, pEnd: j, end: j + 1, block: false }); return j + 1 }
      if (t === '}' && nested) break
      if (t === '{') {
        // 顶层的分组规则(@media / @supports / @layer …)块里是规则表:没有声明,`--x:hover{}` 是规则不是声明(规范 §5.4.1)
        const after = !nested && RULE_LIST_AT.has(T[idx].value.toLowerCase()) ? ruleListBlock(j) : block(j)
        ats.push({ name: T[idx].value, idx, pStart, pEnd: j, end: after, block: true })
        return after
      }
      j = t === '}' ? j + 1 : skipCV(j)
    }
    ats.push({ name: T[idx].value, idx, pStart, pEnd: j, end: j, block: false })
    return j
  }
  /** 嵌套时遇到 `;` 停(规范:这不是规则,交回块内容那层跳过分号)。 */
  const qualified = (j: number, end: number, nested: boolean): number => {
    while (j < end) {
      const t = T[j].type
      if (nested && (t === ';' || t === '}')) return j
      if (t === '{') return block(j)
      j = t === '}' ? j + 1 : skipCV(j)
    }
    return end
  }
  /** 块里的一条声明;不是声明返回 null(调用方按嵌套规则重读)。值整段不透明。 */
  const declaration = (j: number, end: number): number | null => {
    if (T[j].type !== 'ident') return null
    const nameIdx = j
    let k = j + 1
    while (k < end && quiet(k)) k++
    if (k >= end || T[k].type !== ':') return null
    k++
    const vStart = k
    let topBlock = false, other = false
    while (k < end && T[k].type !== ';') {
      if (T[k].type === '{') topBlock = true
      else if (!quiet(k)) other = true
      k = skipCV(k)
    }
    if (k > end) k = end
    const name = T[nameIdx].value
    if (!name.startsWith('--') && topBlock && other) return null
    const semi = k < end && T[k].type === ';'
    decls.push({ name, nameIdx, vStart, vEnd: k, end: semi ? k + 1 : k })
    return semi ? k + 1 : k
  }
  const contents = (j: number, end: number): void => {
    while (j < end) {
      const t = T[j].type
      if (quiet(j) || t === ';') { j++; continue }
      if (t === 'at') { j = atRule(j, end, true); continue }
      const d = declaration(j, end)
      if (d !== null) { j = d; continue }
      const nj = qualified(j, end, true)
      j = nj > j ? nj : j + 1
    }
  }
  /** 规则表(顶层与顶层分组规则的块):只有规则,没有声明;CDO / CDC 跳过。 */
  function rules(j: number, end: number): void {
    while (j < end) {
      const t = T[j].type
      if (quiet(j) || t === 'cdo' || t === 'cdc') { j++; continue }
      if (t === 'at') { j = atRule(j, end, false); continue }
      const nj = qualified(j, end, false)
      j = nj > j ? nj : j + 1
    }
  }
  rules(0, N)
  return { decls, ats }
}

// ── 改写 ─────────────────────────────────────────────────────────────────────────────────────────
const safeId = (id: string): string => id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
/** 主题的关键帧 / 层名前缀(registry 的二次检查用同一个) */
export const themePrefix = (themeId: string): string => `t-${safeId(themeId)}-`
/** 序列化成 CSS 标识符(前缀以 t- 开头,不会出现首位是数字的情况) */
const asIdent = (v: string): string => Array.from(v).map((ch) => (/[A-Za-z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0x80 ? ch : `\\${ch.codePointAt(0)!.toString(16)} `)).join('')
const asString = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`

/** 简写 animation 里的关键字:简写里出现这些词一律当关键字,不当关键帧名改写 */
const ANIM_KEYWORDS = new Set([
  'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end',
  'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse',
  'none', 'forwards', 'backwards', 'both', 'running', 'paused', 'auto',
])
/** 不能当 <custom-ident> 关键帧名的词(规则本身无效,浏览器丢掉,这里不碰) */
const NOT_A_NAME = new Set(['none', 'default', 'initial', 'inherit', 'unset', 'revert', 'revert-layer'])
const ANIM_PROPS = new Set(['animation', '-webkit-animation', '-moz-animation', '-o-animation'])
const ANIM_NAME_PROPS = new Set(['animation-name', '-webkit-animation-name', '-moz-animation-name', '-o-animation-name'])
const KEYFRAMES = new Set(['keyframes', '-webkit-keyframes', '-moz-keyframes', '-o-keyframes'])
const SUBSTITUTE = new Set(['var', 'env', 'attr'])

export function guardThemeCss(source: string, themeId: string): { css: string; report: MotionGuardReport } {
  const src = preprocess(source)
  const prefix = themePrefix(themeId)
  const T = tokenize(src)
  const { decls, ats } = structure(T)
  const tokens: string[] = []
  const note = (name: string): void => { if (!tokens.includes(name)) tokens.push(name) }
  const imports: string[] = []
  /** [start, end, 替换文本] */
  const edits: Array<[number, number, string]> = []
  const firstSig = (a: number, b: number): Tok | null => { for (let j = a; j < b; j++) if (T[j].type !== 'ws' && T[j].type !== 'comment') return T[j]; return null }
  const prevSig = (k: number): Tok | null => { for (let j = k - 1; j >= 0; j--) if (T[j].type !== 'ws' && T[j].type !== 'comment') return T[j]; return null }
  const del = (fromIdx: number, toExcl: number): void => { if (toExcl > fromIdx) edits.push([T[fromIdx].start, T[toExcl - 1].end, '']) }

  // at 规则(只认规则位置上的;声明值里的 @keyframes / @import 是数据)
  const defined = new Set<string>()
  for (const a of ats) {
    const at = a.name.toLowerCase()
    const n = firstSig(a.pStart, a.pEnd)
    if (at === 'import') { del(a.idx, a.end); imports.push(src.slice(T[a.pStart]?.start ?? T[a.idx].end, T[a.pEnd - 1]?.end ?? T[a.idx].end).trim()); continue }
    if (at === 'property' && n?.type === 'ident' && isMotionToken(n.value)) { del(a.idx, a.end); note(n.value); continue }
    if (KEYFRAMES.has(at) && a.block && n && (n.type === 'string' || (n.type === 'ident' && !NOT_A_NAME.has(n.value.toLowerCase())))) {
      defined.add(n.value)
      edits.push([n.start, n.end, n.type === 'string' ? asString(prefix + n.value) : asIdent(prefix + n.value)])
      continue
    }
    if (at === 'layer') { // `@layer a, b.c;` / `@layer a {`:名字加前缀;匿名层不动
      for (let j = a.pStart; j < a.pEnd; j++) if (T[j].type === 'ident') edits.push([T[j].start, T[j].end, asIdent(prefix + T[j].value)])
    }
  }

  for (const d of decls) {
    // 1. 动效 token 的声明:整条删(含后面的分号);关键帧块里的也删
    if (d.name.startsWith('--')) {
      if (isMotionToken(d.name)) { del(d.nameIdx, d.end); note(d.name) }
      continue
    }
    // 2. 主题自己的 animation / animation-name 里引用自己定义的关键帧(值里有 var() 这类替换的整条不碰)
    const lp = d.name.toLowerCase()
    const shorthand = ANIM_PROPS.has(lp)
    if (!defined.size || (!shorthand && !ANIM_NAME_PROPS.has(lp))) continue
    let substituted = false
    for (let j = d.vStart; j < d.vEnd; j++) if (T[j].type === 'function' && SUBSTITUTE.has(T[j].value.toLowerCase())) substituted = true
    if (substituted) continue
    let depth = 0
    for (let j = d.vStart; j < d.vEnd; j++) {
      const v = T[j]
      if (CLOSER[v.type]) { depth++; continue }
      if (v.type === ')' || v.type === ']' || v.type === '}') { depth = Math.max(0, depth - 1); continue }
      if (depth > 0 || !defined.has(v.value)) continue
      if (v.type === 'ident' && prevSig(j)?.type === 'delim' && prevSig(j)?.value === '!') continue // !important
      if (v.type === 'string') edits.push([v.start, v.end, asString(prefix + v.value)])
      else if (v.type === 'ident' && !NOT_A_NAME.has(v.value.toLowerCase()) && !(shorthand && ANIM_KEYWORDS.has(v.value.toLowerCase()))) edits.push([v.start, v.end, asIdent(prefix + v.value)])
    }
  }

  edits.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  let css = ''
  let at = 0
  for (const [s0, e0, text] of edits) {
    if (s0 < at) continue
    css += src.slice(at, s0) + text
    at = e0
  }
  css += src.slice(at)
  return { css, report: { tokens, imports, keyframes: [...defined] } }
}

/** 浏览器再读一遍收口后的文本(和真正应用它的是同一个解析器),返回还漏着的东西;空数组 = 过。
 *  registry 据此决定这套主题的样式加不加载(关着失败)。没有 DOM(vitest 的 node 环境)时返回空。
 *  在一份不挂窗口的文档里用 <style> 读(不用 replaceSync:那个会悄悄丢掉 @import,闸门就看不到它了);
 *  没有浏览上下文的文档不去取 @import 的地址。 */
export function verifyGuardedCss(css: string, themeId: string): string[] {
  if (typeof document === 'undefined' || typeof CSSStyleSheet === 'undefined') return []
  const prefix = themePrefix(themeId)
  const bad: string[] = []
  let sheet: CSSStyleSheet | null = null
  try {
    const doc = document.implementation.createHTMLDocument('')
    const el = doc.createElement('style')
    el.textContent = css
    doc.head.appendChild(el)
    sheet = el.sheet
  } catch { sheet = null }
  if (!sheet) return ['(parse)']
  // 层名以前缀开头即可(嵌套的子层名在它下面,宿主的 forsion-guard 是顶层名);名字里转义的点不拆
  const ours = (name: string): boolean => name.startsWith(prefix)
  const walk = (rules: CSSRuleList | undefined, depth: number): void => {
    if (!rules || depth > 64) { if (rules) bad.push('(depth)'); return }
    for (const r of Array.from(rules)) {
      if (typeof CSSImportRule !== 'undefined' && r instanceof CSSImportRule) bad.push('@import')
      if (typeof CSSLayerStatementRule !== 'undefined' && r instanceof CSSLayerStatementRule) for (const n of r.nameList) { if (!ours(n)) bad.push(`@layer ${n}`) }
      if (typeof CSSLayerBlockRule !== 'undefined' && r instanceof CSSLayerBlockRule && r.name && !ours(r.name)) bad.push(`@layer ${r.name}`)
      if (typeof CSSKeyframesRule !== 'undefined' && r instanceof CSSKeyframesRule && !r.name.startsWith(prefix)) bad.push(`@keyframes ${r.name}`)
      if (typeof CSSPropertyRule !== 'undefined' && r instanceof CSSPropertyRule && isMotionToken(r.name)) bad.push(`@property ${r.name}`)
      const st = (r as Partial<CSSStyleRule>).style
      if (st) for (let i = 0; i < st.length; i++) if (isMotionToken(st[i])) bad.push(st[i])
      walk((r as Partial<CSSGroupingRule>).cssRules, depth + 1)
    }
  }
  walk(sheet.cssRules, 0)
  return bad
}
