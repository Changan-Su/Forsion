/**
 * 外部引擎「当前模型缺 API key」在真应用里的样子:真 Electron × 真引擎(托管模式,本检出 tangu-agent/dist)× 隔离 home。
 *
 * 两个引擎(写进隔离 home 的 engines.json):
 *   - dsh      = 真 DSH(官方包 @deepseek-ai/dsh,`--profile acp`),自己的空目录,没有任何凭据 → 每一句都缺 key,清单里只有当前模型;
 *   - dshfake  = 照 DSH 说话的假 agent(和 tangu-agent/src/engines/acpEngine.credential.test.ts 同一个样子)。用户「登录」= 在
 *                它的目录里放一个 .account 文件,之后起的进程就把账号那一组的模型也列出来。账号登录这一支没有真账号,只能这样点。
 *
 * 点验:
 *   ① 真 DSH:对话里那行失败原因(中文、英文),点名当前模型、说的是去 DSH 里登录或填 key;
 *   ② 假 agent:失败 → 「登录」→ 打开模型菜单时重新探测(请求带 fresh=1),菜单里出现新模型;
 *   ③ 再发一句:失败原因点名可换的模型和设置路径;设置里真有 Agent → 本机 Agent CLI 这一项;
 *   ④ 失败后切到别的对话再切回来:也重新探测;
 *   ⑤ 选了账号那一组的模型再发:通了。
 * 不点验(只有单测):先发的请求晚回、空清单不盖已有结果(appStore.engineCaps.test.ts)。
 *
 * 用法:先 npm run build(桌面)+ tangu-agent 的 npm run build;
 *   node scripts/dsh-nokey-ui.e2e.cjs --node <Node ≥ 24> --dsh <@deepseek-ai/dsh 的 lib/bin.js> --root <全新目录,不在系统临时目录下>
 * 截图在 <root>/shots(只留本机)。跑完核对有没有留下 DSH 进程。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : '' }
const NODE = opt('node'), BIN = opt('dsh'), ROOT_ARG = opt('root')
if (!NODE || !BIN || !ROOT_ARG) { console.error('用法见文件头'); process.exit(2) }
for (const f of ['out/main/main.js', '../tangu-agent/dist/standalone/main.js']) if (!fs.existsSync(path.join(ROOT, f))) { console.error(`缺 ${f} —— 先 build`); process.exit(2) }
fs.mkdirSync(ROOT_ARG, { recursive: true })
const R = fs.realpathSync(ROOT_ARG)
for (const t of [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']) {
  let rt = t; try { rt = fs.realpathSync(t) } catch { /* */ }
  if (R === rt || R.startsWith(rt + path.sep)) { console.error('--root 不能在系统临时目录下面'); process.exit(2) }
}
const D = (...p) => { const d = path.join(R, ...p); fs.mkdirSync(d, { recursive: true }); return d }
const SHOTS = D('shots')
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${String(detail).replace(/\s+/g, ' ').slice(0, 400)}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 假 agent(照 DSH 0.2.2-rc.3 实测的形状:按凭据列清单、当前模型塞进它那一组、缺 key 时 -32603 只有 message)
const DSH_RAW = 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment'
const FAKE_AGENT = String.raw`
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
const store = process.env.FAKE_STORE;
const log = (m) => appendFileSync(store + '.log', m + '\n');
const load = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : { sessions: {} });
const save = (s) => writeFileSync(store, JSON.stringify(s));
const OFFICIAL = 'deepseek-official', ACCOUNT = 'deepseek-account';
const val = (p, m) => JSON.stringify([p, m]);
const DEFAULT = val(OFFICIAL, 'deepseek-v4-flash');
const hasAccount = existsSync(store + '.account');
const options = (s) => {
  const groups = [
    { group: OFFICIAL, name: 'DeepSeek', options: [] },
    { group: ACCOUNT, name: 'DeepSeek Account', options: hasAccount ? [{ value: val(ACCOUNT, 'deepseek-flash'), name: 'DeepSeek-V4.1-Flash' }, { value: val(ACCOUNT, 'deepseek-v4-pro'), name: 'DeepSeek-V4-Pro' }] : [] },
  ];
  if (!groups.some((g) => g.options.some((o) => o.value === s.model))) { const [p, m] = JSON.parse(s.model); groups.find((g) => g.group === p).options.unshift({ value: s.model, name: m }); }
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: groups.filter((g) => g.options.length > 0) },
    { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }] },
  ];
};
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
process.stdin.on('end', () => process.exit(0));
function handle(m) {
  if (!m.method) return;
  log(m.method);
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  const err = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  const st = load(); const p = m.params || {};
  if (m.method === 'initialize') return ok({ protocolVersion: 1, agentInfo: { name: 'fake-dsh-agent', version: '0' }, agentCapabilities: { sessionCapabilities: { resume: {}, close: {}, list: {} } } });
  if (m.method === 'session/new') { const id = 'sess-' + (Object.keys(st.sessions).length + 1); st.sessions[id] = { turns: 0, model: DEFAULT }; save(st); return ok({ sessionId: id, configOptions: options(st.sessions[id]) }); }
  if (m.method === 'session/resume') { const s = st.sessions[p.sessionId]; if (!s) return err(-32602, 'Invalid params: session is not resumable: ' + p.sessionId); return ok({ configOptions: options(s) }); }
  if (m.method === 'session/set_config_option') { const s = st.sessions[p.sessionId]; log('set ' + p.configId + '=' + p.value); if (p.configId === 'model') s.model = p.value; save(st); return ok({ configOptions: options(s) }); }
  if (m.method === 'session/close') return ok({});
  if (m.method === 'session/prompt') {
    const s = st.sessions[p.sessionId]; s.turns += 1; save(st);
    if (JSON.parse(s.model)[0] === OFFICIAL) return err(-32603, ${JSON.stringify(DSH_RAW)});
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply from the account model (turn ' + s.turns + ').' } } } });
    return ok({ stopReason: 'end_turn' });
  }
  if (m.id != null) return err(-32601, 'Method not found: ' + m.method);
}
`

