// LaTeX Suite 插件的**真机台架**:真浏览器 + 真 Amadeus 编辑器 + 真插件宿主
// (`new Function('ctx', main.js)`,经默认 harness 的 `window.__ep.loadPlugin`)。
//
// 与插件自己的 check.mjs 分工:
//   check.mjs  —— 装载契约(产物形态 / 注册了什么 / disposer),node 跑得动的那半;
//   本脚本     —— **只有真编辑器才验得了的那半**:打字真的展开吗?Tab 真的在片段活动时被接管、
//                 不活动时又真的还给宿主做列表缩进吗?装饰真的画出来了吗?
//
// 这层历来是「纸面推演修三轮都修不中」的地方(见 editor-triggers.e2e.cjs 的开头),
// 而且 tabstop 的位置映射错一位就表现为「Tab 跳一次就失灵」而单测全绿 —— 必须有这个脚本。
//
// 用法:
//   npm run e2e:latex          (自起 vite;5173 已有 harness 时直接复用)
//   node scripts/latex-suite.e2e.cjs   (自己起了 vite 的话)
//   CHROMIUM_EXE=… 覆盖浏览器路径;HARNESS_URL=… 换端口(并行会话隔离用)。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

const PLUGIN_DIR = path.resolve(
  __dirname,
  '../../../Forsion-Instrumentality-Project/forsion-plugin-latex-suite',
)

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

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  | ' + JSON.stringify(detail)}`)
}

