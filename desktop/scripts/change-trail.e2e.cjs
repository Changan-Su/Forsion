/**
 * 文件改动记录(11-06 方案 A + C)的真 Electron 台架:桩引擎按演示会话的「改前 / 改后」全文真算 diff,
 * 断言回执 / 工具行摘要 / 任务概览「改动」卡 / 审阅页 / 撤销接线 / 英文 / 手机抽屉,并拍图对方案。
 *
 *   npx electron-vite build
 *   node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="改动记录台架" --eta=4 -- node scripts/change-trail.e2e.cjs
 *   (SHOT_DIR=… 指定出图目录;缺省在系统临时目录)
 *
 * 引擎那半(检查点 → 真增减 / diff / 按文件撤销)由 tangu-agent 的 checkpoints.changes.test.ts 管,这里只证渲染与接线。
 */
const path = require('path')
const { structuredPatch } = require('diff')
const { launch, boot, enterSpace, shotDir, makeReporter } = require('./lib/uiux-electron.cjs')
const { SID, SESSION, PROJECT, T, messages, FILES } = require('./fixtures/change-trail-session.cjs')

const OUT = shotDir('change-trail')
const T2 = T + 600000 // 第二轮起点(第二条用户消息)
const abs = (rel) => `${PROJECT}/${rel}`

// 某一刻文件的样子:第一轮之前 v0、两轮之间 v1、之后 v2
const at = (f, ts) => (ts == null ? f.v2 : ts <= T ? f.v0 : ts <= T2 ? f.v1 : f.v2)
const reverted = new Set() // 撤销过的文件(绝对路径):之后按「回到改前」算

function fileChange(rel, since, until, withPatch) {
  const f = FILES[rel]
  const before = at(f, since)
  let after = at(f, until)
  if (reverted.has(abs(rel)) && until == null) after = before
  if (before === after) return reverted.has(abs(rel)) && until == null && at(f, since) !== f.v2 ? { path: abs(rel), kind: before == null ? 'created' : 'modified', adds: 0, dels: 0, reverted: true, runs: 1 } : null
  const kind = before == null ? 'created' : after == null ? 'deleted' : 'modified'
  const p = structuredPatch(rel, rel, before || '', after || '', '', '', { context: 2 })
  let adds = 0, dels = 0
  const body = []
  for (const h of p.hunks) {
    body.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines) { body.push(l); if (l[0] === '+') adds++; else if (l[0] === '-') dels++ }
  }
  return { path: abs(rel), kind, adds, dels, runs: 1, ...(withPatch ? { patch: body.join('\n') } : {}) }
}
const filesIn = (since, until, withPatch) => Object.keys(FILES).map((rel) => fileChange(rel, since, until, withPatch)).filter(Boolean)

// 「未提交」:除了写文件工具改的,还有一个命令改的(npm install 动了锁文件)
const LOCK_PATCH = '@@ -1204,6 +1204,9 @@\n       "dev": true\n     },\n+    "node_modules/papaparse": {\n+      "version": "5.4.1"\n+    },\n     "node_modules/picocolors": {\n-      "version": "1.0.0"\n+      "version": "1.1.1"\n     }'

