/**
 * ⌘⇧O = 命令「切换 Space」打开 Space 收纳(2026-11-02 主页方案第四轮)。真 Electron,量 out/ 里的产物。
 *
 * 判据:
 *   1 在 Tangu 里按 ⌘⇧O:外层那块收纳弹出来(.hp-organizer-host),搜索框聚焦,默认选中上一个用过的 Space,
 *     当前 Space(Tangu)带「当前」标记,底部是按键说明
 *   2 输入搜索词:只剩名字 / id 里带它的 Space;回车 = 切过去并收起
 *   3 再按一次 ⌘⇧O 收起;Esc 也收起
 *   4 主页上按 ⌘⇧O:开的是主页自己那块(不是外层那块),同样按键说明;点坞上「全部」开时底部提示写着快捷键
 *   5 ⌘K 里「切换 Space」那一行带着快捷键
 *
 * 跑:npm run build && npm run check:spaceorganizer [-- --shot <目录>](亮色截图:Tangu 里叫出来的那张 + 主页那张)
 *   负对照:node scripts/space-organizer.check.cjs --app <没有这次改动、已 build 的 desktop 目录> → 第 1 条红。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null }
const APP_ROOT = path.resolve(arg('--app') || path.join(__dirname, '..'))
const SHOT = arg('--shot')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'space-organizer-'))
const KEY = process.platform === 'darwin' ? 'Meta+Shift+O' : 'Control+Shift+O'
const MOD_K = process.platform === 'darwin' ? 'Meta+k' : 'Control+k'

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : `  ${detail}`}`)
}

const SNAP = `(() => {
  const vis = (e) => !!e && e.getClientRects().length > 0
  const host = document.querySelector('.hp-organizer-host')
  const stage = [...document.querySelectorAll('.hp-organizer-stage')].find(vis)
  const tiles = stage ? [...stage.querySelectorAll('.hp-organizer-grid > .hp-tile')] : []
  return {
    host: vis(host),
    open: !!stage,
    inHome: !!stage && !stage.closest('.hp-organizer-host'),
    focused: document.activeElement?.closest?.('.hp-organizer-search') ? true : false,
    ids: tiles.map((t) => t.getAttribute('data-id')),
    sel: tiles.find((t) => t.hasAttribute('data-sel'))?.getAttribute('data-id') || null,
    current: tiles.find((t) => t.hasAttribute('data-current'))?.getAttribute('data-id') || null,
    keys: !!stage?.querySelector('footer kbd'),
    foot: stage?.querySelector('footer')?.textContent || '',
    active: localStorage.getItem('forsion_tangu_active_space'),
  }
})()`

async function enterSpace(win, id) {
  const hit = await win.evaluate((id) => {
    // 上区格子带 data-id;主页不在上区,在 .rb-home 那一组里
    const b = document.querySelector(`.rb-slot[data-id="space:${id}"] .rb-space`) || (id === 'home' ? document.querySelector('.rb-home .rb-space') : null)
    if (b) { b.click(); return true }
    return false
  }, id)
  await win.waitForTimeout(1800)
  return hit
}

async function main() {
  if (!fs.existsSync(path.join(APP_ROOT, 'out/main/main.js'))) {
    console.error(`缺 ${APP_ROOT}/out/main/main.js —— 先跑 npm run build`)
    process.exit(1)
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(TMP, 'ud')}`, '--lang=zh-CN', APP_ROOT],
    cwd: APP_ROOT,
    env: { ...process.env, TANGU_HOME: path.join(TMP, 'home'), TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  const win = await app.firstWindow()
  const errs = []
  win.on('pageerror', (e) => errs.push(String(e?.message || e)))
  try {
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1512, 950))
    // 先进笔记再进 Tangu:「上一个用过的 Space」= 笔记
    await enterSpace(win, 'amadeus')
    await enterSpace(win, 'tangu')

    // 1
    await win.keyboard.press(KEY)
    await win.waitForTimeout(600)
    const s1 = await win.evaluate(SNAP)
    check('1 Tangu 里按 ⌘⇧O:外层收纳弹出、搜索聚焦、选中上一个(笔记)、当前是 Tangu、底部按键说明',
      s1.host && s1.open && !s1.inHome && s1.focused && s1.sel === 'space:amadeus' && s1.current === 'space:tangu' && s1.keys,
      JSON.stringify(s1))
    if (SHOT) await win.screenshot({ path: path.join(SHOT, 'organizer-tangu.png') })

    // 2
    await win.keyboard.type('calendar')
    await win.waitForTimeout(300)
    const s2 = await win.evaluate(SNAP)
    check('2a 搜索 calendar:只剩日历,且选中它', s2.ids.length === 1 && s2.ids[0] === 'space:calendar' && s2.sel === 'space:calendar', JSON.stringify(s2))
    await win.keyboard.press('Enter')
    await win.waitForTimeout(1500)
    const s2b = await win.evaluate(SNAP)
    check('2b 回车:切到日历并收起', !s2b.open && s2b.active === 'calendar', JSON.stringify(s2b))

    // 3
    await win.keyboard.press(KEY)
    await win.waitForTimeout(400)
    const s3a = await win.evaluate(SNAP)
    await win.keyboard.press(KEY)
    await win.waitForTimeout(400)
    const s3b = await win.evaluate(SNAP)
    await win.keyboard.press(KEY)
    await win.waitForTimeout(400)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
    const s3c = await win.evaluate(SNAP)
    const blockers = await win.evaluate(() => [...document.querySelectorAll('.dialog-overlay, .ctx-menu')].map((x) => `${x.className}:${x.getClientRects().length}`))
    check('3 再按一次收起、Esc 也收起', s3a.open && !s3b.open && !s3c.open, JSON.stringify({ s3a: s3a.open, s3b: s3b.open, s3c: s3c.open, focus: s3c.focused, blockers }))

    // 4
    check('4 前提:进得去主页', await enterSpace(win, 'home'))
    await win.keyboard.press(KEY)
    await win.waitForTimeout(700)
    const s4a = await win.evaluate(SNAP)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
    const s4b = await win.evaluate(SNAP)
    // 鼠标打开:坞上有「全部」就点它,Space 少时没有这颗钮,就右键空白(主页另一个入口)
    const more = win.locator('.hp-more').first()
    if (await more.count()) await more.click()
    else await win.mouse.click(200, 520, { button: 'right' })
    await win.waitForTimeout(700)
    const s4c = await win.evaluate(SNAP)
    if (SHOT) await win.screenshot({ path: path.join(SHOT, 'organizer-home.png') })
    check('4 主页上按 ⌘⇧O 开的是主页那块(按键说明、Esc 收起);点「全部」开时底部提示带快捷键',
      s4a.open && s4a.inHome && !s4a.host && s4a.keys && !s4b.open && s4c.open && !s4c.keys && /⇧⌘O|Ctrl\+Shift\+O/i.test(s4c.foot),
      JSON.stringify({ s4a, s4b: s4b.open, s4c }))
    await win.mouse.click(1490, 930)
    await win.waitForTimeout(400)

    // 5
    await win.keyboard.press(MOD_K)
    await win.waitForTimeout(400)
    await win.locator('.cmd-input').fill('切换')
    await win.waitForTimeout(300)
    const hk = await win.evaluate(() => document.querySelector('.cmd-item[data-command-id="set-active-space"] .cmd-hotkey')?.textContent || '')
    check('5 ⌘K 里「切换 Space」带快捷键', /⇧⌘O|Ctrl\+Shift\+O/i.test(hk), JSON.stringify(hk))
    await win.keyboard.press('Escape')

    check('页面无未捕获异常', errs.length === 0, errs.join(' | '))
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(TMP, { recursive: true, force: true })
  }
  console.log(failed ? `\n${failed} 条红` : '\n全绿')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
