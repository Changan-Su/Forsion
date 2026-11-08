/**
 * Soft(S2 分层浮卡,随包内置)真机出图 + 旧磁盘副本迁移的端到端核对。量的是 out/ 产物,先 `npm run build`。
 * 桩引擎 + 隔离 home / user-data(lib/uiux-electron.cjs),不碰任何真实数据目录;--lang=zh-CN,界面缩放 110%。
 *
 *   node <Forsion 仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="theme-soft shots" --eta=5 -- node scripts/theme-soft.shots.cjs
 *   SHOT_DIR=<目录> 改出图位置(缺省系统临时目录)
 *
 * 1. 迁移:启动前往隔离 home 的 themes/soft 放一份「改过的」06-29 种子 → 主进程该把它整目录改名成 soft-custom;
 *    再模拟升级前的渲染层状态(语言 = soft、没有「已切过」记号)重载 → 应落到 soft-custom,且还是旧 CSS 的样子(.rb 48px)。
 * 2. 出图:内置 Soft × 经典亮 / 经典暗 / 苔绿亮 / 柔青暗,外加 Ribbon 展开、主区获焦两张,并打印各层底色与 Ribbon 宽度。
 *    层级按真实渲染的 OKLab 亮度核:舞台最深;侧栏 < 纸 < 对话里的卡(柔青暗色的侧栏本来就比纸亮,那张只要求舞台最深)。
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, enterSpace, shotDir, makeReporter } = require('./lib/uiux-electron.cjs')

const OUT = shotDir('theme-soft')
const SEED = path.join(__dirname, '../electron/fixtures/soft-seeds/2026-06-29')
const R = makeReporter()
const check = (...a) => R.check(...a)

const at = (t) => ({ created_at: '2026-10-24 09:00:00', updated_at: `2026-10-24 ${t}` })
const base = { summary: '', archived: false, model_id: 'm1', agent_config: null }
const T = 1792848000000
const sessions = [
  { ...base, ...at('10:12:00'), project_path: '__P__', project_name: 'Launch', projectless: false, id: 's-main', title: 'Launch 落地页' },
  { ...base, ...at('09:40:00'), project_path: '__P__', project_name: 'Launch', projectless: false, id: 's-2', title: '数据库导出 CSV 太慢' },
  { ...base, ...at('08:30:00'), projectless: true, id: 's-4', title: '周末去杭州的行程' },
]
const messages = [
  { id: 'u1', role: 'user', timestamp: T, content: '给 Launch 做一版落地页:一屏标题 + 三个卖点 + 下载按钮,用 vite + React。' },
  { id: 'a1', role: 'model', timestamp: T + 360000, content: '写好了三份文件:\n\n- **index.html** —— 入口\n- **src/main.tsx** —— 起 React\n- **src/App.tsx** —— 标题、三个卖点、下载按钮\n\n要看效果的话我把 dev server 起起来。' },
]

const CUSTOM_CSS = fs.readFileSync(path.join(SEED, 'theme.css'), 'utf8') + '\n/* mine */\n'

async function openSession(win) {
  const row = win.locator('.t2s-srow[data-sel-id="s-main"]').first()
  await row.waitFor({ timeout: 20000 }); await row.click()
  await win.locator('#tocmsg-a1 .t2-content').waitFor({ timeout: 15000 })
}

async function settle(ctx) {
  await ctx.win.waitForSelector('.dv-groupview', { timeout: 30000 })
  await ctx.win.waitForTimeout(1500)
  await openSession(ctx.win)
  await ctx.win.evaluate(() => { document.documentElement.style.setProperty('--uiz', '1.1'); document.body.style.zoom = '1.1' })
  await ctx.win.evaluate(() => document.fonts.ready)
  await ctx.win.waitForTimeout(900)
}