async function main() {
  const mainJs = path.join(PLUGIN_DIR, 'main.js')
  if (!fs.existsSync(mainJs)) {
    console.error(`找不到构建产物:${mainJs}\n先在插件目录跑 npm run build`)
    process.exit(1)
  }
  const code = fs.readFileSync(mainJs, 'utf8')

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN' })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
  await page.waitForTimeout(300)

  // 注入插件。扩展注册表代次一变,已建好的编辑器会重建 —— 等它重建完再动手。
  await page.evaluate(([c]) => window.__ep.loadPlugin(c, { id: 'latex-suite', name: 'LaTeX 套件' }), [code])
  await page.waitForTimeout(600)
  const active = await page.evaluate(() => window.__ep.active())
  check('插件在真宿主里激活', active.includes('latex-suite'), active)
  check('装载不报错', errors.length === 0, errors.slice(0, 3))

  /** 最后一个块的纯文本(剥掉装饰:标题 `#` widget、conceal 的替换字符都不是文档内容)。 */
  const lastText = () =>
    page.evaluate(() => {
      const bs = [...document.querySelectorAll('.md-block .ProseMirror')]
      const pm = bs[bs.length - 1]
      const c = pm.cloneNode(true)
      // 剥掉一切**装饰**,只留文档真正的内容:
      //   .katex*      宿主的公式实况预览(公式一闭合就渲染,它的 textContent 会混进 MathML 注解)
      //   .amx-struct-prefix 标题/列表等行首源码 input
      //   .ls-*        本插件的 conceal 替换字符与占位点装饰
      c.querySelectorAll('.katex, .katex-display, .katex-html, .amx-struct-prefix, .ls-conceal-widget').forEach((n) => n.remove())
      return c.textContent
    })

  /** 把最后一个块清空,光标落进去。每个用例必须从干净状态起步 —— 否则断言会读到上一条用例
   *  残留的文本(「正文里不展开」那条曾因此假红:块里还留着上一条的 `\alpha`)。
   *  ⚠️用 Meta+A 不是 Control+A:每个块是**独立的编辑器实例**,Meta+A 只全选本块;
   *  mac 上 Control+A 是「移到行首」,清不掉任何东西。 */
  const reset = async () => {
    await page.locator('.md-block .ProseMirror').last().click()
    await page.keyboard.press('Meta+a')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(120)
    const left = await lastText()
    if (left.trim()) throw new Error(`reset 没清干净,残留:${JSON.stringify(left)}`)
  }

  // ── 1. 自动片段:公式里打 `@a` → \alpha。这是整个插件最核心的一条路径。
  await reset()
  await page.keyboard.type('$@a', { delay: 40 })
  await page.waitForTimeout(200)
  let t = await lastText()
  check('公式里 @a 展开成 \\alpha', t.includes('\\alpha'), t)

  // ── 2. 正文里同一个触发串**不该**展开(模式判定真的接上了)。
  await reset()
  await page.keyboard.type('@a', { delay: 40 })
  await page.waitForTimeout(200)
  t = await lastText()
  check('正文里 @a 原样保留(不越界展开)', t.includes('@a') && !t.includes('\\alpha'), t)

  // ── 3. 自动分式 + Tabout。
  //       ⚠️先用默认片段 `mk` 造一个**闭合**的行内公式(`$|$`)。tabout 要求公式闭合 —— 裸打一个
  //       `$` 是「未闭合」态,那时候跳出去会把光标扔进一片没有结尾的公式里,上游同样不跳。
  //       用裸 `$` 写这条用例会得到一个假红(问过一次了)。
  await reset()
  await page.keyboard.type('mk', { delay: 40 })
  await page.waitForTimeout(250)
  t = await lastText()
  check('mk 展开成闭合行内公式', t === '$$', t)
  await page.keyboard.type('a/', { delay: 40 })
  await page.waitForTimeout(250)
  t = await lastText()
  check('公式里 / 出分式、光标进分母', t === '$\\frac{a}{}$', t)
  await page.keyboard.type('xyz', { delay: 40 })
  await page.waitForTimeout(150)
  t = await lastText()
  check('分母里连打三个字符(位置映射不掉字)', t === '$\\frac{a}{xyz}$', t)

  // ── 3b. Tabout:分式里按 Tab 应当**跳出花括号**,再打字落在外面。
  //        ⚠️要按**两次** Tab:`mk` 展开时压进去的占位点帧到这会儿还活着(光标一直在它范围内),
  //        第一次 Tab 被「收尾这个片段」吃掉 —— 那是**正确行为**(与上游一致),不是 bug。
  //        (查这个花了一轮:真机里 tabout 像没反应,而单测里 tabout 单独跑得好好的。
  //         也别改用 Esc 绕开 —— Esc 在宿主里是「查看源码」的开关,会横生枝节。)
  //        断言必须看「打进去的字在哪」—— 只查 includes 的话,字掉回花括号里也算过。
  await page.keyboard.press('Tab')
  await page.waitForTimeout(120)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(150)
  await page.keyboard.type('n', { delay: 40 })
  await page.waitForTimeout(200)
  t = await lastText()
  check('Tab 跳出花括号(n 落在 } 外面)', t === '$\\frac{a}{xyz}n$', t)

  // ── 3c. 占位点跳位:`sq` 展开成 `\sqrt{ $0 }$1`,Tab 从括号内跳到括号后。
  await reset()
  await page.keyboard.type('$sq', { delay: 40 })
  await page.waitForTimeout(250)
  t = await lastText()
  check('sq 展开成根号', t.includes('\\sqrt{'), t)
  await page.keyboard.type('2', { delay: 40 })
  await page.keyboard.press('Tab')
  await page.waitForTimeout(150)
  await page.keyboard.type('!', { delay: 40 })
  await page.waitForTimeout(200)
  t = await lastText()
  check('Tab 跳到下一个占位点(! 落在 } 之后)', /\}\s*!/.test(t), t)

  // ── 4. 没有活动片段时,Tab **必须还给宿主**做列表缩进。
  //       high 优先级桶最危险的失败模式就是把 Tab 吞掉,这条守住它。
  await reset()
  await page.keyboard.type('- 一项', { delay: 40 })
  await page.keyboard.press('Enter')
  await page.keyboard.type('二项', { delay: 40 })
  await page.waitForTimeout(120)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(200)
  const nested = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('.md-block .ProseMirror')]
    return !!bs[bs.length - 1].querySelector('li ul, li ol')
  })
  check('无片段时 Tab 仍做列表缩进(没被 high 桶吞掉)', nested, nested)

  // ── 5. 行内代码里不展开(用户在写字面量)。
  await reset()
  await page.keyboard.type('`$@a', { delay: 40 })
  await page.waitForTimeout(200)
  t = await lastText()
  check('行内代码里 @a 不展开', !t.includes('\\alpha'), t)

  // ── 6. 设置面板能在真 DOM 里挂起来(内嵌 CodeMirror —— check.mjs 里拿假 DOM 喂它是无底洞,
  //       那条只验契约形状,真挂载归这里)。
  const mounted = await page.evaluate(() => {
    const views = window.__ep.settingsViews()
    if (!views.length) return { ok: false, why: '没有注册设置面板' }
    const host = document.createElement('div')
    document.body.appendChild(host)
    try {
      const off = views[0].mount(host)
      const ok = host.childNodes.length > 0
      const hasCm = !!host.querySelector('.cm-editor')
      if (typeof off === 'function') off()
      host.remove()
      return { ok, hasCm, why: ok ? '' : '挂完是空的' }
    } catch (e) {
      host.remove()
      return { ok: false, why: String(e) }
    }
  })
  check('设置面板在真 DOM 里挂得起来', mounted.ok, mounted.why || undefined)
  check('设置面板里是真 CodeMirror 编辑器', !!mounted.hasCm)

  check('全程无未捕获错误', errors.length === 0, errors.slice(0, 5))

  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
