/**
 * U-32:把界面 zh 词条里紧挨汉字的半角标点换成全角(, ; : ? ! ( ) → ，；：？！（）)。
 * 正典:docs/ToBeImproved/UIUX评审_2026-09-25.md U-32;规则见 genesis-ui skill「中文标点」;
 * 守门的是 frontend/src/i18nCoverage.test.ts 断言 E(本脚本跑过后改成硬断言)。
 *
 * **幂等**:跑第二遍零改动。别的分支合进来又带回半角,合完重跑一遍即可(冲突也照此解:任取一边 → 重跑)。
 *
 * 改哪些字面量:
 *   - frontend/src/i18n.tsx 的 `const zh: Dict = {` 块里每个键的值
 *   - 其余 frontend/src 与 lcl/engine 源码(不含测试)里 `zh: '…'` / `"zh": "…"` 形态的值(registerMessages 片段、
 *     i18n.generated.ts、engineMessages、就地的 { zh, en } 标签表)
 * 不改:
 *   - `amadeus.default.*`:落盘产物命名,改了就和老文件名对不上
 *   - {var}、反引号代码、URL、路径、快捷键、HH:mm、`![[` 里的标点(与断言 E 的 strip 同一套)
 * 括号成对处理:一对 () 里有汉字或紧挨汉字,两边一起换;不成对的单个括号只看是否紧挨汉字。
 * 全角标点自带间距,换完顺手去掉它外侧的空格。
 *
 * 跑法:node scripts/zh-punct.codemod.cjs [--check | --selftest](--check 只报数不写,有待改项退出码 1;--selftest 跑规则自检)
 * 输出:改了的键 + 原值 → 新值,落 SHOT_DIR 或临时目录的 zh-punct-changes.json(给改台架 / 测试里的旧文案用)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'frontend/src')
const LCL = path.join(ROOT, '../lcl/engine')
const CHECK = process.argv.includes('--check')
const SKIP_KEY = /^amadeus\.default\./

const CJK = /[一-龥「」『』《》“”（）]/
const MAP = { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！', '(': '（', ')': '）' }
const PROTECT = [
  /\{\w+\}/g, /`[^`]*`/g, /https?:\/\/\S+/g, /(?:~|\.{1,2})?\/[\w./*~-]+/g,
  /(?:⌘|Ctrl|Cmd|Shift|Alt|Option|Meta)[+\w⇧⌥⌘,.]*/g, /\d{1,2}:\d{2}/g, /!\[\[?/g, /\\[nrtu]/g,
  /!?\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, // Markdown 链接 / 图片的语法括号(目标里允许一层括号):[文字](路径) 换成全角就不是链接了
]

/** 返回换过标点的文本(raw 源码字面量内容,转义序列原样保留)。 */
function fix(raw) {
  const locked = new Array(raw.length).fill(false)
  for (const re of PROTECT) for (const m of raw.matchAll(re)) for (let i = m.index; i < m.index + m[0].length; i++) locked[i] = true
  const out = raw.split('')
  const han = (i) => i >= 0 && i < raw.length && CJK.test(out[i]) // 看 out:刚换成全角的括号也算中文语境
  // 括号配对(跳过锁定区)
  const stack = []
  const pairs = []
  for (let i = 0; i < raw.length; i++) {
    if (locked[i]) continue
    if (raw[i] === '(') stack.push(i)
    else if (raw[i] === ')') pairs.push([stack.length ? stack.pop() : -1, i])
  }
  for (const o of stack) pairs.push([o, -1])
  // 外层先定:内层括号紧挨的是外层括号,外层先换成全角,内层这一遍就能看见 —— 否则第二遍才换,脚本不幂等。
  pairs.sort((x, y) => (x[0] < 0 ? x[1] : x[0]) - (y[0] < 0 ? y[1] : y[0]))
  for (const [o, c] of pairs) {
    const inner = o >= 0 && c >= 0 ? raw.slice(o + 1, c) : ''
    const go = /[一-龥]/.test(inner) || (o >= 0 && (han(o - 1) || (c < 0 && han(o + 1)))) || (c >= 0 && (han(c + 1) || (o < 0 && han(c - 1))))
    if (!go) continue
    if (o >= 0) out[o] = MAP['(']
    if (c >= 0) out[c] = MAP[')']
  }
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (locked[i] || !',;:?!'.includes(ch)) continue
    // 前一个非空白字符是汉字,或后面紧跟汉字 → 换。连写的「?!」跟着前一个一起换。
    let p = i - 1
    while (p >= 0 && raw[p] === ' ') p--
    if (han(p) || han(i + 1) || ('?!'.includes(ch) && p >= 0 && '？！'.includes(out[p]))) out[i] = MAP[ch]
  }
  // 全角标点自带间距:只删**本次换过**的标点外侧的空格(「（」前、其余后),锁定区里的一个不碰。
  const drop = new Array(raw.length).fill(false)
  const blank = (j) => j >= 0 && j < raw.length && (raw[j] === ' ' || raw[j] === '\t') && !locked[j]
  for (let i = 0; i < raw.length; i++) {
    if (out[i] === raw[i]) continue
    if (out[i] === '（') { for (let j = i - 1; blank(j); j--) drop[j] = true; continue }
    for (let j = i + 1; blank(j); j++) drop[j] = true
    if (out[i] !== '）') for (let j = i - 1; blank(j); j--) drop[j] = true
  }
  let s = ''
  for (let i = 0; i < out.length; i++) if (!drop[i]) s += out[i]
  return s
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__snapshots__') walk(p, acc) }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p)
  }
  return acc
}

