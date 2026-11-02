/**
 * check:providerpresets —— 设置 › 模型 › 提供方「添加连接」的服务商预设(2026-10-29)的真 Electron 仪器。
 *
 *  P1 新建连接时有「服务商」下拉,列出全部预设 + 自定义。
 *  P2 选 Anthropic → 名称 anthropic、地址 https://api.anthropic.com/v1、协议 Anthropic Messages、地址说明换成 Anthropic 那句。
 *  P3 名称被占用时顺延(假引擎已有 openai → 选 OpenAI 得 openai-2);用户改过的名称换预设不被覆盖。
 *  P4 选回「自定义」清空地址、协议回 OpenAI 兼容。
 *
 * 跑:npx electron-vite build 之后 `npm run check:providerpresets`。截图(亮中文 / 暗英文)落 PRESET_SHOTS(缺省临时目录),交付前看一眼。
 * 隔离 userData / TANGU_HOME + 假引擎,不碰 ~/.forsion。真 key 实测不在这里:选好预设填 key,点「测试连接」即走引擎 /agent/providers/test。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-provider-presets-'))
const shots = process.env.PRESET_SHOTS || path.join(home, 'shots')
fs.mkdirSync(shots, { recursive: true })
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { if (await fn()) return true } catch { /* retry */ }
    await pause(80)
  }
  return false
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npx electron-vite build')
    process.exit(2)
  }
  const stub = await startStubEngine({ sessions: [], messages: [], agents: [], engines: [] })
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  // 已有一条 openai:选 OpenAI 预设时名称要顺延,不能覆盖它
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sandbox: 'auto', workspace: path.join(home, 'ws'), providers: [{ providerId: 'openai', baseUrl: 'https://api.openai.com/v1' }] }))
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const main = await app.firstWindow()
    await main.waitForSelector('#root', { timeout: 40000 })
    check('前置 主窗已离开首启引导', await skipOnboarding(main))
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setContentSize(1100, 820) }).catch(() => {})

    const floating = () => app.windows().filter((w) => !w.isClosed() && w.url().includes('window=floating')).pop()
    const look = async (mode, lang) => {
      await main.evaluate(([m, l]) => { localStorage.setItem('forsion_theme_pref', m); localStorage.setItem('tangu_locale', l) }, [mode, lang])
      const fl = floating()
      if (fl) await fl.close().catch(() => {})
      await main.reload({ waitUntil: 'domcontentloaded' })
      await main.waitForSelector('#root', { timeout: 30000 })
      await pause(1200)
    }
    const openAdd = async () => {
      await main.evaluate((p) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: p }), { tab: 'model/m-providers', n: Date.now() })
      let fl
      await waitFor(async () => { fl = floating(); return !!fl && (await fl.locator('.settings-sub[data-settings-sub="m-providers"]').count()) > 0 }, 30000)
      if (!fl) throw new Error('settings floating window missing')
      await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('window=floating')) w.setContentSize(1100, 820) })
      await fl.locator('.provider-add button').first().click()
      // 本机扫到可导入的配置时「添加连接」是菜单:点第一项「手动填写」
      await pause(300)
      if (!(await fl.locator('.provider-editor').count())) await fl.locator('[role="menuitem"]').first().click()
      await fl.locator('.provider-editor').waitFor({ timeout: 8000 })
      return fl
    }
    const state = (fl) => fl.evaluate(() => {
      const ed = document.querySelector('.provider-editor')
      const sels = [...ed.querySelectorAll('select')]
      const inputs = [...ed.querySelectorAll('input[type="text"]')]
      const rowDesc = (label) => [...ed.querySelectorAll('.settings-control-row')].find((r) => r.textContent.includes(label))?.querySelector('small, p')?.textContent || ''
      return {
        presets: [...sels[0].options].map((o) => o.value),
        preset: sels[0].value,
        name: inputs[0].value, baseUrl: inputs[1].value,
        protocol: sels[1]?.value,
        urlHint: rowDesc('Base URL'),
      }
    })
    const pick = (fl, sel, value) => fl.locator('.provider-editor select').nth(sel).selectOption(value)

    await look('light', 'zh')
    let fl = await openAdd()
    let s = await state(fl)
    check('P1 有服务商下拉:自定义 + 11 家预设', s.presets.length === 12 && s.presets[0] === '' && s.presets.includes('anthropic') && s.presets.includes('opencode'), s.presets)
    await pick(fl, 0, 'anthropic'); await pause(200)
    s = await state(fl)
    check('P2 选 Anthropic:名称 / 地址 / 原生协议 / 地址说明', s.name === 'anthropic' && s.baseUrl === 'https://api.anthropic.com/v1' && s.protocol === 'anthropic-messages' && s.urlHint.includes('Anthropic'), s)
    await fl.locator('.provider-editor input[type="password"]').fill('sk-ant-…')
    await fl.screenshot({ path: path.join(shots, 'anthropic-light-zh.png') })
    await pick(fl, 0, 'openai'); await pause(200)
    s = await state(fl)
    check('P3a 名称被占用时顺延成 openai-2', s.name === 'openai-2' && s.protocol === 'openai', s)
    await fl.locator('.provider-editor input[type="text"]').first().fill('my-bailian')
    await pick(fl, 0, 'bailian'); await pause(200)
    s = await state(fl)
    check('P3b 自己改过的名称换预设不被覆盖', s.name === 'my-bailian' && s.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1', s)
    await pick(fl, 0, ''); await pause(200)
    s = await state(fl)
    check('P4 选回自定义:地址清空、协议回 OpenAI 兼容', s.baseUrl === '' && s.protocol === 'openai', s)

    await look('dark', 'en')
    fl = await openAdd()
    await pick(fl, 0, 'siliconflow'); await pause(200)
    await fl.screenshot({ path: path.join(shots, 'siliconflow-dark-en.png') })
    const en = await state(fl)
    check('P5 英文界面:预设与协议文案是英文', !/[一-鿿]/.test(await fl.locator('.provider-editor').innerText()), en)
  } catch (e) {
    check('运行', false, String(e && e.stack || e).slice(0, 400))
  } finally {
    await app?.close().catch(() => {})
    stub.close?.()
  }
  console.log(`\nshots: ${shots}`)
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `${bad.length} FAIL` : 'ALL PASS')
  process.exit(bad.length ? 1 : 0)
}
main()