const seen = { restore: [] }
const override = async ({ path: p, method, url, body }) => {
  const m = /^\/agent\/sessions\/([^/]+)\/changes(\/diff|\/git)?$/.exec(p)
  if (m && method === 'GET') {
    if (m[2] === '/git') {
      return { available: true, root: PROJECT, files: [...filesIn(0, null, true), { path: abs('package-lock.json'), kind: 'modified', adds: 4, dels: 1, runs: 0, patch: LOCK_PATCH }] }
    }
    if (m[2] === '/diff') {
      const since = Number(url.searchParams.get('since'))
      const untilRaw = url.searchParams.get('until')
      const until = untilRaw ? Number(untilRaw) : null
      const only = url.searchParams.get('path')
      return { files: filesIn(since, until, true).filter((f) => !only || f.path === only) }
    }
    const bounds = (url.searchParams.get('bounds') || '').split(',').filter(Boolean).map(Number)
    if (!bounds.length) return { windows: [{ since: 0, until: null, files: filesIn(0, null, false) }] }
    return { windows: bounds.map((since, i) => ({ since, until: bounds[i + 1] ?? null, files: filesIn(since, bounds[i + 1] ?? null, false) })) }
  }
  if (/\/checkpoints\/restore$/.test(p) && method === 'POST') {
    const b = await body()
    seen.restore.push(b)
    for (const x of b.paths || []) reverted.add(x)
    return { restored: b.paths || [], deleted: [], skipped: [], conflicts: [], failed: [] }
  }
  return undefined
}

