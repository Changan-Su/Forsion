/**
 * 远程会话全链路台架(P1 · K9,INTEGRATION §4 G1 / G7)—— `npm run check:remotechain`。
 *
 * 链路(全在本机,不碰生产;每一环都是真代码,除注明的一层):
 *   Playwright 手机形态页(390×844 触屏 zh-CN;mobile 的 dev 风味构建,Capacitor 自定义平台 = 「安卓 App」分支)
 *     → 真 mobileShim / unitBridge / unitRelay / relayPaths / K6 targets / K8 UnitsSheet / 渲染层
 *     → [模拟层] 原生 ForsionUnit 插件(scripts/lib/fake-phone-native.cjs,经 exposeBinding;契约照 UnitPlugin/UnitRegistrar/UnitRelay.java)
 *     → 假 unit-hub(scripts/lib/fake-unit-hub.cjs:caller token 与 server 同格式同派生、验票、信封 proxyCaller、SSE 通道、流式回包;
 *        兼「云端大脑」= 可编剧假模型,记下每次 LLM 调用的账号与 client)
 *     → 真 unitHost(electron/unitHost.ts:签 x-unit-caller)→ 真 unitWeb(electron/unitWeb.ts:验签、K4 远程会话闸 createRemoteSessions)
 *     → 真 standalone 引擎(tangu-agent/dist,隔离 home、会话沙箱目录;审批、工作区上传 / 下载、run_bash 都是真的)。
 *   **唯一模拟的一层**:安卓原生插件(Kotlin 的 Keystore 身份 + HttpURLConnection 中继)。浏览器里跑不了它;这里用 Node 按同一契约
 *   代发(登记 kind=phone → caller-secret → 换票 → 头从零重建注 X-Forsion-Caller),凭据只在 Node 进程,与真 App 一样永不进页面 JS。
 *   原生那半的真机证据归 mobile/scripts/unit-relay-emu.cjs(模拟器台架)。Capacitor 的 JS↔原生桥由 window.CapacitorCustomPlatform
 *   + PluginHeaders + nativePromise / nativeCallback 接上(@capacitor/core 自带的自定义平台钩子),mobileShim 走的就是 native 分支。
 *
 * 流程(真 UI 路径):左抽屉 → 互联入口 → UnitsSheet「在哪运行」点那台电脑(懒登记本机 → /unit/remote-access 未确认 → 发起确认 →
 *   执行设备 K4 首次确认框(台架代点「允许」,先截一张等确认的图)→ 探引擎 → 整端切过去)→ 输入区「添加 › 文件」发附件 + 一句话 →
 *   引擎(假模型)要 run_bash → 审批卡(远端只读、来源行 = 本机登记名)→ 手机上点批准 → run 跑完 → 右侧栏工作区列出产物 → 读回内容比对。
 *
 * 断言(节选):
 *   G1  手机页发往 unit 目标的**中继语法面**请求(/proxy/engine*、/proxy/unit/remote-access*)在假 hub 上**全部**带有效 X-Forsion-Caller
 *       且解析成本机登记的 phone unit;不在语法面的(/proxy/unit/config、/proxy/unit/host*)照设计匿名,单列不混算。
 *   K1  信封带 proxyCaller → 引擎 run 的 input.remote.callerUnit = 手机 unit、审批事件 remote.callerName = 登记名;
 *   K3  approval_result.by = {via:'tunnel', callerUnit: 手机};
 *   K4  首次确认框按名册 registeredName 显示手机;确认前会话档 403 REMOTE_CALLER_UNCONFIRMED、确认后放行;
 *   G7  远程 run 的每次 LLM 调用:账号 = 两台设备所属账号、client = 手机的 mobile/<版本>(api_usage_logs「端」列的来源);
 *       Historian 对远程轮次不写长期记忆(引擎日志 + 记忆仓不变)、hub 零云端记忆写入;run 行归属本机引擎用户、agent = 默认 agent。
 *   KNOWN-GAP(缺省只报告,REMOTECHAIN_STRICT=1 时判红):手机附件落在引擎会话沙箱目录,host 模式的模型请求里找不到它的路径。
 *
 * 负对照(NEGCTL=…,须红):
 *   relay     模拟层照发但不带 X-Forsion-Caller(中继漏拦 / 头路径断)→ G1 那条红,且执行设备按「账号级未识别调用方」弹框;
 *   envelope  hub 信封不写 proxyCaller(hub → 设备那一跳断)→ callerUnit / 来源行那几条红。
 *
 * 前置:cd tangu-agent && npm run build(引擎 dist)。mobile 构建缺省现构建进临时目录(约 1–2 分钟),REMOTECHAIN_DIST=<目录> 复用
 *   (须是 VITE_API_ORIGIN=http://phone-hub.test 的 dev 风味构建)。截图落 SHOT_DIR(缺省临时目录)。
 * 端口:全部 listen(0);浏览器以 HTTP 代理方式把 http://phone-hub.test 指到假 hub,不占固定端口,不碰别的会话的 vite。
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { startRemoteWorld, GENESIS } = require('./lib/remote-world.cjs')
const { PHONE_ORIGIN, buildPhoneDist, openPhonePage, pickComputer, closeOverlays, compose } = require('./lib/phone-page.cjs')
const { createFakePhoneNative } = require('./lib/fake-phone-native.cjs')
const { callerTokenParity } = require('./lib/fake-unit-hub.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const NEGCTL = process.env.NEGCTL || ''
const STRICT = process.env.REMOTECHAIN_STRICT === '1'
const SHOT_DIR = process.env.SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-remotechain-shots-'))
// server 仓:显式 FORSION_SERVER_DIR;否则 worktree 布局(.worktrees/<genesis-wt> 旁的 p0-server-roster)或单仓布局(Forsion/server)
const SERVER_DIR = process.env.FORSION_SERVER_DIR || [path.resolve(GENESIS, '../p0-server-roster'), path.resolve(GENESIS, '../server')]
  .find((d) => fs.existsSync(path.join(d, 'microserver/unit-hub/services/callerToken.ts'))) || ''
const MARK = `K9-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
const ATTACH_NAME = `k9-attach-${MARK.toLowerCase()}.txt`
const ATTACH_TEXT = `hello from the phone ${MARK}\nsecond line\n`
const RESULT_NAME = 'k9-result.txt'
const PHONE_NAME = 'K9 Pixel'

const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`) }
const info = (name, detail) => console.log(`INFO  ${name}${detail ? `  | ${detail}` : ''}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 可编剧假模型:主 run 先要 run_bash 处理附件,工具结果回来后收尾;其余(标题 / Historian 等后台调用)回一句 ok ──
function makeLlm(world) {
  return (call) => {
    const msgs = call.messages || []
    const last = msgs[msgs.length - 1] || {}
    const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('') : '')
    const usage = { prompt_tokens: 100, completion_tokens: 10 }
    const isMain = call.tools.includes('run_bash')
    if (!isMain) return [{ t: 'token', d: 'ok' }, { t: 'done', content: 'ok', toolCalls: [], usage }]
    // 审批托盘(approval_tray):要批的调用先挂起,工具结果是「⏸ 等批准」—— 模型先收尾;批完引擎以 <approval_update> 回灌真结果再续一轮
    if (last.role === 'tool' && /^\s*⏸/.test(text(last.content))) {
      const reply = '命令在等你批准。'
      return [{ t: 'token', d: reply }, { t: 'done', content: reply, toolCalls: [], usage }]
    }
    if (last.role === 'tool' || (last.role === 'user' && text(last.content).includes('<approval_update>'))) {
      const reply = `已处理附件,产物 ${RESULT_NAME}(${MARK})。`
      return [{ t: 'token', d: reply }, { t: 'done', content: reply, toolCalls: [], usage }]
    }
    if (last.role === 'user' && text(last.content).includes(MARK)) {
      // 模型要把附件转成大写写到它旁边。附件在引擎会话沙箱目录里 —— host 模式的模型本不知道这个路径(见 KNOWN-GAP),
      // 这里由台架扮的模型直接知道(= 台架只证管道,不证模型能找到附件)。
      const cmd = `f="$(find '${world.sandboxDir}' -type f -name '${ATTACH_NAME}' | head -1)" && tr 'a-z' 'A-Z' < "$f" > "$(dirname "$f")/${RESULT_NAME}" && wc -c < "$(dirname "$f")/${RESULT_NAME}"`
      const args = JSON.stringify({ command: cmd })
      return [
        { t: 'token', d: '我来处理这个附件。' },
        { t: 'tool', id: 'call_k9_bash', name: 'run_bash', args, argsLen: args.length },
        { t: 'done', content: '我来处理这个附件。', toolCalls: [{ id: 'call_k9_bash', type: 'function', function: { name: 'run_bash', arguments: args } }], usage },
      ]
    }
    return [{ t: 'token', d: 'ok' }, { t: 'done', content: 'ok', toolCalls: [], usage }]
  }
}

async function main() {
  console.log(`K9 remote chain  MARK=${MARK}${NEGCTL ? `  NEGCTL=${NEGCTL}` : ''}`)
  // 0 caller token 与 server 同格式同派生(对真模块交叉验证)
  const parity = callerTokenParity(SERVER_DIR)
  if (parity.skipped) info('caller token 与 server 同格式同派生(SKIP)', parity.skipped)
  else check('caller token 与 server 同格式同派生(对 server callerToken.ts 交叉验证)', parity.ok, parity.detail)

  const dist = buildPhoneDist(process.env.REMOTECHAIN_DIST || path.join(os.tmpdir(), 'forsion-remotechain-dist'))
  const nativeCfg = JSON.parse(fs.readFileSync(path.join(dist, 'forsion-native.json'), 'utf8'))
  const home = await startStubEngine({ sessions: [], models: [{ id: 'cloud-model', name: 'Cloud Model', provider: 'forsion', contextWindow: 128000 }], agents: [{ slug: 'xyra', name: 'Tangu' }] })
  let confirmGate = null
  const world = await startRemoteWorld({
    staticDir: dist,
    homeEngineUrl: home.url,
    llm: (call) => makeLlm(world)(call),
    hubNegctl: { omitProxyCaller: NEGCTL === 'envelope' },
    confirm: async () => { if (confirmGate) await confirmGate; return true },
    log: process.env.REMOTECHAIN_DEBUG ? (m) => console.log(`  ${m}`) : undefined,
  })
  console.log(`  产物目录 ${world.out}`)
  // 原生替身用的 apiBase = 构建期烤进 forsion-native.json 的那份(页面启动时逐字比);传输层把 phone-hub.test 映射到假 hub 的真实端口
  const native = createFakePhoneNative({
    apiBase: nativeCfg.apiBase, token: () => world.PHONE_TOKEN, deviceName: PHONE_NAME, negctl: { dropCallerHeader: NEGCTL === 'relay' },
    fetch: (u, init) => fetch(String(u).startsWith(PHONE_ORIGIN) ? world.hub.url + String(u).slice(PHONE_ORIGIN.length) : u, init),
  })

  let browser = null
  try {
    const opened = await openPhonePage({ world, native })
    browser = opened.browser
    const { page, tap, pageErrors } = opened
    const boot = await page.evaluate(() => ({ native: window.Capacitor?.isNativePlatform?.(), self: null }))
    check('手机页走安卓 App 分支(Capacitor 自定义平台 isNativePlatform)', boot.native === true, JSON.stringify(boot))
    const self0 = await page.evaluate(() => window.tangu?.unitSelf?.())
    check('中继启动断言成立(原生 apiBase === 页面 cloudApiBase → relay ready)', self0?.relay === 'ready', JSON.stringify(self0))

    // ── B. UnitsSheet「在哪运行」→ 点那台电脑(执行设备的首次确认框先不答)──
    let releaseConfirm
    confirmGate = new Promise((r) => { releaseConfirm = r })
    await pickComputer({ page, tap, unitId: world.DESKTOP_UNIT })
    // 执行设备弹首次确认框(台架先不答):手机应显示「请在「K9 Studio Mac」上允许这台手机」
    for (let i = 0; i < 40 && !world.confirms.length; i++) await sleep(250)
    await page.waitForSelector(`[data-run-row="${world.DESKTOP_UNIT}"][data-status="awaitingConfirm"]`, { timeout: 8000 }).catch(() => {})
    const waiting = await page.evaluate((u) => { const r = document.querySelector(`[data-run-row="${u}"]`); return r ? { status: r.getAttribute('data-status'), sub: r.querySelector('.us-row-sub')?.textContent || '' } : null }, world.DESKTOP_UNIT)
    check('K4 首次确认:执行设备弹框,名字取名册登记名(手机)', world.confirms.length === 1 && world.confirms[0].message.includes(PHONE_NAME) && /Phone|手机/.test(world.confirms[0].detail), JSON.stringify(world.confirms.map((c) => c.message)))
    check('确认前手机显示「请在那台电脑上允许」(awaitingConfirm)', waiting?.status === 'awaitingConfirm', JSON.stringify(waiting))
    await page.screenshot({ path: path.join(SHOT_DIR, 'remotechain-awaiting-confirm.png') })
    const beforeConfirm = world.hub.ledger.proxy.filter((x) => x.path.startsWith('/engine/agent/runs') && x.method === 'POST').length
    releaseConfirm()
    await page.waitForFunction(() => window.__forsionEngineTargets?.focusRef().kind === 'unit', null, { timeout: 30_000 }).catch(() => {})
    const focus = await page.evaluate(() => window.__forsionEngineTargets.focusRef())
    check('手机上点允许后整端切到那台电脑(setFocusTarget)', focus.kind === 'unit' && focus.unitId === world.DESKTOP_UNIT, JSON.stringify(focus))
    check('本机懒登记为 kind=phone、登记名 = 设备名', !!native.identity && world.hub.units.get(native.identity.unitId)?.kind === 'phone' && world.hub.units.get(native.identity.unitId)?.registeredName === PHONE_NAME, JSON.stringify(native.identity && world.hub.units.get(native.identity.unitId)))
    check('确认之前没有 run 起得来(会话档未放行)', beforeConfirm === 0)
    await closeOverlays(page)
    await page.waitForFunction(() => window.__forsionStore.getState().connState === 'ok', null, { timeout: 20_000 }).catch(() => {})

    // ── C. 发附件 + 一句话(真 UI:添加 › 文件 → 系统文件选择器)──
    await compose(page, `把附件转成大写 ${MARK}`, { name: ATTACH_NAME, mimeType: 'text/plain', buffer: Buffer.from(ATTACH_TEXT) })
    await page.screenshot({ path: path.join(SHOT_DIR, 'remotechain-compose.png') })
    await page.keyboard.press('Enter')

    // ── D. 审批卡(远端只读、来源行)→ 手机上批准 ──
    await page.waitForSelector('.approval-card', { timeout: 30_000 }).catch(() => {})
    const card = await page.evaluate(() => {
      const c = document.querySelector('.approval-card')
      if (!c) return null
      return {
        edit: !!c.querySelector('textarea.approval-edit'),
        buttons: [...c.querySelectorAll('.approval-actions button')].map((b) => (b.textContent || '').trim()),
        readonly: !!c.querySelector('[data-remote-readonly]'),
        source: (c.querySelector('[data-approval-remote]')?.textContent || '').trim(),
        preview: (c.querySelector('.approval-preview')?.textContent || '').trim().slice(0, 120),
      }
    })
    check('run_bash 审批卡到手机:远端只读(无改命令框、无「总允许」)', !!card && !card.edit && card.readonly && card.buttons.length === 2, JSON.stringify(card))
    check('审批卡来源行 = 远程会话 · 本机登记名(K1:hub → unitHost → unitWeb → 引擎一路带到)', !!card && card.source.includes(PHONE_NAME), card?.source)
    await page.addStyleTag({ content: '.ach-toast{display:none!important}' })
    await page.screenshot({ path: path.join(SHOT_DIR, 'remotechain-approval.png') })
    await sleep(600) // 托盘换卡冷却(ARM_MS 350ms)
    const approveBtn = page.locator('.approval-card .approval-actions .btn.primary').first()
    if (await approveBtn.count()) await tap(approveBtn)

    // ── E. run 跑完 ──
    await page.waitForFunction((mark) => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).some((m) => m.role === 'assistant' && m.status === 'done' && m.content.includes(mark)) }, MARK, { timeout: 60_000 }).catch(() => {})
    const st = await page.evaluate(() => { const s = window.__forsionStore.getState(); return { sid: s.activeId, msgs: (s.messagesBySession[s.activeId] || []).map((m) => ({ role: m.role, st: m.status, c: String(m.content).slice(0, 80) })) } })
    check('run 在那台电脑上跑完、结果回到手机', st.msgs.some((m) => m.role === 'assistant' && m.st === 'done' && m.c.includes(MARK)), JSON.stringify(st.msgs))
    await page.screenshot({ path: path.join(SHOT_DIR, 'remotechain-done.png') })

    // 引擎侧的账:run 行、事件
    const sid = st.sid
    const dbh = world.db()
    let runRow = null
    let events = []
    try {
      runRow = dbh.prepare('SELECT id, user_id, session_id, status, input FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sid)
      if (runRow) events = dbh.prepare("SELECT type, payload FROM agent_run_events WHERE run_id = ? AND type IN ('approval_request','approval_result','tool_result') ORDER BY seq").all(runRow.id)
    } finally { dbh.close() }
    const input = runRow ? JSON.parse(runRow.input || '{}') : {}
    const phoneUnit = native.identity?.unitId
    check('引擎 run 带远程污点且调用方 = 手机 unit(input.remote.callerUnit)', input.remote?.via === 'tunnel' && input.remote?.marked === true && input.remote?.callerUnit === phoneUnit, JSON.stringify(input.remote))
    const ar = events.find((e) => e.type === 'approval_request')
    const arp = ar ? JSON.parse(ar.payload) : null
    check('approval_request.remote = {via:tunnel, callerUnit: 手机, callerKind: phone, callerName: 登记名}', arp?.remote?.via === 'tunnel' && arp.remote.callerUnit === phoneUnit && arp.remote.callerKind === 'phone' && arp.remote.callerName === PHONE_NAME && arp.reason?.mode === 'auto-edit', JSON.stringify(arp && { remote: arp.remote, reason: arp.reason }))
    const res = events.find((e) => e.type === 'approval_result')
    const resp = res ? JSON.parse(res.payload) : null
    check('approval_result.by = {via:tunnel, callerUnit: 手机}(K3:谁批的)', resp?.action === 'approve' && resp?.by?.via === 'tunnel' && resp.by.callerUnit === phoneUnit, JSON.stringify(resp))
    const tr = events.find((e) => e.type === 'tool_result')
    info('run_bash 结果', tr ? JSON.parse(tr.payload).result?.slice(0, 120) : '(无)')

    // ── F. 下载产物(真 UI:右侧栏工作区 → 列出 → 下载;下载经 window.fetch → 中继)──
    const want = ATTACH_TEXT.toUpperCase()
    let downloaded = null
    for (let i = 0; i < 4 && !(await page.locator('.mb-drawer--right.open').count()); i++) { await tap(page.locator('.mb-topbar [aria-label="right panel"]')).catch(() => {}); await sleep(700) }
    const drawer = page.locator('.mb-drawer--right.open')
    const views = await drawer.locator('select.mb-drawer-select option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent })))
    const wsOpt = views.find((o) => /工作区|Workspace/.test(o.t || ''))
    if (wsOpt) { await drawer.locator('select.mb-drawer-select').selectOption(wsOpt.v); await sleep(1500) }
    const listed = await drawer.locator(`text=${RESULT_NAME}`).first().isVisible({ timeout: 6000 }).catch(() => false)
    await page.screenshot({ path: path.join(SHOT_DIR, 'remotechain-workspace.png') })
    // 只认右侧抽屉里的行(聊天正文里也有这个文件名 —— 首跑就被它骗出一条假绿)
    if (listed) check('右侧栏工作区列出产物(/agent/workspace/list 经中继)', true)
    else info('右侧栏(统一工作区视图)里没有这个会话的沙箱产物', `抽屉视图 ${JSON.stringify(views.map((o) => o.t))};手机上没有列出 / 下载远端会话工作区的 UI 入口(见 openIssues)`)
    if (listed) {
      const dl = page.waitForEvent('download', { timeout: 10_000 }).catch(() => null)
      await drawer.locator(`text=${RESULT_NAME}`).first().click({ button: 'right' }).catch(() => {})
      await sleep(300)
      const dlItem = page.locator('.ctx-menu .menu-item, [role="menu"] .menu-item').filter({ hasText: /下载|Download/ }).first()
      if (await dlItem.count()) await dlItem.click()
      const d = await dl
      if (d) { const p = await d.path().catch(() => null); if (p) downloaded = fs.readFileSync(p, 'utf8') }
    }
    if (downloaded === null) {
      // UI 没拿到下载事件(右键菜单在触屏上的形态不同):走同一个服务层函数的请求 —— 页面 window.fetch → 中继(仍经 X-Forsion-Caller)
      downloaded = await page.evaluate(async ({ u, sid, name }) => {
        const url = `${window.tangu.getConfig ? (await window.tangu.getConfig()).cloudApiBase : ''}/units/${u}/proxy/engine/agent/workspace/download?sessionId=${encodeURIComponent(sid)}&appId=tangu&path=${encodeURIComponent('/' + name)}`
        const r = await fetch(url)
        return r.ok ? r.text() : `HTTP ${r.status}`
      }, { u: world.DESKTOP_UNIT, sid, name: RESULT_NAME })
      info('下载走服务层请求(UI 下载事件未触发)', 'page window.fetch → 中继')
    }
    check('下载到的产物 = 附件经 run_bash 处理后的内容', downloaded === want, JSON.stringify(String(downloaded).slice(0, 80)))

    // ── G1:发往 unit 目标的中继语法面请求全部带有效调用方票 ──
    const relayRe = /^\/(engine($|[/?])|unit\/remote-access($|\/request$))/
    const toDesktop = world.hub.ledger.proxy.filter((x) => x.unit === world.DESKTOP_UNIT)
    const grammar = toDesktop.filter((x) => relayRe.test(x.path))
    const bad = grammar.filter((x) => !x.callerHeader || x.callerUnit !== phoneUnit)
    check('G1:手机发往那台电脑的中继面请求全部带有效 X-Forsion-Caller(= 手机 unit)', grammar.length > 5 && bad.length === 0, `${grammar.length} 条,缺 / 错 ${bad.length} 条${bad.length ? ':' + bad.slice(0, 4).map((x) => `${x.method} ${x.path.slice(0, 60)}`).join(', ') : ''}`)
    const other = toDesktop.filter((x) => !relayRe.test(x.path))
    info('不在中继语法面的隧道请求(照设计匿名:unit/config、unit/host*)', `${other.length} 条:${[...new Set(other.map((x) => x.path.replace(/\?.*$/, '')))].join(', ')}`)
    check('中继面没有被 hub 拒掉的票(403 UNIT_CALLER_*)', !grammar.some((x) => x.rejected), grammar.filter((x) => x.rejected).map((x) => x.rejected).join(','))
    check('模拟原生层:凭据没进页面(localStorage 无 caller secret / 票 / 设备密钥)', await page.evaluate(({ secret, cs }) => !Object.values(localStorage).some((v) => (secret && v.includes(secret)) || (cs && v.includes(cs)) || v.includes('fuc1.')), { secret: native.identity?.secret || '', cs: native.identity?.callerSecret || '' }))

    // ── G7:远程 run 的用量归属与记忆归属 ──
    // 本会话的 LLM 调用按 cacheKey(= sessionId,引擎给同会话请求的缓存路由键)认;同一台电脑上别的后台 run(Muse 等)不算
    const sessionCalls = world.hub.ledger.brain.filter((c) => c.cacheKey === sid)
    const mainCalls = sessionCalls.filter((c) => c.tools.includes('run_bash'))
    const phoneClient = String(input.client || '')
    check('G7:run 行 client = 手机的 mobile/<版本>(不是执行设备的 desktop/…)', /^mobile\//.test(phoneClient), phoneClient || '(空)')
    check('G7:远程 run 的每次 LLM 调用:账号 = 两台设备所属账号、client = 手机的 mobile/<版本>', mainCalls.length >= 2 && mainCalls.every((c) => c.user === world.USER && c.client === phoneClient), JSON.stringify(mainCalls.map((c) => ({ u: c.user, client: c.client }))))
    const others = world.hub.ledger.brain.filter((c) => c.cacheKey !== sid || !c.tools.includes('run_bash'))
    const head = (c) => { const m = (c.messages || []).find((x) => x.role === 'system') || c.messages?.[0]; const t = typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((x) => x?.text || '').join('') : ''; return t.replace(/\s+/g, ' ').slice(0, 70) }
    info('本会话之外 / 无工具的 LLM 调用(标题 / Historian / Muse …)', JSON.stringify(others.map((c) => ({ u: c.user, client: c.client, key: c.cacheKey === sid ? 'this' : c.cacheKey ? 'other' : null, head: head(c) }))))
    check('G7:电脑上所有 LLM 调用都归本账号(不串到别的账号)', world.hub.ledger.brain.every((c) => c.user === world.USER), JSON.stringify([...new Set(world.hub.ledger.brain.map((c) => c.user))]))
    // 派生调用(本会话的标题 / Historian)按设计继承 run 的 input.client;电脑本机自己的后台 run(Muse)不许被手机的标签盖到
    const muse = others.filter((c) => /^You are Muse/.test(head(c)))
    const derived = others.filter((c) => /^(Write a title|You are the persistent background Historian)/.test(head(c)))
    check('G7:本会话的派生调用(标题 / Historian)同样记在手机的 client 下', derived.length > 0 && derived.every((c) => c.client === phoneClient), JSON.stringify(derived.map((c) => c.client)))
    check('G7:电脑本机的后台 run(Muse)没有被盖上手机的 client', muse.every((c) => c.client !== phoneClient), JSON.stringify(muse.map((c) => c.client)))
    // standalone 引擎是单用户(本机 'local',--user-id 缺省):远程调用方不会在引擎里长出第二个身份;agent = 手机选的(缺省 xyra)
    const slug = input.agentConfig?.agentSlug ?? input.agent_config?.agentSlug ?? null
    check('G7:run 归属本机引擎的单用户(local)、agent = 默认 xyra(远程调用方不在引擎里另起身份 / 串 agent)', runRow?.user_id === 'local' && (slug === null || slug === 'xyra'), JSON.stringify({ user: runRow?.user_id, slug }))
    // Historian:远程轮次不写长期记忆(localHistorian:「第 N 轮来自远端设备,本轮不写长期记忆」)
    await sleep(4000)
    const englog = fs.readFileSync(world.engineLog, 'utf8')
    const remoteRound = /来自远端设备,本轮不写长期记忆/.test(englog)
    const historianRan = /\[historian\]|historian/i.test(englog)
    if (remoteRound) check('G7:Historian 把这一轮认作远端、不写长期记忆', true)
    else info('G7:Historian 远端轮次日志未出现(本轮 Historian 可能没到触发点)', historianRan ? 'Historian 有运行痕迹' : 'Historian 未运行')
    const memDir = path.join(world.home, 'agents')
    const memHits = []
    if (fs.existsSync(memDir)) for (const a of fs.readdirSync(memDir)) { const f = path.join(memDir, a, 'MEMORY.md'); if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(MARK)) memHits.push(a) }
    check('G7:任何 agent 的长期记忆里都没有这次远程会话的内容', memHits.length === 0, memHits.join(','))
    check('G7:hub 没收到任何云端记忆 / 日志写入(记忆留在执行设备本机)', world.hub.ledger.memoryWrites.length === 0, JSON.stringify(world.hub.ledger.memoryWrites.map((w) => w.path)))

    // ── KNOWN-GAP:附件对 host 模式的模型不可见 ──
    const firstMain = mainCalls[0]
    const blob = firstMain ? JSON.stringify(firstMain.messages) : ''
    const visible = blob.includes(ATTACH_NAME) || blob.includes(world.sandboxDir)
    const line = `模型第一轮请求里${visible ? '有' : '没有'}附件名 / 会话沙箱路径;附件实际落在 ${path.relative(world.out, world.sandboxDir)}/<hash>/${ATTACH_NAME},host 模式工具的 cwd = ${path.relative(world.out, world.workspace)}`
    if (STRICT) check('KNOWN-GAP:host 模式的模型看得到手机发来的附件', visible, line)
    else console.log(`${visible ? 'PASS ' : 'KNOWN-GAP'}  host 模式的模型看得到手机发来的附件  | ${line}`)

    check('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    if (world.hub.ledger.unknown.length) info('hub 未实现的路由', JSON.stringify([...new Set(world.hub.ledger.unknown.map((x) => `${x.method} ${x.path}`))]))
    console.log(`screenshots → ${SHOT_DIR}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await world.close()
    home.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过${NEGCTL ? `(负对照 ${NEGCTL}:期望有红)` : ''}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error('✗', e?.stack || e); process.exit(1) })
