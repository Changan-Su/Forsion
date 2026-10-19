/**
 * 插件工具结果卡片(ctx.registerToolResultRenderer,插件开放清单 §3.1 / 10-19 方案 D)的**真 Electron** 验证:
 * 真主进程从磁盘发现插件(含捆绑的引擎半身目录)× 真聊天面 × 可编剧假引擎(工具事件 + /agent/plugins 的名下工具)。
 *
 *  T1 自家引擎半身的工具跑完 → 对话里画插件卡片,通用记录里不再有它;核心工具、出错的调用、别家名字照旧是通用记录
 *  T2 卡片里调 call.quote → 输入框上方多一张引用卡(不发送)
 *  T3「在 Desk 打开」→ 对话里换成占位卡、Desk 里重新挂(surface=desk)并拿回 state;⋯「放回对话」→ 回到对话
 *  T4 落点 desk 的工具 → 结果一到就进 Desk,对话里留占位卡;占位卡「收回到对话」
 *  负对照 --nc=noclaim:引擎不报名下工具(名单为空)→ 不认领、全是通用记录(fail closed)。期望除「核心工具认领不了」外全红
 *  (10-19 实跑 1 passed / 10 failed)。
 *
 * fixture 插件 toolcard-probe 只在本脚本的临时家目录里生成,不进产品、不进仓里的插件目录。
 * 截图写到 /tmp/forsion-toolcard-*.png(观感自查用,不入库)。
 *
 * 需先 npm run build(跑的是 out/,对别人的 HMR 免疫)。用法:npm run e2e:toolcard   ｜   --nc=noclaim 负对照
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.join(__dirname, '..')
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok }) // !!:短路出来的 null 也得算失败
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 's1', title: '插件卡片会话', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
  created_at: '2026-10-19 09:00:00', updated_at: '2026-10-19 09:00:00',
}
const ENGINE_ID = 'toolcard-probe-engine'

/** fixture 插件:两个渲染器(inline 的 probe_chart、desk 的 probe_board),挂载 / 清理记进 window.__toolcard。 */
const PROBE_MAIN = `
const log = (window.__toolcard = window.__toolcard || { mounts: [], cleanups: [] })
function draw(el, call, label) {
  const st = call.state.get() || { clicks: 0 }
  log.mounts.push(call.tool + ':' + call.surface + ':' + st.clicks)
  el.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'probe-card'
  box.style.cssText = 'display:flex;flex-direction:column;gap:8px;color:var(--text);font-size:var(--ui-font-body)'
  const rows = (call.args && call.args.rows) || []
  const head = document.createElement('div')
  head.className = 'probe-head'
  head.textContent = label + ' · ' + rows.length + ' rows · clicks=' + st.clicks
  box.appendChild(head)
  const list = document.createElement('div')
  list.style.cssText = 'display:grid;grid-template-columns:repeat(' + Math.max(rows.length, 1) + ',1fr);gap:6px;align-items:end;height:' + (call.surface === 'desk' ? 220 : 90) + 'px'
  rows.forEach(function (r) {
    const bar = document.createElement('div')
    bar.style.cssText = 'background:var(--accent-ink);opacity:.7;border-radius:4px;height:' + Math.round(r.v) + '%'
    bar.title = r.k
    list.appendChild(bar)
  })
  box.appendChild(list)
  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;gap:6px'
  const more = document.createElement('button')
  more.className = 'probe-click'
  more.textContent = '+1'
  more.onclick = function () { st.clicks++; call.state.set(st); head.textContent = label + ' · ' + rows.length + ' rows · clicks=' + st.clicks }
  const q = document.createElement('button')
  q.className = 'probe-quote'
  q.textContent = 'Quote'
  q.onclick = function () { call.quote('probe quote: ' + rows.map(function (r) { return r.k }).join(', ')) }
  actions.appendChild(more)
  actions.appendChild(q)
  box.appendChild(actions)
  el.appendChild(box)
  return function () { log.cleanups.push(call.tool + ':' + call.surface) }
}
ctx.registerToolResultRenderer({ tool: 'probe_chart', title: 'Probe chart', mount: function (el, call) { return draw(el, call, 'CHART') } })
ctx.registerToolResultRenderer({ tool: 'probe_board', surface: 'desk', title: 'Probe board', mount: function (el, call) { return draw(el, call, 'BOARD') } })
// 想认领核心工具:宿主必须不给(引擎不会把 read_file 报在插件名下)
ctx.registerToolResultRenderer({ tool: 'read_file', mount: function (el) { el.textContent = 'HIJACKED' } })
`

