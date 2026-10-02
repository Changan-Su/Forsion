// 页面版本历史(评审 C-20):「⋯ → 版本历史」面板 + 恢复。台架 `?upage&upane&uhist`:`&uhist` 给内存 vault 桥挂上与主进程
// fs/pageHistory 同口径的内存快照(CAS 写用盘上旧文留一份、时间窗内最多一份、与最近一份相同不存;恢复 = 比对 → 强制补快照 → 写回),
// 顶栏 ⋯ 与生产 amadeusViews 同一个 PageHistoryHost(门控 canPageHistory)。存储 / 淘汰 / 主进程恢复的单测在
// electron/amadeus/fs/pageHistory.test.ts。
// 钉:桥不实现 → ⋯ 里没有入口;真打字留快照(存的是旧文);列表新→旧、相对 + 绝对时间 + 大小;原文 / 对比两种预览;
// 恢复须二次确认 → 盘上换版、编辑器走外部回灌(同一个 PM 实例,不重挂)、恢复前的内容进历史;恢复后 Cmd+Z 不撤回恢复(拍板 #7);
// 锁定页能看不能恢复;英文界面文案跟语言。
// 用法:npm run check:pagehistory(由 e2e-editor 自起 / 复用 Vite);`--shot=<目录>` 留明暗 / 窄屏截图(DESIGN §8)。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const SHOT = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice('--shot='.length)
if (SHOT) fs.mkdirSync(SHOT, { recursive: true })
const shot = async (page, name, opts = {}) => { if (SHOT) await page.screenshot({ path: path.join(SHOT, `${name}.png`), ...opts }) }

const SEED = '# 历史标题\n\n第一段原文。\n\n第二段原文。\n'
const P = 'Unified.md'

