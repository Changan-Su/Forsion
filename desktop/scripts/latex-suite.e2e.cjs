// LaTeX Suite 插件的**真机台架**:真浏览器 + 真 Amadeus 编辑器 + 真插件宿主
// (`new Function('ctx', main.js)`,经 harness 的 `window.__ep.loadPlugin`)。
//
// 与插件自己的 check.mjs / 单测分工:
//   check.mjs / vitest —— 装载契约、Tab 链与位置映射(和 Obsidian 逐键对过的序列在插件仓
//                         test/obsidianParity.test.ts 里);
//   本脚本             —— **只有真编辑器才验得了的那半**:打字真的展开吗?Tab 真的在片段活动时被接管、
//                         不活动时又真的还给宿主?装饰真的画出来、颜色真的没被宿主的公式源码配色盖住吗?
//
// 两段:
//   一、默认壳(v3 块编辑器)冒烟:展开、自动分式、跳位、列表缩进、行内代码、设置面板。
//   二、?upage&upane(v4 统一编辑器,生产组件):和 Obsidian 的 Latex Suite 逐键对过的 Tab 序列,
//       以及括号 / 占位 / `$` 的计算样式,浅色、深色各量一遍。
//
// 用法:
//   npm run e2e:latex          (自起 vite;5173 已有 harness 时直接复用)
//   node scripts/latex-suite.e2e.cjs   (自己起了 vite 的话)
//   CHROMIUM_EXE=… 覆盖浏览器路径;HARNESS_URL=… 换端口(并行会话隔离用)。
//   LATEX_SUITE_MAIN=<main.js>      测指定的插件产物(缺省:插件仓里的 main.js)。
//   LATEX_SUITE_SETTINGS=<json>     用一份插件设置跑(经 readPluginData 交给插件,等同用户存过的设置);
//                                   其中 taboutExitEquationOnlyOnEOL=false 时 Tab 序列按那一档的期望走。
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

const MAIN_JS = process.env.LATEX_SUITE_MAIN || path.join(PLUGIN_DIR, 'main.js')
const SETTINGS_TEXT = process.env.LATEX_SUITE_SETTINGS ? fs.readFileSync(process.env.LATEX_SUITE_SETTINGS, 'utf8') : null
const SETTINGS = SETTINGS_TEXT ? JSON.parse(SETTINGS_TEXT) : {}
/** 「只在行尾才跳出公式」:缺省开;设置里显式关掉时 T4 / T6 走另一档期望(与 Obsidian 同一档实测)。 */
const EOL_ONLY = SETTINGS.taboutExitEquationOnlyOnEOL !== false

/** 注入插件。readPluginData 必须在 loadPlugin 之前挂上:插件 setup 里就开始读设置。 */
async function loadPlugin(page, code) {
  await page.evaluate(([c, settings]) => {
    if (settings != null) window.amadeus.readPluginData = async (id) => (id === 'latex-suite' ? settings : null)
    window.__ep.loadPlugin(c, { id: 'latex-suite', name: 'LaTeX 套件' })
  }, [code, SETTINGS_TEXT])
}