async function main() {
  const r = makeReporter()
  const ctx = await launch({ tag: 'change-trail', fixtures: { agents: [], sessions: [SESSION] }, messages, stubOverride: override })
  const { win } = ctx
  const shot = async (name, opts = {}) => { await win.waitForTimeout(350); await win.screenshot({ path: path.join(OUT, `${name}.png`), ...opts }); r.note('shot', path.join(OUT, `${name}.png`)) }
  // 明暗 / 配色:写偏好再重载(直接改 <html> 的属性会被主题 store 刷回去)
  const theme = async (mode, skin) => {
    await win.evaluate(({ mode, skin }) => {
      localStorage.setItem('forsion_theme_pref', mode); localStorage.setItem('forsion_theme', mode)
      localStorage.setItem('forsion_theme_skin', skin); localStorage.setItem('forsion_theme_bg', skin)
    }, { mode, skin })
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await open(); await toBottom()
  }
  const open = async () => {
    const row = win.locator(`.t2s-srow[data-sel-id="${SID}"]`).first(); await row.waitFor({ timeout: 20000 }); await row.click()
    await win.locator('.t2-asst-col').last().waitFor(); await win.evaluate(() => document.fonts.ready)
    await win.locator('[data-change-receipt]').last().waitFor({ timeout: 15000 })
  }
  const toBottom = () => win.evaluate(() => { let e = document.querySelector('.t2-asst-col'); while (e && !/(auto|scroll)/.test(getComputedStyle(e).overflowY)) e = e.parentElement; if (e) e.scrollTop = e.scrollHeight })
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    await open(); await theme('light', 'cream')

    // ── A 回执 ──
    const receipts = win.locator('[data-change-receipt]')
    r.check('A1 每轮一条回执', (await receipts.count()) === 2, `count=${await receipts.count()}`)
    const t0 = await receipts.nth(0).innerText(), t1 = await receipts.nth(1).innerText()
    r.check('A2 第一轮 改了 1 个文件 +1 −1', /改了 1 个文件/.test(t0) && /\+1/.test(t0) && /−1/.test(t0), t0.replace(/\n/g, ' '))
    r.check('A3 第二轮 改了 4 个文件', /改了 4 个文件/.test(t1), t1.replace(/\n/g, ' '))
    const groupHead = await win.locator('.tool-group-head').last().innerText()
    r.check('A4 过程行按文件数(写入 1 · 编辑 3)', /写入 1 文件/.test(groupHead) && /编辑 3 文件/.test(groupHead), groupHead.replace(/\n/g, ' '))
    await win.mouse.move(1400, 120)
    await shot('a1-collapsed-light')

    await receipts.nth(1).locator('.ct-rcpt-head').click()
    const rows = receipts.nth(1).locator('.ct-row')
    r.check('A5 展开列出 4 个文件', (await rows.count()) === 4)
    const csvRow = receipts.nth(1).locator('[data-change-file="toCsv.ts"]')
    r.check('A6 新建文件带「新建」', /新建/.test(await csvRow.innerText()))
    const reportRow = receipts.nth(1).locator('[data-change-file="ReportView.tsx"]')
    await reportRow.locator('.ct-row-head').click()
    await reportRow.locator('[data-change-diff]').waitFor({ timeout: 10000 })
    const lnText = await reportRow.locator('[data-change-diff] td.ln').allInnerTexts()
    r.check('A7 diff 带真行号', lnText.some((x) => Number(x) > 3), lnText.filter(Boolean).slice(0, 6).join(','))
    r.check('A8 两处改动之间有「⋯ 第 N 行」分隔', (await reportRow.locator('tr.hunk').count()) >= 1)
    await reportRow.hover()
    await shot('a2-open-code-light')

    const manualRow = receipts.nth(1).locator('[data-change-file="用户手册.md"]')
    await reportRow.locator('.ct-row-head').click() // 收起
    await manualRow.locator('.ct-row-head').click()
    await manualRow.locator('.ct-diff.prose').waitFor({ timeout: 10000 })
    r.check('A9 文字文件按字标(.w)', (await manualRow.locator('.ct-diff.prose .w').count()) > 0)
    const foot1 = await receipts.nth(1).locator('.ct-rcpt-foot').innerText()
    r.check('A10 最新一轮 = 撤销这一轮的改动 + 说明 run_bash', /撤销这一轮的改动/.test(foot1) && /命令里改的/.test(foot1), foot1.replace(/\n/g, ' '))
    await receipts.nth(0).locator('.ct-rcpt-head').click()
    const foot0 = await receipts.nth(0).locator('.ct-rcpt-foot').innerText()
    r.check('A11 更早一轮 = 撤销到这一轮之前', /撤销到这一轮之前/.test(foot0), foot0.replace(/\n/g, ' '))
    await receipts.nth(0).locator('.ct-rcpt-head').click()

    // ── 撤销接线 ──
    const i18nRow = receipts.nth(1).locator('[data-change-file="report.ts"]')
    await i18nRow.hover()
    await i18nRow.locator('.ct-row-ops .ct-act', { hasText: '撤销' }).click()
    const dlg = win.locator('[data-change-undo-confirm] .dialog')
    await dlg.waitFor({ timeout: 5000 })
    r.check('U1 确认框列出文件', /report\.ts/.test(await dlg.innerText()))
    await shot('u1-confirm-light')
    await dlg.locator('.dialog-btn[data-primary]').click()
    await win.waitForFunction(() => true)
    for (let i = 0; i < 40 && !seen.restore.length; i++) await win.waitForTimeout(100)
    const rb = seen.restore[0] || {}
    r.check('U2 撤销请求 = 这一轮起点 + 只这个文件 + keepEdited', rb.at === T2 && JSON.stringify(rb.paths) === JSON.stringify([abs('src/i18n/report.ts')]) && rb.keepEdited === true, JSON.stringify(rb))
    await win.locator('[data-change-file="report.ts"] .ct-tag', { hasText: '已撤销' }).first().waitFor({ timeout: 8000 }).then(() => r.check('U3 撤销后重拉、标「已撤销」', true), () => r.check('U3 撤销后重拉、标「已撤销」', false))

    // ── C 任务概览「改动」卡 ──
    const card = win.locator('[data-card="changes"]')
    await card.waitFor({ timeout: 8000 }).catch(() => {})
    r.check('C1 任务概览有「改动」卡', (await card.count()) === 1)
    if (await card.count()) {
      r.check('C2 产物卡不再列写盘文件', (await win.locator('[data-card="outputs"]').count()) === 0)
      const cardRow = card.locator('[data-change-file="ReportView.tsx"]')
      await cardRow.hover()
      r.check('C3 停上去露「撤销」', await cardRow.locator('.ct-crow-undo').isVisible())
      const box = await card.boundingBox()
      await shot('c1-card-light', box ? { clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 } } : {})
      await card.locator('[data-change-scope="session"]').click()
      await win.waitForTimeout(800)
      r.check('C4 本会话档记在这台电脑上', (await win.evaluate(() => localStorage.getItem('forsion.changes.scope'))) === 'session')
      r.check('C5 切档不折叠卡片', await card.evaluate((d) => d.open))
      const box2 = await card.boundingBox()
      await shot('c2-card-session-light', box2 ? { clip: { x: box2.x - 12, y: box2.y - 12, width: box2.width + 24, height: box2.height + 24 } } : {})
      await card.locator('[data-change-scope="turn"]').click()
      await card.locator('[data-change-review]').click()
      const page = win.locator('[data-change-review-page]').first()
      await page.waitFor({ timeout: 10000 })
      await page.locator('[data-rv-file]').first().waitFor({ timeout: 10000 })
      r.check('C6 审阅页列出本轮文件', (await page.locator('[data-rv-file]').count()) >= 3, `n=${await page.locator('[data-rv-file]').count()}`)
      await win.mouse.move(1400, 120)
      await shot('c3-review-turn-light')
      await page.locator('[data-change-scope="git"]').click()
      await page.locator(`[data-rv-file="${abs('package-lock.json')}"]`).waitFor({ timeout: 10000 })
      r.check('C7 未提交档含命令改的文件,且不给撤销', (await page.locator('[data-change-undo-all]').count()) === 0)
      await shot('c4-review-git-light')
    }

    // ── 暗色 / 别的配色(审阅页留在 Desk 里,重载后还在) ──
    const reviewScope = async (k) => {
      const pg = win.locator('[data-change-review-page]').first()
      if (!(await pg.count())) return false
      await pg.locator(`[data-change-scope="${k}"]`).click(); await pg.locator('[data-rv-file]').first().waitFor({ timeout: 10000 })
      return true
    }
    await theme('light', 'teal')
    if (await reviewScope('git')) { await win.mouse.move(1400, 120); await shot('c4-review-git-teal') }
    await theme('dark', 'cream')
    r.check('D1 暗色真的生效', await win.evaluate(() => document.documentElement.classList.contains('dark')))
    {
      const rc = win.locator('[data-change-receipt]').last()
      await rc.locator('.ct-rcpt-head').click()
      const mr = rc.locator('[data-change-file="用户手册.md"]')
      await mr.locator('.ct-row-head').click(); await mr.locator('.ct-diff.prose').waitFor({ timeout: 10000 }); await mr.hover()
      await shot('a3-open-prose-dark')
      if (await reviewScope('session')) await shot('c5-review-session-dark')
    }
    await theme('light', 'cream')

    // ── 英文 ──
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await open(); await toBottom()
    const en = await win.locator('[data-change-receipt]').last().innerText()
    r.check('E1 英文回执', /Changed 4 file\(s\)/.test(en), en.replace(/\n/g, ' '))
    await win.mouse.move(1400, 120)
    await shot('e1-collapsed-en')
    await win.evaluate(() => localStorage.setItem('tangu_locale', 'zh'))
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 30000 }); await open(); await toBottom()

    // ── 手机:贴底抽屉(装作粗指针 + 窄窗) ──
    await ctx.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(320, 500); w.setContentSize(400, 860) })
    await win.waitForTimeout(800)
    await win.evaluate(() => {
      const orig = window.matchMedia.bind(window)
      window.matchMedia = (q) => (q.includes('pointer: coarse') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } : orig(q))
    })
    await toBottom()
    await win.locator('[data-change-receipt]').last().locator('.ct-rcpt-head').click()
    const sheet = win.locator('[data-change-sheet] .ct-sheet')
    await sheet.waitFor({ timeout: 5000 }).then(() => r.check('M1 手机上点开是贴底抽屉', true), () => r.check('M1 手机上点开是贴底抽屉', false))
    await shot('m1-sheet-phone')
  } finally {
    await ctx.close()
  }
  const failed = r.summary()
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
