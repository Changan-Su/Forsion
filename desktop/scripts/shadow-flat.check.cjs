/**
 * Genesis raised / flat 运行态契约。
 *
 * 用生产 CSS 复刻一组代表性真实 DOM，逐项读取 computed box-shadow：空间高程在
 * data-flat=0 时存在、data-flat=1 时必须为 none；拖拽/编辑/特效反馈则必须保留。
 *
 * 跑：npm run check:shadowflat
 * 截图：npm run check:shadowflat -- --shot
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

const DESKTOP = path.resolve(__dirname, '..')
const SHOT_DIR = process.env.SHADOW_SHOT_DIR || path.join(os.tmpdir(), 'forsion-shadow-audit')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
      for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
        candidates.unshift(path.join(cache, dir, 'chrome-mac-arm64', app))
      }
    }
  }
  const hit = candidates.find((candidate) => fs.existsSync(candidate))
  if (!hit) throw new Error('找不到 Chromium；可设置 CHROMIUM_EXE')
  return hit
}

const cssFiles = [
  'frontend/src/styles/base.css',
  'frontend/src/amadeus/styles.css',
  'frontend/src/amadeus-host.css',
  'frontend/src/quickFind.css',
  'frontend/src/hoverTip.css',
  'frontend/src/styles/unitSwitcher.css',
  'frontend/src/amadeus/pdf/pdfAnnotator.css',
  'frontend/src/views/chat2/sidebar2.css',
  'frontend/src/views/dashCanvas.css',
  '../lcl/engine/singleColumn.css',
]
const CSS = cssFiles.map((file) => fs.readFileSync(path.join(DESKTOP, file), 'utf8').replace(/@import\s+[^;]+;/g, '')).join('\n')

const surfaces = [
  ['project-menu', '项目菜单', 'project-menu'],
  ['memory-modal', '记忆弹窗', 'memv-modal-box'],
  ['context-menu', '右键菜单', 'ctx-menu'],
  ['quick-find', '快速查找', 'amx-qf'],
  ['find-bar', '编辑器查找', 'amx-findbar'],
  ['link-card', '链接预览', 'amx-linkcard'],
  ['db-card', '数据库卡片', 'amx-db-card'],
  ['trash-pop', '回收站弹窗', 'amx-trash-pop'],
  ['calendar-card', '日历详情', 'amx-cal-cardwrap'],
  ['unit-menu', 'Unit 菜单', 'unitsw-menu'],
  ['pdf-bar', 'PDF 工具栏', 'pdfa-bottombar'],
  ['toast', '通知', 'amx-toast'],
  ['mobile-cap', '移动端胶囊', 'mb-cap'],
  ['mobile-sheet', '移动端抽屉', 'mb-sheet'],
  ['device-card', '设备卡片', 'sc-device'],
  ['theme-preview', '主题预览', 'theme-preview-window'],
  ['pdf-page', 'PDF 页面', 'wsfile-pdf-page'],
]

const surfaceHtml = surfaces.map(([id, label, classes]) => `
  <section class="audit-cell${id === 'mobile-cap' ? ' mb-shell' : ''}">
    <span>${label}</span>
    <div id="${id}" class="audit-surface ${classes}"><i></i><b></b></div>
  </section>`).join('')

const PAGE = `<!doctype html>
<html data-mode="light" data-flat="0"><head><meta charset="utf-8"><style>
${CSS}
html, body { min-height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); overflow: auto; }
.audit-shell { min-height: 100vh; padding: 28px; }
.audit-head { display: flex; justify-content: space-between; align-items: end; margin: 0 auto 20px; max-width: 1100px; }
.audit-head h1 { margin: 0; font: 650 24px/1.2 var(--font-ui); letter-spacing: -0.4px; }
.audit-head p { margin: 4px 0 0; color: var(--text-muted); font: 13px/1.4 var(--font-ui); }
.audit-badge { border-radius: 999px; padding: 7px 11px; background: var(--accent-light); color: var(--accent-ink); font: 650 12px/1 var(--font-ui); }
.audit-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; max-width: 1100px; margin: auto; }
.audit-cell { min-width: 0; min-height: 118px; padding: 13px; border: 1px solid var(--border); border-radius: var(--radius-md); background: color-mix(in srgb, var(--bg-card) 62%, transparent); }
.audit-cell.mb-shell { position: relative; inset: auto; display: block; overflow: visible; }
.audit-cell > span { display: block; margin-bottom: 16px; color: var(--text-muted); font: 600 11px/1 var(--font-ui); }
.audit-surface { position: relative !important; inset: auto !important; top: auto !important; right: auto !important; bottom: auto !important; left: auto !important; width: 100% !important; min-width: 0 !important; max-width: none !important; height: 56px !important; min-height: 0 !important; max-height: none !important; margin: 0 !important; padding: 0 !important; display: block !important; visibility: visible !important; opacity: 1 !important; transform: none !important; animation: none !important; overflow: hidden !important; pointer-events: none !important; background: var(--bg-card) !important; border-radius: var(--radius-md) !important; }
.audit-surface i, .audit-surface b { position: absolute; display: block; left: 13px; height: 7px; border-radius: 999px; background: var(--overlay-medium); }
.audit-surface i { top: 15px; width: 42%; }
.audit-surface b { top: 31px; width: 68%; opacity: .65; }
.audit-exceptions { position: fixed; left: -10000px; top: 0; display: flex; gap: 10px; }
.audit-exceptions > div { width: 92px; height: 40px; border-radius: 8px; background: var(--bg-card); }
@media (max-width: 850px) { .audit-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
</style></head><body>
<main class="audit-shell am-app tangu-lovable pdfa-container" data-mode="light">
  <header class="audit-head"><div><h1>Genesis 阴影契约</h1><p>同一批生产组件 · Raised / Flat 计算样式对照</p></div><strong class="audit-badge">RAISED</strong></header>
  <div class="audit-grid">${surfaceHtml}</div>
  <div class="audit-exceptions" aria-label="保留的交互反馈">
    <div id="editing-feedback" class="amx-el-selbox is-editing"></div>
    <div id="drag-feedback" class="dash2-card" data-dragging></div>
    <div class="cm-effort is-max"><div id="max-feedback" class="cm-effort-thumb"></div></div>
  </div>
</main>
</body></html>`

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` | ${detail}` : ''}`)
}

async function readShadows(page, ids) {
  return page.evaluate((wanted) => Object.fromEntries(wanted.map((id) => [id, getComputedStyle(document.getElementById(id)).boxShadow])), ids)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1 })
  await page.setContent(PAGE, { waitUntil: 'load' })

  const ids = surfaces.map(([id]) => id)
  const raised = await readShadows(page, ids)
  for (const [id, label] of surfaces) check(`Raised：${label} 有高程`, raised[id] !== 'none', raised[id])

  if (process.argv.includes('--shot')) {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(SHOT_DIR, 'raised.png'), fullPage: true })
  }

  await page.evaluate(() => {
    document.documentElement.dataset.flat = '1'
    document.querySelector('.audit-badge').textContent = 'FLAT'
  })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

  const flat = await readShadows(page, ids)
  for (const [id, label] of surfaces) check(`Flat：${label} 清除高程`, flat[id] === 'none', flat[id])

  const tokenState = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return ['--card-shadow', '--btn-shadow', '--icon-shadow', '--shadow-panel'].map((token) => [token, style.getPropertyValue(token).trim()])
  })
  for (const [token, value] of tokenState) check(`Flat 契约清空 ${token}`, value === 'none', value)

  const exceptions = await readShadows(page, ['editing-feedback', 'drag-feedback', 'max-feedback'])
  check('Flat 保留画布编辑反馈', exceptions['editing-feedback'] !== 'none', exceptions['editing-feedback'])
  check('Flat 保留拖拽反馈', exceptions['drag-feedback'] !== 'none', exceptions['drag-feedback'])
  check('Flat 保留 Max 语义辉光', exceptions['max-feedback'] !== 'none', exceptions['max-feedback'])

  if (process.argv.includes('--shot')) await page.screenshot({ path: path.join(SHOT_DIR, 'flat.png'), fullPage: true })
  await browser.close()

  const failed = results.filter((result) => !result.ok)
  if (failed.length) {
    console.error(`\n${failed.length} 项阴影运行态契约失败`)
    process.exitCode = 1
  } else {
    console.log(`\nPASS  shadow flat runtime | ${surfaces.length} 个空间组件 + 3 个语义反馈${process.argv.includes('--shot') ? ` | ${SHOT_DIR}` : ''}`)
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