async function main() {
  if (!fs.existsSync(MAIN_JS)) {
    console.error(`找不到构建产物:${MAIN_JS}\n先在插件目录跑 npm run build`)
    process.exit(1)
  }
  const code = fs.readFileSync(MAIN_JS, 'utf8')
  console.log(`插件产物:${MAIN_JS}${SETTINGS_TEXT ? `\n插件设置:${process.env.LATEX_SUITE_SETTINGS}` : ''}`)

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    await v3Smoke(browser, code)
    for (const dark of [false, true]) await v4Styles(browser, code, dark)
    await v4Sequences(browser, code)
  } finally {
    await browser.close()
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、默认壳(v3 块编辑器)冒烟
// ─────────────────────────────────────────────────────────────────────────────
async function v3Smoke(browser, code) {
  const page = await browser.newPage({ locale: 'zh-CN' })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // 首块种一条带括号的公式,当「插件读完设置、装饰已经画上」的信号(见下面的等待)。
  await page.goto(`${URL}?seed=${encodeURIComponent('$(r)$')}`, { waitUntil: 'domcontentloaded', timeout: 90000 }) // 冷启动的 vite 要先预构建依赖
  await page.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })

  // 注入插件后等「就绪」,而不是睡固定时长:扩展注册表代次一变编辑器会换上插件,而插件的设置是
  // 异步读的,读完之前任何输入都原样放行 —— 所以等它在种子公式上画出括号着色
  // (着色只在设置读完后才开,新旧两版插件都一样)。
  await loadPlugin(page, code)
  const ready = await page.waitForFunction(() => !!document.querySelector('.md-block .ProseMirror [class*="bracket"]'), null, { timeout: 15000 }).then(() => true, () => false)
  const active = await page.evaluate(() => window.__ep.active())
  check('插件在真宿主里激活', active.includes('latex-suite'), active)
  check('装载不报错', errors.length === 0, errors.slice(0, 3))
  check('设置读完、装饰画上(就绪信号)', ready)

  /** 最后一个块的纯文本(剥掉装饰:标题 `#` widget、conceal 的替换字符都不是文档内容)。 */
  const lastText = () =>
    page.evaluate(() => {
      const bs = [...document.querySelectorAll('.md-block .ProseMirror')]
      const pm = bs[bs.length - 1]
      const c = pm.cloneNode(true)
      // 剥掉一切**装饰**,只留文档真正的内容:
      //   .katex*      宿主的公式实况预览(公式一闭合就渲染,它的 textContent 会混进 MathML 注解)
      //   .amx-struct-prefix 标题/列表等行首源码 input
      //   .ls-*        本插件的 conceal 替换字符
      c.querySelectorAll('.katex, .katex-display, .katex-html, .amx-struct-prefix, .ls-conceal-widget').forEach((n) => n.remove())
      return c.textContent
    })

  /** 把最后一个块清空,光标落进去。每个用例必须从干净状态起步 —— 否则断言会读到上一条用例
   *  残留的文本(「正文里不展开」那条曾因此假红:块里还留着上一条的 `\alpha`)。
   *  全选用 DOM Range 直接框住本块,不按 Meta+A:点击可能落在公式的实况预览上(不可编辑),
   *  那时 Meta+A 什么也不选,紧跟的 Backspace 又正好碰上「刚展开就按退格 = 还原触发串」,
   *  块里留下 `$@a$`(实测过)。每个块是**独立的编辑器实例**,框住的只是本块。 */
  const reset = async () => {
    await page.locator('.md-block .ProseMirror').last().click()
    await page.evaluate(() => {
      const bs = [...document.querySelectorAll('.md-block .ProseMirror')]
      const pm = bs[bs.length - 1]
      pm.focus()
      const r = document.createRange()
      r.selectNodeContents(pm)
      const sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(r)
    })
    await page.waitForTimeout(80)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(120)
    const left = await lastText()
    if (left.trim()) throw new Error(`reset 没清干净,残留:${JSON.stringify(left)}`)
  }

  // ── 1. `mk` 在正文里建一条闭合的行内公式(正文自动片段缺省开,与 Obsidian 的 Latex Suite 一致)。
  //       ⚠️公式里的片段只在**闭合**的公式里展开:裸打一个 `$` 是字面量(孤立的 `$` 不接管后面的正文),
  //       所以后面几条都先用 `mk` 造出 `$|$` 再打触发串。
  await reset()
  await page.keyboard.type('mk', { delay: 40 })
  await page.waitForTimeout(250)
  let t = await lastText()
  check('mk 展开成闭合行内公式', t === '$$', t)

  // ── 2. 自动片段:公式里打 `@a` → \alpha。这是整个插件最核心的一条路径。
  await page.keyboard.type('@a', { delay: 40 })
  await page.waitForTimeout(200)
  t = await lastText()
  check('公式里 @a 展开成 \\alpha', t === '$\\alpha$', t)

  // ── 3. 正文里同一个触发串**不该**展开(模式判定真的接上了)。
  await reset()
  await page.keyboard.type('@a', { delay: 40 })
  await page.waitForTimeout(200)
  t = await lastText()
  check('正文里 @a 原样保留(不越界展开)', t.includes('@a') && !t.includes('\\alpha'), t)

  // ── 4. 自动分式 + 跳位。
  await reset()
  await page.keyboard.type('mk', { delay: 40 })
  await page.waitForTimeout(250)
  await page.keyboard.type('a/', { delay: 40 })
  await page.waitForTimeout(250)
  t = await lastText()
  check('公式里 / 出分式、光标进分母', t === '$\\frac{a}{}$', t)
  await page.keyboard.type('xyz', { delay: 40 })
  await page.waitForTimeout(150)
  t = await lastText()
  check('分母里连打三个字符(位置映射不掉字)', t === '$\\frac{a}{xyz}$', t)

  // ── 4b. 分母里按**一次** Tab 落到分式后面(自动分式压了「分母 → 分式后」两格,与上游一致);
  //        再按一次 Tab 跳出公式。断言看「打进去的字在哪」—— 只查 includes 的话,字掉回花括号里也算过。
  //        (旧脚本这里按两次:那是旧实现把第一次 Tab 用来「收尾」`mk` 的单格占位,Obsidian 里没有这一下。)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(150)
  await page.keyboard.type('n', { delay: 40 })
  await page.waitForTimeout(200)
  t = await lastText()
  check('Tab 跳出花括号(n 落在 } 外面)', t === '$\\frac{a}{xyz}n$', t)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(150)
  await page.keyboard.type('m', { delay: 40 })
  await page.waitForTimeout(200)
  t = await lastText()
  check('再 Tab 跳出公式(m 落在 $ 外面)', t === '$\\frac{a}{xyz}n$m', t)

  // ── 4c. 占位点跳位:`sq` 展开成 `\sqrt{ $0 }$1`,Tab 从括号内跳到括号后。
  await reset()
  await page.keyboard.type('mk', { delay: 40 })
  await page.waitForTimeout(250)
  await page.keyboard.type('sq', { delay: 40 })
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

  // ── 5. 没有活动片段时,Tab **必须还给宿主**做列表缩进。
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

  // ── 6. 行内代码里不展开(用户在写字面量)。
  await reset()
  await page.keyboard.type('`$@a', { delay: 40 })
  await page.waitForTimeout(200)
  t = await lastText()
  check('行内代码里 @a 不展开', !t.includes('\\alpha'), t)

  // ── 7. 设置面板能在真 DOM 里挂起来(内嵌 CodeMirror —— check.mjs 里拿假 DOM 喂它是无底洞,
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
  await page.close()
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、v4 统一编辑器(?upage&upane):Tab 序列与计算样式
// ─────────────────────────────────────────────────────────────────────────────

