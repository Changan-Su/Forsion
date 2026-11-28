// check:vaultmenu —— 左栏底部「智库」菜单(多智库第 1 步)的真应用走查。先 npm run build。
// 隔离 home 起已构建的桌面端,老配置起步(只有 lastVault / localVault,没有清单):
//   菜单只列当前库且打勾 → 钉住的库「从清单移除」置灰 → 打开另一篇 → 新建「工作」并切过去(树为空)
//   → 菜单两行 → 切回原库,落在离开前那篇 → 配置:syncVault 钉在第一个库、两库都进清单、lastVault 跟着切。
// 段 A(智库同步第 3 步 U3a,先跑,单独一个隔离 home):盘上种一个形状合法的 activeVault、不登录 → 回落开的是本机库,
//   盘上的 activeVault 还在、lastVault 是真目录;window.amadeus 是转发壳(本机桥在 amadeusLocal);插件数据的库那一层
//   经主窗能写、hostPath 给本机路径 —— 宿主判「在线」只认渲染层的报告,不看盘(负对照:宿主改成看盘 → 这几步红);
//   之后切走再切回:activeVault 被清掉(切本机库同一次落盘清)。
//   段 B(坏配置)先不加:main 上宽松读把坏配置当 {},走首启建默认库并改写文件;H3 12b(#954)改了 restoreVault
//   (内容坏 → 原样挪成 .corrupt-*、从空配置起;I/O 读不了 → 拒绝),等它进 main 再按那套语义补。
// 截图(菜单亮 / 暗、两行)落 SHOT_DIR,缺省临时目录。跑:node .claude/hooks/devlock.cjs run --vehicle=e2e -- node scripts/check-vault-menu.cjs
const fs = require('fs'); const os = require('os'); const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const DESK = path.join(__dirname, '..')
const SHOTS = process.env.SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vaultmenu-shots-'))
const W = 1280, H = 820

const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body)) }
let failed = 0
const check = (ok, what, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++ }

