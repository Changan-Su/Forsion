// 双链右键 = 这份文件的菜单(2026-10-13 用户定:双链是一个文件,右键出文件的操作,不是文字编辑的系统菜单)。
//
//  渲染出来的双链在 contextmenu 时派 amadeus:wikilink-menu(blocks/markdown/wikilink.ts),宿主 amadeusLinkMenu 接:
//  认得出目标 → 不出系统菜单、弹自己的;外链不接。目标解析的口径在 amadeus/lib/wikiTarget(单测另钉)。
//
//  M1 笔记链接右键 → 出菜单、系统菜单被拦;有「新标签页 / 文件管理器 / 复制路径 / 编辑链接」,没有「用系统程序打开」
//  M2 文件链接(PDF 带页码)右键 → 多一项「用系统程序打开」;「复制路径」写进剪贴板的是库内路径(不带 #page)
//  M3 「在新标签页打开」→ 走 openWikiLink 的 newTab(PDF 的打开事件带 newTab、带页码)
//  M4 「在文件管理器中显示」「用系统程序打开」→ 用解析出来的库内路径调桥
//  M5 库里没有的链接 → 只有「创建笔记」和「编辑链接」;点「创建笔记」进询问创建
//  M6 外链 `[[https://…]]` → 不接(不出菜单、不拦系统菜单)
//  M7 「编辑链接」→ 光标进到那条 `[[…]]` 源码里(那一行露出源码)
//  M8 点菜单外 / 按 Esc → 收起
//  M9 正文文字上右键 → 不出这份菜单(照旧系统菜单)
//
// 用法:npm run check:linkmenu(= node scripts/e2e-editor.cjs --check=link-menu;worktree 里设 HARNESS_URL)
const fs = require('fs'), os = require('os'), path = require('path')
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

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const MENU = '.amx-link-menu'
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SEED = '# T\n\n正文一段,提到 [[Imaginary Time]] 和 [[project_book (1).pdf#page=12]]。\n\n还没有的 [[Missing Note]],外链 [[https://example.com/x]]。\n\n结尾一段。\n'

async function open(browser) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.evaluate(() => {
    window.__upage.pageStore.setState({ pages: ['Unified.md', 'notes/Imaginary Time.md'], files: ['docs/project_book (1).pdf'] })
    const v = window.__upage.probe.view(); v.dispatch(v.state.tr.setMeta('link-menu-check', 1))
    // 观测位:系统菜单有没有被拦(捕获期挂、下一拍读 defaultPrevented)、打开事件、桥调用、剪贴板。
    window.__lm = { ctx: [], opened: [], bridge: [], clip: [] }
    window.addEventListener('contextmenu', (e) => setTimeout(() => window.__lm.ctx.push(e.defaultPrevented), 0), true)
    for (const t of ['amadeus:open-pdf', 'amadeus:open-file']) window.addEventListener(t, (e) => window.__lm.opened.push({ type: t, ...e.detail }))
    window.amadeus.revealInFileManager = (p) => { window.__lm.bridge.push(['reveal', p]); return Promise.resolve() }
    window.amadeus.openVaultFile = (p) => { window.__lm.bridge.push(['system', p]); return Promise.resolve() }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (s) => { window.__lm.clip.push(s); return Promise.resolve() } } })
  })
  await p.waitForFunction(() => document.querySelectorAll('.unified-body .wikilink:not(.wikilink-unresolved)').length >= 2, null, { timeout: 20000 })
  return p
}

