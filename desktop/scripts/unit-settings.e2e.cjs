/**
 * 设置 › 设备(原 Ribbon 胶囊菜单,10-17 搬进设置)的**真 Electron** 验证:点胶囊 → 设置浮窗直接落在「设备」页;
 * 在浮窗里「通过地址连接…」→ 浮窗收起、主窗整个主区切到那个地址(unit-route 主窗动作的整条跨窗口路径;
 * harness 里设置是窗内的,这条只有真多窗口才走得到)。顺带截一张真实设置窗(交付纪律)。
 *
 * 不点「允许其他设备连接本机」:那会在本机起局域网服务。数据全在临时 TANGU_HOME。
 * 需先 npm run build。用法:npm run e2e:unitsettings   (SHOT_DIR 指截图目录,缺省 /tmp)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || '/tmp'
const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-unitset-'))
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    // 命令区放不下时胶囊收在底部「⋯」溢出浮层里(用户报「Ribbon 恢复就关掉」的现场正是这里:浮层一收,旧菜单跟着卸载)
    const openPill = async () => {
      await win.waitForTimeout(400) // 溢出浮层的收起动画走完再判
      if (!(await win.locator('.unitsw-pill').first().isVisible().catch(() => false))) await win.locator('[data-rb-more="bottom"]').first().click()
      await win.waitForSelector('.unitsw-pill', { timeout: 10_000 })
      await win.waitForTimeout(300)
      await win.locator('.unitsw-pill').first().click()
    }
    const opened = app.waitForEvent('window', { timeout: 20_000 }).catch(() => null)
    await openPill()
    const sp = await opened
    check('点胶囊 → 开出设置浮窗(主窗不弹菜单)', !!sp && !(await win.locator('.unitsw-menu').count()))
    if (!sp) throw new Error('设置浮窗没开出来')
    await sp.waitForSelector('.unitset-page', { timeout: 20_000 }).catch(() => {})
    const landed = await sp.evaluate(() => ({
      page: !!document.querySelector('.unitset-page'),
      nav: document.querySelector('.settings-nav [aria-current="page"], .settings-nav .active')?.textContent?.trim() ?? '',
      rows: Array.from(document.querySelectorAll('.unitset-list .unitsw-row .unitsw-title')).map((n) => n.textContent.trim()),
    }))
    check('浮窗直接落在「设备」页', landed.page, landed)
    check('列表里有「本地」与「通过地址连接…」', landed.rows.includes('本地') && landed.rows.some((r) => r.includes('地址')), landed.rows)
    await sp.waitForTimeout(500)
    await sp.screenshot({ path: path.join(SHOT_DIR, 'unit-settings-electron.png') })

    // 跨窗口:浮窗里手输地址 → 主窗远程面
    await sp.locator('.unitset-list .unitsw-row', { hasText: '通过地址连接' }).first().click()
    const input = sp.locator('.dialog input').first()
    await input.waitFor({ timeout: 5000 })
    await input.fill('http://127.0.0.1:9')
    const closed = sp.waitForEvent('close', { timeout: 8000 }).then(() => true).catch(() => false)
    await input.press('Enter')
    check('确认后设置浮窗收起', await closed)
    await win.waitForSelector('.unitrs', { timeout: 8000 }).catch(() => {})
    const surf = await win.evaluate(() => ({
      src: document.querySelector('.unitrs-web')?.getAttribute('src') ?? '',
      visible: !!document.querySelector('.unitrs') && getComputedStyle(document.querySelector('.unitrs')).visibility === 'visible',
      pill: document.querySelector('.unitsw-pill')?.getAttribute('title') ?? '',
    }))
    check('主窗整个主区切到该地址(unit-route 跨窗口)', surf.visible && surf.src === 'http://127.0.0.1:9/', surf)
    surf.pill = await win.locator('.unitsw-pill').first().getAttribute('title').catch(() => '') || ''
    check('胶囊显示当前设备(回来的路)', surf.pill.includes('127.0.0.1:9'), surf.pill)
    await win.screenshot({ path: path.join(SHOT_DIR, 'unit-settings-remote.png') })

    // 再开设置选「本地」→ 远程面退场
    // 设置浮窗关掉后可能被复用(不再发 window 事件):按「哪扇窗里有设备页」找
    await openPill()
    let sp2 = null
    for (let i = 0; i < 40 && !sp2; i++) {
      await win.waitForTimeout(250)
      for (const p of app.windows()) if (p !== win && await p.locator('.unitset-page').count().catch(() => 0)) sp2 = p
    }
    check('再点胶囊:设置浮窗再次落在设备页', !!sp2)
    const stillRemote = await win.evaluate(() => getComputedStyle(document.querySelector('.unitrs')).visibility)
    check('去点胶囊(含展开「⋯」)不会把远程面踢回本机', stillRemote === 'visible', stillRemote)
    await sp2?.locator('.unitset-list .unitsw-row', { hasText: '本地' }).first().click()
    await win.waitForFunction(() => getComputedStyle(document.querySelector('.unitrs')).visibility === 'hidden', null, { timeout: 8000 }).catch(() => {})
    const back = await win.evaluate(() => getComputedStyle(document.querySelector('.unitrs')).visibility)
    check('设置里选「本地」→ 远程面隐藏(切回本机)', back === 'hidden', back)
  } finally {
    await app?.close().catch(() => {})
    stub.close?.()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const fails = results.filter((r) => !r).length
  console.log(fails ? `\n❌ ${fails}/${results.length} 未过` : `\n✅ ${results.length}/${results.length} 通过`)
  process.exit(fails ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
