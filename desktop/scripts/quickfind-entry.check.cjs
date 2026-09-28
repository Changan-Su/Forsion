// 「从编辑器外进入」的几个输入框(npm run check:quickfind;真 Chromium × `?qf` 台架)。
// 由来:2026-09-27 编辑器评审 G4 组。
//   G4-11 ⌘P 曾被 quick-find 与 Amadeus 快速切换两条命令同时绑定,分发取先注册的那条,能新建笔记的切换器
//         永远按不出来 —— 合成一个:全局快速查找吸收「新建笔记」行(走 G4-12 素文件出生)+ ⌘/Ctrl+Enter 新标签打开;
//         源码里 `hotkey: 'mod+p'` 只许出现一次。
//   G4-02 快速查找 / 模板选择器 / 命令面板的输入框没有 IME 守卫:拼音组字中按 Enter 直接打开第一条、↓ 移动选中、
//         Esc 连面板一起关掉。合成 KeyboardEvent 的 isComposing 到不了 React,必须走 CDP Input.imeSetComposition。
//   G4-06 从快速查找 / 日记进入**已有**笔记后焦点不在编辑器上,直接打字无效 —— openNote(focus:'body')经
//         UnifiedPipeHandle.focusBody 把焦点给正文(不动选区);`?upage` 台架直调生产 openNote。
// 用法:npm run check:quickfind(自带起停 vite);或已起 vite 后 HARNESS_URL=… node scripts/quickfind-entry.check.cjs
//       ONLY=G4-02 只跑某一节。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const SRC = path.join(__dirname, '../frontend/src')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null
const tryTest = async (name, fn) => {
  if (ONLY && !ONLY.includes(name)) return
  try {
    await fn()
  } catch (e) {
    check(`${name}(异常)`, false, String((e && e.message) || e).slice(0, 200))
  }
}

