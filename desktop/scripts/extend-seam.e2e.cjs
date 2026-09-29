/**
 * Forsion Extend 主进程半身 × 真 Electron(electron/cloudHost.ts):清单里带 desktop 的内置包,启动时验签装载,
 * 云端账号面 IPC(个人中心 / 会员页 / 额度 / 反馈 / cloud:fetch)由它注册,不再住在 main.ts。
 *
 * 钉住:
 *  ① dev 随包(node_modules/@forsion/extend)播种进 <home>/plugins/forsion-extend/(含 SIGNATURE),[cloud-host] 装载成功;
 *  ② 渲染层 window.tangu.accountQuota / submitFeedback / cloudFetch / openPayCenter 都在;未登录 accountQuota → {status:401,json:null};
 *     cloudFetch 绝对 URL → bad_path(token 不出主进程、边界仍在);②b Connect 三个桥键由 Extend 0.2 注册,越界 publish 被拒;
 *  ③ 已装副本被改过(用户目录可写:版本抬高、入口改动、没重签)→ 下次启动播种把它换回可信的随包那份(永不降级的唯一例外),
 *     装载的是换回来的已装副本,账号面仍在;
 *  ④ 负对照 --absent:随包缺席 → preload 按 cloud:present 删键,四个键全 undefined(渲染层门控自动隐藏,不是 reject)。
 *  ⑥ 设置里「Forsion 云端」自成一级页(账号 + 笔记同步),旧深链落到它;插件卡上 Extend 的开关拨了落盘 disabledBundles + 显示待重启;
 *  ⑦ 停用后重启 = 与缺席同形态(桥键全删、没有这一页、日志记下「已在插件页停用」),开关读主进程状态;重新启用 → ③ 那一跑账号面回来。
 *
 * 需先 npm run build(读 out/)。用法:npm run e2e:extend;负对照:node scripts/extend-seam.e2e.cjs --absent
 * 前置:node_modules/@forsion/extend 是签过名的 npm 包(npm install 装的;本地 pack 的也行,签名用同一把钥匙)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const ABSENT = process.argv.includes('--absent')
const BUNDLED = path.join(ROOT, 'node_modules', '@forsion', 'extend')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function launch(home, stubUrl) {
  const logs = []
  const app = await electron.launch({
    // -ApplePersistenceIgnoreState:所有台架与用户 dev 实例共用同一个 node_modules/electron/dist/Electron.app,前一个实例被杀后
    // macOS 会弹「应用在重新打开窗口时意外退出」模态框,主进程卡在 NSAlert runModal、永远不出窗口(同日日志「Electron 台架启动卡死」)。
    // ⚠️ 单短横的 Cocoa 参数必须放在应用路径之后:放前面会被 Electron 当成应用路径,launch 直接超时。
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    // ELECTRON_ENABLE_LOGGING:主进程 console 实时走 stderr;不开的话 stdout 是管道时要到进程退出才冲出来,起不来窗口就什么也看不到。
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 90_000,
  })
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => logs.push(String(d)))
  // 机器满载时(别的会话在打包)冷启动可能超过 Playwright 默认的 30s;超时把主进程日志尾巴带出来,别只报「没窗口」。
  // 卡住的主进程连 SIGTERM 都不理,app.close() 会一起挂死 —— 直接 SIGKILL。
  const win = await app.firstWindow({ timeout: 120_000 }).catch(async (e) => {
    try { app.process().kill('SIGKILL') } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 500))
    throw new Error(`${e.message}\n--- main log tail ---\n${logs.join('').split('\n').filter((l) => !/AppleShowScrollBars|^\s*$/.test(l)).slice(-15).join('\n')}`)
  })
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(1500)
  const bridge = await win.evaluate(async () => {
    const t = window.tangu || {}
    const out = {
      accountQuota: typeof t.accountQuota, submitFeedback: typeof t.submitFeedback, cloudFetch: typeof t.cloudFetch, openPayCenter: typeof t.openPayCenter,
      connectStore: typeof t.connectStore, connectPublish: typeof t.connectPublish, connectMeta: typeof t.connectMeta,
      // 账号核心(Extend 0.3 起):登录 / 状态 / 多账号也是 Extend 的通道
      authStatus: typeof t.authStatus, forsionLogin: typeof t.forsionLogin, authAccounts: typeof t.authAccounts, forsionSwitchAccount: typeof t.forsionSwitchAccount,
      // 云同步 + collab(Extend 0.4 起):两个桥随通道存在
      amadeusSync: typeof window.amadeusSync, amadeusCollab: typeof window.amadeusCollab,
      // 渲染层门控的可见结果:账号卡(ribbon 底部)与设置里的 Forsion 子页是否存在
      dom: {
        accountCard: !!document.querySelector('.ribbon-account, .account-card'),
      },
    }
    if (window.amadeusSync) out.syncStatus = await window.amadeusSync.get()
    if (typeof t.authStatus === 'function') out.status = await t.authStatus()
    if (typeof t.authAccounts === 'function') out.accounts = await t.authAccounts()
    if (typeof t.accountQuota === 'function') out.quota = await t.accountQuota()
    if (typeof t.cloudFetch === 'function') out.evil = await t.cloudFetch({ path: 'https://evil.test/x' })
    // Connect(Extend 0.2 起):meta 读不存在的目录 → {};publish 越界目录 → 拒(不打云端)
    if (typeof t.connectMeta === 'function') out.meta = await t.connectMeta('/nonexistent/project-dir')
    if (typeof t.connectPublish === 'function') out.publishOutside = await t.connectPublish({ dir: '/tmp', name: 'x', slug: 'x', entry: 'index.html' })
    return out
  })
  return { app, win, logs: () => logs.join(''), bridge }
}

/** 壳层配置(userData/tangu-desktop-config.json);未打包时 userData 带 -dev 后缀。 */
const shellConfig = (home) => {
  for (const dir of ['userdata-dev', 'userdata']) {
    try { return JSON.parse(fs.readFileSync(path.join(home, dir, 'tangu-desktop-config.json'), 'utf8')) } catch { /* 下一个 */ }
  }
  return {}
}

