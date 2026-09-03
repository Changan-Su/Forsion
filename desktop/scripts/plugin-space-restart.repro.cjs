/**
 * 复现:插件 Space(server-admin)重启后点击进不去/内容变成 Tangu(用户 2026-08-27 实报)。
 * 真 Electron 双程,同一份 user-data-dir;探针 = 活动 Space + 布局键面板 + 全部命名布局槽的面板类型。
 * 需先 npm run build。用法:node scripts/plugin-space-restart.repro.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pluginspace-'))
const UD = path.join(home, 'userdata')

// 真插件字节:优先 dev 安装,其次插件仓
const PLUGIN_SRC = [
  path.join(os.homedir(), '.forsion-dev/plugins/server-admin'),
  path.join(ROOT, '../../Forsion-Instrumentality-Project/forsion-plugin-server-admin'),
  path.join(ROOT, '../../../../Forsion-Instrumentality-Project/forsion-plugin-server-admin'),
].find((p) => fs.existsSync(path.join(p, 'manifest.json')))
if (!PLUGIN_SRC) { console.error('找不到 server-admin 插件源'); process.exit(1) }
fs.cpSync(PLUGIN_SRC, path.join(home, 'plugins/server-admin'), { recursive: true })

async function boot() {
  const app = await electron.launch({
    args: [`--user-data-dir=${UD}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    // ELECTRON_RENDERER_URL:复用正在跑的 vite dev 渲染层(与用户 dev 实例同款代码与时序);
    // user-data-dir 隔离 → 同源不同 profile,localStorage 互不可见。
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', ELECTRON_RENDERER_URL: process.env.REPRO_DEV_URL || 'http://localhost:5273' },
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30000 })
  await win.waitForTimeout(2000)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.wb-dockview, .dv-groupview', { timeout: 30000 })
  await win.waitForTimeout(2500)
  return { app, win }
}

const state = (win, tag) => win.evaluate((t) => {
  const panels = (raw) => {
    try { return Object.values(JSON.parse(raw).dockview.panels).map((p) => (p.params || {}).__type || p.contentComponent) } catch { return null }
  }
  let named = {}
  try {
    const all = JSON.parse(localStorage.getItem('tangu2_named_layouts') || '{}')
    for (const [k, v] of Object.entries(all)) named[k] = panels(JSON.stringify(v))
  } catch (e) { named = { err: String(e) } }
  // 活体 DOM:主区当前真实挂着什么(不等持久化)
  const live = [...document.querySelectorAll('.dv-groupview .dv-default-tab, .dv-groupview [data-testid]')].length
  return {
    tag: t,
    active: localStorage.getItem('forsion_tangu_active_space'),
    layoutKey: panels(localStorage.getItem('tangu2_layout_v4')),
    named,
    ribbonSpaces: [...document.querySelectorAll('.rb-space')].map((b) => b.title || b.textContent).slice(0, 10),
    live,
  }
}, tag)

const dump = (s) => console.log(JSON.stringify(s, null, 1).replace(/\n\s*/g, ' ').slice(0, 1200))

;(async () => {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先 npm run build'); process.exit(1) }

  // ── 程 1:等插件 Space 上 ribbon → 点进去 → 退出(退出时人就在插件 Space 里,贴用户场景)
  let { app, win } = await boot()
  await win.waitForFunction(() => [...document.querySelectorAll('.rb-space')].some((b) => (b.title || b.textContent || '').includes('服务器')), null, { timeout: 60000 })
  dump(await state(win, 'boot1:插件Space已上ribbon'))
  await win.evaluate(() => { const b = [...document.querySelectorAll('.rb-space')].find((x) => (x.title || x.textContent || '').includes('服务器')); b && b.click() })
  await win.waitForTimeout(3000)
  dump(await state(win, 'boot1:点击服务器后'))
  await app.close()
  await new Promise((r) => setTimeout(r, 1500))

  // ── 程 2:重启(上次退出=服务器 Space)→ 500ms 采样时间线(活动 id / 图标高亮 / 布局键)→ 点服务器
  ;({ app, win } = await boot())
  for (let i = 0; i < 16; i++) {
    const s = await win.evaluate(() => ({
      active: localStorage.getItem('forsion_tangu_active_space'),
      hi: (() => { const b = [...document.querySelectorAll('.rb-space')].find((x) => (x.title || x.textContent || '').includes('服务器')); return b ? (b.className.includes('on') ? 'ON' : 'off') : '无图标' })(),
      lk: (() => { try { return Object.values(JSON.parse(localStorage.getItem('tangu2_layout_v4')).dockview.panels).map((p) => (p.params || {}).__type || p.contentComponent).join(',') } catch { return null } })(),
    }))
    console.log(`t+${i * 500}ms  active=${s.active}  服务器图标=${s.hi}  layoutKey=[${s.lk}]`)
    await win.waitForTimeout(500)
  }
  await win.evaluate(() => { const b = [...document.querySelectorAll('.rb-space')].find((x) => (x.title || x.textContent || '').includes('服务器')); b && b.click() })
  await win.waitForTimeout(3000)
  const after = await state(win, 'boot2:点击服务器后')
  dump(after)
  await app.close()

  const mainIsPlugin = (after.layoutKey || []).some((t) => String(t).startsWith('plugin:server-admin:'))
  console.log(`\n${mainIsPlugin ? 'PASS(未复现)' : 'FAIL(复现!)'}  重启后点击服务器 Space,主区应是插件面板  | layoutKey=${JSON.stringify(after.layoutKey)}`)
  process.exit(mainIsPlugin ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
