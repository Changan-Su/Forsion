// 「从编辑器外进入」的几个输入框(npm run check:quickfind;真 Chromium × `?qf` 台架)。
// 由来:2026-09-27 编辑器评审 G4 组。
//   G4-11 ⌘P 曾被 quick-find 与 Amadeus 快速切换两条命令同时绑定,分发取先注册的那条,能新建笔记的切换器
//         永远按不出来 —— 合成一个:全局快速查找吸收「新建笔记」行(走 G4-12 素文件出生)+ ⌘/Ctrl+Enter 新标签打开;
//         源码里 `hotkey: 'mod+p'` 只许出现一次。
//   G4-02 快速查找 / 模板选择器 / 命令面板的输入框没有 IME 守卫:拼音组字中按 Enter 直接打开第一条、↓ 移动选中、
//         Esc 连面板一起关掉。合成 KeyboardEvent 的 isComposing 到不了 React,必须走 CDP Input.imeSetComposition。
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
  } finally {
    await browser.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
})()
