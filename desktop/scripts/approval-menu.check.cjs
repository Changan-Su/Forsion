/**
 * 模式胶囊 / 审批档位菜单的布局契约检查(真 Chromium 断言)。
 *
 * 契约:
 *  A 模式胶囊像 ModelPill 一样平滑展开到 224px,与菜单等宽、右缘对齐、文案居中。
 *  B 审批档位行只放图标 / 标题 / 勾,说明不占菜单布局。
 *  C hover 时说明作为侧边 tooltip 出现,并保留 aria-describedby 键盘/读屏关系；窄 View 改叠到行上方且不越界。
 *
 * 页面注入仓里真实的 base.css + composer2.css,不复制样式。
 * 跑:npm run check:approval   (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
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

const BASE_CSS = fs.readFileSync(path.join(__dirname, '../frontend/src/styles/base.css'), 'utf8')
const COMPOSER_CSS = fs.readFileSync(path.join(__dirname, '../frontend/src/views/chat2/composer2.css'), 'utf8')

// 复刻 Composer2 的真实结构与文案。
const ROWS = [
  { id: 'readonly', title: '询问我批准', desc: '改文件、跑命令、联网,每次都先问我' },
  { id: 'auto-edit', title: '替我批准', desc: '工作区内可直接改文件,跑命令才问我', active: true },
  { id: 'full-auto', title: '完全放行', desc: '不受限地访问网络和你电脑上的任何文件', danger: true },
  { id: 'custom', title: '自定义(config.json)', desc: '按 config.json 的 approval 段(allow / ask / deny)判定' },
]

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { --bg-card:#fff; --bg:#fff; --border:#ddd; --border-width:1px; --overlay-light:#eee;
          --radius-lg:12px; --radius-md:8px; --shadow:rgba(0,0,0,.15);
          --text:#111; --text-light:#222; --text-muted:#666; --text-faint:#999;
          --accent-ink:#3b5bdb; --danger:#e03131; --font-ui:system-ui; }
  body { margin:0; font-family:var(--font-ui); }
  ${BASE_CSS}
  ${COMPOSER_CSS}
  /* 药丸容器:菜单是它的 absolute 定位子级。 */
  .approval-stage { position:fixed; inset:0; padding:0; border:0; border-radius:0; background:transparent; box-shadow:none; }
  .anchor { margin:480px 0 0 80px; }
</style></head><body>
<div class="approval-stage t2c-card">
  <span class="anchor mode-pill-wrap">
    <button class="t2c-pill mode-pill-btn">
      <svg width="13" height="13"><rect width="13" height="13"/></svg>
      <span class="t2c-pill-label">替我批准</span>
      <svg width="10" height="10"><rect width="10" height="10"/></svg>
    </button>
    <div class="composer-menu composer-menu--mode">
      <div class="menu-section">Tangu 的操作如何批准?</div>
      ${ROWS.map((r) => `
        <button data-id="${r.id}" aria-describedby="approval-mode-desc-${r.id}" class="menu-item approval-item${r.active ? ' active' : ''}${r.danger ? ' danger' : ''}">
          <svg class="approval-ic" width="15" height="15"><rect width="15" height="15"/></svg>
          <span class="grow approval-title">${r.title}</span>
          ${r.active ? '<svg class="approval-ck" width="13" height="13"><rect width="13" height="13"/></svg>' : ''}
          <span id="approval-mode-desc-${r.id}" role="tooltip" class="approval-hover-desc">${r.desc}</span>
        </button>`).join('')}
    </div>
  </span>
