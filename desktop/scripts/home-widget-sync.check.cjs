/**
 * 主页「同步」卡(Forsion Extend 出的插件列表卡,11-07 主页小组件方案 A 第 3 步):真 Electron(out/ 构建)× 桩引擎 ×
 * 临时家目录里装好**打包签名过**的 Extend(整包原样拷,不改 manifest —— 改一个字 SIGNATURE 就对不上,主进程半身不装,
 * 新同步通道没了,卡只会画「暂时读不到」)。
 * 查:收纳面板「插件」组里有「同步」;点一下放上主页;卡头「同步 · Forsion 扩展」;没登录时宿主拿到行、画出「未登录 Forsion 账号」
 * (不是「暂时读不到」也不是空);点行打开蓬洲云。已登录的各种状态(在传 / 冲突 / 出错)由 Extend 的单测钉
 * (test/vitest/renderer/syncWidget.test.ts)。截图进 OUT(缺省 ../../outputs/home-widget-sync)。
 *
 * 用法:先在本检出 npx electron-vite build;Extend 检出里 npm run build && npm run sign(版本要比本检出随包的新,播种才不会换掉它);然后
 *   EXTEND_PLUGIN_DIR=<Forsion-Extend 检出> node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="主页同步卡" --eta=2 -- node scripts/home-widget-sync.check.cjs
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, sleep, makeReporter, captureWindow } = require('./lib/uiux-electron.cjs')

const OUT = path.resolve(process.env.OUT || path.join(__dirname, '../../outputs/home-widget-sync'))
const EXTEND = process.env.EXTEND_PLUGIN_DIR && path.resolve(process.env.EXTEND_PLUGIN_DIR)
const CARD = 'plugin:forsion-extend/sync'
const R = makeReporter()
const check = R.check

const ver = (v) => String(v).split(/[.-]/).slice(0, 3).map(Number)
const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }

async function main() {
  if (!EXTEND || !fs.existsSync(path.join(EXTEND, 'SIGNATURE')) || !fs.existsSync(path.join(EXTEND, 'dist/main.js'))) {
    throw new Error('EXTEND_PLUGIN_DIR 要指向 build + sign 过的 Forsion-Extend 检出(npm run build && npm run sign)')
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(EXTEND, 'package.json'), 'utf8'))
  const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '../node_modules/@forsion/extend/package.json'), 'utf8')).version
  if (!newer(pkg.version, bundled)) throw new Error(`Extend 检出 ${pkg.version} 不比随包的 ${bundled} 新:播种会把它换成随包那份`)
  if (!JSON.parse(fs.readFileSync(path.join(EXTEND, 'manifest.json'), 'utf8')).widgets?.includes('widgets/sync')) throw new Error('这份 Extend 的 manifest 没声明 widgets/sync')
  fs.mkdirSync(OUT, { recursive: true })
  const ctx = await launch({
    tag: 'home-widget-sync', fixtures: { agents: [], sessions: [] },
    beforeLaunch: ({ home }) => {
      // 照包的 files 白名单原样拷(同用户 dev 装 Extend 的口径),一个字节不改
      const dest = path.join(home, 'plugins', 'forsion-extend')
      for (const f of ['package.json', ...pkg.files]) {
        fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true })
        fs.cpSync(path.join(EXTEND, f), path.join(dest, f), { recursive: true })
      }
    },
    stubOverride: async (req) => {
      if (req.path === '/agent/special/muse/starters' && req.method === 'GET') return { starters: [] }
      if (req.path === '/agent/widgets' && req.method === 'GET') return { widgets: [] }
      if (/^\/agent\/widgets\//.test(req.path)) return { __code: 404, body: { error: 'WIDGET_NOT_FOUND' } }
    },
  })
  const { app, win } = ctx
  const card = () => win.locator(`.hp-rail .hp-wcard[data-widget-id="${CARD}"]`).first()
  try {
    await boot(app, win, { space: 'home', width: 1512, height: 950 })
    await win.evaluate(() => document.fonts.ready)
    await win.locator('.hp-composer').first().waitFor({ timeout: 15_000 })
    await sleep(3500) // 插件装载

    // 主进程半身装上了(验签过):卡读的是新同步通道,不是退回宿主老接缝的那条路(那条没登录也画「未登录」,分不出来)
    const chan = await win.evaluate(() => window.tangu?.cloudInvoke?.('penzor:sync:get').catch((e) => ({ thrown: String(e?.message || e) })))
    check('Extend 主进程半身已装载:新同步通道回 not_signed_in', chan?.ok === false && chan?.error === 'not_signed_in', JSON.stringify(chan))

    // ── 收纳面板:插件组里有「同步」,点一下放上主页 ──
    await win.locator('.hp-dock .hp-more').first().click(); await sleep(700)
    await win.locator('.hp-organizer-tabs [data-tab="widgets"]').first().click(); await sleep(900)
    const tiles = await win.evaluate(() => [...document.querySelectorAll('.hp-lib-tile')].map((t) => t.innerText.replace(/\n/g, ' ')))
    const tile = win.locator('.hp-lib-tile').filter({ hasText: /^同步/ }).first()
    check('收纳:插件组里有「同步」', await tile.count() === 1, JSON.stringify(tiles))
    await captureWindow(app, path.join(OUT, 'library.png'))
    if (await tile.count() !== 1) throw new Error('收纳面板里没有「同步」,后面的不查了(这份 Extend 没装上,或播种换回了随包的旧版)')
    await tile.click(); await sleep(600)
    await win.keyboard.press('Escape'); await sleep(400)
    const box = await win.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    await win.mouse.click(box.w - 60, box.h - 40); await sleep(400)
    check('点一下放上主页', await card().count() === 1, JSON.stringify(await win.evaluate(() => [...document.querySelectorAll('.hp-rail .hp-wcard')].map((c) => c.dataset.widgetId))))

    // ── 卡头 + 行:没登录 = 宿主拿到一行提示 ──
    await card().locator('.hp-wl-row').first().waitFor({ timeout: 12_000 }).catch(() => {})
    const text = await card().innerText().catch(() => '')
    check('卡头「同步 · Forsion 扩展」', /同步/.test(text) && /Forsion 扩展/.test(text), text.split('\n').slice(0, 2).join(' / '))
    check('没登录:画出「未登录 Forsion 账号」那一行', await card().locator('.hp-wl-row').filter({ hasText: '未登录 Forsion 账号' }).count() === 1, text.replace(/\n/g, ' | '))
    check('不是「暂时读不到」也不是空', !/暂时读不到|暂时没有内容/.test(text), text.replace(/\n/g, ' | '))
    await captureWindow(app, path.join(OUT, 'sync-card.png'))

    // ── 点行打开蓬洲云 ──
    const penzorOn = () => win.evaluate(() => !!document.querySelector('[class*="pz-"]'))
    const before = await penzorOn()
    await card().locator('.hp-wl-row').first().click(); await sleep(1500)
    check('点行:打开蓬洲云', !before && await penzorOn(), `before=${before}`)
    await captureWindow(app, path.join(OUT, 'penzor.png'))
  } catch (e) {
    check(String(e?.message || e).split('\n')[0], false)
  } finally {
    await ctx.close()
  }
  process.exitCode = R.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exit(1) })