const HOME = D('app')
const FAKE_DIR = D('fake')
const FAKE_STORE = path.join(FAKE_DIR, 'store.json')
const fakeFile = path.join(FAKE_DIR, 'fake-agent.mjs')
fs.writeFileSync(fakeFile, FAKE_AGENT)
const dshEnv = { PATH: `${path.dirname(NODE)}:/usr/bin:/bin`, HOME: D('dsh-home'), DSH_HOME: D('dsh'), TMPDIR: D('dsh-tmp'),
  XDG_CACHE_HOME: D('xc'), XDG_DATA_HOME: D('xd'), XDG_STATE_HOME: D('xs'), XDG_CONFIG_HOME: D('xcfg'), DSH_TELEMETRY_DISABLED: '1' }
const engines = { engines: [
  { id: 'dsh', name: 'DeepSeek Harness', command: NODE, args: [BIN, '--profile', 'acp'], env: dshEnv },
  { id: 'dshfake', name: 'DeepSeek Harness (fake agent)', command: process.execPath, args: [fakeFile], env: { FAKE_STORE } },
] }
for (const dir of [HOME, D('app', 'tangu')]) fs.writeFileSync(path.join(dir, 'engines.json'), JSON.stringify(engines, null, 2))
const WS = D('workspace'), VAULT = D('vault')
fs.writeFileSync(path.join(VAULT, 'welcome.md'), '# check\n')
for (const dir of [D('app', 'userdata'), D('app', 'userdata-dev')]) {
  fs.writeFileSync(path.join(dir, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: VAULT, localVault: VAULT }))
  fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', sandbox: 'none', browserEnabled: false, unitHostEnabled: false, defaultWorkspaceDir: WS, modelId: 'unused/unused-model' }))
}

