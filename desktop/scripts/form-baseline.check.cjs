/**
 * 表单控件基线的**层叠**契约(base.css 文件头那两块 `:where(…)`)。
 *
 * 病因:全仓有一大批 <input>/<select>/<textarea> 既没有 className 也不在 .field 里,于是掉回
 * Chromium 默认的方角灰框 —— 用户实报「设置里还有这种很原始、跟整体 UI 不搭的输入框」。
 * 修法是一条零特异性基线,而不是逐处补 class。基线有两个会静默出事的方向:
 *
 *  A 裸控件确实拿到主题外观(圆角 + 主题描边 + 卡面底),明暗两态都不是浏览器默认。
 *  B ⚠️ 负对照 ——「外壳画框、内部裸输入」的控件(搜索框、聊天输入区…)**一个像素都不许动**。
 *    它们写了 border:0;background:transparent 却从没写 padding,基线的 `padding:7px 10px`
 *    会把那行字整体顶开。base.css 里紧跟基线的归零块负责兜住,本组逐条比对「有基线 / 无基线」
 *    的 computed 值必须**完全一致**。基线特异性爬高、归零块被挪到基线上方,这组都会红。
 *  C 完整性:CSS 里任何**新出现的**「壳画框、内部裸输入」规则都必须登记进归零块,
 *    否则下一个搜索框会悄悄多出 7px/10px 内距。静态扫全部 CSS,不靠人记。
 *  D 勾选框 / 单选 / 滑杆 / 文件选择不在基线内(给它们塞 padding+边框会变形)。
 *
 * 改 base.css 的表单基线、或新增「壳画框、内部裸输入」的搜索框后必跑:
 *   node scripts/form-baseline.check.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SRC = path.join(__dirname, '../frontend/src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')
// 真源:base.css + 所有会给表单控件上样式的视图/主题 CSS(壳画框那批散在这些文件里)。
const FILES = [
  'styles/base.css', 'amadeus-host.css', 'quickFind.css', 'amadeus/styles.css',
  'amadeus/theme/lcl/tangu.css', 'amadeus/theme/lcl/tanguSoft.css',
  'views/chat2/chat2.css', 'views/chat2/composer2.css', 'views/chat2/sidebar2.css',
  'views/automation/automation.css', 'views/dashData.css', 'views/homepage.css',
]
const BASE = read('styles/base.css')
// 基线两块合起来抽出来 —— A/B 就是「把这段插进去 / 拿掉」。
const BL_START = BASE.indexOf('/* form-baseline:start')
const BL_END = BASE.indexOf('/* form-baseline:end */')
function die(msg) { console.log(`FAIL  ${msg}`); process.exit(1) }
if (BL_START < 0 || BL_END < BL_START) die('base.css 里找不到 form-baseline:start/end 这对标记(整块被删或被改写了)')
const BASELINE = BASE.slice(BL_START, BL_END)
const CSS_NO_BASELINE = FILES.map(read).join('\n').replace(BASELINE, '')

/** 归零块登记的选择器(= B 组探针,也是 C 组的白名单)。 */
const NAKED = (BASELINE.match(/:where\(([^)]*)\)\s*\{\s*padding:\s*0;/) || [, ''])[1]
  .split(',').map((s) => s.trim()).filter(Boolean)
if (!NAKED.length) die('base.css 里找不到「壳画框、内部裸输入」的归零块(`:where(…) { padding: 0; … }`)')

