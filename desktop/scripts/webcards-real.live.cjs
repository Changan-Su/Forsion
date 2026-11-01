/** 网页卡片真机旅程(网页卡片 A + D、第二轮 1,10-28):编译好的 Electron(外部模式)→ 真 standalone 引擎 → 台架给的真模型。
 * 云端 = 台架的假账号云端,/api/connect、/apps 转给本地真 server(connect-local.mts);Extend 用 --extend-pkg 给的签好的包,
 * 引擎那半由台架装进引擎的插件目录(判官方要靠签名),桌面那半装进这里的临时 Forsion 目录。
 * 只经 live-harness --only webcardsreal 跑。同一个本机项目会话里四句真话,每句看一张卡:
 *   ① 写一页 HTML → 本地网页卡(缩略图、名字取 <title>);② 用 run_background 起本地服务 → 服务卡(运行中、localhost 缩略图);
 *   ③ 发布 → 审批卡上点「批准」→ Extend 的「网页」卡(已上线、线上缩略图),①那张变「已发布」;④ 问发布了哪些 → Extend 的「我的网页」卡。
 * 最后在服务卡上点「停止」,看它变「已停止」。不造模型事件。证据与截图落 <OUT>/webcardsui-evidence*。 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')
const ROOT = path.resolve(__dirname, '..')
const env = (k) => process.env[`TANGU_WP_${k}`] || ''
const base = process.env.TANGU_BACKEND_URL, token = env('TOKEN'), cloud = env('CLOUD')
const PKG = env('PKG'), OUT = env('OUT'), MODEL = env('MODEL')
const SHOTS = path.join(OUT, 'webcardsui-evidence')
const PORT = 18000 + Math.floor(Math.random() * 2000)
const PROMPTS = [
  '在当前项目里新建 tea-signup/index.html:「周五下午茶接龙」的单页网页,写上时间(周五下午三点)和地点(三楼茶水间),能填名字和想喝的饮品,点「接龙」后在页面上列出来。只写这一个文件,先别发布,也别启动服务。',
  `在后台起一个本地服务预览它:在 tea-signup 目录里用 run_background 运行 \`python3 -u -m http.server ${PORT} --bind 127.0.0.1\`,起来后把地址发我。`,
  '把 tea-signup/index.html 发布成网页,网址名用 tea-signup,把链接发我。',
  '我现在一共发布了哪些网页?',
]

async function api(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error(`${route}: ${r.status}`)
  return r.json()
}

/** 真引擎的事件流(同 webpages-real.live.cjs)。 */
async function observeRun(runId) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 420_000)
  const ev = { calls: [], results: [], approvals: [], content: '', usages: [] }
  try {
    const r = await fetch(`${base}/agent/runs/${runId}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
    let buf = ''; const dec = new TextDecoder()
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true })
      let pos
      while ((pos = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, pos); buf = buf.slice(pos + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const e = JSON.parse(line.slice(5)), p = e.payload || {}
          if (e.type === 'tool_call') ev.calls.push(p.name)
          if (e.type === 'tool_result') ev.results.push({ name: p.name, isError: !!p.isError, parked: !!p.parked, result: String(p.result || '').slice(0, 600) })
          if (e.type === 'approval_request') ev.approvals.push({ name: p.name })
          if (e.type === 'usage') ev.usages.push(p)
          if (e.type === 'done') { ev.content = p.content || ''; return ev }
          if (e.type === 'error') { ev.error = p.error; return ev }
        }
      }
    }
    ev.error = 'Stream ended without done'
  } catch (e) { ev.error = String(e.message) } finally { clearTimeout(timer); ac.abort() }
  return ev
}

async function main() {
  if (!(base && token && cloud && OUT && MODEL && fs.existsSync(path.join(PKG, 'SIGNATURE')))) throw new Error('Use live-harness --only webcardsreal --connect-server <server checkout> --extend-pkg <signed package dir>')
  fs.mkdirSync(SHOTS, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webcardsui-'))
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'webcards-proj-'))
  const t0 = Date.now(), legs = [], pageErrors = [], runs = []
  const leg = (name, ok, why) => { legs.push({ name, ok: !!ok, why }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  | ${why}`) }
  const shotWin = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {})
  let app, step = '准备', plugins = null
  try {
    fs.cpSync(PKG, path.join(home, 'plugins', 'forsion-extend'), { recursive: true })
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud, token }))
    for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: base, token, defaultWorkspaceDir: proj }))
    }
    // 引擎有没有把 Extend 的引擎半身判成官方:没有的话 A / D 两张卡不会出(那是装包问题,不是渲染问题)
    plugins = (await api('/agent/plugins').catch(() => ({}))).plugins || []
    const off = plugins.filter((p) => p.official).map((p) => p.id)
    leg('引擎把 Extend 的引擎半身判为官方(A / D 卡的前提)', off.length > 0, off.length ? `official: [${off.join(', ')}]` : `✗ 没有 official 的插件;在跑的:[${plugins.map((p) => `${p.id}${p.active ? '' : '(未启用)'}`).join(', ')}]`)
    const sid = (await api('/agent/sessions', 'POST', { title: 'ZZ-网页卡片真机', model_id: MODEL, project_path: proj, project_name: '网页卡片真机', agent_config: { execMode: 'host', approvalMode: 'auto-edit' } })).session.id
    step = '启动'
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: base }, timeout: 90_000 })
    const win = await app.firstWindow({ timeout: 120_000 }); win.setDefaultTimeout(20_000)
    win.on('pageerror', (e) => pageErrors.push(e.message))
    await win.waitForSelector('#root')
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_tangu_onboarding_done', '1') })
    await win.reload(); await win.waitForTimeout(1800)
    step = '进 Tangu'
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview:visible'); await enterSpace(win, 'tangu')
    const later = win.getByRole('button', { name: '稍后', exact: true })
    if (await later.first().waitFor({ timeout: 8000 }).then(() => true, () => false)) { await later.first().click(); await win.waitForTimeout(400) }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960))
    step = '点开会话'
    await win.locator(`.t2s-srow[data-sel-id="${sid}"]`).first().click()
    const ta = win.locator('.t2c-ta').first(); await ta.waitFor()
    // 要审批的那一步会分成两块回答(批准前那块带着工具调用,批准后续跑的是新的一块):卡在批准前那块里,所以在整段对话里找最新的一张
    const colOf = (card) => win.locator('.t2-asst-col').filter({ has: card }).last()
    const crop = async (name, card) => { await win.waitForTimeout(600); await colOf(card).screenshot({ path: path.join(SHOTS, `${name}.png`), scale: 'device' }).catch(() => {}) }
    const LOCAL = '[data-web-card-host="local"]', SERVICE = '[data-web-card-host="service"]'

    /** 发一句话;run 期间出现的审批卡一律在界面上点「批准」(只为让旅程走完,审批本身不是这次要验的)。 */
    const say = async (i) => {
      step = `第 ${i + 1} 句`
      const posted = win.waitForResponse((r) => /\/agent\/runs$/.test(r.url()) && r.request().method() === 'POST', { timeout: 30_000 })
      await ta.fill(PROMPTS[i]); await ta.press('Enter')
      let finished = false
      const run = observeRun((await (await posted).json()).runId).finally(() => { finished = true })
      const card = win.locator('.approval-card', { has: win.locator('.approval-actions .btn', { hasText: '批准' }) }).first()
      let approved = 0
      while (!finished) {
        if (!await card.waitFor({ timeout: 3000 }).then(() => true, () => false)) continue
        const h = await card.elementHandle()
        await win.waitForTimeout(500)
        await card.locator('.approval-actions .btn', { hasText: '批准' }).first().click().catch(() => {})
        approved++
        await h.waitForElementState('hidden', { timeout: 20_000 }).catch(() => {})
      }
      const ev = await run
      runs.push({ prompt: PROMPTS[i], calls: ev.calls, approved, reply: ev.content.slice(0, 800), error: ev.error || null,
        results: ev.results.filter((r) => !r.parked).map((r) => `${r.name}${r.isError ? ' ✗' : ''}: ${r.result.split('\n')[0].slice(0, 160)}`) })
      await win.waitForTimeout(2500)
      return ev
    }
    const thumbOf = (loc) => loc.locator('.wc-thumb img').first().waitFor({ timeout: 20_000 }).then(() => true, () => false)

    // ① 本地网页卡
    const e1 = await say(0)
    const local = win.locator(LOCAL).last()
    const localShown = await local.waitFor({ timeout: 10_000 }).then(() => true, () => false)
    const localThumb = localShown && await thumbOf(local)
    const localName = localShown ? (await local.locator('.wc-name').innerText().catch(() => '')).trim() : ''
    const htmlWrite = e1.calls.filter((c) => /write_file|apply_patch|edit_file/.test(c)).length
    await crop('01-local-card', win.locator(LOCAL))
    leg('① 写一页 HTML → 本地网页卡:出卡、拍到缩略图、名字取页面标题', localShown && localThumb && !!localName && !/index\.html$/.test(localName),
      `${htmlWrite} 次写文件(${e1.calls.join(', ')});${localShown ? '出了卡' : '✗ 没出卡'};${localThumb ? '有缩略图' : '✗ 没缩略图'};名字「${localName}」`)

    // ② 服务卡
    const e2 = await say(1)
    const svc = win.locator(SERVICE).last()
    const svcShown = await svc.waitFor({ timeout: 20_000 }).then(() => true, () => false)
    const svcThumb = svcShown && await thumbOf(svc)
    const svcPill = svcShown ? (await svc.locator('.wc-pill').innerText().catch(() => '')).trim() : ''
    const svcAddr = svcShown ? (await svc.locator('.wc-link').innerText().catch(() => '')).trim() : ''
    await crop('02-service-card', win.locator(SERVICE))
    leg('② run_background 起本地服务 → 服务卡:运行中、地址是这个端口、拍到缩略图', svcShown && svcPill.includes('运行中') && svcAddr.includes(String(PORT)) && svcThumb,
      `工具 ${e2.calls.join(', ')};${svcShown ? `出了卡「${svcPill}」${svcAddr}` : '✗ 没出卡'};${svcThumb ? '有缩略图' : '✗ 没缩略图'}`)

    // ③ 发布 → Extend 的「网页」卡
    const e3 = await say(2)
    const a = win.locator('[data-plugin-tool-card="publish_web_page"]').last()
    const aShown = await a.waitFor({ timeout: 20_000 }).then(() => true, () => false)
    const aLive = aShown && await a.locator('.wc-pill', { hasText: '已上线' }).waitFor({ timeout: 20_000 }).then(() => true, () => false)
    const aThumb = aShown && await thumbOf(a)
    const aAddr = aShown ? (await a.locator('.wc-link').innerText().catch(() => '')).trim() : ''
    await crop('03-publish-card', win.locator('[data-plugin-tool-card="publish_web_page"]'))
    const firstLocal = win.locator(`${LOCAL} .wc-pill`).first()
    const nowPublished = await firstLocal.filter({ hasText: '已发布' }).waitFor({ timeout: 10_000 }).then(() => true, () => false)
    leg('③ 发布 → Extend 画的「网页」卡:已上线、线上地址、拍到缩略图;第一句那张本地卡变「已发布」', aShown && aLive && aThumb && /tea-signup/.test(aAddr) && nowPublished,
      `工具 ${e3.calls.join(', ')}(批了 ${runs[2].approved} 张审批卡);${aShown ? `出了卡${aLive ? '「已上线」' : '✗ 不是已上线'} ${aAddr}` : '✗ 没出卡(看第 0 条 official)'};${aThumb ? '有缩略图' : '✗ 没缩略图'};本地卡${nowPublished ? '变「已发布」' : '✗ 没变'}`)

    // ④ 问发布了哪些 → Extend 的「我的网页」卡
    const e4 = await say(3)
    const d = win.locator('[data-plugin-tool-card="forsion_account"]').last()
    const dShown = await d.waitFor({ timeout: 20_000 }).then(() => true, () => false)
    const rows = dShown ? await d.locator('[data-web-card="row"]').count() : 0
    const dText = dShown ? (await d.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200) : ''
    await crop('04-list-card', win.locator('[data-plugin-tool-card="forsion_account"]'))
    leg('④ 问发布了哪些 → Extend 画的「我的网页」卡:列出 tea-signup', dShown && rows >= 1 && /tea-signup/.test(dText),
      `工具 ${e4.calls.join(', ')};${dShown ? `出了卡,${rows} 行「${dText}」` : '✗ 没出卡'}`)

    // ⑤ 在服务卡上点「停止」
    step = '停止服务'
    const svcCard = win.locator(SERVICE).last()
    await svcCard.scrollIntoViewIfNeeded().catch(() => {})
    await svcCard.locator('[data-act="stop"]').click().catch(() => {})
    const stopped = await svcCard.locator('.wc-pill', { hasText: '已停止' }).waitFor({ timeout: 15_000 }).then(() => true, () => false)
    await svcCard.screenshot({ path: path.join(SHOTS, '05-service-stopped.png'), scale: 'device' }).catch(() => {})
    leg('⑤ 服务卡上点「停止」→ 变「已停止」、地址划掉', stopped, stopped ? '已停止' : '✗ 状态没变')
    await shotWin(win, '06-whole-window')
    leg('界面没有报错', !pageErrors.length, pageErrors.join(' | ') || '无')
  } catch (e) {
    leg('旅程跑完', false, `卡在「${step}」:${String(e?.message || e).split('\n')[0]}`)
    for (const [i, w] of (app?.windows() || []).entries()) await shotWin(w, `99-failure-${i}`)
  } finally {
    await app?.close().catch(() => {})
    try { fs.cpSync(path.join(proj, 'tea-signup'), path.join(SHOTS, 'tea-signup'), { recursive: true }) } catch { /* 没写出来 */ }
    fs.rmSync(home, { recursive: true, force: true }) // 隔离 home(含令牌)不留
    fs.rmSync(proj, { recursive: true, force: true })
  }
  const bad = legs.filter((l) => !l.ok)
  const row = {
    ok: !bad.length, ms: Date.now() - t0,
    detail: legs.map((l, i) => `${i + 1}${l.ok ? '✓' : '✗'} ${l.name}:${l.why}`).join(' ‖ '),
    output: runs.map((r, i) => `【第 ${i + 1} 句】${r.prompt}\n→ ${r.reply}`).join('\n\n'),
    toolCalls: runs.flatMap((r) => r.calls), legs, runs,
    plugins: (plugins || []).map((p) => ({ id: p.id, active: p.active, official: !!p.official })),
    shots: fs.readdirSync(SHOTS).sort(),
  }
  fs.writeFileSync(path.join(OUT, 'webcardsui-evidence.json'), JSON.stringify(row, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