/** 开设置浮窗到 target(与 uiux-walk 同法:openFloatingPanel 带 tab 参数),返回那个窗口。 */
async function openSettingsAt(app, win, target) {
  await win.evaluate(([n, t]) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: t, n } }), [Date.now(), target])
  for (let i = 0; i < 80; i++) {
    for (const w of app.windows().filter((x) => !x.isClosed() && x.url().includes('window=floating'))) {
      if (await w.locator('.settings-page').count().catch(() => 0)) { await w.waitForTimeout(600); return w }
    }
    await win.waitForTimeout(250)
  }
  throw new Error('设置浮窗没出来')
}

/** 左栏:一级项文字、点开某一级项后它的子项文字。 */
const navTops = (sp) => sp.$$eval('.settings-nav-parent > button', (bs) => bs.map((b) => b.innerText.trim()))
async function navSubs(sp, top, id) {
  const b = sp.locator('.settings-nav-parent > button', { hasText: top }).first()
  if (!(await b.count())) return null
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click()
  await sp.waitForTimeout(300)
  return sp.$$eval(`#settings-nav-subitems-${id} .settings-nav-subitem`, (bs) => bs.map((b) => b.innerText.trim()))
}

/** 插件页里 Forsion Extend 那张卡:开关在不在 / 勾没勾 / 待重启提示在不在。 */
async function extendCard(sp) {
  const b = sp.locator('.settings-nav-parent > button', { hasText: '插件' }).first()
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click()
  const card = sp.locator('[data-plugin-id="forsion-extend"]').first()
  await card.waitFor({ timeout: 10_000 }).catch(() => {})
  const sw = card.locator('[data-bundle-switch]')
  return {
    card: await card.count(),
    switch: await sw.count(),
    checked: (await sw.count()) ? await sw.isChecked() : null,
    pending: await card.locator('[data-restart-pending]').count(),
    sw,
  }
}