/** 代表性的裸控件语境(A 组):设置面板里的行内行、.field、以及完全裸的几种 type。 */
const BOXED = [
  '.settings-inline-row > input', '.settings-inline-row > select',
  '.field input[type="text"]', '.field textarea', '.chan-row select', '.theme-opt-row select',
]

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS_NO_BASELINE}
body { margin: 0; }
</style></head><body></body></html>`

/** 按选择器现造 DOM:祖先复合选择器造 div,末段造对应的表单元素。 */
const BUILD = (sels) => {
  const strip = (c) => c.replace(/:not\([^)]*\)/g, '')
  const mk = (comp, isLast) => {
    const c = strip(comp)
    // ⚠️ 只认**开头的元素名**:`.settings-filter-input` 里也有 "input" 三个字母,
    //    用 /\binput\b/ 会把外壳造成 <input>,内层探针于是量到一堆 UA 默认值(假红)。
    const lead = (c.match(/^(input|select|textarea)\b/) || [])[1]
    let tag = lead || (isLast ? 'input' : 'div')
    const el = document.createElement(tag)
    for (const m of c.matchAll(/\.([A-Za-z0-9_-]+)/g)) el.classList.add(m[1])
    for (const m of c.matchAll(/\[([a-zA-Z-]+)=['"]?([^\]'"]+)['"]?\]/g)) el.setAttribute(m[1], m[2])
    return el
  }
  window.__probes = {}
  for (const sel of sels) {
    const comps = sel.split(/\s*>\s*|\s+/).filter(Boolean)
    let root = null, cur = null
    comps.forEach((c, i) => { const el = mk(c, i === comps.length - 1); if (!root) { root = el; cur = el } else { cur.appendChild(el); cur = el } })
    document.body.appendChild(root)
    window.__probes[sel] = cur
  }
}
const SNAP = () => Object.fromEntries(Object.entries(window.__probes).map(([k, el]) => {
  const cs = getComputedStyle(el)
  return [k, [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft,
    cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor, cs.backgroundColor, cs.borderTopLeftRadius].join('|')]
}))

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  await p.setContent(PAGE)
  await p.evaluate(BUILD, [...NAKED, ...BOXED, 'input', 'select', 'textarea',
    'input[type="checkbox"]', 'input[type="radio"]', 'input[type="range"]', 'input[type="file"]'])

  const inject = (on) => p.evaluate(({ on, css }) => {
    document.getElementById('bl')?.remove()
    if (!on) return
    const el = document.createElement('style'); el.id = 'bl'; el.textContent = css
    document.head.appendChild(el)
  }, { on, css: BASELINE })

  for (const mode of ['light', 'dark']) {
    await p.evaluate((m) => {
      document.documentElement.classList.toggle('dark', m === 'dark')
      document.documentElement.dataset.mode = m
    }, mode)

    await inject(false)
    const off = await p.evaluate(SNAP)
    await inject(true)
    const on = await p.evaluate(SNAP)

    // ── A 裸控件拿到主题外观 ──
    for (const sel of [...BOXED, 'input', 'select', 'textarea']) {
      const [pt, , , pl, bw, bs, , bg, r] = on[sel].split('|')
      check(`A/${mode} ${sel} 不是浏览器默认框`,
        pt === '7px' && pl === '10px' && parseFloat(bw) > 0 && bs === 'solid' && parseFloat(r) >= 4 && !/rgba\(0, 0, 0, 0\)/.test(bg),
        on[sel])
    }

    // ── B 负对照:壳画框的控件一个像素都不许动 ──
    for (const sel of NAKED) {
      check(`B/${mode} ${sel} 未被基线改动`, on[sel] === off[sel], on[sel] === off[sel] ? '' : `无基线=${off[sel]}  有基线=${on[sel]}`)
    }

    // ── D 排除的 type 保持原生 ──
    for (const t of ['checkbox', 'radio', 'range', 'file']) {
      const sel = `input[type="${t}"]`
      check(`D/${mode} ${sel} 保持原生(基线没伸手)`, on[sel] === off[sel], on[sel])
    }
  }
  await browser.close()

  // ── C 完整性:静态扫出所有「壳画框、内部裸输入」的规则,必须都已登记 ──
  const FORM = /\b(input|select|textarea)\b/
  const found = new Map()
  for (const f of FILES) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2]
      if (!/border\s*:\s*(none|0)/.test(body)) continue
      if (!/background\s*:\s*(transparent|none)/.test(body)) continue
      if (/padding/.test(body)) continue
      for (const one of m[1].split(',').map((s) => s.trim())) {
        if (!FORM.test(one) || one.startsWith('@') || one.startsWith(':where') || one.includes('::')) continue
        if (/:(hover|focus|active|checked|disabled)/.test(one)) continue
        found.set(one, f)
      }
    }
  }
  // 归零块里的写法与 CSS 源里的写法可能差个祖先(如 `.am-app .amx-findbar input`),按末段比对。
  // ⚠️ 按**整条**选择器比(允许祖先前缀差异),别退化成比末段:那样 `.zz-x input` 会被
  //    `.t2s-search input` 的末段 "input" 认领,C 组永远绿(写这条检查时真踩过)。
  const ok = (s) => NAKED.some((n) => n === s || n.endsWith(' ' + s) || s.endsWith(' ' + n))
  const missing = [...found.keys()].filter((s) => !ok(s))
  check('C 没有漏登记的「壳画框、内部裸输入」规则', missing.length === 0,
    missing.length ? missing.map((s) => `${s} @ ${found.get(s)}`).join(' / ') : `已登记 ${found.size} 条`)

  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})()
