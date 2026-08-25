/**
 * 全主题视觉审计图：第一方设计语言 × 命名/自定义配色 × 明暗。
 *
 * 与 theme-contrast.check.cjs 分工：后者是数值门禁；这里把真实 token 和主题结构选择器
 * 组成一个缩小版工作区，输出每种语言的全组合联系表，专门抓“数值都对但看起来怪”的问题。
 * 输出：/tmp/forsion-theme-audit/<language>.png
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (fs.existsSync(systemChrome)) return systemChrome
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()
  for (const dir of dirs) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const executable = path.join(root, dir, 'chrome-mac-arm64', app)
      if (fs.existsSync(executable)) return executable
    }
  }
  throw new Error('找不到 Chromium，设 CHROMIUM_EXE 环境变量')
}

const SRC = path.join(__dirname, '../frontend/src')
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8')
require('sucrase/register/ts')
const { SEED_THEMES } = require(path.join(__dirname, '../electron/seedThemes.ts'))
const { customSkinVars } = require(path.join(SRC, 'theme/lcl/lovableData.ts'))
const softCss = SEED_THEMES.find((theme) => theme.id === 'soft')?.css
if (!softCss) throw new Error('缺少第一方 soft 磁盘种子主题')

const LANGS = ['lovable', 'genesis-glass', 'soft', 'zhi']
const COMBOS = [
  { id: 'cream', label: '经典' },
  { id: 'coral', label: '珊瑚' },
  { id: 'teal', label: '柔青' },
  { id: 'lavender', label: '薰衣草' },
  { id: 'zhi', label: '知蓝' },
  { id: 'custom', label: '自定紫', accent: '#8b7fd6' },
  { id: 'custom', label: '敌意色', accent: '#ffffff', bg: '#000000' },
]

const css = [
  read('styles/base.css'),
  read('theme/skins.css'),
  read('theme/themes/lovable/theme.css'),
  read('theme/themes/genesis-glass/theme.css'),
  softCss,
  read('theme/themes/zhi/theme.css'),
  read('views/chat2/chat2.css'),
  fs.readFileSync(path.join(__dirname, '../../lcl/engine/engine.css'), 'utf8'),
].join('\n')

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
* { box-sizing: border-box; transition: none !important; animation: none !important; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
body { background: var(--bg); color: var(--text); font-family: var(--font-ui); }
.audit-shell.shell { width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; }
.audit-titlebar.shell-titlebar { height: 18px; min-height: 18px; padding: 3px 8px; color: var(--text-faint); font: 8px/1 var(--font-ui); }
.audit-top.shell-top { min-height: 0; flex: 1; display: flex; gap: 0; }
.audit-ribbon.rb { width: 34px; min-width: 34px; height: auto; padding: 7px 5px; display: flex; flex-direction: column; align-items: center; gap: 7px; }
.audit-ribbon i { width: 18px; height: 18px; display: grid; place-items: center; border-radius: var(--radius-sm); color: var(--text-muted); font: 600 8px/1 var(--font-ui); }
.audit-ribbon i.active { color: var(--accent-ink); background: var(--accent-light); }
.audit-work.shell-work { min-width: 0; min-height: 0; flex: 1; }
.audit-dock.dockview-theme-lcl { width: 100%; height: 100%; display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 5px; }
.audit-group.dv-groupview { min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.audit-tabs.dv-tabs-and-actions-container { height: 24px; min-height: 24px; display: flex; align-items: center; padding: 0 7px; color: var(--text-muted); font: 600 8px/1 var(--font-ui); }
.audit-side .dv-content-container { min-height: 0; flex: 1; }
.audit-side .dv-react-part { height: 100%; padding: 7px; background: var(--sidebar-bg); }
.audit-navitem { margin-bottom: 4px; padding: 5px 6px; border-radius: var(--radius-sm); color: var(--text-muted); font: 8px/1.2 var(--font-ui); }
.audit-navitem.active { color: var(--accent-ink); background: var(--accent-light); font-weight: 650; }
.audit-main .dv-content-container { min-height: 0; flex: 1; padding: 5px; }
.audit-main .dv-react-part { position: relative; height: 100%; overflow: hidden; padding: 10px 11px; background: var(--bg-card); }
.audit-kicker { color: var(--accent-ink); font-size: 7px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.audit-title { margin: 3px 0 2px; color: var(--text); font-size: 14px; line-height: 1.1; }
.audit-copy { margin: 0; max-width: 160px; color: var(--text-muted); font-size: 8px; line-height: 1.4; }
.audit-row { display: flex; gap: 5px; margin-top: 7px; }
.audit-chip { padding: 3px 6px; border: 1px solid var(--overlay-medium); border-radius: 999px; color: var(--accent-ink); background: var(--accent-light); font: 650 7px/1 var(--font-ui); }
.audit-chip.ok { color: var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); }
.audit-chip.bad { color: var(--danger); background: var(--danger-light); }
.audit-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-top: 6px; }
.audit-card { min-height: 34px; padding: 5px 6px; border: 1px solid transparent; border-radius: var(--radius-md); background: var(--user-bg); color: var(--text-light); font-size: 7.5px; line-height: 1.35; }
.audit-card.tool { background: var(--tool-bg); color: var(--tool-text); }
.audit-card small { display: block; margin-top: 2px; color: var(--text-faint); font-size: 6.5px; }
.audit-composer.t2c-card { position: absolute; left: 10px; right: 10px; bottom: 9px; min-height: 31px; padding: 7px 35px 6px 8px; border: 1px solid transparent; border-radius: var(--radius-chat-card); background: var(--bg-card); box-shadow: var(--card-shadow); color: var(--text-faint); font-size: 7.5px; }
.audit-send.t2-send { right: 5px; bottom: 5px; width: 21px; height: 21px; min-height: 0; border-radius: 50%; font-size: 9px; }
.audit-menu.composer-menu { display: block; left: auto; right: 7px; top: 40px; bottom: auto; width: 78px; min-width: 0; padding: 4px; border-radius: var(--radius-md); background: var(--bg-glass); box-shadow: var(--card-shadow); }
.audit-menu span { display: block; padding: 4px 5px; border-radius: var(--radius-sm); color: var(--text-muted); font-size: 7px; }
.audit-menu span.active { color: var(--accent-ink); background: var(--accent-light); }
</style></head><body>
<div class="audit-shell shell">
  <div class="audit-titlebar shell-titlebar">Forsion · Theme audit</div>
  <div class="audit-top shell-top">
    <nav class="audit-ribbon rb"><i class="active">F</i><i>⌘</i><i>AI</i></nav>
    <div class="audit-work shell-work">
      <div class="audit-dock dockview-theme-lcl">
        <section class="audit-group audit-side dv-groupview">
          <div class="audit-tabs dv-tabs-and-actions-container"><span class="wb-tab wb-tab--icon">空间</span></div>
          <div class="dv-content-container"><div class="dv-react-part">
            <div class="audit-navitem active">今天</div><div class="audit-navitem">项目</div><div class="audit-navitem">收藏</div>
          </div></div>
        </section>
        <section class="audit-group audit-main dv-groupview">
          <div class="audit-tabs dv-tabs-and-actions-container">主题工作区</div>
          <div class="dv-content-container"><div class="dv-react-part">
            <div class="audit-kicker">Forsion Genesis</div><h1 class="audit-title">主题应该自然</h1>
            <p class="audit-copy">结构、层级、弱信息与状态色需要在每个组合中保持同一语义。</p>
            <div class="audit-row"><span class="audit-chip">选中</span><span class="audit-chip ok">成功</span><span class="audit-chip bad">危险</span></div>
            <div class="audit-cards"><div class="audit-card">用户消息<small>次要说明仍应清楚</small></div><div class="audit-card tool">工具结果<small>来自语义工具表面</small></div></div>
            <div class="audit-composer t2c-card">输入消息…<button class="audit-send t2-send">↑</button></div>
            <div class="audit-menu composer-menu"><span class="active">当前项目</span><span>新建空间</span><span>设置</span></div>
          </div></div>
        </section>
      </div>
    </div>
  </div>
</div>
</body></html>`

async function applyCombo(page, lang, combo, mode) {
  const vars = combo.id === 'custom' ? customSkinVars(combo.accent, mode === 'dark', combo.bg) : null
  await page.evaluate(({ lang, skin, mode, vars }) => {
    const root = document.documentElement
    root.dataset.theme = lang
    root.dataset.skin = skin
    root.dataset.mode = mode
    root.dataset.platform = 'win'
    root.dataset.glass = 'on'
    root.dataset.flat = '0'
    root.classList.toggle('dark', mode === 'dark')
    root.style.cssText = ''
    for (const [key, value] of Object.entries(vars || {})) root.style.setProperty(key, value)
  }, { lang, skin: combo.id, mode, vars })
}

async function makeSheet(browser, lang, shots, outDir) {
  const width = 7 * 360 + 6 * 8 + 24
  const page = await browser.newPage({ viewport: { width, height: 650 }, deviceScaleFactor: 1 })
  const cards = shots.map((shot) => `<figure><figcaption>${shot.label} · ${shot.mode === 'dark' ? '暗' : '亮'}</figcaption><img src="data:image/png;base64,${shot.data}" /></figure>`).join('')
  await page.setContent(`<!doctype html><style>*{box-sizing:border-box}body{margin:0;padding:12px;background:#777;font:12px system-ui;color:#fff}.grid{display:grid;grid-template-columns:repeat(7,360px);gap:8px}figure{margin:0;background:#555}figcaption{height:24px;padding:5px 8px;font-weight:650}img{display:block;width:360px;height:280px}</style><div class="grid">${cards}</div>`)
  const file = path.join(outDir, `${lang}.png`)
  await page.screenshot({ path: file, fullPage: true })
  await page.close()
  return file
}

;(async () => {
  const outDir = process.env.THEME_AUDIT_DIR || path.join(os.tmpdir(), 'forsion-theme-audit')
  fs.mkdirSync(outDir, { recursive: true })
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 360, height: 280 }, deviceScaleFactor: 1 })
  await page.setContent(pageHtml)
  const files = []
  for (const lang of LANGS) {
    const shots = []
    for (const mode of ['light', 'dark']) {
      for (const combo of COMBOS) {
        await applyCombo(page, lang, combo, mode)
        const data = (await page.screenshot({ type: 'png' })).toString('base64')
        shots.push({ label: combo.label, mode, data })
      }
    }
    files.push(await makeSheet(browser, lang, shots, outDir))
  }
  await page.close()
  await browser.close()
  for (const file of files) console.log(`AUDIT  ${file}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
