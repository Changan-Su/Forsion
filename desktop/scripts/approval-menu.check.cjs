/**
 * 审批档位菜单(Codex 形:图标 + 标题 + 说明副行)的布局契约检查(真 Chromium 断言)。
 *
 * 为什么存在:这四行的排布全压在 `.menu-item .grow{flex:1}` 被 `.approval-item .grow`
 * 改成 `display:flex; flex-direction:column` 这一处覆盖上 —— 覆盖没生效,说明就会挤到标题
 * **右边**同一行去(视觉上像两个标签),而不是掉到下一行;肉眼在窄菜单里很难分辨。
 * 另外模式菜单被 `.composer-menu--mode{min/max-width:320/512px}` 夹住,说明文案必须能折行而不撑破。
 *
 * 页面注入仓里**真实的 base.css**(不复制样式),故不会与源码漂移。
 * 档位语义/顺序是 Composer2.tsx 里的 APPROVALS 常量,不在此断言。
 *
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

// 复刻 Composer2 的真实结构与文案(说明句取最长的那条,好压出折行)。
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
  /* 药丸容器:菜单是它的 absolute 定位子级(Composer2 里那个 inline-flex 的 span) */
  .anchor { position:relative; display:inline-flex; margin:400px 0 0 40px; }
  ${BASE_CSS}
</style></head><body>
  <span class="anchor">
    <div class="composer-menu composer-menu--mode left">
      <div class="menu-section">Tangu 的操作如何批准?</div>
      ${ROWS.map((r) => `
        <button data-id="${r.id}" class="menu-item approval-item${r.active ? ' active' : ''}${r.danger ? ' danger' : ''}">
          <svg class="approval-ic" width="15" height="15"><rect width="15" height="15"/></svg>
          <span class="grow">
            <span class="approval-title">${r.title}</span>
            <span class="approval-desc">${r.desc}</span>
          </span>
          ${r.active ? '<svg class="approval-ck" width="13" height="13"><rect width="13" height="13"/></svg>' : ''}
        </button>`).join('')}
    </div>
  </span>
</body></html>`

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  await page.setContent(html)
  // `.composer-menu` 带 `animation: pop 0.16s`(scale 起手),不等它落定量到的是缩着的中间帧
  // ——曾让 min-width:320 量成 310.4(×0.97),看着像 CSS 没生效。
  await page.waitForTimeout(300)

  const geo = await page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right } }
    const menu = document.querySelector('.composer-menu')
    return {
      menu: { ...box(menu), scrollW: menu.scrollWidth, clientW: menu.clientWidth },
      rows: [...document.querySelectorAll('.approval-item')].map((el) => ({
        id: el.dataset.id,
        row: box(el),
        ic: box(el.querySelector('.approval-ic')),
        title: box(el.querySelector('.approval-title')),
        desc: box(el.querySelector('.approval-desc')),
        titleColor: getComputedStyle(el.querySelector('.approval-title')).color,
        descColor: getComputedStyle(el.querySelector('.approval-desc')).color,
      })),
    }
  })

  const rows = geo.rows
  check('四档全在场', rows.length === 4 && rows.map((r) => r.id).join(',') === 'readonly,auto-edit,full-auto,custom',
    rows.map((r) => r.id).join(','))

  // 病灶所在:说明必须在标题**下面**一行,不是右边。差 1px 也算错行,故要求整块低于标题底边。
  const stacked = rows.filter((r) => r.desc.y >= r.title.bottom - 0.5)
  check('说明落在标题下一行(而非并排)', stacked.length === 4,
    rows.map((r) => `${r.id}:title.bottom=${r.title.bottom.toFixed(1)} desc.y=${r.desc.y.toFixed(1)}`).join(' | '))

  // 图标与文案左对齐关系:图标在文字左侧,且顶对齐(两行时不被拉到垂直居中)。
  const iconOk = rows.every((r) => r.ic.right <= r.title.x + 0.5 && Math.abs(r.ic.y - r.title.y) < 6)
  check('图标在文案左侧且顶对齐', iconOk,
    rows.map((r) => `${r.id}:ic.y=${r.ic.y.toFixed(1)} title.y=${r.title.y.toFixed(1)}`).join(' | '))

  check('菜单不被文案撑破(说明能折行)', geo.menu.scrollW <= geo.menu.clientW + 1 && geo.menu.w <= 512.5 && geo.menu.w >= 320,
    `scrollW=${geo.menu.scrollW} clientW=${geo.menu.clientW} menuW=${geo.menu.w.toFixed(1)}`)

  // 折行确实发生了(最长那条 custom),否则「不撑破」可能只是文案恰好够短,断言是空的。
  const custom = rows.find((r) => r.id === 'custom')
  check('最长说明确有折行(断言非真空)', custom.desc.h > 20, `desc.h=${custom.desc.h.toFixed(1)}`)

  // 完全放行整行染 danger:标题与说明都要变色(说明行有自己的 --text-faint,不覆盖就漏染)。
  const full = rows.find((r) => r.id === 'full-auto')
  const plain = rows.find((r) => r.id === 'readonly')
  check('完全放行整行染 danger(标题+说明都变)',
    full.titleColor !== plain.titleColor && full.descColor !== plain.descColor && full.titleColor === full.descColor,
    `full=${full.titleColor}/${full.descColor} plain=${plain.titleColor}/${plain.descColor}`)

  await browser.close()
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} passed`)
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