/** 起一个隔离实例(老配置 cfg 种进四份配置文件),进到笔记 Space、树出来为止;run(ctx) 跑完关掉并删临时目录。 */
async function withApp(cfgOf, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-vaultmenu-'))
  const A = path.join(home, 'Forsion', 'Amadeus')
  put(path.join(A, '日记.md'), '上午把周报发出去。\n')
  put(path.join(A, '项目/路线图.md'), '## 本季度\n\n多设备同步体验\n')
  const ud = path.join(home, 'userdata')
  const cfgFiles = []
  for (const d of [ud, `${ud}-dev`]) for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) {
    cfgFiles.push(path.join(d, f)); put(path.join(d, f), cfgOf(A))
  }
  const readCfg = () => cfgFiles.map((f) => { try { return { f, mtime: fs.statSync(f).mtimeMs, v: JSON.parse(fs.readFileSync(f, 'utf8')) } } catch { return null } })
    .filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0].v
  const workspace = `${home}-workspace`
  const env = { ...process.env, TANGU_HOME: home, FORSION_WORKSPACE_DIR: workspace, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1' }
  const app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', DESK], cwd: DESK, env })
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0].setContentSize(s.W, s.H) }, { W, H })
    await win.waitForSelector('#root', { timeout: 30_000 }); await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'amadeus')`)
    await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.amx-tree .t2s-scroll', { timeout: 30_000 }); await win.waitForTimeout(2000)
    await run({ win, app, A, home, workspace, readCfg })
  } finally {
    await app.close().catch(() => {})
    for (const d of [home, workspace]) fs.rmSync(d, { recursive: true, force: true })
  }
}

// 形状合法(H3 12a 修订第 7 条)、但不属于任何登录账号的在线库:不登录时宿主 get 回 fallback,渲染层开 lastVault
const SAVED_ONLINE = { kind: 'online', account: 'ab'.repeat(32), libraryId: 'vault-lab:Amadeus/Lab/', vaultId: 'vault-lab', prefix: 'Amadeus/Lab/', name: 'Lab' }

async function segmentA() {
  console.log('— 段 A:盘上有 activeVault、不登录 → 回落本机库,插件数据按本机库')
  await withApp((A) => ({ lastVault: A, localVault: A, lastPage: '日记.md', activeVault: SAVED_ONLINE }), async ({ win, app, A, home, readCfg }) => {
    const shell = await win.evaluate(() => ({ local: !!window.amadeusLocal, shell: !!window.amadeus && window.amadeus !== window.amadeusLocal, fwd: !!window.amadeusLocal && window.amadeus.listPages === window.amadeusLocal.listPages }))
    check(shell.local && shell.shell && shell.fwd, 'A: window.amadeus 是转发壳,本机桥在 amadeusLocal、方法原样转发', JSON.stringify(shell))
    // window.amadeus 这个键的属性跟 contextBridge 暴露的键一样(只读 / 删不掉 / 可枚举),换成壳以后插件改不了、删不掉它
    const keys = await win.evaluate(() => {
      const f = (k) => { const d = Object.getOwnPropertyDescriptor(window, k); return d ? { w: !!d.writable, c: !!d.configurable, e: !!d.enumerable } : null }
      return { local: f('amadeusLocal'), shell: f('amadeus'), frozen: Object.isFrozen(window.amadeusLocal) }
    })
    check(!!keys.local && JSON.stringify(keys.shell) === JSON.stringify(keys.local), 'A: window.amadeus 键的属性同 contextBridge 暴露的键', JSON.stringify(keys))
    const foot = (await win.locator('.amx-tree .t2s-foot button[aria-haspopup="menu"]').textContent())?.trim()
    check(/Amadeus/.test(foot ?? ''), 'A: 打开的是本机库 Amadeus', foot)
    check(await win.$$eval('.amx-tree .t2s-srow[data-sel-id="日记.md"]', (e) => e.length) === 1, 'A: 树里是本机库的笔记')
    const read = await win.evaluate(() => window.amadeus.activeVaultGet().then((r) => r, (e) => ({ error: String(e?.message ?? e) })))
    check(read?.ref === null && read?.fallback?.reason === 'account' && read?.fallback?.name === 'Lab', 'A: 宿主读到在线库但账号对不上 → fallback(经转发壳)', JSON.stringify(read))
    let cfg = readCfg()
    check(JSON.stringify(cfg.activeVault) === JSON.stringify(SAVED_ONLINE), 'A: 盘上的 activeVault 还在(回落不清)', JSON.stringify(cfg.activeVault))
    check(cfg.lastVault === A && fs.statSync(cfg.lastVault).isDirectory(), 'A: lastVault 是本机库的真目录', cfg.lastVault)
    // 插件数据:请求里的 vault 用主进程挂着的根本身(macOS 临时目录有 /var 与 /private/var 两种写法,别用脚本里的 A)
    const ps = await win.evaluate(async () => {
      const root = (await window.amadeus.restoreVault(true))?.root
      const id = 'vaultmenu-probe'
      const out = { root }
      const t = async (k, f) => { try { out[k] = await f() } catch (e) { out[k] = { error: String(e?.message ?? e) } } }
      await t('write', () => window.amadeus.pluginStorage({ id, vault: root, op: 'write', path: 'probe.txt', data: 'ok' }).then(() => true))
      await t('read', () => window.amadeus.pluginStorage({ id, vault: root, op: 'readText', path: 'probe.txt' }))
      await t('hostPath', () => window.amadeus.pluginStorage({ id, vault: root, op: 'hostPath', path: 'probe.txt' }))
      await t('appHostPath', () => window.amadeus.pluginStorage({ id, op: 'hostPath', path: 'probe.txt' }))
      return out
    })
    check(ps.write === true && ps.read === 'ok', 'A: 插件数据的库那一层能写能读(按本机库)', JSON.stringify({ write: ps.write, read: ps.read }))
    const hp = typeof ps.hostPath === 'string' ? ps.hostPath : ''
    check(!!hp && path.isAbsolute(hp) && (hp.startsWith(fs.realpathSync(home)) || hp.startsWith(home)), 'A: 库那一层的 hostPath 给本机绝对路径', JSON.stringify(ps.hostPath))
    check(!!hp && /[\\/]vaults[\\/][0-9a-f]{16}[\\/]probe\.txt$/.test(hp) && fs.existsSync(hp) && fs.readFileSync(hp, 'utf8') === 'ok', 'A: 那个路径上就是刚写的文件', hp)
    check(typeof ps.appHostPath === 'string' && path.isAbsolute(ps.appHostPath), 'A: 跟应用那一层的 hostPath 照旧', JSON.stringify(ps.appHostPath))
    // 新接缝接上了、且这一包不改任何东西:主窗报 null 收下;按需迁移在不登录时回 null,配置一字不动
    const before = JSON.stringify(readCfg())
    const wired = await win.evaluate(async () => {
      const r = {}
      try { r.opened = (await window.amadeusLocal.onlineOpened(null)) ?? 'ok' } catch (e) { r.opened = { error: String(e?.message ?? e) } }
      try { r.migrate = await window.amadeus.activeVaultMigrate() } catch (e) { r.migrate = { error: String(e?.message ?? e) } }
      return r
    })
    check(wired.opened === 'ok' && wired.migrate === null && JSON.stringify(readCfg()) === before, 'A: online-opened / migrate 通道在,不登录时什么都不改', JSON.stringify(wired))
    // 在线库代发通道的推送口(window.tangu.onCloudVaultEvent):Extend 注册了代发通道才有这个键;有的话主进程 send 的那一包原样到订阅者
    const relay = await win.evaluate(() => {
      if (typeof window.tangu?.onCloudVaultEvent !== 'function') return { present: false }
      window.__cvPushes = []
      window.__cvOff = window.tangu.onCloudVaultEvent((p) => window.__cvPushes.push(p))
      return { present: true, off: typeof window.__cvOff === 'function' }
    })
    if (!relay.present) console.log('     (这个实例没有 Extend 的代发通道:onCloudVaultEvent 不在,跳过推送那一步)')
    else {
      const push = { subscriptionId: 's-1', event: { type: 'change', data: { path: 'a.md', extra: [1, { x: null }] } } }
      check(relay.off, 'A: onCloudVaultEvent 回取消函数')
      await app.evaluate(({ BrowserWindow }, p) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('cloudvault:event', p) }, push)
      await win.waitForTimeout(300)
      const got = await win.evaluate(() => { window.__cvOff(); return window.__cvPushes })
      check(JSON.stringify(got) === JSON.stringify([push]), 'A: cloudvault:event 原样转发给订阅者', JSON.stringify(got))
    }
    // 切走再切回:切本机库同一次落盘清掉 activeVault,lastVault 始终是真目录
    const sw = await win.evaluate(async (a) => {
      try { await window.amadeus.createVault('工作'); return { ok: true, back: (await window.amadeus.switchVault(a))?.root ?? null } } catch (e) { return { error: String(e?.message ?? e) } }
    }, ps.root)
    cfg = readCfg()
    check(sw.ok && !('activeVault' in cfg), 'A: 切到「工作」再切回 → activeVault 清掉', JSON.stringify({ sw, activeVault: cfg.activeVault }))
    check(cfg.lastVault === ps.root || cfg.lastVault === A, 'A: 切回后 lastVault = 本机库', cfg.lastVault)
  })
}

async function main() {
  await segmentA()
  console.log('— 菜单走查:老配置起步')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-vaultmenu-'))
  const A = path.join(home, 'Forsion', 'Amadeus')
  put(path.join(A, '日记.md'), '上午把周报发出去。\n')
  put(path.join(A, '项目/路线图.md'), '## 本季度\n\n多设备同步体验\n')
  const ud = path.join(home, 'userdata')
  const cfgFiles = []
  for (const d of [ud, `${ud}-dev`]) for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) {
    cfgFiles.push(path.join(d, f)); put(path.join(d, f), { lastVault: A, localVault: A, lastPage: '项目/路线图.md' })
  }
  const readCfg = () => cfgFiles.map((f) => { try { return { f, mtime: fs.statSync(f).mtimeMs, v: JSON.parse(fs.readFileSync(f, 'utf8')) } } catch { return null } })
    .filter(Boolean).sort((a, b) => b.mtime - a.mtime)[0].v // 应用写的是其中一份(dev / 正式),取最新那份
  // 工作区显式给临时目录:不继承外面的 FORSION_WORKSPACE_DIR,收尾只删自己建的(Codex 评审:继承了会删掉真实工作区)
  const workspace = `${home}-workspace`
  const env = { ...process.env, TANGU_HOME: home, FORSION_WORKSPACE_DIR: workspace, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1' }
  const B = path.join(workspace, 'Vaults', '工作')
  const app = await electron.launch({ args: [`--user-data-dir=${ud}`, '--lang=zh-CN', DESK], cwd: DESK, env })
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0].setContentSize(s.W, s.H) }, { W, H })
    await win.waitForSelector('#root', { timeout: 30_000 }); await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'amadeus')`)
    await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.amx-tree .t2s-scroll', { timeout: 30_000 }); await win.waitForTimeout(2000)

    const footBtn = win.locator('.amx-tree .t2s-foot button[aria-haspopup="menu"]')
    const footText = async () => (await footBtn.textContent())?.trim()
    const rows = () => win.$$eval('.ctx-menu [role="menuitemradio"]', (els) => els.map((e) => ({ name: e.getAttribute('aria-label'), on: e.getAttribute('aria-checked') === 'true' })))
    const openMenu = async () => { await footBtn.click(); await win.waitForSelector('.ctx-menu [role="menuitemradio"]', { timeout: 5000 }) }
    const closeMenu = async () => { await win.keyboard.press('Escape'); await win.waitForTimeout(250) }
    const setMode = (m) => win.evaluate((mode) => { const r = document.documentElement; r.dataset.mode = mode; r.classList.toggle('dark', mode === 'dark') }, m)
    const shot = async (name) => { await win.waitForTimeout(350); const p = path.join(SHOTS, `${name}.png`); await win.screenshot({ path: p }); console.log('shot', p) }
    const bodyHas = (s) => win.evaluate((t) => document.body.innerText.includes(t), s)

    check(await footBtn.count() === 1, '底部是智库菜单按钮')
    check(/Amadeus/.test(await footText()), '按钮写当前库名', await footText())
    await openMenu()
    let r = await rows()
    check(r.length === 1 && r[0].name === 'Amadeus' && r[0].on, '老配置:清单只有当前库且打勾', JSON.stringify(r))
    await shot('menu-light'); await setMode('dark'); await shot('menu-dark'); await setMode('light')
    await closeMenu()

    await openMenu()
    await win.click('.ctx-menu [role="menuitemradio"][aria-label="Amadeus"]', { button: 'right' })
    await win.waitForSelector('.ctx-menu button[aria-label="从清单移除"]', { timeout: 5000 })
    check(await win.$eval('.ctx-menu button[aria-label="从清单移除"]', (b) => b.disabled), '当前 / 同步库「从清单移除」置灰')
    await closeMenu()

    await win.click('.amx-tree .t2s-srow[data-sel-id="日记.md"]'); await win.waitForTimeout(1200)
    check(await bodyHas('上午把周报发出去'), '在原库打开「日记」')

    await openMenu()
    await win.click('.ctx-menu button[aria-label="新建智库…"]')
    await win.waitForSelector('.dialog-input', { timeout: 5000 })
    await win.fill('.dialog-input', '工作'); await win.keyboard.press('Enter')
    await win.waitForFunction(() => /工作/.test(document.querySelector('.amx-tree .t2s-foot button[aria-haspopup="menu"]')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => {})
    check(/工作/.test(await footText()), '新建后切到「工作」', await footText())
    check(fs.existsSync(B), '文件夹建在 <工作区>/Vaults/工作', B)
    check(!(await bodyHas('上午把周报发出去')) && await win.$$eval('.amx-tree .t2s-srow', (e) => e.length) === 0, '新库树为空、旧库笔记不残留')
    let cfg = readCfg()
    check(cfg.syncVault === A, '同步库钉在第一个库', cfg.syncVault)
    check(cfg.localVault === B && cfg.lastVault === B, 'localVault / lastVault 跟着切(Tangu 读 lastVault)', `${cfg.localVault} | ${cfg.lastVault}`)
    check(JSON.stringify((cfg.vaults ?? []).map((v) => v.root)) === JSON.stringify([A, B]), '两库都进清单', JSON.stringify(cfg.vaults))
    check(cfg.vaults?.[0]?.lastPage === '日记.md', '离开的库记下末次页', cfg.vaults?.[0]?.lastPage)

    await openMenu()
    r = await rows()
    check(r.length === 2 && r.find((x) => x.name === '工作')?.on && !r.find((x) => x.name === 'Amadeus')?.on, '菜单两行,勾在「工作」', JSON.stringify(r))
    await shot('menu-two')
    await win.click('.ctx-menu [role="menuitemradio"][aria-label="Amadeus"]')
    await win.waitForFunction(() => /Amadeus/.test(document.querySelector('.amx-tree .t2s-foot button[aria-haspopup="menu"]')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => {})
    await win.waitForTimeout(1500)
    check(/Amadeus/.test(await footText()), '切回 Amadeus', await footText())
    check(await bodyHas('上午把周报发出去'), '切回后落在离开前那篇(日记)')
    cfg = readCfg()
    check(cfg.lastVault === A && cfg.syncVault === A, '切回后 lastVault = 原库、同步库不动', `${cfg.lastVault} | ${cfg.syncVault}`)
    await shot('back')
  } finally {
    await app.close().catch(() => {})
    for (const d of [home, workspace]) fs.rmSync(d, { recursive: true, force: true })
  }
  console.log(failed ? `\n${failed} 项没过` : '\n全部通过', '截图:', SHOTS)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
