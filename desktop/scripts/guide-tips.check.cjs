/**
 * 插件上手提示(manifest guide.tips,2026-11-02)的真 Electron 仪器。
 * 方案页 docs/ToBeImproved/可复用引导系统方案_2026-11-02/(Forsion-Root 仓),用户选 D「用到时再提示」。
 *
 * 在隔离 TANGU_HOME 里现生成夹具插件 guide-fixture(不依赖任何外部插件仓):两个 View、两条提示,
 * main.js 把 ctx 挂到 window.__guideFixture 让台架开 View / 报事件 / 占弹窗队列。
 *  - line-tip:锚点 a1(View main),when.open main,done did-a1,行内一行
 *  - ring-tip:锚点 a2(View second),when.open second,done did-a2,圈注 + 小卡
 *
 * 断言:
 *  A 打开 View → 锚点出现 2 秒后出行内一行,贴在锚点上沿
 *  B 点 × → 记成看过,同一个 View 重开也不再出(⚠ 负对照靶子:把「ok → 记看过」那行注掉,B 必须红)
 *  C 圈注出现(圈 + 小卡标题)
 *  D 圈注出着时插件报了 done 事件 → 当场收掉,ctx.guide.state = learned
 *  E 当天已出满 3 条 → 不出
 *  F 有弹窗在排(ctx.app.queuePopup)→ 不出;让出后才出;出着时又来了弹窗 → 收掉让路、不记看过
 *  G 设置里关了上手提示 → 不出,state = off
 *  H 做过那件事(done 计数 ≥ 1)的提示从来不出
 *
 * 用法:npx electron-vite build 之后 `node scripts/guide-tips.check.cjs`(台架上锁见 .claude/hooks/devlock.cjs)。
 * SHOTS=<目录> 时另拍行内 / 圈注的浅色、深色各一张。
 */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-guide-tips-'))
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`) }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ID = 'guide-fixture'
const SHOTS = process.env.SHOTS

function writeFixture(home) {
  const dir = path.join(home, 'plugins', ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: ID, name: 'Guide Fixture', version: '1.0.0', minAppVersion: '0.0.1',
    description: 'guide-tips.check 的夹具,不是产品插件',
    guide: { tips: [
      { id: 'line-tip', at: 'a1', style: 'line', when: { open: 'main', times: 1 }, done: ['did-a1'],
        text: '行内提示:打 # 加标签', en: { text: 'Line tip: type # to tag' } },
      { id: 'ring-tip', at: 'a2', style: 'ring', when: { open: 'second', times: 1 }, done: ['did-a2'],
        title: '拖到这里', text: '圈注提示的正文', en: { title: 'Drag here', text: 'Ring tip body' } },
    ] },
  }, null, 2))
  const view = (id, anchor) => `ctx.registerView({ id: '${id}', title: '${id}', mount(el) {
  el.innerHTML = '<div style="padding:120px 40px"><input data-guide-anchor="${anchor}" placeholder="${anchor}" style="width:420px;height:36px"></div>'
} })`
  fs.writeFileSync(path.join(dir, 'main.js'), `window.__guideFixture = ctx\n${view('main', 'a1')}\n${view('second', 'a2')}\n`)
}

async function waitFor(fn, timeoutMs = 10000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true
    await pause(150)
  }
  return false
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npx electron-vite build')
    process.exit(2)
  }
  const home = path.join(temp, 'home')
  writeFixture(home)
  const userData = path.join(temp, 'userdata')
  fs.mkdirSync(userData + '-dev', { recursive: true })
  const stub = await startStubEngine({ sessions: [] })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'guide-tips-test-token' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    const win = await app.firstWindow()
    await win.waitForSelector('.shell-host', { timeout: 30000, state: 'attached' })
    check('主窗已离开首启引导', await skipOnboarding(win))
    check('夹具插件已启用', await waitFor(() => win.evaluate(() => !!window.__guideFixture), 30000))

    const line = win.locator('.guide-tip-line')
    const ring = win.locator('.guide-spot-ring')
    const state = (id) => win.evaluate((t) => window.__guideFixture.guide?.state(t), id)
    const open = (v) => win.evaluate((x) => window.__guideFixture.openView(x), v)
    // 关掉再开 = View 重新挂载(宿主「一个 View 打开一次最多一条」按挂载算;不关就只是切标签,测不到「重开」)
    const reopen = async (v) => { await win.evaluate(() => { window.__guideFixture.closeView?.('main'); window.__guideFixture.closeView?.('second') }); await pause(300); await open(v) }
    const reset = () => win.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('guide.') && !k.includes('.__open.')) localStorage.removeItem(k) })
    const shoot = async (name) => {
      if (!SHOTS) return
      fs.mkdirSync(SHOTS, { recursive: true })
      for (const dark of [false, true]) {
        await win.evaluate((d) => { document.documentElement.dataset.mode = d ? 'dark' : 'light'; document.documentElement.classList.toggle('dark', d) }, dark)
        await pause(250)
        await win.screenshot({ path: path.join(SHOTS, `${name}-${dark ? 'dark' : 'light'}.png`) })
      }
      await win.evaluate(() => { document.documentElement.dataset.mode = 'light'; document.documentElement.classList.remove('dark') })
    }

    // 后台弹窗(What's new 等)占着队列时提示本来就不出:先等它们走完,免得把 F 的效果混进 A
    await win.evaluate(() => { for (const b of document.querySelectorAll('.dialog-actions button')) b.click() }).catch(() => {})
    await pause(500)

    await open('main')
    check('A 打开 View 后出行内一行', await waitFor(() => line.count().then((n) => n === 1), 12000))
    const geo = await win.evaluate(() => {
      const t = document.querySelector('.guide-tip-line')?.getBoundingClientRect()
      const a = document.querySelector('[data-guide-anchor="a1"]')?.getBoundingClientRect()
      return t && a ? { tipBottom: t.bottom, anchorTop: a.top, sameLeft: Math.abs(t.left - a.left) < 2, text: document.querySelector('.guide-tip-line')?.textContent } : null
    })
    check('A 贴在锚点上沿、同左边、中文正文', !!geo && geo.tipBottom <= geo.anchorTop + 1 && geo.sameLeft && geo.text.includes('行内提示'), JSON.stringify(geo))
    await shoot('line')
    await line.locator('.guide-tip-x').click()
    check('B 点 × 后收起', await waitFor(() => line.count().then((n) => n === 0), 3000))
    check('B 记成看过', (await state('line-tip')) === 'seen', String(await state('line-tip')))
    await reopen('main')
    await pause(4500)
    check('B 重开 View 也不再出', (await line.count()) === 0)

    await reopen('second')
    check('C 圈注出现', await waitFor(() => ring.count().then((n) => n === 1), 12000))
    check('C 小卡标题', (await win.locator('.guide-spot-card .guide-spot-title').textContent().catch(() => '')) === '拖到这里')
    await shoot('ring')
    await win.evaluate(() => window.__guideFixture.achievements.track('did-a2'))
    check('D 报了 done 事件 → 圈注当场收掉', await waitFor(() => ring.count().then((n) => n === 0), 3000))
    check('D state = learned', (await state('ring-tip')) === 'learned', String(await state('ring-tip')))

    // E:当天出满 3 条
    await reset()
    await win.evaluate(() => localStorage.setItem('guide.day', JSON.stringify({ d: ((x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`)(new Date()), n: 3 })))
    await reopen('main')
    await pause(4500)
    check('E 当天已出满 3 条 → 不出', (await line.count()) === 0)

    // F:有弹窗在排
    await reset()
    await win.evaluate(() => { window.__turn = window.__guideFixture.app.queuePopup() })
    await reopen('main')
    await pause(4500)
    check('F 有弹窗在排 → 不出', (await line.count()) === 0)
    await win.evaluate(() => window.__turn.done())
    check('F 弹窗让出后才出', await waitFor(() => line.count().then((n) => n === 1), 8000))
    // 提示出着时又来了弹窗:收掉让路,不记看过(否则压在弹窗底下还先吃掉 Esc)
    await win.evaluate(() => { window.__turn2 = window.__guideFixture.app.queuePopup() })
    check('F 出着时来了弹窗 → 收掉、不记看过', await waitFor(() => line.count().then((n) => n === 0), 3000) && (await state('line-tip')) === 'waiting', String(await state('line-tip')))
    await win.evaluate(() => window.__turn2.done())

    // G:总开关关掉
    await reset()
    await win.evaluate(() => localStorage.setItem('guide.enabled', '0'))
    await reopen('main')
    await pause(4500)
    check('G 关了上手提示 → 不出', (await line.count()) === 0)
    check('G state = off', (await state('line-tip')) === 'off', String(await state('line-tip')))
    await win.evaluate(() => localStorage.removeItem('guide.enabled'))

    // H:先做过那件事
    await reset()
    await win.evaluate(() => window.__guideFixture.achievements.track('did-a1'))
    await reopen('main')
    await pause(4500)
    check('H 做过那件事的提示从来不出', (await line.count()) === 0 && (await state('line-tip')) === 'learned', String(await state('line-tip')))
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok) || results.length === 0) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