/** 每个场景单开一页:种子文档 + 光标落点。种子末尾另带一段 `$(r)$` 当就绪信号(同 v3)。 */
async function openUPage(browser, code, { seed, caret, dark = false }) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const md = `${seed}\n\n$(r)$\n`
  await page.goto(`${URL}?upage&upane${dark ? '&udark' : ''}&useed=${encodeURIComponent(md)}`, { waitUntil: 'domcontentloaded', timeout: 90000 }) // 冷启动的 vite 要先预构建依赖
  await page.waitForFunction(() => !!window.__upage?.probe?.view?.(), null, { timeout: 30000 })
  await loadPlugin(page, code)
  // 就绪 = 编辑器带着插件重建过(状态里有插件的按键插件)+ 设置读完(括号着色的装饰算得出来)。
  // 直接问插件的 decorations,不看 DOM:光标不在那条公式里时宿主可能只画渲染结果。
  const ready = await page.waitForFunction(() => {
    const v = window.__upage.probe.view()
    if (!v || !v.state.plugins.some((p) => String(p.key).startsWith('LATEX_SUITE_KEYS'))) return false
    return v.state.plugins.some((p) => {
      const set = p.props.decorations && p.props.decorations.call(p, v.state)
      return !!set && typeof set.find === 'function' && set.find().some((d) => /bracket/.test((d.type && d.type.attrs && d.type.attrs.class) || ''))
    })
  }, null, { timeout: 15000 }).then(() => true, () => false)
  await page.evaluate(() => {
    const leaf = (n) => (/break/.test(n.type.name) ? '\n' : '￼')
    const view = () => window.__upage.probe.view()
    window.__ls = {
      /** 光标所在 textblock 的源码,`|` = 光标,«…» = 选区。 */
      line() {
        const st = view().state
        const sel = st.selection
        const $f = sel.$from
        const a = $f.start()
        const b = $f.end()
        const t = (x, y) => st.doc.textBetween(x, y, '\n', leaf)
        if (sel.empty) return t(a, sel.from) + '|' + t(sel.from, b)
        if (sel.to > b) return '(选区跨段)'
        return t(a, sel.from) + '«' + t(sel.from, sel.to) + '»' + t(sel.to, b)
      },
      /** 光标放进第一个文本含 needle 的 textblock,偏移 = needle 起点 + delta。 */
      caret(needle, delta) {
        const v = view()
        const st = v.state
        let pos = null
        st.doc.descendants((n, p) => {
          if (pos != null) return false
          if (!n.isTextblock) return true
          const i = n.textBetween(0, n.content.size, '\n', leaf).indexOf(needle)
          if (i >= 0) pos = p + 1 + i + delta
          return false
        })
        if (pos == null) return false
        v.dispatch(st.tr.setSelection(st.selection.constructor.create(st.doc, pos)))
        v.focus()
        return true
      },
      focused: () => view().hasFocus(),
      /** 光标所在 textblock 里每个字(文档内容,不含宿主预览 / 插件 widget)的计算样式,按块内偏移。 */
      styles() {
        const v = view()
        const $f = v.state.selection.$from
        const start = $f.start()
        const dom = v.nodeDOM($f.before())
        const out = {}
        if (!dom) return out
        const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const el = n.parentElement
          if (!el || el.closest('[contenteditable="false"], .katex, .katex-display')) continue
          let base
          try { base = v.posAtDOM(n, 0) } catch { continue }
          const cs = getComputedStyle(el)
          for (let i = 0; i < n.data.length; i++) {
            out[base + i - start] = { ch: n.data[i], color: cs.color, bg: cs.backgroundColor, outline: cs.outlineStyle, cls: String(el.className) }
          }
        }
        return out
      },
      /** 插件的空占位标记(零宽虚线)与有内容的占位底色。 */
      placeholders() {
        const dom = view().dom
        const field = dom.querySelector('.latex-suite-snippet-field')
        const box = dom.querySelector('.latex-suite-snippet-placeholder')
        const f = field && getComputedStyle(field)
        const b = box && getComputedStyle(box)
        return {
          fields: dom.querySelectorAll('.latex-suite-snippet-field').length,
          // 宽度量实际占位(getBoundingClientRect):宿主全局 border-box 下计算出的 width 是边框宽,
          // 要守的是「只有一条虚线、不把字挤开」。
          field: f && { style: f.borderLeftStyle, color: f.borderLeftColor, width: field.getBoundingClientRect().width },
          box: b && { text: box.textContent, bg: b.backgroundColor, outline: `${b.outlineStyle} ${b.outlineColor}` },
        }
      },
    }
  })
  if (caret) {
    const ok = await page.evaluate(([n, d]) => window.__ls.caret(n, d), caret)
    if (!ok) throw new Error(`落不下光标:${JSON.stringify(caret)}`)
  }
  await page.waitForTimeout(150)
  return { page, errors, ready }
}