async function setTheme(ctx, s) {
  await ctx.app.evaluate(({ nativeTheme }, m) => { nativeTheme.themeSource = m }, s.mode)
  await ctx.win.emulateMedia({ colorScheme: s.mode })
  await ctx.win.evaluate((s) => {
    localStorage.setItem('forsion_theme_lang', s.lang); localStorage.setItem('forsion_theme_skin', s.skin); localStorage.setItem('forsion_theme_bg', s.skin)
    localStorage.setItem('forsion_theme_pref', s.mode); localStorage.setItem('forsion_ui_zoom', '1.1')
    // 等于用户在设置里自己选了内置 Soft(setLang 会记 done);不记的话迁移接管会把 soft 再切回 soft-custom
    if (localStorage.getItem('forsion_theme_migrated.soft-custom') === 'adopted') localStorage.setItem('forsion_theme_migrated.soft-custom', 'done')
  }, s)
  await ctx.win.reload({ waitUntil: 'domcontentloaded' })
  await settle(ctx)
}

/** 计算样式里的颜色 → OKLab 亮度 ×100(rgb() 与 color-mix 解析出的 oklab() 两种写法)。 */
function lightness(c) {
  const ok = /^oklab\(([\d.]+)/.exec(c || '')
  if (ok) return Number(ok[1]) * 100
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(c || '')
  if (!m) return NaN
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const [r, g, b] = [m[1], m[2], m[3]].map(Number).map(lin)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return (0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s) * 100
}

/** 各层实际底色 + Ribbon 几何(给图配数字)。 */
const layers = (win) => win.evaluate(() => {
  const q = (s) => document.querySelector(s)
  const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null)
  const rb = q('.rb'), r = rb?.getBoundingClientRect()
  const side = q('.dockview-theme-lcl .dv-groupview:has(.wb-tab--icon)'), main = q('.dockview-theme-lcl .dv-groupview:not(:has(.wb-tab--icon))')
  return {
    theme: document.documentElement.dataset.theme,
    stage: bg(q('.shell')), ribbon: bg(rb), side: bg(side), paper: bg(main),
    card: bg(q('.t2c-card') || q('.t2-userwrap')),
    rbWidth: r ? Math.round(r.width) : null, rbPadTop: rb ? getComputedStyle(rb).paddingTop : null,
    radius: main ? getComputedStyle(main).borderRadius : null, font: getComputedStyle(document.body).fontFamily.slice(0, 40),
  }
})

