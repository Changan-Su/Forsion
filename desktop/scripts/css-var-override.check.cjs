#!/usr/bin/env node
/**
 * 「断点里的简写把带变量的基础规则吃掉了」扫描器(check:cssvar)。
 *
 * 病的形状(2026-08-14 实证,用户报「窄栏最底下的消息总有一截到不了 chatbox 上面」):
 *   .t2-stream-inner              { padding: 28px 28px calc(var(--t2-composer-h) + 8px); }
 *   @container (max-width:520px) { .t2-stream-inner { padding: 20px 12px 6px; } }   ← 抹掉了 calc
 * 变量对、量高的 ResizeObserver 对、基础规则也对,**只有窄栏犯病**;typecheck、单测、
 * 类型系统全看不见,因为这不是错误,是「后一条合法地覆盖了前一条」。
 *
 * 判据(刻意只抓这一种形状,别扩):同一份文件里、**字面完全相同的选择器**,
 * 先声明过含 `var(--x)` 的属性 P,后面又声明 P(通常在 @media/@container 里)且新值不含 `var(--x)`
 * —— 那个 var 就此丢失。同名长写/简写视作同一属性(padding-bottom ⊂ padding)。
 *
 * 刻意不做:
 *   · 不解析选择器语义(`.a .b` 与 `.b` 的覆盖关系不管)—— 那要真 CSS 引擎,且噪声远大于信号。
 *   · 不判特异性 —— 同名选择器已经足够覆盖真实事故形状。
 *   · **不阻断构建**(用户 08-14 定的):存量里合法的简写覆盖不少,先当报告用。
 *     要接门禁,先把存量清了或在 ALLOW 里列白名单。
 *
 * 用法:npm run check:cssvar        退出码恒 0(报告式)
 *      npm run check:cssvar -- --strict   有发现则退出码 1(想接 CI 时用)
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIRS = [path.join(ROOT, 'frontend/src'), path.join(ROOT, '../lcl')]

/** 简写 → 它**真正**会重置的长写。别用「前缀一刀切」:`border` 不重置 `border-radius`
 * (第一版就是这么误报的),`inset` 反过来要吃 top/right/bottom/left(没有共同前缀)。 */
const SHORTHAND = {
  padding: /^padding-(top|right|bottom|left|inline|block)/,
  margin: /^margin-(top|right|bottom|left|inline|block)/,
  border: /^border-(width|style|color|top|right|bottom|left|inline|block|image)/,
  'border-radius': /-radius$/,
  background: /^background-/,
  font: /^font-/,
  inset: /^(top|right|bottom|left|inset-)/,
  overflow: /^overflow-/,
  transition: /^transition-/,
  animation: /^animation-/,
  mask: /^mask-/,
  flex: /^flex-(grow|shrink|basis)$/,
  gap: /^(row|column)-gap$/,
}

/** 这些上下文里的「重置」是设计意图,不是事故:降级动效、进场起手值。 */
const DELIBERATE = /prefers-reduced-motion|@starting-style/
/** @keyframes 里的关键帧步(from/to/50%)不是选择器,语义也不是「覆盖」——整块跳过。 */
const SKIP_AT = /@keyframes/

/** a 声明的属性是否覆盖 b 声明的属性(同名,或 a 是 b 的简写)。 */
function covers(a, b) {
  if (a === b) return true
  const re = SHORTHAND[a]
  return !!re && re.test(b)
}

const VAR_RE = /var\(\s*(--[a-zA-Z0-9_-]+)/g

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.css')) out.push(p)
  }
  return out
}

/** 极简 CSS 扫描:只要「选择器 + 声明 + 行号 + 是否在 @media/@container 里」,不建 AST。 */
function declsOf(css) {
  const out = []
  let i = 0
  let line = 1
  const stack = [] // { sel, at }
  let buf = ''
  const bump = (s) => { for (const ch of s) if (ch === '\n') line++ }
  while (i < css.length) {
    const ch = css[i]
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      const seg = css.slice(i, end < 0 ? css.length : end + 2)
      bump(seg); i += seg.length; continue
    }
    if (ch === '{') {
      const sel = buf.trim().replace(/\s+/g, ' ')
      stack.push({ sel, at: sel.startsWith('@'), line })
      buf = ''; i++; continue
    }
    if (ch === '}') {
      stack.pop(); buf = ''; i++; continue
    }
    if (ch === ';') {
      const top = stack[stack.length - 1]
      const d = buf.trim()
      const m = /^([-a-zA-Z]+)\s*:\s*([\s\S]+)$/.exec(d)
      if (top && !top.at && m) {
        const at = stack.slice(0, -1).filter((s) => s.at).map((s) => s.sel).join(' ')
        out.push({ sel: top.sel, prop: m[1].toLowerCase(), value: m[2], line, at })
      }
      buf = ''; i++; continue
    }
    buf += ch
    if (ch === '\n') line++
    i++
  }
  return out
}

const findings = []
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue
  for (const file of walk(dir)) {
    const decls = declsOf(fs.readFileSync(file, 'utf8'))
    // 按选择器分组,保序
    const bySel = new Map()
    for (const d of decls) {
      if (!bySel.has(d.sel)) bySel.set(d.sel, [])
      bySel.get(d.sel).push(d)
    }
    for (const [sel, list] of bySel) {
      for (let k = 0; k < list.length; k++) {
        const later = list[k]
        for (let j = 0; j < k; j++) {
          const earlier = list[j]
          if (!covers(later.prop, earlier.prop)) continue
          if (DELIBERATE.test(later.at)) continue
          if (SKIP_AT.test(later.at) || SKIP_AT.test(earlier.at)) continue
          const vars = [...earlier.value.matchAll(VAR_RE)].map((m) => m[1])
          if (!vars.length) continue
          const lost = vars.filter((v) => !later.value.includes(v))
          if (!lost.length) continue
          findings.push({
            file: path.relative(ROOT, file),
            sel,
            lost,
            earlier: `${earlier.line}: ${earlier.prop}: ${earlier.value.trim().slice(0, 70)}`,
            later: `${later.line}: ${later.prop}: ${later.value.trim().slice(0, 70)}${later.at ? '   [' + later.at + ']' : ''}`,
          })
        }
      }
    }
  }
}

for (const f of findings) {
  console.log(`\n${f.file}  ${f.sel}`)
  console.log(`  丢失 ${f.lost.join(', ')}`)
  console.log(`  先  ${f.earlier}`)
  console.log(`  后  ${f.later}`)
}
console.log(findings.length ? `\n${findings.length} 处「后面的声明把前面的 var() 抹掉了」——逐条确认是不是故意的` : '\n未发现简写吃掉变量的覆盖')
process.exit(process.argv.includes('--strict') && findings.length ? 1 : 0)
