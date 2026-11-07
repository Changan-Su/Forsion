// check:vaultmenu —— 左栏底部「智库」菜单(多智库第 1 步)的真应用走查。先 npm run build。
// 隔离 home 起已构建的桌面端,老配置起步(只有 lastVault / localVault,没有清单):
//   菜单只列当前库且打勾 → 钉住的库「从清单移除」置灰 → 打开另一篇 → 新建「工作」并切过去(树为空)
//   → 菜单两行 → 切回原库,落在离开前那篇 → 配置:syncVault 钉在第一个库、两库都进清单、lastVault 跟着切。
// 截图(菜单亮 / 暗、两行)落 SHOT_DIR,缺省临时目录。跑:node .claude/hooks/devlock.cjs run --vehicle=e2e -- node scripts/check-vault-menu.cjs
const fs = require('fs'); const os = require('os'); const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const DESK = path.join(__dirname, '..')
const SHOTS = process.env.SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'vaultmenu-shots-'))
const W = 1280, H = 820

const put = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body)) }
let failed = 0
const check = (ok, what, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++ }

async function main() {
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