const link = (p, text) => p.locator(`${PM} .wikilink`, { hasText: text }).first()
const rclick = async (p, text) => { await link(p, text).click({ button: 'right' }); await p.waitForTimeout(150) }
const acts = (p) => p.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].map((b) => b.dataset.act), MENU)
const lastCtx = (p) => p.evaluate(() => window.__lm.ctx[window.__lm.ctx.length - 1])
const pick = async (p, act) => { await p.click(`${MENU} button[data-act="${act}"]`); await p.waitForTimeout(150) }
const menuOpen = (p) => p.evaluate((sel) => !!document.querySelector(sel), MENU)

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const p = await open(browser)

    // M1
    await rclick(p, 'Imaginary Time')
    let a = await acts(p)
    record('M1 笔记链接右键 → 出菜单、系统菜单被拦;没有「用系统程序打开」',
      a.includes('newtab') && a.includes('reveal') && a.includes('copypath') && a.includes('edit') && !a.includes('system') && !a.includes('create') && (await lastCtx(p)) === true,
      `${JSON.stringify(a)} prevented=${await lastCtx(p)}`)
    await p.keyboard.press('Escape'); await p.waitForTimeout(100)
    const closedByEsc = !(await menuOpen(p))

    // M2
    await rclick(p, 'project_book')
    a = await acts(p)
    await pick(p, 'copypath')
    let st = await p.evaluate(() => window.__lm)
    record('M2 文件链接右键 → 多「用系统程序打开」;复制的是库内路径',
      a.includes('system') && a.includes('newtab') && st.clip[st.clip.length - 1] === 'docs/project_book (1).pdf' && !(await menuOpen(p)),
      `${JSON.stringify(a)} clip=${JSON.stringify(st.clip)}`)

    // M3
    await rclick(p, 'project_book')
    await pick(p, 'newtab')
    st = await p.evaluate(() => window.__lm)
    const ev = st.opened[st.opened.length - 1]
    record('M3 「在新标签页打开」→ 打开事件带 newTab 和页码', !!ev && ev.type === 'amadeus:open-pdf' && ev.path === 'docs/project_book (1).pdf' && ev.newTab === true && ev.page === 12, JSON.stringify(ev))

    // M4
    await rclick(p, 'project_book'); await pick(p, 'reveal')
    await rclick(p, 'project_book'); await pick(p, 'system')
    st = await p.evaluate(() => window.__lm)
    record('M4 文件管理器 / 系统程序 → 用解析出来的库内路径调桥',
      JSON.stringify(st.bridge) === JSON.stringify([['reveal', 'docs/project_book (1).pdf'], ['system', 'docs/project_book (1).pdf']]), JSON.stringify(st.bridge))

    // M5
    await rclick(p, 'Missing Note')
    a = await acts(p)
    await pick(p, 'create')
    const pending = await p.evaluate(() => window.__upage.pageStore.getState().pendingWikiCreate)
    record('M5 库里没有的链接 → 只有「创建笔记 / 编辑链接」;创建进询问', JSON.stringify(a) === JSON.stringify(['create', 'edit']) && pending?.name === 'Missing Note', `${JSON.stringify(a)} pending=${JSON.stringify(pending)}`)
    await p.evaluate(() => window.__upage.pageStore.setState({ pendingWikiCreate: null }))

    // M6
    await rclick(p, 'example.com')
    record('M6 外链 → 不接(不出菜单、不拦系统菜单)', !(await menuOpen(p)) && (await lastCtx(p)) === false, `open=${await menuOpen(p)} prevented=${await lastCtx(p)}`)

    // M7
    await rclick(p, 'Imaginary Time')
    await pick(p, 'edit')
    const src = await p.evaluate(() => {
      const v = window.__upage.probe.view()
      const { $from } = v.state.selection
      const text = $from.parent.textContent
      const at = text.indexOf('[[Imaginary Time]]')
      return { inside: $from.parentOffset > at && $from.parentOffset < at + '[[Imaginary Time]]'.length, focused: v.hasFocus(), rendered: [...document.querySelectorAll('.unified-body .wikilink')].some((e) => e.textContent.includes('Imaginary Time')) }
    })
    record('M7 「编辑链接」→ 光标进到那条源码里,该行露出源码', src.inside && src.focused && !src.rendered, JSON.stringify(src))

    // M8
    await p.evaluate(() => { const v = window.__upage.probe.view(); v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.atEnd(v.state.doc))) })
    await p.waitForTimeout(150)
    await rclick(p, 'Imaginary Time')
    const wasOpen = await menuOpen(p)
    await p.mouse.click(900, 700); await p.waitForTimeout(150)
    record('M8 点菜单外 / 按 Esc → 收起', wasOpen && !(await menuOpen(p)) && closedByEsc, `开过=${wasOpen} 点外后=${await menuOpen(p)} Esc=${closedByEsc}`)

    // M9
    await p.locator(`${PM} p`, { hasText: '结尾一段' }).click({ button: 'right' }); await p.waitForTimeout(150)
    record('M9 正文文字上右键 → 不出这份菜单', !(await menuOpen(p)) && (await lastCtx(p)) === false, `open=${await menuOpen(p)} prevented=${await lastCtx(p)}`)

    if (process.argv.some((x) => x.startsWith('--shot'))) {
      const dir = (process.argv.find((x) => x.startsWith('--shot=')) || '').slice(7) || os.tmpdir()
      await rclick(p, 'project_book')
      await p.screenshot({ path: path.join(dir, 'link-menu.png') })
      console.log('shot →', path.join(dir, 'link-menu.png'))
    }
    await p.close()
  } finally {
    await browser.close()
  }
  const bad = results.filter((x) => !x).length
  console.log(bad ? `\n${bad} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
