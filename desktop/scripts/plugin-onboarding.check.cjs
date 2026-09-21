/**
 * 插件检查卡(2026-09-21 重做)的真 Electron 仪器。
 *
 * 用户原话:「每个插件都有一个运行引导,有些没用,有些莫名其妙」。重做后的契约:
 *  - manifest onboarding 有 requires = 闸:宿主实测每一条,有未满足才挂「待引导」徽标、弹检查卡;
 *  - 没有 requires = 使用说明:详情页里折叠展示,不给「运行引导」按钮、不挂徽标、不弹;
 *  - 状态全由实测派生:没有「点一下完成」的自证按钮,满足了徽标自己消失。
 *
 * 在隔离 TANGU_HOME 里现生成两个夹具插件(不依赖任何外部插件仓):
 *  - gate-fixture :requires = setting:name(默认值是占位串「占位名」)+ check:probe(插件自报,读 localStorage 开关)
 *  - guide-fixture:只有 intro + steps,没有 requires
 *
 * 断言(都打在设置浮窗里 —— 设置是独立 BrowserWindow,见 floating-panel.check.cjs):
 *  A 闸插件一开设置就挂徽标:setting 的值还是占位默认 → 未满足。⚠ 负对照靶子:把 settingState 改回「非空即可」,A 必须红。
 *  B 说明插件没有徽标
 *  C 说明插件详情页:没有「运行引导」按钮,有折叠的「使用说明」
 *  D 手动重新启用闸插件 = 注意力在场 → 检查卡自己弹出来
 *  E 卡里 setting 行未满足 → 就地填写 → 变成已就绪
 *  F 卡里 check 行未满足 → 插件那边条件变真 → 点「重新检查」→ 已就绪,整卡「全部就绪」
 *  G 关卡后徽标消失(没有任何人点过「完成设置」)
 *
 * 用法:npm run build(或 npx electron-vite build)之后 `node scripts/plugin-onboarding.check.cjs`。
 * 渲染层改动不 build 就跑 = 测的是旧代码(调试铁律 2)。
 */
const fs = require('fs'), os = require('os'), path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-plugin-onboarding-'))
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` | ${detail}` : ''}`) }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const GATE = 'gate-fixture'
const GUIDE = 'guide-fixture'
const LEGACY = 'legacy-fixture'
const PLACEHOLDER = '占位名'

function writeFixtures(home) {
  const plugins = path.join(home, 'plugins')
  const gate = path.join(plugins, GATE)
  fs.mkdirSync(gate, { recursive: true })
  fs.writeFileSync(path.join(gate, 'manifest.json'), JSON.stringify({
    id: GATE, name: 'Gate Fixture', version: '1.0.0', minAppVersion: '0.0.1',
    description: 'plugin-onboarding.check 的闸夹具,不是产品插件',
    onboarding: {
      intro: '夹具:两条前置条件。',
      requires: [{ kind: 'setting', key: 'name' }, { kind: 'check', id: 'probe' }],
      en: { intro: 'Fixture: two requirements.' },
    },
  }, null, 2))
  // main.js 是 new Function('ctx', code) 的函数体。
  fs.writeFileSync(path.join(gate, 'main.js'), `