const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function open(page, flags) {
  await page.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unified-body .ProseMirror p', { timeout: 30000 })
  await page.waitForTimeout(400)
}
const openMenu = async (page) => {
  await page.click('.amx-toolbar .amx-more-btn')
  await page.waitForSelector('[data-pagestyle-menu]', { timeout: 5000 })
}
const openPanel = async (page) => {
  await openMenu(page)
  await page.click('[data-page-history]')
  await page.waitForSelector('[data-testid="page-history"]', { timeout: 10000 })
  await page.waitForFunction(() => document.querySelector('[data-testid="page-history"] .amx-hist-row, [data-testid="page-history"] [data-hist-empty]'), null, { timeout: 10000 })
}
const panelState = (page) => page.evaluate(() => {
  const root = document.querySelector('[data-testid="page-history"]')
  if (!root) return null
  return {
    title: root.querySelector('.dialog-title')?.textContent ?? '',
    rows: [...root.querySelectorAll('.amx-hist-row')].map((r) => ({ id: r.dataset.histId, sel: r.getAttribute('aria-selected'), rel: r.querySelector('.amx-hist-rel')?.textContent, meta: r.querySelector('.amx-hist-meta')?.textContent })),
    pre: root.querySelector('.amx-hist-text')?.textContent ?? null,
    restoreDisabled: root.querySelector('[data-hist-restore]')?.disabled ?? null,
    restoreText: root.querySelector('[data-hist-restore]')?.textContent ?? '',
    hint: root.querySelector('.amx-hist-hint')?.textContent ?? '',
  }
})
const bodyText = (page) => page.evaluate(() => document.querySelector('.unified-body .ProseMirror').innerText)
const savesOf = (page) => page.evaluate((p) => window.__upage.writes.filter((w) => w.path === p).length, P)
async function typeAtEnd(page, s) {
  await page.click('.unified-body .ProseMirror p:last-of-type')
  await page.keyboard.press('Meta+ArrowDown')
  await page.waitForTimeout(150) // 等 selectionchange 把新光标交给 PM
  const before = await savesOf(page)
  await page.keyboard.type(s)
  await page.waitForFunction(([p, n]) => window.__upage.writes.filter((w) => w.path === p).length > n, [P, before], { timeout: 8000 })
  await page.waitForTimeout(100)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))

  // ── H0 门控:桥没有 listPageHistory(web 云桥 / 移动本地库的形态)→ ⋯ 里不出「版本历史」 ──
  await open(page, '&upane')
  await openMenu(page)
  check('H0 桥不实现版本历史 → ⋯ 里没有入口', (await page.locator('[data-page-history]').count()) === 0)

  // ── H1 真打字留快照:存的是写之前的盘上旧文 ──
  await open(page, '&upane&uhist')
  await page.evaluate(() => {
    window.__upage.historyWindowMs = 0 // 每次保存都留一份(时间窗口径由单测钉)
    window.__toasts = []
    window.addEventListener('amadeus:toast', (e) => window.__toasts.push(e.detail))
  })
  await typeAtEnd(page, '甲')
  await typeAtEnd(page, '乙')
  const snaps = await page.evaluate((p) => (window.__upage.history.get(p) ?? []).map((e) => e.text), P)
  check('H1 两次保存留两份快照,存的是旧文(先原文,后「甲」那版)', snaps.length === 2 && !snaps[0].includes('甲') && snaps[0].includes('第二段原文。') && snaps[1].includes('甲') && !snaps[1].includes('乙'), JSON.stringify(snaps))

  // ── H2 面板:新→旧、相对 + 绝对时间 + 大小;默认选最新;原文预览 ──
  await openMenu(page)
  const label = await page.locator('[data-page-history]').textContent()
  await page.click('[data-page-history]')
  await page.waitForSelector('[data-testid="page-history"] .amx-hist-row', { timeout: 10000 })
  await page.waitForSelector('[data-testid="page-history"] .amx-hist-text', { timeout: 10000 })
  const s2 = await panelState(page)
  check('H2 ⋯ 入口文案「版本历史」,面板标题带笔记名', label?.trim() === '版本历史' && s2.title.includes('版本历史') && s2.title.includes('Unified'), JSON.stringify({ label, title: s2.title }))
  check('H2 两行、新在上、默认选中最新;行里有「刚刚」+ 绝对时间 + 字节数', s2.rows.length === 2 && s2.rows[0].sel === 'true' && s2.rows[1].sel === 'false'
    && s2.rows.every((r) => r.rel === '刚刚' && /\d{1,2}:\d{2}/.test(r.meta) && /\d+(\.\d)? (B|KB)/.test(r.meta)), JSON.stringify(s2.rows))
  check('H2 原文预览 = 最新那份(有「甲」无「乙」)', s2.pre != null && s2.pre.includes('第二段原文。甲') && !s2.pre.includes('乙'), JSON.stringify(s2.pre))
  check('H2 未锁定:「恢复此版本」可点,提示「恢复前会先存」', s2.restoreDisabled === false && s2.hint.includes('恢复前'), JSON.stringify({ d: s2.restoreDisabled, hint: s2.hint }))

  // ── H3 与当前对比:diff2html 出删 / 增行 ──
  await page.click('[data-hist-tab="diff"]')
  await page.waitForSelector('[data-testid="page-history"] .d2h-wrapper', { timeout: 10000 })
  const d3 = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="page-history"]')
    return { del: r.querySelectorAll('.d2h-del').length, ins: r.querySelectorAll('.d2h-ins').length, txt: r.querySelector('.d2h-wrapper').textContent }
  })
  check('H3 对比视图:当前 → 此版本 有删 / 增行(「乙」那行)', d3.del > 0 && d3.ins > 0 && d3.txt.includes('乙'), JSON.stringify({ del: d3.del, ins: d3.ins }))
  await shot(page, 'history-diff-light')

  // ── H4 恢复最旧那份:二次确认 → 盘上换版、编辑器同一实例回灌、成功提示 ──
  await page.click('[data-hist-tab="content"]')
  await page.click(`[data-hist-id="${s2.rows[1].id}"]`)
  await page.waitForFunction(() => !document.querySelector('[data-testid="page-history"] .amx-hist-text')?.textContent.includes('甲'), null, { timeout: 5000 })
  await page.waitForTimeout(200)
  await shot(page, 'history-panel-light')
  await page.evaluate(() => { document.querySelector('.unified-body .ProseMirror').dataset.histMark = '1' })
  await page.click('[data-hist-restore]')
  await page.waitForSelector('.dialog:not(.amx-hist) .dialog-title', { timeout: 5000 })
  const confirmTitle = await page.locator('.dialog:not(.amx-hist) .dialog-title').textContent()
  const vaultBefore = await page.evaluate((p) => window.__upage.vault.get(p), P)
  await page.waitForTimeout(300) // 浮层淡入
  const onTop = await page.evaluate(() => {
    const d = document.querySelector('.dialog:not(.amx-hist)')
    const r = d.getBoundingClientRect()
    return d.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
  })
  check('H4 恢复先弹确认(压在面板之上;此时盘上不动)', /恢复到 .+ 的版本/.test(confirmTitle ?? '') && onTop && vaultBefore.includes('甲乙'), JSON.stringify({ confirmTitle, onTop }))
  await shot(page, 'history-confirm-light')
  await page.click('.dialog:not(.amx-hist) .dialog-btn[data-primary]')
  await page.waitForSelector('[data-testid="page-history"]', { state: 'detached', timeout: 8000 })
  await page.waitForFunction(() => !document.querySelector('.unified-body .ProseMirror').innerText.includes('甲'), null, { timeout: 8000 }).catch(() => {})
  const h4 = await page.evaluate((p) => ({
    disk: window.__upage.vault.get(p),
    body: document.querySelector('.unified-body .ProseMirror').innerText,
    sameInstance: document.querySelector('.unified-body .ProseMirror').dataset.histMark === '1',
    toasts: window.__toasts.map((t) => `${t.level}:${t.text}`),
  }), P)
  check('H4 盘上 = 选中那份(原文),编辑器跟上', h4.disk === snaps[0] && !h4.body.includes('甲') && h4.body.includes('第二段原文。'), JSON.stringify({ disk: h4.disk, body: h4.body }))
  check('H4 走外部回灌:同一个 PM 实例(没换 key 重挂)', h4.sameInstance)
  check('H4 成功提示', h4.toasts.some((t) => t.startsWith('success:已恢复到')), JSON.stringify(h4.toasts))

  // ── H5 恢复前的内容进了历史(恢复可撤回)──
  const snaps5 = await page.evaluate((p) => (window.__upage.history.get(p) ?? []).map((e) => e.text), P)
  check('H5 恢复前的「甲乙」那版成为最新一份', snaps5.length === 3 && snaps5[2].includes('甲乙'), JSON.stringify(snaps5.map((s) => s.slice(-12))))

  // ── H6 恢复后 Cmd+Z 不把恢复撤回(回灌不进撤销栈,拍板 #7)──
  await page.click('.unified-body .ProseMirror p:last-of-type')
  await page.waitForTimeout(150)
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(1500)
  const h6 = await page.evaluate((p) => ({ disk: window.__upage.vault.get(p), body: document.querySelector('.unified-body .ProseMirror').innerText }), P)
  check('H6 Cmd+Z 之后正文与盘上都没回到恢复前', !h6.body.includes('甲') && !h6.disk.includes('甲'), JSON.stringify(h6))

  // ── H7 英文界面:入口与面板文案跟语言 ──
  await page.evaluate(() => window.__upage.setLocale('en'))
  await page.waitForTimeout(150)
  await openMenu(page)
  const enItem = await page.locator('[data-page-history]').textContent()
  await page.click('[data-page-history]')
  await page.waitForSelector('[data-testid="page-history"] .amx-hist-row', { timeout: 10000 })
  const en = await page.evaluate((item) => ({
    item,
    s: { title: document.querySelector('[data-testid="page-history"] .dialog-title')?.textContent, restore: document.querySelector('[data-hist-restore]')?.textContent, tabs: [...document.querySelectorAll('[data-hist-tab]')].map((b) => b.textContent) },
  }), enItem)
  check('H7 英文:Version history / Restore this version / Content · Compare with current', en.item?.trim() === 'Version history' && en.s.title?.startsWith('Version history') && en.s.restore === 'Restore this version' && en.s.tabs.join('|') === 'Content|Compare with current', JSON.stringify(en))
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="page-history"]', { state: 'detached', timeout: 5000 })
  check('H7 Esc 关面板', true)
  await page.evaluate(() => window.__upage.setLocale('zh'))

  // ── H8 锁定页:能看,不能恢复 ──
  const lockPage = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  await open(lockPage, '&upane&uhist&ulock')
  await lockPage.evaluate(async (p) => {
    window.__upage.history.set(p, [{ id: 'm0-00000001', at: Date.now() - 3 * 3600e3, size: 9, text: '# 很早的版本\n' }])
    await window.__upage.setLocked(true)
  }, P)
  await lockPage.waitForTimeout(400)
  await openPanel(lockPage)
  await lockPage.waitForSelector('[data-testid="page-history"] .amx-hist-text', { timeout: 10000 })
  const s8 = await panelState(lockPage)
  check('H8 锁定页:列表与预览照常,「恢复此版本」置灰 + 说明', s8.rows.length === 1 && s8.rows[0].rel === '3 小时前' && s8.pre?.includes('很早的版本') && s8.restoreDisabled === true && s8.hint.includes('锁定'), JSON.stringify(s8))
  await lockPage.close()

  // ── 截图自查(DESIGN §8):暗色 + 窄屏 ──
  if (SHOT) {
    const dark = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
    await open(dark, '&upane&uhist&udark')
    await dark.evaluate((p) => {
      const t = Date.now()
      window.__upage.history.set(p, [
        { id: 'm1-00000001', at: t - 26 * 3600e3, size: 30, text: '# 历史标题\n\n很早的第一段。\n' },
        { id: 'm2-00000002', at: t - 40 * 60e3, size: 46, text: '# 历史标题\n\n第一段原文。\n\n第二段草稿。\n' },
      ])
    }, P)
    await openPanel(dark)
    await dark.waitForSelector('[data-testid="page-history"] .amx-hist-text', { timeout: 10000 })
    await dark.waitForTimeout(300)
    await shot(dark, 'history-panel-dark')
    await dark.click('[data-hist-tab="diff"]')
    await dark.waitForSelector('[data-testid="page-history"] .d2h-wrapper', { timeout: 10000 })
    await dark.waitForTimeout(300)
    await shot(dark, 'history-diff-dark')
    await dark.close()
    const narrow = await browser.newPage({ locale: 'zh-CN', viewport: { width: 390, height: 844 } })
    await open(narrow, '&upane&uhist')
    await narrow.evaluate((p) => { window.__upage.history.set(p, [{ id: 'm1-00000001', at: Date.now() - 600e3, size: 30, text: '# 历史标题\n\n很早的第一段。\n' }]) }, P)
    await openPanel(narrow)
    await narrow.waitForTimeout(400)
    const over = await narrow.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    check('H9 窄屏(390):面板不撑出横向滚动', !over)
    await shot(narrow, 'history-panel-390')
    await narrow.close()
  }

  await browser.close()
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