</div>
</body></html>`

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  await page.setContent(html)
  const box = (sel) => page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, cx: r.left + r.width / 2 }
  }, sel)

  // A:打开/收回都必须真有中间宽度帧,不是瞬变。
  const closedW = (await box('.mode-pill-btn')).w
  const trace = (open) => page.evaluate((on) => new Promise((resolve) => {
    const wrap = document.querySelector('.mode-pill-wrap')
    const btn = document.querySelector('.mode-pill-btn')
    wrap.classList.toggle('is-open', on)
    btn.classList.toggle('is-open', on)
    const menu = document.querySelector('.composer-menu--mode')
    const out = []
    const t0 = performance.now()
    const tick = () => {
      out.push([performance.now() - t0, btn.getBoundingClientRect().width, menu.getBoundingClientRect().left])
      if (performance.now() - t0 < 240) requestAnimationFrame(tick)
      else resolve(out)
    }
    requestAnimationFrame(tick)
  }), open)
  const opening = await trace(true)
  const openW = opening.at(-1)[1]
  const mids = (frames) => frames.filter(([t, w]) => t > 35 && t < 155 && w > closedW + 8 && w < openW - 8).length
  check('模式胶囊展开有连续宽度动画', mids(opening) >= 3, `${closedW.toFixed(1)} → ${openW.toFixed(1)},中间帧 ${mids(opening)}`)
  const menuXs = opening.map((frame) => frame[2])
  const menuDrift = Math.max(...menuXs) - Math.min(...menuXs)
  check('胶囊展开时菜单锚点不横移（只从下方向上弹）', menuDrift < 8, `横向漂移 ${menuDrift.toFixed(1)}px`)
  const closing = await trace(false)
  check('模式胶囊收回也有连续宽度动画', mids(closing) >= 3, `${openW.toFixed(1)} → ${closedW.toFixed(1)},中间帧 ${mids(closing)}`)
  await page.evaluate(() => {
    document.querySelector('.mode-pill-wrap').classList.add('is-open')
    document.querySelector('.mode-pill-btn').classList.add('is-open')
    document.querySelectorAll('.mode-pill-btn,.composer-menu--mode').forEach((el) => el.getAnimations().forEach((a) => a.finish()))
  })

  const geo = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right } }
    const menu = document.querySelector('.composer-menu')
    const pill = document.querySelector('.mode-pill-btn')
    const label = document.querySelector('.mode-pill-btn .t2c-pill-label')
    return {
      menu: box(menu),
      pill: box(pill),
      centers: { pill: pill.getBoundingClientRect().left + pill.getBoundingClientRect().width / 2, label: label.getBoundingClientRect().left + label.getBoundingClientRect().width / 2 },
      inlineDescriptions: document.querySelectorAll('.approval-desc').length,
      rows: [...document.querySelectorAll('.approval-item')].map((el) => ({
        id: el.dataset.id,
        row: box(el),
        ic: box(el.querySelector('.approval-ic')),
        title: box(el.querySelector('.approval-title')),
        titleColor: getComputedStyle(el.querySelector('.approval-title')).color,
        hintColor: getComputedStyle(el.querySelector('.approval-hover-desc')).color,
        hintOpacity: getComputedStyle(el.querySelector('.approval-hover-desc')).opacity,
        describedBy: el.getAttribute('aria-describedby'),
        hintId: el.querySelector('.approval-hover-desc').id,
      })),
    }
  })

  const rows = geo.rows
  check('模式胶囊与菜单等宽且右缘对齐', Math.abs(geo.pill.w - geo.menu.w) < 1 && Math.abs(geo.pill.right - geo.menu.right) < 1,
    `pill=${geo.pill.w.toFixed(1)}/${geo.pill.right.toFixed(1)} menu=${geo.menu.w.toFixed(1)}/${geo.menu.right.toFixed(1)}`)
  check('展开后模式文字保持居中', Math.abs(geo.centers.pill - geo.centers.label) < 0.6, JSON.stringify(geo.centers))
  check('四档全在场', rows.length === 4 && rows.map((r) => r.id).join(',') === 'readonly,auto-edit,full-auto,custom',
    rows.map((r) => r.id).join(','))
  check('模式行已移除内联说明且保持单行高度', geo.inlineDescriptions === 0 && rows.every((r) => r.row.h < 34),
    `inline=${geo.inlineDescriptions}, heights=${rows.map((r) => r.row.h.toFixed(1)).join('/')}`)
  check('每行 tooltip 与 aria-describedby 一一对应且默认隐藏', rows.every((r) => r.describedBy === r.hintId && r.hintOpacity === '0'),
    rows.map((r) => `${r.id}:${r.describedBy}/${r.hintId}/${r.hintOpacity}`).join(' | '))

  await page.locator('[data-id="full-auto"]').hover()
  await page.waitForTimeout(220)
  const hovered = await page.evaluate(() => {
    const menu = document.querySelector('.composer-menu').getBoundingClientRect()
    const tip = document.querySelector('[data-id="full-auto"] .approval-hover-desc')
    const r = tip.getBoundingClientRect()
    const cs = getComputedStyle(tip)
    return { opacity: cs.opacity, visibility: cs.visibility, left: r.left, menuRight: menu.right, text: tip.textContent.trim() }
  })
  check('hover 后说明在菜单右侧浮出', hovered.opacity === '1' && hovered.visibility === 'visible' && hovered.left >= hovered.menuRight && !!hovered.text,
    JSON.stringify(hovered))

  await page.evaluate(() => {
    const stage = document.querySelector('.approval-stage')
    stage.style.inset = 'auto'
    stage.style.left = '100px'
    stage.style.top = '0'
    stage.style.width = '420px'
    stage.style.height = '700px'
  })
  await page.locator('[data-id="full-auto"]').hover()
  await page.waitForTimeout(40)
  const narrowTip = await page.evaluate(() => {
    const stage = document.querySelector('.approval-stage').getBoundingClientRect()
    const row = document.querySelector('[data-id="full-auto"]').getBoundingClientRect()
    const tip = document.querySelector('[data-id="full-auto"] .approval-hover-desc').getBoundingClientRect()
    return { stage: { left: stage.left, right: stage.right }, rowTop: row.top, tip: { left: tip.left, right: tip.right, bottom: tip.bottom } }
  })
  check('窄 Chat View 中模式说明叠到行上方且不越出 View',
    narrowTip.tip.bottom < narrowTip.rowTop && narrowTip.tip.left >= narrowTip.stage.left && narrowTip.tip.right <= narrowTip.stage.right,
    JSON.stringify(narrowTip))

  // 完全放行的行保留 danger 强调,侧边说明回到中性正文色。
  const full = rows.find((r) => r.id === 'full-auto')
  const plain = rows.find((r) => r.id === 'readonly')
  check('完全放行行保持 danger 强调,tooltip 使用中性色', full.titleColor !== plain.titleColor && full.hintColor === plain.hintColor,
    `title=${full.titleColor}/${plain.titleColor} hint=${full.hintColor}/${plain.hintColor}`)

  await browser.close()
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} passed`)
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