/** 字符串字面量;n = 引号所在的捕获组号(反向引用要跟着组号走)。 */
const LIT = (n) => `(['"])((?:\\\\.|(?!\\${n})[^\\\\\\n])*)\\${n}`
const KEYED = new RegExp(String.raw`^(\s*(['"])([\w.:-]+)\2\s*:\s*)` + LIT(4), 'gm') // i18n.tsx zh 块:'key': 'value'
const ZHPROP = new RegExp(String.raw`((?:\bzh|"zh"|'zh')\s*:\s*)` + LIT(2), 'g') // 其余:zh: 'value'

function main() {
  const changes = []
  let files = 0
  for (const file of [...walk(SRC), ...walk(LCL)]) {
    const text = fs.readFileSync(file, 'utf8')
    let next = text
    const rel = path.relative(ROOT, file)
    if (file === path.join(SRC, 'i18n.tsx')) {
      const a = text.indexOf('const zh: Dict = {')
      const b = text.indexOf('const en: Dict = {')
      if (a < 0 || b < a) throw new Error('i18n.tsx 的 zh / en 块标记找不到了 —— 先来改本脚本')
      const block = text.slice(a, b).replace(KEYED, (m, head, _q, key, q, val) => {
        if (SKIP_KEY.test(key)) return m
        const v = fix(val)
        if (v !== val) changes.push({ file: rel, key, from: val, to: v })
        return head + q + v + q
      })
      next = text.slice(0, a) + block + text.slice(b)
    } else {
      // 找所属键:往前最近的 'key': { 或 "key": {
      next = text.replace(ZHPROP, (m, head, q, val, offset) => {
        const before = text.slice(Math.max(0, offset - 400), offset)
        const km = [...before.matchAll(/(['"])([\w.:-]+)\1\s*:\s*\{/g)].pop()
        const key = km ? km[2] : '?'
        if (SKIP_KEY.test(key)) return m
        const v = fix(val)
        if (v !== val) changes.push({ file: rel, key, from: val, to: v })
        return head + q + v + q
      })
    }
    if (next !== text) { files++; if (!CHECK) fs.writeFileSync(file, next) }
  }

  const out = path.join(process.env.SHOT_DIR || os.tmpdir(), 'zh-punct-changes.json')
  fs.writeFileSync(out, JSON.stringify(changes, null, 1))
  console.log(`${CHECK ? '待改' : '已改'} ${changes.length} 条 / ${files} 个文件 → 明细 ${out}`)
  if (CHECK && changes.length) process.exitCode = 1

}

/** 自检:node scripts/zh-punct.codemod.cjs --selftest(每条都要一遍即对、第二遍零改动)。 */
function selftest() {
  const cases = [
    ['会话(旧)', '会话（旧）'], ['输入消息(Enter 发送, Shift+Enter 换行)', '输入消息（Enter 发送，Shift+Enter 换行）'],
    ['删除「{name}」?', '删除「{name}」？'], ['失败: {error}', '失败：{error}'], ['时间 12:30 开始', '时间 12:30 开始'],
    ['打开 https://a.b/c?x=1 看看', '打开 https://a.b/c?x=1 看看'], ['自定义(config.json)', '自定义（config.json）'],
    ['用 `a,b` 分隔', '用 `a,b` 分隔'], ['真的吗?!', '真的吗？！'], ['Token: abc', 'Token: abc'], ['按 ⌘, 打开', '按 ⌘, 打开'],
    ['插入![[文件]]', '插入![[文件]]'], ['路径 ~/a/b:c', '路径 ~/a/b:c'], ['汉((A))', '汉（（A））'],
    ['关闭:插入 [文件名](相对路径) 链接。', '关闭：插入 [文件名](相对路径) 链接。'],
    ['见 [文件](目录(子目录))中文', '见 [文件](目录(子目录))中文'],
    ['说明 `/中文， a.md` 看', '说明 `/中文， a.md` 看'], ['拿不到(与 A 同样),X11', '拿不到（与 A 同样），X11'],
  ]
  const bad = cases.filter(([i, o]) => fix(i) !== o || fix(o) !== o)
  for (const [i, o] of bad) console.log(`✗ ${i} → ${fix(i)}(期望 ${o})`)
  console.log(bad.length ? `${bad.length} 条不对` : `自检 ${cases.length} 条全对`)
  if (bad.length) process.exitCode = 1
}

if (require.main === module) { if (process.argv.includes('--selftest')) selftest(); else main() }
module.exports = { fix }