async function main() {
  const ctx = await launch({
    tag: 'theme-soft', fixtures: { agents: [], sessions }, messages,
    beforeLaunch: ({ home }) => {
      const dir = path.join(home, 'themes', 'soft')
      fs.mkdirSync(dir, { recursive: true })
      fs.copyFileSync(path.join(SEED, 'theme.json'), path.join(dir, 'theme.json'))
      fs.writeFileSync(path.join(dir, 'theme.css'), CUSTOM_CSS)
    },
  })
  for (const s of sessions) if (s.project_path === '__P__') s.project_path = ctx.projectDir
  try {
    await boot(ctx.app, ctx.win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(ctx.win, 'tangu')
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1512, 950))

    // ── 1. 迁移 ──
    const themes = path.join(ctx.home, 'themes')
    check('迁移:改过的 themes/soft 被整目录改名(soft/ 不在了)', !fs.existsSync(path.join(themes, 'soft')))
    check('迁移:soft-custom/theme.css 逐字节等于原来的自改 CSS',
      fs.existsSync(path.join(themes, 'soft-custom', 'theme.css')) && fs.readFileSync(path.join(themes, 'soft-custom', 'theme.css'), 'utf8') === CUSTOM_CSS)
    const m = JSON.parse(fs.readFileSync(path.join(themes, 'soft-custom', 'theme.json'), 'utf8'))
    check('迁移:theme.json 改名「Soft(自改)」/ Soft (custom),id 仍是 soft', m.name === 'Soft(自改)' && m.nameEn === 'Soft (custom)' && m.id === 'soft', JSON.stringify({ id: m.id, name: m.name, nameEn: m.nameEn }))
    check('迁移:写了标记', fs.existsSync(path.join(themes, '.soft-migration.json')))
    // 模拟升级前的渲染层:语言 = soft,没有「已切过」记号
    await ctx.win.evaluate(() => { localStorage.setItem('forsion_theme_lang', 'soft'); localStorage.setItem('forsion_theme_skin', 'cream'); localStorage.setItem('forsion_theme_bg', 'cream'); localStorage.removeItem('forsion_theme_migrated.soft-custom') })
    await ctx.app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    await ctx.win.emulateMedia({ colorScheme: 'light' })
    await ctx.win.reload({ waitUntil: 'domcontentloaded' })
    await settle(ctx)
    const mig = await layers(ctx.win)
    const stored = await ctx.win.evaluate(() => ({ lang: localStorage.getItem('forsion_theme_lang'), flag: localStorage.getItem('forsion_theme_migrated.soft-custom') }))
    check('切换:正用 soft 的人落到 soft-custom(记号 = adopted)', mig.theme === 'soft-custom' && stored.lang === 'soft-custom' && stored.flag === 'adopted', JSON.stringify(stored))
    check('切换:soft-custom 还是旧 CSS 的样子(.rb 定宽 48px)', mig.rbWidth === Math.round(48 * 1.1) || mig.rbWidth === 48, `rb=${mig.rbWidth}`)
    await ctx.win.mouse.move(700, 900); await ctx.win.waitForTimeout(300)
    await ctx.win.screenshot({ path: path.join(OUT, 'migrated-soft-custom-light-cream.png') })
    console.log('NOTE migrated', JSON.stringify(mig))

    // ── 2. 内置 Soft 出图 ──
    const SHOTS = [
      { name: 'S2-light-cream', skin: 'cream', mode: 'light' },
      { name: 'S2-dark-cream', skin: 'cream', mode: 'dark' },
      { name: 'S2-light-sage', skin: 'sage', mode: 'light' },
      { name: 'S2-dark-teal', skin: 'teal', mode: 'dark' },
      { name: 'S2-expand-light-cream', skin: 'cream', mode: 'light', act: 'expand' },
      { name: 'S2-focus-light-cream', skin: 'cream', mode: 'light', act: 'focus' },
    ]
    for (const s of SHOTS) {
      await setTheme(ctx, { lang: 'soft', ...s })
      await ctx.win.mouse.move(700, 900); await ctx.win.waitForTimeout(350)
      const file = path.join(OUT, `${s.name}.png`)
      if (s.act === 'expand') {
        const before = await layers(ctx.win)
        await ctx.win.locator('.rb-toggle').first().click(); await ctx.win.waitForTimeout(700); await ctx.win.mouse.move(700, 900)
        const after = await layers(ctx.win)
        await ctx.win.screenshot({ path: file })
        check('Ribbon 展开不再被钉死在 48px(展开后明显变宽)', after.rbWidth > before.rbWidth + 40, `收起 ${before.rbWidth} → 展开 ${after.rbWidth}`)
        await ctx.win.locator('.rb-toggle').first().click(); await ctx.win.waitForTimeout(500)
      } else if (s.act === 'focus') {
        await ctx.win.mouse.click(700, 640); await ctx.win.waitForTimeout(300); await ctx.win.mouse.move(700, 900); await ctx.win.waitForTimeout(300)
        const tabBg = await ctx.win.evaluate(() => {
          const t = document.querySelector('.dv-groupview:not(:has(.wb-tab--icon)) .dv-tab.dv-active-tab')
          return t ? getComputedStyle(t).backgroundColor : null
        })
        await ctx.win.screenshot({ path: file })
        check('主区获焦后外层 .dv-tab 不铺方底', !tabBg || tabBg === 'rgba(0, 0, 0, 0)' || tabBg === 'transparent', `dv-tab bg=${tabBg}`)
      } else {
        const l = await layers(ctx.win)
        await ctx.win.screenshot({ path: file })
        check(`${s.name}:语言是内置 soft`, l.theme === 'soft')
        const L = Object.fromEntries(['stage', 'ribbon', 'side', 'paper', 'card'].map((k) => [k, Math.round(lightness(l[k]) * 10) / 10]))
        check(`${s.name}:舞台最深`, ['ribbon', 'side', 'paper', 'card'].every((k) => L.stage < L[k]), JSON.stringify(L))
        if (s.skin !== 'teal') check(`${s.name}:侧栏 < 纸 < 卡`, L.side < L.paper && L.paper < L.card, JSON.stringify(L))
        console.log('NOTE', s.name, JSON.stringify(l))
      }
      console.log('shot', file)
    }
  } finally {
    await ctx.close()
  }
  if (R.summary()) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
