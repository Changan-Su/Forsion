/** 「发布网页 → 我的网页」真机旅程:编译好的 Electron(外部模式)→ 真 standalone 引擎 → 台架给的真模型。
 * 云端 = 台架的假账号云端,其中 /api/connect、/apps 转给本地真 server(server scripts/connect-local.mts:PGlite + 真 Connect 模块,
 * 文件走 bytea、不经蓬洲)。Extend 用 --extend-pkg 给的签好的包(装进临时 Forsion 目录)。
 * 只经 live-harness --only webpublishreal 跑。不造模型事件:提示词打进真输入框、审批卡在界面上点「批准」、「我的网页」里点按钮;
 * 上架审核那一步模拟后台,用 server 的管理员令牌调真路由 /api/admin/connect。证据与截图落 <OUT>/webpagesui-evidence*。 */
const fs = require('node:fs'), path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')
const ROOT = path.resolve(__dirname, '..')
const env = (k) => process.env[`TANGU_WP_${k}`] || ''
const base = process.env.TANGU_BACKEND_URL, token = env('TOKEN'), cloud = env('CLOUD'), sim = env('SIM'), admin = env('ADMIN')
const PKG = env('PKG'), OUT = env('OUT'), MODEL = env('MODEL'), workspace = env('WORKSPACE')
const SLUG = 'tea-signup', PROMPT = '帮我做一个「周五下午茶接龙」的单页网页:写上时间(周五下午三点)和地点(三楼茶水间),能填名字和想喝的饮品,点「接龙」后在页面上列出来。做好直接发布,网址名用 tea-signup,把链接发我。'
const SHOTS = path.join(OUT, 'webpagesui-evidence')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error(`${route}: ${r.status}`)
  return r.json()
}
const listed = () => fetch(`${cloud}/api/connect/apps`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())
const adminCall = (route, method = 'GET', body) => fetch(`${sim}/api/admin/connect${route}`, { method, headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json())

/** 真引擎的事件流:工具调用、结果、审批请求、最终回复(同 intelligent-ui.live.cjs 的 observeRun)。 */
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
          if (e.type === 'tool_result') ev.results.push({ name: p.name, isError: !!p.isError, result: String(p.result || '').slice(0, 2000) })
          if (e.type === 'approval_request') ev.approvals.push({ name: p.name, reason: p.reason })
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
  if (!(base && token && cloud && sim && admin && OUT && MODEL && fs.existsSync(path.join(PKG, 'SIGNATURE')))) throw new Error('Use live-harness --only webpublishreal --extend-pkg <signed package dir>')
  fs.mkdirSync(SHOTS, { recursive: true })
  const home = path.join(OUT, 'webpagesui-shell')
  fs.cpSync(PKG, path.join(home, 'plugins', 'forsion-extend'), { recursive: true })
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud, token }))
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: base, token, defaultWorkspaceDir: workspace }))
  }
  const sid = (await api('/agent/sessions', 'POST', { title: 'ZZ-网页发布真机', model_id: MODEL, project_path: workspace, project_name: '网页发布真机', agent_config: { preset: 'chat', execMode: 'sandbox' } })).session.id
  const t0 = Date.now(), legs = [], pageErrors = []
  const leg = (name, ok, why) => { legs.push({ name, ok: !!ok, why }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  | ${why}`) }
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {})
  const url = `${cloud}/apps/livetester/${SLUG}/`
  let app, ev = null, approvalText = '', step = '启动'
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: base }, timeout: 90_000 })
    const win = await app.firstWindow({ timeout: 120_000 }); win.setDefaultTimeout(20_000)
    win.on('pageerror', (e) => pageErrors.push(`main: ${e.message}`))
    await win.waitForSelector('#root')
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_tangu_onboarding_done', '1') })
    await win.reload(); await win.waitForTimeout(1800)
    step = '跳过引导 / 进 Tangu'
    for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) { await b.first().click(); break } }
    await win.waitForSelector('.dv-groupview:visible'); await enterSpace(win, 'tangu')
    // 登录着云端 → 首次会问「把这台电脑同步到蓬洲云」(登录后缺省开的引导,产品行为),挡住点击;点「稍后」
    const later = win.getByRole('button', { name: '稍后', exact: true })
    if (await later.first().waitFor({ timeout: 8000 }).then(() => true, () => false)) { await later.first().click(); await win.waitForTimeout(400) }
    step = '点开会话'
    await win.locator(`.t2s-srow[data-sel-id="${sid}"]`).first().click()
    const ta = win.locator('.t2c-ta').first(); await ta.waitFor()

    // 1. 聊天里让 Tangu 做页并发布:真输入框 → 审批卡在界面上点「批准」→ 回复给链接
    step = '发提示词 / 等审批卡'
    const posted = win.waitForResponse((r) => /\/agent\/runs$/.test(r.url()) && r.request().method() === 'POST', { timeout: 30_000 })
    await ta.fill(PROMPT); await ta.press('Enter')
    const res = await posted
    const run = observeRun((await res.json()).runId)
    const card = win.locator('.approval-card', { has: win.locator('.approval-actions .btn', { hasText: '批准' }) }).first()
    const appeared = await card.waitFor({ timeout: 300_000 }).then(() => true, () => false)
    let before = null
    if (appeared) {
      approvalText = (await card.innerText()).replace(/\s+/g, ' ').slice(0, 600)
      before = (await listed()).apps?.some((a) => a.slug === SLUG)
      await win.waitForTimeout(500) // 换卡冷却(ApprovalTray ARM_MS)
      await shot(win, '01-approval-card')
      await card.locator('.approval-actions .btn', { hasText: '批准' }).first().click()
    }
    ev = await run
    await win.waitForTimeout(1500)
    await shot(win, '02-reply-with-link')
    const published = ev.results.some((r) => r.name === 'publish_web_page' && !r.isError && !/^Error/.test(r.result))
    // 模型常把链接写成带标题的 markdown 链接(「已发布:[周五下午茶接龙](…)」),界面上看得到的是标题、地址在 href 里
    const uiLink = await win.locator(`a[href="${url}"]`).count().catch(() => 0)
    const uiLinkText = uiLink ? (await win.locator(`a[href="${url}"]`).first().innerText().catch(() => '')).trim() : ''
    leg('聊天里让 Tangu 做页并发布:界面弹审批卡,点「批准」前一个字节都没发,批准后发布成功,回复(界面上)给了链接',
      appeared && before === false && published && ev.content.includes(url) && uiLink > 0,
      `${appeared ? `弹了审批卡「${approvalText.slice(0, 80)}…」` : '✗ 没弹审批卡'};批准前${before === false ? '服务端没有这页' : before ? '✗ 已经发了' : '-'};publish_web_page ${published ? '成功' : '✗ 没成'};回复${ev.content.includes(url) ? '带了链接' : `✗ 没带链接 ${url}`};界面${uiLink ? `显示了可点的链接「${uiLinkText}」` : '✗ 没显示链接'}${ev.error ? `;✗ ${ev.error}` : ''}`)

    // 2. 链接真能打开:壳页 200,内容带 CSP sandbox,就是做的那页;再在窗口里打开看一眼
    const shellRes = await fetch(url).catch(() => null)
    const content = await fetch(`${url}__content/`).catch(() => null)
    const html = content ? await content.text() : ''
    leg('链接真能打开:壳页 200,内容带 CSP sandbox,是「下午茶接龙」那页',
      shellRes?.status === 200 && content?.status === 200 && /sandbox/.test(content.headers.get('content-security-policy') || '') && /下午茶/.test(html),
      `壳 ${shellRes?.status} / 内容 ${content?.status};CSP ${content?.headers.get('content-security-policy') || '无'};${/下午茶/.test(html) ? '含「下午茶」' : '✗ 不含「下午茶」'};${html.length} 字节`)
    if (shellRes?.status === 200) {
      await app.evaluate(({ BrowserWindow }, u) => { const w = new BrowserWindow({ width: 900, height: 700, show: true, title: 'published' }); void w.loadURL(u) }, url)
      let pub = null
      for (let i = 0; i < 40 && !pub; i++) { pub = app.windows().find((w) => w.url() === url) || null; if (!pub) await sleep(250) }
      if (pub) { await pub.waitForTimeout(2500); await shot(pub, '03-public-page'); await pub.close().catch(() => {}) }
    }

    step = '我的网页'
    // 3. 设置 → Forsion 云端 → 我的网页:列出这页,链接与回复里的一致
    await win.evaluate(([n]) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'forsion', n } }), [Date.now()])
    let sp = null
    for (let i = 0; i < 80 && !sp; i++) {
      for (const w of app.windows()) if (w.url().includes('window=floating') && await w.locator('.settings-page').count().catch(() => 0)) sp = w
      if (!sp) await sleep(250)
    }
    if (!sp) throw new Error('设置浮窗没出来')
    sp.on('pageerror', (e) => pageErrors.push(`settings: ${e.message}`))
    await app.evaluate(({ BrowserWindow }, u) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === u)?.setContentSize(1100, 860) }, sp.url())
    await sp.waitForFunction(() => [...document.querySelectorAll('#settings-nav-subitems-forsion .settings-nav-subitem')].some((b) => b.innerText.trim() === '我的网页'), null, { timeout: 20_000 })
    await sp.locator('#settings-nav-subitems-forsion .settings-nav-subitem', { hasText: '我的网页' }).first().click()
    const root = '[data-fx-page="webpages"]', item = sp.locator(`${root} [data-webpage="${SLUG}"]`)
    const shown = await item.waitFor({ timeout: 20_000 }).then(() => true, () => false)
    const href = shown ? await item.locator('.fx-web-url').getAttribute('href') : null
    const all = await sp.locator(`${root} [data-webpage]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-webpage')))
    const quota = await sp.locator(`${root} .fx-web-quota`).innerText().catch(() => '')
    await shot(sp, '04-my-web-pages')
    leg('设置 → 我的网页:列出这页,链接与回复里的一致,名额按真 server 的会员档',
      shown && href === url && /\/ 5/.test(quota),
      `${shown ? '列出了' : '✗ 没列出'} ${SLUG};链接 ${href === url ? '一致' : `✗ ${href}`};页上共 [${all.join(', ')}];「${quota}」`)

    step = '申请上架'
    // 4. 申请上架 → 上架审核中(真 server 里是一条 pending)
    await item.getByRole('button', { name: '申请上架', exact: true }).click()
    await item.locator('textarea').fill('周五下午茶接龙报名页。')
    await item.locator('form button[type="submit"]').click()
    const pending = await item.getByText('上架审核中', { exact: true }).waitFor({ timeout: 15_000 }).then(() => true, () => false)
    const queue = (await adminCall('/listings')).listings || []
    const mine = queue.find((l) => l.slug === SLUG)
    await shot(sp, '05-listing-pending')
    leg('申请上架:页上变「上架审核中」,后台审核队列里有这条(带简介)', pending && mine?.status === 'pending' && mine.summary === '周五下午茶接龙报名页。',
      `${pending ? '页上显示审核中' : '✗ 页上没变'};后台 ${mine ? `${mine.status}「${mine.summary}」` : '✗ 没这条'}`)

    step = '后台批准'
    // 5. 后台批准(管理员令牌调真路由)→ 刷新 → 已上架,商店公开列表里有它
    const review = mine ? await adminCall(`/listings/${mine.app_id}/review`, 'POST', { action: 'approve' }) : null
    await sp.locator(root).getByRole('button', { name: '刷新', exact: true }).click()
    const approved = await item.getByText('已上架', { exact: true }).waitFor({ timeout: 15_000 }).then(() => true, () => false)
    const store = await fetch(`${cloud}/api/connect/store`).then((r) => r.json()).catch(() => ({}))
    await shot(sp, '06-listed')
    leg('后台批准后刷新:页上「已上架」,商店「网站应用」公开列表里有它', approved && (store.items || []).some((i) => i.slug === SLUG),
      `审核 ${review?.status || '✗'};${approved ? '页上已上架' : '✗ 页上没变'};商店 ${(store.items || []).map((i) => i.slug).join(', ') || '空'}`)

    step = '下架'
    // 6. 下架(二次确认)→ 商店里没了
    await item.getByRole('button', { name: '下架', exact: true }).click()
    await item.getByRole('button', { name: '确认下架', exact: true }).click()
    const delisted = await item.getByText('已上架', { exact: true }).waitFor({ state: 'detached', timeout: 15_000 }).then(() => true, () => false)
    const store2 = await fetch(`${cloud}/api/connect/store`).then((r) => r.json()).catch(() => ({}))
    leg('下架(二次确认):标记消失,商店里没了', delisted && !(store2.items || []).some((i) => i.slug === SLUG), `${delisted ? '标记消失' : '✗ 还在'};商店 ${(store2.items || []).map((i) => i.slug).join(', ') || '空'}`)

    step = '下线'
    // 7. 下线(二次确认)→ 列表少这一条,公开链接 404,服务端也没了
    await item.getByRole('button', { name: '下线', exact: true }).click()
    await shot(sp, '07-take-down-armed')
    await item.getByRole('button', { name: '确认下线', exact: true }).click()
    const gone = await item.waitFor({ state: 'detached', timeout: 15_000 }).then(() => true, () => false)
    const after = await fetch(url).then((r) => r.status).catch(() => null)
    const left = ((await listed()).apps || []).map((a) => a.slug)
    await shot(sp, '08-after-take-down')
    leg('下线(二次确认):列表少这一条,公开链接 404,服务端没了', gone && after === 404 && !left.includes(SLUG), `${gone ? '页上没了' : '✗ 还在'};链接 ${after};服务端剩 [${left.join(', ')}]`)
    leg('界面没有报错', !pageErrors.length, pageErrors.join(' | ') || '无')
  } catch (e) {
    leg('旅程跑完', false, `卡在「${step}」:${String(e?.message || e).split('\n')[0]}`)
    for (const [i, w] of (app?.windows() || []).entries()) await shot(w, `99-failure-${i}`)
  } finally {
    await app?.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true }) // 隔离 home(含令牌)不留
  }
  const bad = legs.filter((l) => !l.ok)
  const row = {
    ok: !bad.length, ms: Date.now() - t0,
    detail: legs.map((l, i) => `${i + 1}${l.ok ? '✓' : '✗'} ${l.name}:${l.why}`).join(' ‖ '),
    output: ev ? ev.content : '',
    toolCalls: ev ? ev.calls : [],
    tokens: ev ? ev.usages.reduce((a, u) => a + (Number(u.prompt) || 0) + (Number(u.completion) || 0), 0) || null : null,
    legs, approvalCard: approvalText, approvals: ev?.approvals || [], shots: fs.readdirSync(SHOTS).sort(),
  }
  fs.writeFileSync(path.join(OUT, 'webpagesui-evidence.json'), JSON.stringify(row, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
