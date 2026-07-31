/**
 * 界面字体覆盖(设置 → 外观)的**层叠**契约。这里量的不是逻辑而是 CSS 谁压过谁 —— 唯一的失败形态是
 * 「设置里改了、界面纹丝不动」,vitest 量不到(要真浏览器算 computed style)。
 *
 *  A 覆盖必须穿透到主题重定义字体的每一层:主题在 `.tangu-lovable[data-skin='qbird']` 这类
 *    **更高特异性**的选择器上重写 --font-ui,只写 :root 会被整个子树遮住 —— 这就是 uiFont.ts 里
 *    SCOPES 枚举类名 + !important 的全部理由。新增会重定义字体变量的类名而忘了补 SCOPES,这条转红。
 *  B --font / --mono(Amadeus soft 基座自己的词汇,有十几处直接 var() 消费)也要跟着盖,
 *    否则 soft 语言下笔记正文不跟随。
 *  C 「跟随主题」= 一条声明都不出:留空时各主题必须还是各自的字体栈,不能被清成浏览器默认。
 *
 * 改 uiFont.ts 的 SCOPES / VARS,或给主题新增字体变量后必跑:node scripts/ui-font.check.cjs
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
require('sucrase/register/ts')
const { buildFontCss } = require(path.join(SRC, 'uiFont.ts'))

// 真源:base.css 的 token 底 + 两个 LCL 基座(lovable 带 [data-skin] 变体、soft 用 --font/--mono 词汇)。
const CSS = [read('styles/base.css'), read('amadeus/theme/lcl/tangu.css'), read('amadeus/theme/lcl/tanguSoft.css')].join('\n')

// 每个探针都住在真实的祖先链下,量的就是「主题重定义之后我还压不压得住」。
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
body { margin: 0; }
</style></head><body>
  <div id="plain">root</div>
  <div class="am-app tangu-lovable"><div id="lovable">lovable</div></div>
  <div class="am-app tangu-lovable" data-skin="qbird"><div id="qbird">qbird</div></div>
  <div class="am-app tangu-lovable" data-skin="custom"><div id="custom">custom</div></div>
  <div class="am-app tangu-soft"><div id="soft">soft</div></div>
</body></html>`

const PROBES = ['plain', 'lovable', 'qbird', 'custom', 'soft']

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ viewport: { width: 900, height: 600 } })
  await p.setContent(PAGE)

  /** 给每个探针挂上要读的变量,回读 computed 值。 */
  const readVars = (vars) => p.evaluate(({ ids, vars }) => Object.fromEntries(ids.map((id) => {
    const el = document.getElementById(id)
    const cs = getComputedStyle(el)
    return [id, Object.fromEntries(vars.map((v) => [v, cs.getPropertyValue(v).trim()]))]
  })), { ids: PROBES, vars })

  const inject = (css) => p.evaluate((css) => {
    document.getElementById('probe-font')?.remove()
    if (!css) return
    const el = document.createElement('style')
    el.id = 'probe-font'
    el.textContent = css
    document.head.appendChild(el)
  }, css)

  // ── C 基线:没有覆盖时,各基座保持自己的字体栈(且彼此不同 → 说明主题确实在重定义) ──
  const base = await readVars(['--font-ui', '--font', '--font-mono', '--mono'])
  check('C 未设时各主题保留自己的字体栈(覆盖为空不清字体)',
    !!base.lovable['--font-ui'] && !!base.qbird['--font-ui'] && base.lovable['--font-ui'] !== base.qbird['--font-ui'],
    `lovable=${base.lovable['--font-ui'].slice(0, 22)} / qbird=${base.qbird['--font-ui'].slice(0, 22)}`)
  check('C 空覆盖不产出 CSS', buildFontCss({}) === '', `css=${JSON.stringify(buildFontCss({}))}`)

  // ── A 界面档穿透到每一层(含高特异性的 [data-skin] 变体) ──
  await inject(buildFontCss({ ui: 'ProbeSans' }))
  const ui = await readVars(['--font-ui', '--font'])
  for (const id of PROBES) {
    check(`A ${id} 的 --font-ui 被盖住`, ui[id]['--font-ui'] === 'ProbeSans', `实得=${ui[id]['--font-ui']}`)
  }
  check('B soft 基座的 --font 同步被盖(十几处直接 var(--font) 消费)',
    ui.soft['--font'] === 'ProbeSans', `实得=${ui.soft['--font']}`)

  // 真正落到文字上,而不只是变量变了(var() 链断了照样白改)。
  const applied = await p.evaluate((ids) => Object.fromEntries(
    ids.map((id) => [id, getComputedStyle(document.getElementById(id)).fontFamily])), PROBES)
  check('A 变量确实传导到 font-family(body 继承 --font-ui)',
    applied.plain.includes('ProbeSans'), `body=${applied.plain}`)

  // ── B 等宽档独立生效,且不误伤界面档 ──
  await inject(buildFontCss({ mono: 'ProbeMono' }))
  const mono = await readVars(['--font-mono', '--mono', '--font-ui'])
  check('B --font-mono 与 --mono 一起被盖', mono.soft['--font-mono'] === 'ProbeMono' && mono.soft['--mono'] === 'ProbeMono',
    `font-mono=${mono.soft['--font-mono']} mono=${mono.soft['--mono']}`)
  check('B 只设等宽时界面字体原样不动', mono.qbird['--font-ui'] === base.qbird['--font-ui'],
    `实得=${mono.qbird['--font-ui'].slice(0, 22)}`)

  // ── C 撤掉覆盖 → 完全回到主题原样 ──
  await inject('')
  const restored = await readVars(['--font-ui', '--font-mono'])
  check('C 清空后回到主题原值(不留残影)',
    PROBES.every((id) => restored[id]['--font-ui'] === base[id]['--font-ui']),
    PROBES.map((id) => `${id}=${restored[id]['--font-ui'] === base[id]['--font-ui'] ? 'ok' : 'drift'}`).join(' '))

  await browser.close()
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})()