async function openQF(browser) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 700 } })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${BASE}?qf`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('.amx-qf-input', { timeout: 120000 })
  await page.waitForFunction(() => !!window.__qf, null, { timeout: 60000 })
  // 导航记账:openNote / openDb … 都落到 workspace.openView(台架没有 dockview api → 一律走「新开」分支);
  // createWikiPage 换成记账桩 —— 本仪器只验「面板把意图路由对了」,落盘由 pageStore.birth.test 管。
  await page.evaluate(() => {
    window.__nav = []
    window.__qf.useWorkspace.setState({ openView: (type, params, loc, opts) => { window.__nav.push({ type, path: params && params.notePath, newTab: !!(opts && opts.newTab) }) } })
    window.__qf.usePageStore.setState({ vaultRoot: '/v', createWikiPage: async (n) => { window.__nav.push({ create: n }) } })
  })
  await page.focus('.amx-qf-input')
  return page
}
const qfState = (page) => page.evaluate(() => ({
  open: !!document.querySelector('.amx-qf'),
  value: document.querySelector('.amx-qf-input')?.value ?? null,
  rows: [...document.querySelectorAll('.amx-qf-row')].map((r) => (r.classList.contains('sel') ? '*' : '') + r.querySelector('.amx-qf-title')?.textContent),
  nav: window.__nav,
}))

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    await tryTest('G4-11', async () => {
      // 源码台账:mod+p 只许一条命令持有(两条同绑 = 后注册的那条永远按不出来)。
      const files = ['bootstrapEngine.tsx', 'amadeusCommands.ts'].map((f) => path.join(SRC, f))
      const hits = files.flatMap((f) => (fs.readFileSync(f, 'utf8').match(/hotkey:\s*['"]mod\+p['"]/g) || []).map(() => path.basename(f)))
      check('G4-11a mod+p 只绑一条命令', hits.length === 1, JSON.stringify(hits))

      const page = await openQF(browser)
      await page.keyboard.type('全新的一篇')
      await page.waitForTimeout(150)
      const s1 = await qfState(page)
      check('G4-11b 无同名笔记 → 列出「新建笔记」行并选中', s1.rows.length === 1 && /^\*新建笔记「全新的一篇」$/.test(s1.rows[0]), JSON.stringify(s1.rows))
      await page.keyboard.press('Enter')
      await page.waitForTimeout(200)
      const s2 = await qfState(page)
      check('G4-11c 回车新建 → createWikiPage(查询串),面板关', !s2.open && JSON.stringify(s2.nav) === JSON.stringify([{ create: '全新的一篇' }]), JSON.stringify(s2))
      await page.close()

      const p2 = await openQF(browser)
      await p2.keyboard.type('月度计划')
      await p2.waitForTimeout(150)
      const s3 = await qfState(p2)
      check('G4-11d 有同名笔记 → 不给新建行', s3.rows.length === 1 && s3.rows[0] === '*月度计划', JSON.stringify(s3.rows))
      await p2.keyboard.press('Meta+Enter')
      await p2.waitForTimeout(300)
      const s4 = await qfState(p2)
      check('G4-11e ⌘Enter → 新标签打开(openView newTab)', JSON.stringify(s4.nav) === JSON.stringify([{ type: 'amadeus-editor', path: '月度计划.md', newTab: true }]), JSON.stringify(s4.nav))
      await p2.close()
    })
    await tryTest('G4-02', async () => {
      /** 在当前聚焦的输入框里起一段真组合(不提交),按 key,量面板状态。 */
      const composeThenPress = async (page, text, key) => {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
        await page.waitForTimeout(150)
        await page.keyboard.press(key)
        await page.waitForTimeout(250)
      }
      // 快速查找:组字回车 / ↓ / Esc
      for (const [key, text, want] of [['Enter', 'moc', 'Enter 不打开第一条'], ['ArrowDown', 'r', '↓ 不移动选中'], ['Escape', 'yue', 'Esc 不关面板']]) {
        const page = await openQF(browser)
        await composeThenPress(page, text, key)
        const after = await qfState(page)
        const ok = after.open && after.nav.length === 0 && (key !== 'ArrowDown' || after.rows.findIndex((r) => r.startsWith('*')) === 0)
        check(`G4-02 快速查找组字中 ${want}`, ok, JSON.stringify({ rows: after.rows.slice(0, 3), open: after.open, nav: after.nav }))
        await page.close()
      }
      // 命令面板(lcl CommandPalette)与模板选择器(Amadeus 浮层):组字回车不执行、Esc 不关。
      const page = await openQF(browser)
      await page.evaluate(() => {
        window.__qf.useQuickFind.getState().close()
        window.__qf.useCommandStore.setState({ commands: [{ id: 'x-cmd', title: 'Xcmd', run: () => window.__nav.push({ ran: 'x-cmd' }) }], paletteOpen: true })
      })
      await page.waitForSelector('.cmd-input')
      await page.focus('.cmd-input')
      await composeThenPress(page, 'x', 'Enter')
      const cp = await page.evaluate(() => ({ open: !!document.querySelector('.cmd-input'), nav: window.__nav }))
      check('G4-02 命令面板组字中 Enter 不执行命令', cp.open && cp.nav.length === 0, JSON.stringify(cp))
      await composeThenPress(page, 'xy', 'Escape')
      const cp2 = await page.evaluate(() => !!document.querySelector('.cmd-input'))
      check('G4-02 命令面板组字中 Esc 不关面板', cp2)
      await page.evaluate(() => {
        window.__qf.useCommandStore.setState({ paletteOpen: false })
        window.__qf.usePageStore.setState({ pages: ['templates/日报.md', '月度计划.md'] })
        window.__qf.useUiOverlay.getState().openTemplate({ v4Path: '月度计划.md' })
      })
      await page.waitForSelector('.cmd-input')
      await page.focus('.cmd-input')
      await composeThenPress(page, 'ri', 'Enter')
      const tp = await page.evaluate(() => ({ overlay: window.__qf.useUiOverlay.getState().overlay, input: !!document.querySelector('.cmd-input') }))
      check('G4-02 模板选择器组字中 Enter 不插模板', tp.overlay === 'template' && tp.input, JSON.stringify(tp))
      // 对照:提交组字后(不在组字中)Enter 照常选中 —— 证明上面不是面板本身坏了。
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.insertText', { text: 'ri' })
      await page.waitForTimeout(150)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(250)
      const tp2 = await page.evaluate(() => window.__qf.useUiOverlay.getState().overlay)
      check('G4-02 对照:组字提交后 Enter 照常选中模板', tp2 === null, String(tp2))
      await page.close()
    })
    await tryTest('G4-06', async () => {
      const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1100, height: 800 } })
      page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
      await page.goto(`${BASE}?upage&useed=${encodeURIComponent('# A\n\nA 正文。\n')}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await page.waitForSelector('.unified-body .ProseMirror', { timeout: 120000 })
      await page.waitForTimeout(400)
      /** 焦点先在编辑器外的输入框(= 快速查找面板里打完字),再经生产 openNote 进入这篇已开着的笔记。 */
      const enter = (focus) => page.evaluate(async (focus) => {
        const i = document.createElement('input')
        document.body.appendChild(i)
        i.focus()
        const nav = await import('/src/amadeusNav.ts')
        i.remove()
        await nav.openNote('Unified.md', focus ? { focus: 'body' } : undefined)
        return window.__upage.probe.view().hasFocus()
      }, focus)
      const without = await enter(false)
      check('G4-06 对照:不带 focus 参数进入 → 焦点不在正文(修前的全部入口)', without === false, String(without))
      const withFocus = await enter(true)
      check("G4-06 openNote(focus:'body') → 正文拿到焦点", withFocus === true, String(withFocus))
      const w0 = await page.evaluate(() => window.__upage.writes.length)
      await page.keyboard.type('zz')
      await page.waitForTimeout(1300)
      const typed = await page.evaluate((w0) => ({ doc: window.__upage.probe.view().state.doc.textContent, writes: window.__upage.writes.length - w0 }), w0)
      check('G4-06 进入后直接打字落进正文并落盘', typed.doc.includes('zz') && typed.writes > 0, JSON.stringify(typed))
      // 源码台账:快速查找的笔记项与日记入口必须带 focus:'body'(新建流不带 —— 新建聚焦标题)。
      const qf = fs.readFileSync(path.join(SRC, 'quickFind.tsx'), 'utf8')
      const tpl = fs.readFileSync(path.join(SRC, 'amadeusTemplates.ts'), 'utf8')
      check("G4-06 快速查找笔记项 / 日记入口带 focus:'body'", /openNote\(p, \{[^}]*focus: 'body'/.test(qf) && /openNote\(path, \{ focus: 'body' \}\)/.test(tpl))
      await page.close()
    })
  } finally {
    await browser.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
})()