ctx.registerSetting({ key: 'name', label: 'Name', type: 'text', default: ${JSON.stringify(PLACEHOLDER)} })
if (ctx.registerReadiness) ctx.registerReadiness({
  id: 'probe',
  label: 'Probe',
  check: async () => (localStorage.getItem('fixture.probe') === 'ok' ? 'ok' : { state: 'unmet', detail: 'probe says no' }),
})
`)
  // 迁移夹具:老用户点过「完成设置」(localStorage 里留着 __setupDone=1),但前置条件其实没满足。
  // 新实现必须无视那个自证标志 —— 只测「不再写入」证明不了这一点(needsOnboarding 若加回短路,那条照样绿)。
  const legacy = path.join(plugins, LEGACY)
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'manifest.json'), JSON.stringify({
    id: LEGACY, name: 'Legacy Fixture', version: '1.0.0', minAppVersion: '0.0.1',
    description: 'plugin-onboarding.check 的迁移夹具,不是产品插件',
    onboarding: { intro: '老用户点过完成设置。', requires: [{ kind: 'setting', key: 'name' }], en: { intro: 'Legacy user clicked done.' } },
  }, null, 2))
  fs.writeFileSync(path.join(legacy, 'main.js'),
    `ctx.registerSetting({ key: 'name', label: 'Name', type: 'text', default: ${JSON.stringify(PLACEHOLDER)} })\n`)

  const guide = path.join(plugins, GUIDE)
  fs.mkdirSync(guide, { recursive: true })
  fs.writeFileSync(path.join(guide, 'manifest.json'), JSON.stringify({
    id: GUIDE, name: 'Guide Fixture', version: '1.0.0', minAppVersion: '0.0.1',
    description: 'plugin-onboarding.check 的说明夹具,不是产品插件',
    onboarding: { intro: '只是使用说明。', steps: [{ title: '第一步' }], en: { intro: 'Just a guide.', steps: [{ title: 'Step one' }] } },
  }, null, 2))
  fs.writeFileSync(path.join(guide, 'main.js'), '')
}

async function waitFor(fn, timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true
    await pause(100)
  }
  return false
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npx electron-vite build')
    process.exit(2)
  }
  const home = path.join(temp, 'home')
  writeFixtures(home)
  const userData = path.join(temp, 'userdata')
  fs.mkdirSync(userData + '-dev', { recursive: true })
  const stub = await startStubEngine({ sessions: [] })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'onboarding-test-token' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    const main = await app.firstWindow()
    await main.waitForSelector('.shell-host', { timeout: 30000, state: 'attached' })
    for (const name of ['跳过引导', 'Skip']) { const b = main.getByRole('button', { name, exact: true }); if (await b.count()) { await b.click(); break } }

    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'amadeus-plugins' } }))
    let fl
    await waitFor(async () => { fl = app.windows().find((p) => p.url().includes('window=floating')); return !!fl }, 10000)
    if (!fl) throw new Error('settings floating window missing')
    await fl.waitForSelector(`[data-plugin-id="${GATE}"]`, { timeout: 30000 })
    await fl.waitForSelector(`[data-plugin-id="${GUIDE}"]`, { timeout: 30000 })

    // 老标志先种进去(与真实老用户同形:同源 localStorage,设置窗读的就是它),再逼宿主重测一次。
    await fl.evaluate((id) => localStorage.setItem(`plugin.${id}.__setupDone`, '1'), LEGACY)
    const gateCard = fl.locator(`[data-plugin-id="${GATE}"]`)
    const legacyCard = fl.locator(`[data-plugin-id="${LEGACY}"]`)
    const guideCard = fl.locator(`[data-plugin-id="${GUIDE}"]`)
    const badgeOn = (loc) => loc.locator('[data-onboarding-badge]').count().then((n) => n > 0)

    // A:占位默认值 = 未填 → 一打开就有徽标
    check('A 闸插件:设置还是占位默认值 → 列表上挂「待引导」', await waitFor(() => badgeOn(gateCard)))
    // B
    check('B 说明插件(无 requires)不挂徽标', !(await badgeOn(guideCard)))

    // H:老的自证标志不许再让一道真闸闭嘴(删 __setupDone 之后的迁移回归)
    await legacyCard.locator('input[type="checkbox"]').click() // 关
    await pause(300)
    await legacyCard.locator('input[type="checkbox"]').click() // 开 → 重测
    check('H 老用户点过的 __setupDone=1 不再让未满足的闸闭嘴',
      await waitFor(() => badgeOn(legacyCard), 10000))
    const legacyPopped = await waitFor(() => fl.locator('.plugin-onboarding-card').count().then((n) => n === 1), 10000)
    check('H 它照样会弹检查卡', legacyPopped)
    if (legacyPopped) {
      await fl.locator('.plugin-onboarding-card .dialog-actions button').first().click() // 稍后
      await waitFor(() => fl.locator('.plugin-onboarding-card').count().then((n) => n === 0))
    }

    // C:说明插件详情页
    await guideCard.click()
    await fl.waitForSelector(`[data-plugin-detail="${GUIDE}"]`, { timeout: 10000 })
    const guideDetail = fl.locator(`[data-plugin-detail="${GUIDE}"]`)
    check('C 说明插件详情页没有「运行引导」按钮', (await guideDetail.locator('[data-onboarding-run]').count()) === 0)
    check('C 说明插件的内容以折叠的「使用说明」展示(没丢)', (await guideDetail.locator('details.plugin-guide').count()) === 1
      && (await guideDetail.locator('details.plugin-guide').innerText()).includes('使用说明'))
    await guideDetail.locator('[data-plugin-back]').click()
    await fl.waitForSelector(`[data-plugin-id="${GATE}"]`, { timeout: 10000 })

    // D:关掉再打开 = 手动启用 → 检查卡自己弹
    const box = gateCard.locator('input[type="checkbox"]')
    await box.click() // 关
    await pause(300)
    await box.click() // 开
    const card = fl.locator('.plugin-onboarding-card')
    check('D 手动启用闸插件 → 检查卡自动弹出', await waitFor(() => card.count().then((n) => n === 1), 10000))

    const reqState = (key) => card.locator(`[data-requirement="${key}"] .plugin-req-state`).getAttribute('data-state').catch(() => null)
    // E:setting
    check('E 卡里 setting 行初始为未完成', await waitFor(async () => (await reqState('setting:name')) === 'unmet'))
    await waitFor(async () => (await reqState('check:probe')) === 'unmet')
    // 入场动画(panel-rise)跑完再截,否则半透明的中间帧会被误读成「卡片透底」。
    await fl.evaluate(() => document.getAnimations().forEach((a) => { if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish() }))
    await pause(100)
    const cardShot = path.join(temp, 'plugin-onboarding-card.png')
    await fl.screenshot({ path: cardShot })
    const cardBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor)
    console.log(`CARD_BG ${cardBg}`)
    console.log(`CARD_SCREENSHOT ${cardShot}`)
    await card.locator('[data-requirement="setting:name"] input[type="text"]').fill('我的真名字')
    check('E 就地填写后 setting 行变为已就绪', await waitFor(async () => (await reqState('setting:name')) === 'ok'), String(await reqState('setting:name')))

    // F:check
    check('F 卡里 check 行初始为未完成(插件自报,带原因)', await waitFor(async () => (await reqState('check:probe')) === 'unmet')
      && (await card.locator('[data-requirement="check:probe"]').innerText()).includes('probe says no'))
    await fl.evaluate(() => localStorage.setItem('fixture.probe', 'ok'))
    await card.locator('.dialog-actions [data-primary]').click() // 未满足时主按钮 = 重新检查
    check('F 条件变真后「重新检查」→ check 行已就绪', await waitFor(async () => (await reqState('check:probe')) === 'ok'), String(await reqState('check:probe')))
    check('F 两条都满足 → 卡片说「全部就绪」', await waitFor(() => card.locator('.plugin-onboarding-summary[data-ready="1"]').count().then((n) => n === 1)))

    // G:关卡后徽标消失
    await card.locator('.dialog-actions [data-primary]').click() // 全部就绪时主按钮 = 完成(只是关卡)
    await waitFor(() => card.count().then((n) => n === 0))
    check('G 前置条件都满足后徽标自己消失(没人点过「完成设置」)', await waitFor(async () => !(await badgeOn(gateCard))))
    const legacy = await fl.evaluate((id) => localStorage.getItem(`plugin.${id}.__setupDone`), GATE)
    check('G 不再写自证标志 __setupDone', legacy === null, String(legacy))

    const shot = path.join(temp, 'plugin-onboarding.png')
    await fl.screenshot({ path: shot })
    console.log(`SCREENSHOT ${shot}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some((ok) => !ok) || results.length === 0) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