const line = (page) => page.evaluate(() => window.__ls.line())

/** 逐步驱动:step = [动作, 期望行]。动作:'Tab' / 'S-Tab' / 其它 = 逐字键入。 */
async function drive(page, steps) {
  const got = []
  for (const [act, want] of steps) {
    if (act === 'Tab') await page.keyboard.press('Tab')
    else if (act === 'S-Tab') await page.keyboard.press('Shift+Tab')
    else await page.keyboard.type(act, { delay: 30 })
    await page.waitForTimeout(140)
    const l = await line(page)
    got.push(l)
    if (l !== want) return { ok: false, at: act, want, got: l, trail: got }
  }
  return { ok: true }
}

/** 与 Obsidian 的 Latex Suite 1.12.8 逐键对过的序列(插件仓 test/obsidianParity.test.ts 里同名场景)。 */
async function v4Sequences(browser, code) {
  const scenes = [
    {
      name: 'T1b 块级公式里 t({n_j 再连按 Tab:内层 → 外层 → 括号后 → 出公式',
      seed: '$$  $$', caret: ['$$  $$', 3],
      steps: [
        ['t({n_j', '$$ t({n_{j|}}) $$'],
        ['Tab', '$$ t({n_{j}|}) $$'],
        ['Tab', '$$ t({n_{j}}|) $$'],
        ['Tab', '$$ t({n_{j}})| $$'],
        ['Tab', '$$ t({n_{j}}) $$|'],
      ],
    },
    {
      name: 'T3b 正文 mk 建行内公式,// a Tab b Tab Tab',
      seed: 'Para text', caret: ['Para text', 9],
      steps: [
        [' mk', 'Para text $|$'],
        ['//', 'Para text $\\frac{|}{}$'],
        ['a', 'Para text $\\frac{a|}{}$'],
        ['Tab', 'Para text $\\frac{a}{|}$'],
        ['b', 'Para text $\\frac{a}{b|}$'],
        ['Tab', 'Para text $\\frac{a}{b}|$'],
        ['Tab', 'Para text $\\frac{a}{b}$|'],
      ],
    },
    {
      name: `T4${EOL_ONLY ? '' : '-EOLfalse'} 没有片段时 Tab 一路跳出括号再跳出公式`,
      seed: '$$ \\frac{a}{b} $$', caret: ['{a}', 2],
      steps: [
        ['Tab', '$$ \\frac{a}|{b} $$'],
        ['Tab', '$$ \\frac{a}{b}| $$'],
        ['Tab', '$$ \\frac{a}{b} $$|'],
      ],
    },
    {
      name: 'T7 Shift+Tab 回到已填的格整格选中,Tab 再整格选中下一格',
      seed: '$$  $$', caret: ['$$  $$', 3],
      steps: [
        ['//', '$$ \\frac{|}{} $$'],
        ['a', '$$ \\frac{a|}{} $$'],
        ['Tab', '$$ \\frac{a}{|} $$'],
        ['b', '$$ \\frac{a}{b|} $$'],
        ['S-Tab', '$$ \\frac{«a»}{b} $$'],
        ['Tab', '$$ \\frac{a}{«b»} $$'],
        ['Tab', '$$ \\frac{a}{b}| $$'],
      ],
    },
    {
      name: 'T8 带缺省文字的格:落上去整格选中',
      seed: '$$  $$', caret: ['$$  $$', 3],
      steps: [
        ['sum', '$$ \\sum| $$'],
        ['Tab', '$$ \\sum_{«i»=1}^{N}  $$'],
        ['Tab', '$$ \\sum_{i=«1»}^{N}  $$'],
        ['Tab', '$$ \\sum_{i=1}^{«N»}  $$'],
        ['Tab', '$$ \\sum_{i=1}^{N} | $$'],
        ['Tab', '$$ \\sum_{i=1}^{N}  $$|'],
      ],
    },
  ]
  for (const sc of scenes) {
    const { page, errors, ready } = await openUPage(browser, code, sc)
    const r = ready ? await drive(page, sc.steps) : { ok: false, why: '插件没就绪' }
    check(`v4 ${sc.name}`, r.ok && errors.length === 0, r.ok ? (errors.length ? errors.slice(0, 2) : undefined) : r)
    await page.close()
  }

  // T6:右边还有内容时。只在行尾跳出 = 开:Tab 不接(光标不动,还给宿主);= 关:直接跳出公式。
  {
    const { page, errors, ready } = await openUPage(browser, code, { seed: '$$ a + b $$', caret: ['a +', 1] })
    await page.keyboard.press('Tab')
    await page.waitForTimeout(150)
    const l = await line(page)
    const ok = EOL_ONLY ? l.startsWith('$$ a') && l.includes('+ b $$') && !l.endsWith('$$|') : l === '$$ a + b $$|'
    check(`v4 T6${EOL_ONLY ? '' : '-EOLfalse'} 公式中间按 Tab:${EOL_ONLY ? '不跳出' : '直接跳出公式'}`, ready && ok && errors.length === 0, l)
    await page.close()
  }

  // 第一格上 Shift+Tab:插件不接(上游同样交还编辑器),占位原样保留,焦点留在编辑器里。
  {
    const { page, errors, ready } = await openUPage(browser, code, { seed: '$$  $$', caret: ['$$  $$', 3] })
    await page.keyboard.type('//', { delay: 30 })
    await page.waitForTimeout(150)
    const before = await line(page)
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(150)
    const after = await line(page)
    const ph = await page.evaluate(() => window.__ls.placeholders())
    const focused = await page.evaluate(() => window.__ls.focused())
    check('v4 第一格 Shift+Tab:不动光标、占位保留、焦点不丢',
      ready && before === '$$ \\frac{|}{} $$' && after === before && ph.fields >= 2 && focused && errors.length === 0,
      { before, after, fields: ph.fields, focused })
    await page.close()
  }
}