;(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-extend-seam-'))
  const stub = await startStubEngine({ models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off'] }] })
  const installed = path.join(home, 'plugins', 'forsion-extend')
  let hidden = null
  try {
    if (ABSENT) {
      hidden = `${BUNDLED}.absent-${process.pid}`
      fs.renameSync(BUNDLED, hidden)
      const { app, logs, bridge } = await launch(home, stub.url)
      await app.close().catch(() => {})
      check('④ 随包缺席:播种跳过、装载器没装、cloud:present=[] → 账号面与 Connect 的桥键全从 window.tangu 删掉', bridge.accountQuota === 'undefined' && bridge.submitFeedback === 'undefined' && bridge.cloudFetch === 'undefined' && bridge.openPayCenter === 'undefined' && bridge.connectStore === 'undefined' && bridge.connectPublish === 'undefined' && !fs.existsSync(installed), JSON.stringify(bridge))
      check('④b 账号核心(0.3 起)也随包消失:authStatus / forsionLogin / authAccounts / forsionSwitchAccount 全 undefined,账号卡不画', bridge.authStatus === 'undefined' && bridge.forsionLogin === 'undefined' && bridge.authAccounts === 'undefined' && bridge.forsionSwitchAccount === 'undefined' && bridge.dom?.accountCard === false, JSON.stringify({ authStatus: bridge.authStatus, dom: bridge.dom }))
      check('④c 云同步 + collab(0.4 起)也随包消失:window.amadeusSync / amadeusCollab 都不暴露', bridge.amadeusSync === 'undefined' && bridge.amadeusCollab === 'undefined', JSON.stringify({ amadeusSync: bridge.amadeusSync, amadeusCollab: bridge.amadeusCollab }))
      check('④ 主进程日志:随包来源缺失被记下(不是静默)', logs().includes('随包来源缺失'), logs().split('\n').filter((l) => l.includes('builtin')).join(' / ').slice(0, 200))
    } else {
      const bundledVersion = JSON.parse(fs.readFileSync(path.join(BUNDLED, 'manifest.json'), 'utf8')).version
      // 本机 node_modules 里的那份必须就是 package.json 钉的版本:「声明 0.1、实装 0.2」会让这份台架假绿而干净安装红(Codex)
      const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies['@forsion/extend']
      check(`⓪ node_modules 里的 @forsion/extend@${bundledVersion} = package.json 钉的 ${pinned}`, bundledVersion === pinned)
      const run1 = await launch(home, stub.url)
      const seeded = fs.existsSync(path.join(installed, 'SIGNATURE')) && JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8')).version === bundledVersion
      check(`① 随包 @forsion/extend@${bundledVersion} 播种进 <home>/plugins/forsion-extend(含 SIGNATURE),[cloud-host] 装载成功`, seeded && run1.logs().includes(`[cloud-host] 已装载 forsion-extend@${bundledVersion}`), run1.logs().split('\n').filter((l) => l.includes('cloud-host') || l.includes('builtin-plugins')).join(' / ').slice(0, 300))
      check('② 渲染层四个云端键都在;未登录 accountQuota → 401;cloudFetch 绝对 URL → bad_path', run1.bridge.accountQuota === 'function' && run1.bridge.submitFeedback === 'function' && run1.bridge.cloudFetch === 'function' && run1.bridge.openPayCenter === 'function' && run1.bridge.quota?.status === 401 && run1.bridge.quota?.json === null && run1.bridge.evil?.error === 'bad_path', JSON.stringify(run1.bridge))
      check('②b Connect(0.2 起)由 Extend 注册:三个 connect 键在;meta 读不存在目录 → {};publish 越界目录被拒且不打云端', run1.bridge.connectStore === 'function' && run1.bridge.connectPublish === 'function' && run1.bridge.connectMeta === 'function' && JSON.stringify(run1.bridge.meta) === '{}' && run1.bridge.publishOutside?.ok === false && /只能发布|不存在/.test(String(run1.bridge.publishOutside?.detail)), JSON.stringify({ meta: run1.bridge.meta, publishOutside: run1.bridge.publishOutside }))
      check('②d 云同步 + collab(0.4 起)由 Extend 注册:amadeusSync / amadeusCollab 两个桥都在;未登录 sync:get → auth-required / side=local', run1.bridge.amadeusSync === 'object' && run1.bridge.amadeusCollab === 'object' && run1.bridge.syncStatus?.state === 'auth-required' && run1.bridge.syncStatus?.side === 'local' && run1.logs().includes('[forsion-extend] amadeus cloud sync registered'), JSON.stringify(run1.bridge.syncStatus))
      check('②c 账号核心(0.3 起)由 Extend 注册:authStatus 未登录 → loggedIn=false / tokenSource=null / 不含 token;authAccounts=[];账号卡画出来了', run1.bridge.authStatus === 'function' && run1.bridge.forsionLogin === 'function' && run1.bridge.status?.loggedIn === false && run1.bridge.status?.tokenSource === null && !('token' in (run1.bridge.status || {})) && Array.isArray(run1.bridge.accounts) && run1.bridge.accounts.length === 0 && run1.bridge.dom?.accountCard === true && run1.logs().includes('[forsion-extend] account core registered'), JSON.stringify({ status: run1.bridge.status, accounts: run1.bridge.accounts, dom: run1.bridge.dom }))

      // ⑥ 设置页:旧深链 general/g-forsion 落到「Forsion 云端 → 账号」;常规 / 同步里不再有旧子页
      {
        const sp = await openSettingsAt(run1.app, run1.win, 'general/g-forsion')
        const tops = await navTops(sp)
        // 账号页由 Extend 渲染半身画(registerSettingsView category 'forsion'),异步注册:等它挂上
        await sp.waitForSelector('[data-plugin-settings="forsion-extend:account"] .fx-acct', { timeout: 20_000 }).catch(() => {})
        const account = await sp.locator('[data-plugin-settings="forsion-extend:account"] .fx-acct').count()
        const forsionSubs = await navSubs(sp, 'Forsion 云端', 'forsion')
        const generalSubs = await navSubs(sp, '常规', 'general')
        const syncSubs = await navSubs(sp, '同步', 'sync')
        check('⑥ 「Forsion 云端」一级页 = Extend 画的五页 + 宿主的同步 / 连接,旧深链落到 Extend 的账号页;常规里没有 Forsion、同步里没有在线同步', tops.includes('Forsion 云端') && account === 1 && forsionSubs?.join() === '账号,额度与积分,安全,用量记录,反馈,云端同步,连接' && Array.isArray(generalSubs) && !generalSubs.includes('Forsion') && Array.isArray(syncSubs) && !syncSubs.includes('在线同步'), JSON.stringify({ tops, account, forsionSubs, generalSubs, syncSubs }))

        // ⑥b 插件卡上 Extend 的开关:读主进程状态(开),拨下 → 落盘 + 待重启;拨回 → 名单清空、提示消失
        const before = await extendCard(sp)
        await before.sw.click()
        await sp.waitForTimeout(800)
        const off = await extendCard(sp)
        const offCfg = shellConfig(home).disabledBundles
        await off.sw.click()
        await sp.waitForTimeout(800)
        const back = await extendCard(sp)
        const backCfg = shellConfig(home).disabledBundles
        check('⑥b 插件卡的 Extend 开关:开着;拨下 → disabledBundles 落盘 + 「重启后生效」;拨回 → 名单清空、提示消失', before.switch === 1 && before.checked === true && before.pending === 0 && off.checked === false && off.pending === 1 && JSON.stringify(offCfg) === '["forsion-extend"]' && back.checked === true && back.pending === 0 && JSON.stringify(backCfg) === '[]', JSON.stringify({ before: { ...before, sw: undefined }, off: { checked: off.checked, pending: off.pending }, offCfg, back: { checked: back.checked, pending: back.pending }, backCfg }))
      }
      // ⑦ 停用(走桥,等同拨开关)→ 重启:与缺席同形态;开关读主进程状态(关、不待重启)
      const offRes = await run1.win.evaluate(() => window.tangu.setBundleEnabled('forsion-extend', false))
      await run1.app.close().catch(() => {})
      const run1b = await launch(home, stub.url)
      {
        const sp = await openSettingsAt(run1b.app, run1b.win, 'forsion')
        const tops = await navTops(sp)
        const card = await extendCard(sp)
        const b = run1b.bridge
        check('⑦ 停用后重启:主进程半身不装(日志记下),账号 / 云同步 / Connect 的桥键全删,账号卡不画,设置里没有「Forsion 云端」', offRes?.restartPending === true && run1b.logs().includes('[cloud-host] forsion-extend 已在插件页停用') && !run1b.logs().includes('[cloud-host] 已装载 forsion-extend') && b.accountQuota === 'undefined' && b.forsionLogin === 'undefined' && b.cloudFetch === 'undefined' && b.connectStore === 'undefined' && b.amadeusSync === 'undefined' && b.dom?.accountCard === false && !tops.includes('Forsion 云端'), JSON.stringify({ offRes, tops, bridge: { accountQuota: b.accountQuota, forsionLogin: b.forsionLogin, amadeusSync: b.amadeusSync, dom: b.dom } }))
        check('⑦b 停用中的插件卡:仍列出、开关关着、没有待重启提示(包照常播种,只是主进程半身不装)', card.card === 1 && card.switch === 1 && card.checked === false && card.pending === 0 && fs.existsSync(installed), JSON.stringify({ card: card.card, switch: card.switch, checked: card.checked, pending: card.pending }))
        // 重新启用:待重启;下面 ③ 那一跑就是「启用后重启」—— 账号面回来
        const onRes = await run1b.win.evaluate(() => window.tangu.setBundleEnabled('forsion-extend', true))
        check('⑦c 重新启用 → 待重启,disabledBundles 清空', onRes?.restartPending === true && JSON.stringify(shellConfig(home).disabledBundles) === '[]', JSON.stringify({ onRes, cfg: shellConfig(home).disabledBundles }))
      }
      await run1b.app.close().catch(() => {})

      // ③ 用户目录里的副本被改:抬版本 + 改入口 + 不重签
      const evil = fs.readFileSync(path.join(installed, 'dist', 'desktop.mjs'), 'utf8') + '\n// tampered'
      fs.writeFileSync(path.join(installed, 'dist', 'desktop.mjs'), evil)
      const m = JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'))
      fs.writeFileSync(path.join(installed, 'manifest.json'), JSON.stringify({ ...m, version: '9.9.9' }))
      const run2 = await launch(home, stub.url)
      await run2.app.close().catch(() => {})
      const healed = JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8')).version === bundledVersion
        && !fs.readFileSync(path.join(installed, 'dist', 'desktop.mjs'), 'utf8').includes('// tampered')
      check('③ 改过的已装副本:播种验签失败后换回随包那份(9.9.9 → 随包版本),装载的是换回来的已装副本,账号面仍在', healed && run2.logs().includes('已装副本验签失败') && run2.logs().includes(`[cloud-host] 已装载 forsion-extend@${bundledVersion}(${installed})`) && run2.bridge.accountQuota === 'function' && run2.bridge.quota?.status === 401, run2.logs().split('\n').filter((l) => l.includes('cloud-host') || l.includes('builtin-plugins] forsion')).join(' / ').slice(0, 400))
    }
  } catch (e) {
    check('台架本身没炸', false, String(e?.stack || e).slice(0, 400))
  } finally {
    if (hidden) fs.renameSync(hidden, BUNDLED)
    stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed${ABSENT ? '(负对照)' : ''}`)
  process.exit(failed ? 1 : 0)
})()