const capsRequests = []
const errText = (win) => win.evaluate(() => [...document.querySelectorAll('.t2-status-err')].map((e) => e.textContent.trim()).pop() || '')
const errCount = (win) => win.evaluate(() => document.querySelectorAll('.t2-status-err').length)

async function shot(win, name) { await win.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {}) }

async function newChat(win) {
  await win.getByText('新会话', { exact: true }).first().click()
  await sleep(1200)
}
const sidebarRow = (win, title) => win.locator('aside, nav, [class*="sidebar"], [class*="side"]').getByText(title, { exact: true }).first()
const freshFor = (id) => capsRequests.filter((u) => u.includes(`/engines/${id}/capabilities?fresh=1`)).length
async function until(fn, ms, every = 300) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every) } }
async function openSettings(app, win) {
  const opened = app.waitForEvent('window', { timeout: 15000 }).catch(() => null)
  await win.keyboard.press('Meta+Comma').catch(() => {})
  const sp = await opened
  if (!sp) return null
  await sp.waitForSelector('.settings-main', { timeout: 15000 }).catch(() => {})
  return sp
}

async function pickEngine(win, name) {
  const pill = win.locator('.agent-select-strip .compact-chat-picker').first()
  await pill.click()
  const row = win.locator('.chat-pick-row', { has: win.locator('.chat-pick-name', { hasText: new RegExp(`^${name.replace(/[()]/g, '\\$&')}$`) }) }).first()
  await row.waitFor({ timeout: 10_000 })
  await row.click()
  await sleep(800)
}

async function send(win, text) {
  const ta = win.locator('.t2c-ta').last()
  await ta.click()
  await ta.fill(text)
  await ta.press('Enter')
}

async function waitErr(win, before, ms = 90_000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if ((await errCount(win)) > before) return errText(win); await sleep(400) }
  return ''
}

async function openModelMenu(win) {
  const btn = win.locator('.model-pill-btn').last()
  await btn.click()
  await win.locator('.composer-menu--model').first().waitFor({ timeout: 8000 })
  // 菜单第一层是「模型 ›」一行,模型清单在它点开的那一格里
  await win.locator('.composer-menu--model [data-pane-trigger="model"]').first().click()
  await sleep(500)
}
const menuText = (win) => win.evaluate(() => [...document.querySelectorAll('.composer-menu--model .menu-item')].map((e) => e.textContent.trim()).join(' | '))
const FAKE = 'DeepSeek Harness (fake agent)'