/** 括号 / 占位 / `$` 的计算样式(与 Obsidian 的 Latex Suite 1.12.8 实测值逐个对)。 */
async function v4Styles(browser, code, dark) {
  const mode = dark ? '深色' : '浅色'
  const C = dark
    ? { b0: 'rgb(71, 184, 255)', b1: 'rgb(255, 85, 205)', b2: 'rgb(115, 255, 99)', cursor: 'rgba(152, 111, 246, 0.6)', phOutline: 'rgba(135, 206, 250, 0.263)' }
    : { b0: 'rgb(82, 122, 255)', b1: 'rgb(255, 80, 183)', b2: 'rgb(105, 186, 0)', cursor: 'rgba(66, 12, 192, 0.3)', phOutline: 'rgba(135, 206, 250, 0.43)' }
  const GREEN = 'rgb(97, 174, 8)'
  const RED = 'rgb(255, 0, 0)'
  const MISMATCH = 'rgba(255, 18, 18, 0.8)'
  const NONE = 'rgba(0, 0, 0, 0)'

  // S1 用户报的那条:深度三色 + 光标所在的最内层一对只加底色(不描边),`$$` 标绿。
  //    这些字同时带着宿主公式源码的 token 类 —— 颜色对得上,就说明插件的选择器压住了宿主那一层。
  {
    const seed = '$$ t(\\{n_{j}\\}) $$'
    const { page, errors, ready } = await openUPage(browser, code, { seed, caret: ['n_{j', 3], dark })
    const s = await page.evaluate(() => window.__ls.styles())
    const at = (i) => s[i] || {}
    // 偏移:0-1 `$$`,4 `(`,5-6 `\{`,9 `{`,10 j,11 `}`,12-13 `\}`,14 `)`,16-17 `$$`
    const want = [
      [0, GREEN, NONE], [1, GREEN, NONE],
      [4, C.b0, NONE], [5, C.b1, NONE], [6, C.b1, NONE],
      [9, C.b2, C.cursor], [11, C.b2, C.cursor],
      [12, C.b1, NONE], [13, C.b1, NONE], [14, C.b0, NONE],
      [16, GREEN, NONE], [17, GREEN, NONE],
    ]
    const bad = want.filter(([i, color, bg]) => at(i).color !== color || at(i).bg !== bg)
      .map(([i, color, bg]) => ({ i, ch: at(i).ch, want: [color, bg], got: [at(i).color, at(i).bg], cls: at(i).cls }))
    check(`v4 ${mode}:括号按深度三色、光标那一对加底色、$$ 标绿(压过宿主源码配色)`, ready && bad.length === 0 && errors.length === 0, bad.length ? bad.slice(0, 4) : undefined)
    const outlined = [9, 11].filter((i) => at(i).outline !== 'none')
    check(`v4 ${mode}:光标那一对不描边`, ready && outlined.length === 0, outlined.length ? outlined.map((i) => at(i).outline) : undefined)
    await page.close()
  }

  // S2 配不上的括号标红;块级公式里多出来的 `$`、没写完的 `$$` 标红。
  {
    const { page, errors, ready } = await openUPage(browser, code, { seed: '$$ (a] $$', caret: ['(a', 2], dark })
    const s = await page.evaluate(() => window.__ls.styles())
    const got = [s[3] && s[3].color, s[5] && s[5].color]
    check(`v4 ${mode}:配不上的括号标红`, ready && got.every((c) => c === MISMATCH) && errors.length === 0, got)
    await page.close()
  }
  {
    const { page, errors, ready } = await openUPage(browser, code, { seed: '$$ a c$ b $$', caret: ['b $$', 1], dark })
    const s = await page.evaluate(() => window.__ls.styles())
    const got = [s[0] && s[0].color, s[6] && s[6].color, s[10] && s[10].color]
    check(`v4 ${mode}:块级公式里多出来的 $ 标红、两端 $$ 标绿`, ready && got[0] === GREEN && got[1] === RED && got[2] === GREEN && errors.length === 0, got)
    await page.close()
  }

  // S3 占位标记:空格是零宽的虚线竖线;填了字的格按组上色(第一组蓝)、1px 描边。
  {
    const { page, errors, ready } = await openUPage(browser, code, { seed: '$$  $$', caret: ['$$  $$', 3], dark })
    await page.keyboard.type('//', { delay: 30 })
    await page.waitForTimeout(150)
    const empty = await page.evaluate(() => window.__ls.placeholders())
    const fieldOk = !!empty.field && empty.field.style === 'dotted' && empty.field.color === 'rgb(136, 136, 136)' && empty.field.width <= 1.5
    check(`v4 ${mode}:空占位是零宽虚线`, ready && fieldOk, empty.field)
    await page.keyboard.type('a', { delay: 30 })
    await page.keyboard.press('Tab')
    await page.keyboard.type('b', { delay: 30 })
    await page.waitForTimeout(150)
    const filled = await page.evaluate(() => window.__ls.placeholders())
    const boxOk = !!filled.box && filled.box.text === 'b' && filled.box.bg === 'rgba(135, 206, 250, 0.18)' && filled.box.outline === `solid ${C.phOutline}`
    check(`v4 ${mode}:填了字的占位按组上底色、1px 描边`, ready && boxOk && errors.length === 0, filled.box)
    await page.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