function writeProbe(pluginsDir) {
  const dir = path.join(pluginsDir, 'toolcard-probe')
  fs.mkdirSync(path.join(dir, 'tangu-plugins', ENGINE_ID), { recursive: true })
  fs.writeFileSync(path.join(dir, 'main.js'), PROBE_MAIN)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'toolcard-probe', name: 'Toolcard Probe', version: '1.0.0', minAppVersion: '0.0.1',
    description: 'e2e fixture for tool result cards; not a product plugin',
  }, null, 2))
  // 捆绑的引擎半身只要有 manifest,主进程就把它记进 bundle.enginePlugins(引擎是假的,不会真去跑它)
  fs.writeFileSync(path.join(dir, 'tangu-plugins', ENGINE_ID, 'tangu-plugin.json'), JSON.stringify({ id: ENGINE_ID, entry: 'index.js', apiVersion: 1 }))
}

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40; i++) {
    if (await ta.isEnabled().catch(() => false)) break
    await win.waitForTimeout(500)
  }
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2200)
}

const shot = async (win, name) => {
  const p = `/tmp/forsion-toolcard-${name}.png`
  await win.screenshot({ path: p }).catch(() => {})
  console.log(`      截图 ${p}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  if (NC) console.log(`⚠️ 负对照 --nc=${NC}:期望除「核心工具认领不了」外全红\n`)
  const stub = await startStubEngine({
    sessions: [SESSION],
    handle: ({ path: p, method }) => {
      if (p === '/agent/plugins' && method === 'GET') {
        return { plugins: [{
          id: ENGINE_ID, name: 'Toolcard Probe engine', description: '', scopes: ['global'], settings: null, source: 'folder',
          enabled: true, active: true, version: '1.0.0', ...(NC === 'noclaim' ? {} : { tools: ['probe_chart', 'probe_board'] }),
        }] }
      }
      if (/^\/agent\/plugins\/[^/]+\/enabled$/.test(p)) return { ok: true, enabled: true, active: true, plugins: [] }
      return undefined
    },
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-toolcard-'))
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  writeProbe(path.join(home, 'plugins'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })

  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(1200)
    await enterSpace(win, 'tangu')
    await win.waitForTimeout(1200)
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    const row = win.locator(`.t2s-srow[data-sel-id="${SESSION.id}"]`).first()
    if (!(await row.waitFor({ timeout: 10_000 }).then(() => true, () => false))) throw new Error('没找到会话行')
    await row.click()
    await win.waitForTimeout(1500)

    // ── T1 / T2:对话里的卡片
    const rows = [{ k: 'Mon', v: 40 }, { k: 'Tue', v: 75 }, { k: 'Wed', v: 55 }, { k: 'Thu', v: 90 }]
    stub.script([
      { type: 'tool_call', payload: { id: 'c-read', name: 'read_file', arguments: JSON.stringify({ path: 'notes.md' }) } },
      { type: 'tool_result', payload: { id: 'c-read', result: 'file body' } },
      { type: 'tool_call', payload: { id: 'c-chart', name: 'probe_chart', arguments: JSON.stringify({ rows }) } },
      { type: 'tool_result', payload: { id: 'c-chart', result: 'Chart drawn for 4 rows.' } },
      { type: 'tool_call', payload: { id: 'c-bad', name: 'probe_chart', arguments: JSON.stringify({ rows: [] }) } },
      { type: 'tool_result', payload: { id: 'c-bad', result: 'Error: no rows', isError: true } },
      { type: 'token', payload: { delta: '这周的数据画好了。' } },
    ])
    await send(win, '画一下这周的数据')
    await win.waitForTimeout(1200)
    const t1 = await win.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-plugin-tool-card]')]
      return {
        cards: cards.map((c) => c.getAttribute('data-plugin-tool-card')),
        body: document.querySelector('[data-plugin-tool-card="probe_chart"] .probe-head')?.textContent || '',
        title: document.querySelector('[data-plugin-tool-card="probe_chart"] .sketch-card-title')?.textContent || '',
        hijacked: document.body.textContent.includes('HIJACKED'),
        groups: document.querySelectorAll('.tool-group').length,
        mounts: (window.__toolcard || { mounts: [] }).mounts.slice(),
      }
    })
    check('T1 自家工具跑完画插件卡片(只有成功的那次)', t1.cards.length === 1 && t1.cards[0] === 'probe_chart' && t1.body.startsWith('CHART · 4 rows'), JSON.stringify(t1))
    check('T1 卡头 = 卡片名 · 插件名', t1.title === 'Probe chart · Toolcard Probe', t1.title)
    check('T1 核心工具 read_file 认领不了(没有 HIJACKED)', !t1.hijacked)
    // 通用记录里还剩 read_file 与出错的 probe_chart:展开工具组数行
    // 卡片把工具切成前后两组(read_file 在前、出错的那次在后):两组都展开再数
    const heads = win.locator('.tool-group-head')
    for (let i = 0; i < await heads.count(); i++) await heads.nth(i).click().catch(() => {})
    await win.waitForTimeout(500)
    const rowsLeft = await win.evaluate(() => [...document.querySelectorAll('.tool-row-verb')].length)
    await shot(win, '1-inline')
    for (let i = 0; i < await heads.count(); i++) await heads.nth(i).click().catch(() => {})
    check('T1 出错的那次和核心工具留在通用记录里(两行),成功那次不在', rowsLeft === 2, `rows=${rowsLeft}`)

    await win.locator('[data-plugin-tool-card="probe_chart"] .probe-click').click().catch(() => {})
    await win.locator('[data-plugin-tool-card="probe_chart"] .probe-quote').click().catch(() => {})
    await win.waitForTimeout(600)
    const quote = await win.evaluate(() => [...document.querySelectorAll('.t2c-quote-text')].map((e) => e.textContent))
    check('T2 call.quote → 输入框上方一张引用卡', quote.length === 1 && quote[0].includes('probe quote: Mon, Tue, Wed, Thu'), JSON.stringify(quote))
    await win.locator('.t2c-quote-x').first().click().catch(() => {})

    // ── T3:在 Desk 打开 → 放回对话
    await win.locator('[data-plugin-tool-card="probe_chart"] [data-act="tool-card-desk"]').click().catch(() => {})
    await win.waitForTimeout(1200)
    const t3 = await win.evaluate(() => ({
      stub: document.querySelector('[data-plugin-tool-stub="probe_chart"]')?.textContent || '',
      desk: document.querySelector('.agent-desk.open [data-plugin-tool-card-desk="probe_chart"] .probe-head')?.textContent || '',
      cap: document.querySelector('.agent-desk.open .desk-cap-label')?.textContent || '',
      log: JSON.parse(JSON.stringify(window.__toolcard || {})),
    }))
    await shot(win, '2-desk')
    check('T3 对话里换成占位卡(名字 + 插件名 + 正在 Desk 中显示)', t3.stub.includes('Probe chart') && t3.stub.includes('Toolcard Probe') && t3.stub.includes('正在 Desk 中显示'), t3.stub)
    check('T3 Desk 里重新挂、拿回 state(clicks=1),胶囊上是卡片名', t3.desk.includes('clicks=1') && t3.cap === 'Probe chart', `${t3.desk} | cap=${t3.cap}`)
    check('T3 旧位置先清理再在新位置 mount', JSON.stringify(t3.log.cleanups).includes('probe_chart:inline') && t3.log.mounts.includes('probe_chart:desk:1'), JSON.stringify(t3.log))
    // ⋯ → 放回对话
    await win.locator('.agent-desk.open .desk-cap button[aria-haspopup="menu"]').last().click().catch(() => {})
    await win.waitForTimeout(400)
    await win.locator('text=放回对话').first().click().catch(() => {})
    await win.waitForTimeout(1200)
    const t3b = await win.evaluate(() => ({
      card: document.querySelector('[data-plugin-tool-card="probe_chart"] .probe-head')?.textContent || '',
      stub: !!document.querySelector('[data-plugin-tool-stub]'),
      deskOpen: !!document.querySelector('.agent-desk.open'),
    }))
    check('T3 ⋯「放回对话」→ 卡片回到对话、state 还在、Desk 收起', t3b.card.includes('clicks=1') && !t3b.stub && !t3b.deskOpen, JSON.stringify(t3b))

    // ── T4:落点 desk 的工具直接进 Desk
    stub.script([
      { type: 'tool_call', payload: { id: 'c-board', name: 'probe_board', arguments: JSON.stringify({ rows: rows.slice(0, 3) }) } },
      { type: 'tool_result', payload: { id: 'c-board', result: 'Board ready.' } },
      { type: 'token', payload: { delta: '白板放在右边了。' } },
    ])
    await send(win, '再开一块看板')
    await win.waitForTimeout(1500)
    const t4 = await win.evaluate(() => ({
      stub: document.querySelector('[data-plugin-tool-stub="probe_board"]')?.textContent || '',
      desk: document.querySelector('.agent-desk.open [data-plugin-tool-card-desk="probe_board"] .probe-head')?.textContent || '',
      inline: !!document.querySelector('[data-plugin-tool-card="probe_board"]'),
    }))
    await shot(win, '3-desk-surface')
    check('T4 落点 desk:结果一到就进 Desk,对话里只有占位卡', t4.desk.startsWith('BOARD · 3 rows') && t4.stub.includes('正在 Desk 中显示') && !t4.inline, JSON.stringify(t4))
    await win.locator('[data-plugin-tool-stub="probe_board"] [data-act="tool-card-back"]').click().catch(() => {})
    await win.waitForTimeout(1000)
    const t4b = await win.evaluate(() => ({
      inline: document.querySelector('[data-plugin-tool-card="probe_board"] .probe-head')?.textContent || '',
      deskOpen: !!document.querySelector('.agent-desk.open'),
    }))
    check('T4 占位卡「收回到对话」→ 卡片画在对话里', t4b.inline.startsWith('BOARD') && !t4b.deskOpen, JSON.stringify(t4b))
    await shot(win, '4-back')
  } finally {
    await app.close().catch(() => {})
    stub.close()
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} passed / ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