async function main() {
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(HOME, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    // 一个用不到的本机提供方:隔离 home 里没有任何 Tangu 模型时,桌面发 run 不带 model_id,引擎直接 400(和本改动无关的老问题);
    // 引擎会话的那一轮交给 DSH,不会调这个地址
    env: { ...process.env, TANGU_HOME: HOME, FORSION_WORKSPACE_DIR: WS, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1',
      TANGU_PROVIDER_ID: 'unused', TANGU_PROVIDER_BASE_URL: 'http://127.0.0.1:9/v1', TANGU_PROVIDER_API_KEY: 'unused', TANGU_PROVIDER_MODELS: 'unused-model' },
  })
  const pageErrors = []
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    win.on('pageerror', (e) => pageErrors.push(e.message))
    win.on('request', (r) => { const u = r.url(); if (u.includes('/capabilities')) capsRequests.push(u) })
    win.on('response', async (r) => { if (/\/agent\/runs(\?|$)/.test(r.url()) && r.request().method() === 'POST' && r.status() >= 400) console.log(`  · POST /agent/runs → ${r.status()} ${(await r.text().catch(() => '')).slice(0, 300)}`) })
    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    check('前置:跳过首启引导', await skipOnboarding(win))
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    const ready = await win.waitForFunction(async () => (await window.tangu.getConfig()).backendState?.state === 'ready', null, { timeout: 120_000 }).then(() => true, () => false)
    check('前置:托管模式,本检出的引擎就绪', ready)
    check('前置:进 Tangu', await enterSpace(win, 'tangu'))
    await sleep(1500)
    await shot(win, '00-tangu')

    // ① 真 DSH,什么凭据都没有
    await pickEngine(win, 'DeepSeek Harness')
    await shot(win, '01-picked-dsh')
    let n = await errCount(win)
    await send(win, 'Say OK.')
    const e1 = await waitErr(win, n)
    await shot(win, '02-dsh-nokey-zh')
    check('① 真 DSH:失败原因是中文的、点名引擎和当前模型 deepseek-v4-flash', e1.includes('DeepSeek Harness 当前的模型 deepseek-v4-flash 要 API key'), e1)
    check('① 没有别的模型:说去 DSH 里登录或填 key,不叫人换模型', e1.includes('它也没有别的模型可选') && e1.includes('先在 DeepSeek Harness 里登录或填上 API key') && !e1.includes('模型菜单'), e1)
    check('① DSH 原话留在括号里', e1.includes('no API key for provider route "deepseek-official"'), e1)
    check('① 括号里没有机器码和 JSON', !e1.includes('engine_model_no_api_key') && !e1.includes('{"engine"'), e1)
    await openModelMenu(win)
    const m1 = await menuText(win)
    await shot(win, '03-dsh-menu')
    check('① 模型菜单里列着 DSH 的当前模型', m1.includes('deepseek-v4-flash'), m1)
    await win.keyboard.press('Escape'); await sleep(400)

    // ② 假 agent:失败 → 「登录」→ 打开模型菜单时重新探测
    await newChat(win)
    await pickEngine(win, FAKE)
    n = await errCount(win)
    await send(win, 'Fake one: say OK.')
    const e2 = await waitErr(win, n)
    check('② 假 agent 第一次失败:没有别的模型可选', e2.includes(`${FAKE} 当前的模型 deepseek-v4-flash 要 API key`) && e2.includes('它也没有别的模型可选'), e2)
    fs.writeFileSync(`${FAKE_STORE}.account`, '') // 用户照提示去引擎那边登录了
    const before = freshFor('dshfake')
    await openModelMenu(win)
    const refetched = await until(() => freshFor('dshfake') > before, 15_000)
    check('② 失败后打开模型菜单:让引擎重新探测(fresh=1)', refetched, `fresh 请求 ${before} → ${freshFor('dshfake')}`)
    const m2 = await until(async () => { const t = await menuText(win); return t.includes('DeepSeek-V4.1-Flash') && t.includes('DeepSeek-V4-Pro') ? t : null }, 20_000)
    await shot(win, '04-fake-menu-after-login')
    check('② 菜单里出现登录后才有的两个账号模型', !!m2, m2 || await menuText(win))
    await win.keyboard.press('Escape'); await sleep(400)

    // ③ 再发一句(还是缺省模型):失败原因点名可换的模型和设置路径
    n = await errCount(win)
    await send(win, 'Fake two: say OK.')
    const e3 = await waitErr(win, n)
    await shot(win, '05-fake-pick-zh')
    check('③ 点名当前模型和可换的模型', e3.includes(`${FAKE} 当前的模型 deepseek-v4-flash 要 API key`) && e3.includes('比如 DeepSeek-V4.1-Flash、DeepSeek-V4-Pro'), e3)
    check('③ 叫人去输入框的模型菜单里换,提到设置路径', e3.includes('在输入框的模型菜单里换一个再发') && e3.includes('设置 → Agent → 本机 Agent CLI'), e3)
    const sp = await openSettings(app, win)
    let navOk = false, subOk = false, rowOk = false
    if (sp) {
      const nav = sp.locator('.settings-nav')
      const agentTab = nav.getByRole('button', { name: 'Agent', exact: true }).first()
      navOk = (await agentTab.count()) > 0
      if (navOk) { await agentTab.click(); await sleep(700) }
      const subTab = sp.getByRole('button', { name: '本机 Agent CLI', exact: true }).first()
      subOk = (await subTab.count()) > 0
      if (subOk) { await subTab.click(); await sleep(1500) }
      const body = await sp.locator('.settings-main').first().innerText().catch(() => '')
      rowOk = body.includes(FAKE) && body.includes('默认模型')
      await sp.screenshot({ path: path.join(SHOTS, '06-settings-agent-clis.png') }).catch(() => {})
      await sp.close().catch(() => {})
    }
    check('③ 设置里真有「Agent」这一栏', navOk)
    check('③ 「Agent」下真有「本机 Agent CLI」', subOk)
    check('③ 那一页列着这个引擎和「默认模型」', rowOk)

    // ④ 失败后(③ 又标了过时)切到别的对话再切回来:也重新探测
    const b4 = freshFor('dshfake')
    await sidebarRow(win, 'Say OK.').click(); await sleep(1500)
    await sidebarRow(win, 'Fake one: say OK.').click()
    const switched = await until(() => freshFor('dshfake') > b4, 15_000)
    check('④ 切到别的对话再切回来:重新探测', switched, `fresh 请求 ${b4} → ${freshFor('dshfake')}`)

    // ⑤ 选账号那一组的模型再发:通了
    await openModelMenu(win)
    await win.locator('.composer-menu--model .menu-item', { hasText: 'DeepSeek-V4.1-Flash' }).first().click()
    await sleep(800)
    await send(win, 'Fake three: say OK.')
    const ok5 = await until(() => win.evaluate(() => document.body.innerText.includes('Reply from the account model')), 60_000)
    await shot(win, '07-fake-account-ok')
    check('⑤ 选了账号那一组的模型:这一句通了', !!ok5)
    check('⑤ 引擎那边换上的是账号那一组的模型', fs.readFileSync(`${FAKE_STORE}.log`, 'utf8').includes('set model=["deepseek-account","deepseek-flash"]'))

    // ⑥ 英文(引擎会话的失败行重载后不留 —— 引擎会话的提问本来就不落库,和本改动无关 —— 所以切成英文后重新发)
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'en') })
    await win.reload(); await win.waitForSelector('.dv-groupview', { timeout: 40_000 }); await sleep(2500)
    await enterSpace(win, 'tangu'); await sleep(1000)
    await sidebarRow(win, 'Say OK.').click(); await sleep(1500)
    n = await errCount(win)
    await send(win, 'Say OK again.')
    const e6 = await waitErr(win, n)
    await shot(win, '08-dsh-nokey-en')
    check('⑥ 英文:没有别的模型那一句', e6.includes("DeepSeek Harness's current model deepseek-v4-flash needs an API key and none is set up, and it offers no other model. Sign in or add an API key in DeepSeek Harness itself, then send again"), e6)
    await win.getByText('New session', { exact: true }).first().click(); await sleep(1200)
    await pickEngine(win, FAKE)
    n = await errCount(win)
    await send(win, 'Fake four: say OK.')
    const e7 = await waitErr(win, n)
    await shot(win, '09-fake-pick-en')
    check('⑥ 英文:点名可换的模型和设置路径', e7.includes("Pick another one in the composer's model menu and send again, for example DeepSeek-V4.1-Flash, DeepSeek-V4-Pro") && e7.includes('Settings → Agents → Local agent CLIs'), e7)
  } finally {
    await app.close().catch(() => {})
  }
  return { pageErrors }
}

main().then(({ pageErrors }) => {
  check('没有页面异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' / '))
}).catch((e) => { console.error(e); check('台架跑完', false, e.message) }).finally(async () => {
  await sleep(3000)
  let left = ''; try { left = execFileSync('pgrep', ['-fl', R], { encoding: 'utf8' }).trim() } catch { left = '' }
  check('没有留下 DSH / 假 agent 进程', !left, left)
  console.log(`\n能力清单请求:${capsRequests.length} 次,其中 fresh ${capsRequests.filter((u) => u.includes('fresh=1')).length} 次`)
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
})
