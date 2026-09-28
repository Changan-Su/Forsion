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
 *     → 真 standalone 引擎(tangu-agent/dist,隔离 home、会话沙箱目录;审批、工作区上传 / 下载、run_bash、Historian、remember 都是真的)。
 *   **唯一模拟的一层**:安卓原生插件(Kotlin 的 Keystore 身份 + HttpURLConnection 中继)。浏览器里跑不了它;这里用 Node 按同一契约
 *   代发(登记 kind=phone → caller-secret → 换票 → 头从零重建注 X-Forsion-Caller),凭据只在 Node 进程。原生那半(含「凭据不进页面 JS」)
 *   的证据归 mobile/scripts/unit-relay-emu.cjs(模拟器台架);这里的替身从不把凭据交给页面,所以本台架**证不了**那一条(只打 INFO)。
 *   Capacitor 的 JS↔原生桥由 window.CapacitorCustomPlatform + PluginHeaders + nativePromise / nativeCallback 接上(@capacitor/core 自带的
 *   自定义平台钩子),mobileShim 走的就是 native 分支。
 *   **没测的一段(G12)**:hub 这一跳是 Node 直连,前面没有 nginx。生产 server 的 nginx 已关请求缓冲;Genesis web 容器的 nginx 模板缺
 *   `proxy_request_buffering off`(方案 §九-10),设备 / 手机若经它打隧道,流式上行会被整包缓冲 —— 那条路径本台架不覆盖。
 *
 * 流程(真 UI 路径):左抽屉 → 互联入口 → UnitsSheet「在哪运行」点那台电脑(懒登记本机 → /unit/remote-access 未确认 → 发起确认 →
 *   执行设备 K4 首次确认框(台架先不答:截图 + 趁机经中继打一次 POST /engine/agent/runs,须 403)→ 允许 → 探引擎 → 整端切过去)
 *   → 关掉再开两次 UnitsSheet(名册里有这台手机 / 老 server 名册不带 kind)→ 输入区「添加 › 文件」发附件 + 一句话 → 引擎(假模型)要 run_bash
 *   → 审批卡(远端只读、来源行 = 本机登记名)→ 手机上点批准 → run 跑完 → 第二轮:模型先 remember(远端须硬拒)再 run_bash,电脑本机批
 *   → 手机聊天流结局行写明「在执行的电脑上(电脑名)」(M1B)→ 右侧栏「工作区」›「本会话的文件」(远端会话沙箱)点产物的下载键(M1B)
 *   → 本机正对照会话(同一套假模型,本机起 run)。
 *
 * 断言(节选):
 *   G1  手机页发往 unit 目标的**中继语法面**请求(/proxy/engine*、/proxy/unit/remote-access*)在假 hub 上**全部**带有效 X-Forsion-Caller
 *       且解析成本机登记的 phone unit;不在语法面的(/proxy/unit/config、/proxy/unit/host*)照设计匿名,单列不混算。
 *   K1  信封带 proxyCaller → 引擎 run 的 input.remote.callerUnit = 手机 unit、审批事件 remote.callerName = 登记名;
 *   K3  approval_result.by = {via:'tunnel', callerUnit: 手机};
 *   K4  确认前经中继起 run → 403 REMOTE_CALLER_UNCONFIRMED{state:pending};允许后同一请求穿过闸到引擎(引擎自己的 400,无副作用);
 *   R-25 手机登记后名册里被改名(name / alias = 「Renamed phone」):确认框、审批卡来源行、callerName 仍是登记名「K9 Pixel」;
 *   G7  远程 run 的每次 LLM 调用:账号 = 两台设备所属账号、client = 手机的 mobile/<版本>,且 server 的 clientTagOf / usageClientTagOf
 *       收这个值(否则生产 api_usage_logs「端」列落 NULL);Historian 把远程轮次认作远端(日志缺席 = 红),假判官**照样交出**含本次标记的
 *       记忆候选、远程 run 的 remember 须被硬拒,agents/** 下任何文件都不许出现远程会话的标记;**正对照**:本机会话同一套剧本 → remember
 *       落 MEMORY.md、判官候选落 .memory-raw.md(证明探针看得见写入);run 行归属本机引擎用户、agent = 默认 agent。
 *   K3  执行设备的 approvalDelivery(真模块)收到远程待批 → 系统通知(不含命令)→ 60s(快进)没人批投收件箱提醒(只带 sessionId/count/kinds)
 *       → 手机批完撤条目、关通知;反方向:电脑本机批 → approval_result.by = {via:local},手机聊天流的结局行写「在执行的电脑上(K9 Studio Mac)」、
 *       手机自己批的那行不写(M1B)。
 *   K8  等电脑确认的这段时间,UnitsSheet「本机」一行已写登记名(ensureSelf 之后即刷新,M1B)。
 *   M1B 手机右侧栏「工作区」列出远端会话沙箱的文件(附件 + 产物),点行尾下载键 → 下载内容 = 产物;列表 / 下载都经中继带手机的票。
 *   K8  本机登记后重开「在哪运行」:名册里确有这台手机(kind=phone)也不列出;老 server 名册不带 kind(按电脑算)时仍不列出(本机 id 过滤)。
 *   KNOWN-GAP(缺省只报告,REMOTECHAIN_STRICT=1 时判红):① 手机附件落在引擎会话沙箱目录,host 模式的模型请求里找不到它的路径。
 *       (原 ② 「电脑本机批了之后手机上看不到谁批的」已由 M1B 补上,改为 check。)
 *
 * 退出码:0 = 全绿且没有 KNOWN-GAP;1 = 有 FAIL;**2 = 断言全绿但还有 KNOWN-GAP —— M1 退出标准未达成**(汇总行写明)。
 *   别把「N/N 通过」当 M1 端到端证据:退出码 2 就是「管道通、但真模型打不开附件 / 手机看不到谁批的」。
 *
 * 负对照(NEGCTL=…,须红):
 *   relay     模拟层照发但不带 X-Forsion-Caller(中继漏拦 / 头路径断)→ G1 那条红,且执行设备按「账号级未识别调用方」弹框;
 *   envelope  hub 信封不写 proxyCaller(hub → 设备那一跳断)→ callerUnit / 来源行那几条红;
 *   r25       hub 不留登记名快照(名册 registeredName 与信封 name 都取改过的名字)→ 确认框 / 来源行 / callerName 三条红。
 *   G7 记忆那几条的负对照要改引擎(historianRoundRemote 恒 false + remember 移出远程只读名单)再 npm run build,见 K9 交付记录。
 *
 * 前置:cd tangu-agent && npm run build(引擎 dist)。mobile 构建按源码戳缓存(scripts/lib/phone-page.cjs:GENESIS 路径 + HEAD + 相关路径的
 *   diff / 未跟踪文件;缺省目录按 worktree 分开),源码一变就现构建(约 1–2 分钟);REMOTECHAIN_DIST=<目录> 换缓存位置(照样比戳),
 *   REMOTECHAIN_REUSE_DIST=1 不比戳硬复用(打 WARN)。戳的自测:node scripts/lib/phone-dist-stamp.selftest.cjs。
 *   截图落 SHOT_DIR(缺省临时目录),文件名带 <zh|en>-<light|dark>;手机页语言 / 明暗:REMOTECHAIN_LOCALE=en-US、REMOTECHAIN_SCHEME=dark。
 *   世界的产物目录判红时留下,否则删掉(REMOTECHAIN_KEEP=1 一律留)。
 * 端口:全部 listen(0);浏览器以 HTTP 代理方式把 http://phone-hub.test 指到假 hub,不占固定端口,不碰别的会话的 vite。
 */
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { startRemoteWorld, GENESIS } = require('./lib/remote-world.cjs')
const { PHONE_ORIGIN, buildPhoneDist, openPhonePage, openUnitsSheet, closeUnitsSheet, pickComputer, closeOverlays, compose } = require('./lib/phone-page.cjs')
const { createFakePhoneNative } = require('./lib/fake-phone-native.cjs')
const { callerTokenParity } = require('./lib/fake-unit-hub.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const NEGCTL = process.env.NEGCTL || ''
const STRICT = process.env.REMOTECHAIN_STRICT === '1'
// 手机页的界面语言 / 明暗(截图用;执行设备主进程恒 zh)。缺省 zh-CN / light
const LOCALE = process.env.REMOTECHAIN_LOCALE || 'zh-CN'
const SCHEME = process.env.REMOTECHAIN_SCHEME === 'dark' ? 'dark' : 'light'
const SHOT_TAG = `${LOCALE.startsWith('zh') ? 'zh' : 'en'}-${SCHEME}`
const SHOT_DIR = process.env.SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-remotechain-shots-'))
// server 仓:显式 FORSION_SERVER_DIR;否则 worktree 布局(.worktrees/<genesis-wt> 旁的 p0-server-roster)或单仓布局(Forsion/server)
const SERVER_DIR = process.env.FORSION_SERVER_DIR || [path.resolve(GENESIS, '../p0-server-roster'), path.resolve(GENESIS, '../server')]
  .find((d) => fs.existsSync(path.join(d, 'microserver/unit-hub/services/callerToken.ts'))) || ''
const hex = () => crypto.randomBytes(3).toString('hex').toUpperCase()
const MARK = `K9-${hex()}` // 第一轮(手机批)
const MARK2 = `K9B-${hex()}` // 第二轮:远端 remember + 电脑本机批(反方向)
const LMARK = `K9L-${hex()}` // 本机正对照会话
const ATTACH_NAME = `k9-attach-${MARK.toLowerCase()}.txt`
const ATTACH_TEXT = `hello from the phone ${MARK}\nsecond line\n`
const RESULT_NAME = 'k9-result.txt'
const PHONE_NAME = 'K9 Pixel'
const DESKTOP_NAME = 'K9 Studio Mac' // = remote-world 缺省的执行设备名(名册 name;手机「在哪运行」据此设焦点展示名)
const RENAMED = 'Renamed phone' // R-25:登记之后用户在名册里给手机改的名字
const HOST_CLIENT = 'desktop/9.9.9-k9' // = remote-world 给引擎的 TANGU_HOST_CLIENT

const results = []
const gaps = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`) }
const info = (name, detail) => console.log(`INFO  ${name}${detail ? `  | ${detail}` : ''}`)
const gap = (name, ok, detail) => {
  if (ok || STRICT) return check(name, ok, detail)
  gaps.push(name)
  console.log(`KNOWN-GAP  ${name}  | ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text || '').join('') : '')
async function until(fn, ms, step = 200) { const t0 = Date.now(); let v; while (!(v = await fn()) && Date.now() - t0 < ms) await sleep(step); return v }

/** server 的 clientTag 判定(api_usage_logs.client 落库前的闸)—— 打包 server 仓的 src/utils/clientTag.ts;缺席 → null。 */
function serverClientTag(serverDir) {
  const file = serverDir && path.join(serverDir, 'src/utils/clientTag.ts')
  if (!file || !fs.existsSync(file)) return null
  const { buildSync } = require('esbuild')
  const src = buildSync({ entryPoints: [file], bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs' }).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', src)(mod, mod.exports, require)
  return mod.exports
}

// ── 可编剧假模型 ──
// 主 run(工具里有 run_bash):
//   MARK 轮:run_bash 处理附件 → (托盘挂起)先收尾 → 批完回灌 <approval_update> → 收尾;
//   MARK2 轮:先 remember(远端须硬拒)→ run_bash(电脑本机批)→ 收尾;
//   LMARK(本机正对照):remember → 收尾。
// Historian 判官(独立模式;fork 模式的尾部分叉判官同样处理):对话里有哪个标记就交出含它的记忆候选 —— 不管提示词要没要候选,
//   「远程轮不写长期记忆」是代码闸(localHistorian 的 judgeMemory),不是提示词;假判官照样交,才测得到闸。其余后台调用回一句 ok。
function makeLlm(world) {
  const usage = { prompt_tokens: 100, completion_tokens: 10 }
  const say = (s) => [{ t: 'token', d: s }, { t: 'done', content: s, toolCalls: [], usage }]
  const tool = (id, name, argsObj, lead = '我来处理。') => {
    const args = JSON.stringify(argsObj)
    return [{ t: 'token', d: lead }, { t: 'tool', id, name, args, argsLen: args.length }, { t: 'done', content: lead, toolCalls: [{ id, type: 'function', function: { name, arguments: args } }], usage }]
  }
  const judge = (mark) => say(JSON.stringify({ title: 't', summary: '', log: 'l', memory_candidates: [`User code is ${mark}`], harness_candidates: [] }))
  const markIn = (s) => [MARK2, LMARK, MARK].find((m) => s.includes(m)) || null // MARK2 / LMARK 先判(前缀互不包含,顺序只为读着清楚)
  return (call) => {
    const msgs = call.messages || []
    const sys = text(msgs.find((m) => m.role === 'system')?.content)
    const lastUserText = text([...msgs].reverse().find((m) => m.role === 'user')?.content)
    if (/^You are the persistent background Historian/.test(sys) && lastUserText.includes('[Task: judge]')) {
      const mark = [MARK, LMARK].find((m) => lastUserText.includes(m))
      return mark ? judge(mark) : say('{"title":"","log":""}')
    }
    if (/^## Historian fork/.test(lastUserText)) {
      const all = JSON.stringify(msgs)
      const mark = [MARK, LMARK].find((m) => all.includes(m))
      return mark ? judge(mark) : say('{"title":"","log":""}')
    }
    // Muse(执行设备本机的后台 agent)的周期:安静收尾。它的提示词里可能带着远程会话的内容(见 G7 的 INFO),但剧本不替它编动作
    if (/^You are Muse/.test(sys)) return say('ok')
    const last = msgs[msgs.length - 1] || {}
    // 这一轮是哪句话起的(<approval_update> 是引擎回灌的用户消息,不算)
    let ui = -1
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !text(msgs[i].content).includes('<approval_update>')) { ui = i; break }
    const asked = ui >= 0 ? text(msgs[ui].content) : ''
    const mark = markIn(asked)
    const since = JSON.stringify(msgs.slice(ui + 1)) // 本轮用户消息之后的一切(含 assistant.tool_calls 的 id)
    // 本机正对照(本机 run 缺省是 chat 面,没有 run_bash;remember 在常驻面里):remember → 收尾
    if (mark === LMARK && call.tools.length) {
      if (!since.includes('call_k9_lremember') && call.tools.includes('remember')) return tool('call_k9_lremember', 'remember', { action: 'add', fact: `User code is ${LMARK}` }, '记下了。')
      return say(`已记住(${LMARK})。`)
    }
    if (!call.tools.includes('run_bash')) return say('ok')
    // 审批托盘(approval_tray):要批的调用先挂起,工具结果是「⏸ 等批准」—— 模型先收尾;批完引擎以 <approval_update> 回灌真结果再续一轮
    if (last.role === 'tool' && /^\s*⏸/.test(text(last.content))) return say('命令在等你批准。')
    if (mark === MARK2 && !since.includes('call_k9_remember') && call.tools.includes('remember')) {
      return tool('call_k9_remember', 'remember', { action: 'add', fact: `User code is ${MARK2}` }, '先记一下。')
    }
    const bashId = mark === MARK ? 'call_k9_bash' : 'call_k9_bash2'
    if (mark && !since.includes(bashId)) {
      // 第一轮:把附件转成大写写到它旁边。附件在引擎会话沙箱目录里 —— host 模式的模型本不知道这个路径(见 KNOWN-GAP),
      // 这里由台架扮的模型直接知道(= 台架只证管道,不证模型能找到附件)。第二轮:随便一条要批的复合命令。
      const cmd = mark === MARK
        ? `f="$(find '${world.sandboxDir}' -type f -name '${ATTACH_NAME}' | head -1)" && tr 'a-z' 'A-Z' < "$f" > "$(dirname "$f")/${RESULT_NAME}" && wc -c < "$(dirname "$f")/${RESULT_NAME}"`
        : `ls '${world.sandboxDir}' && echo ${MARK2}`
      return tool(bashId, 'run_bash', { command: cmd })
    }
    if (mark) return say(mark === MARK ? `已处理附件,产物 ${RESULT_NAME}(${MARK})。` : `已核对产物(${MARK2})。`)
    return say('ok')
  }
}

/** agents/** 下内容含 needle 的文件(相对 agents/ 的路径)。 */
function filesContaining(root, needle) {
  const hits = []
  const walk = (d) => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) { try { if (fs.readFileSync(p, 'utf8').includes(needle)) hits.push(path.relative(root, p)) } catch { /* 读不了就不算 */ } }
    }
  }
  walk(root)
  return hits
}

async function main() {
  console.log(`K9 remote chain  MARK=${MARK} MARK2=${MARK2} LMARK=${LMARK}${NEGCTL ? `  NEGCTL=${NEGCTL}` : ''}`)
  // 0 caller token 与 server 同格式同派生(对真模块交叉验证)
  const parity = callerTokenParity(SERVER_DIR)
  if (parity.skipped) info('caller token 与 server 同格式同派生(SKIP)', parity.skipped)
  else check('caller token 与 server 同格式同派生(对 server callerToken.ts 交叉验证)', parity.ok, parity.detail)

  const dist = buildPhoneDist(process.env.REMOTECHAIN_DIST || undefined)
  const nativeCfg = JSON.parse(fs.readFileSync(path.join(dist, 'forsion-native.json'), 'utf8'))
  const home = await startStubEngine({ sessions: [], models: [{ id: 'cloud-model', name: 'Cloud Model', provider: 'forsion', contextWindow: 128000 }], agents: [{ slug: 'xyra', name: 'Tangu' }] })
  let confirmGate = null
  const world = await startRemoteWorld({
    staticDir: dist,
    homeEngineUrl: home.url,
    llm: (call) => makeLlm(world)(call),
    hubNegctl: { omitProxyCaller: NEGCTL === 'envelope', noRegisteredSnapshot: NEGCTL === 'r25' },
    // R-25:手机刚登记完,用户就在名册里给它改了名(server:name / alias 可改,registered_name 是登记时的快照)
    hubOnRegister: (row) => { if (row.kind === 'phone') { row.name = RENAMED; row.alias = RENAMED } },
    confirm: async () => { if (confirmGate) await confirmGate; return true },
    approvalDelivery: true, // K3 真 approvalDelivery:远程待批的系统通知 + 60s 收件箱提醒(快进)
    mainLocale: 'zh',
    log: process.env.REMOTECHAIN_DEBUG ? (m) => console.log(`  ${m}`) : undefined,
  })
  console.log(`  产物目录 ${world.out}`)
  // 原生替身用的 apiBase = 构建期烤进 forsion-native.json 的那份(页面启动时逐字比);传输层把 phone-hub.test 映射到假 hub 的真实端口
  const native = createFakePhoneNative({
    apiBase: nativeCfg.apiBase, token: () => world.PHONE_TOKEN, deviceName: PHONE_NAME, negctl: { dropCallerHeader: NEGCTL === 'relay' },
    fetch: (u, init) => fetch(String(u).startsWith(PHONE_ORIGIN) ? world.hub.url + String(u).slice(PHONE_ORIGIN.length) : u, init),
  })
  // 页面里经中继打一次 unit 目标(页面 window.fetch → mobileShim 中继 → 原生替身注票 → hub);回 {status, json}
  const relayed = (page, sub, init) => page.evaluate(async ({ url, init: i }) => {
    const r = await fetch(url, i)
    let json = null
    try { json = await r.json() } catch { /* 空体 */ }
    return { status: r.status, json }
  }, { url: `${PHONE_ORIGIN}/api/units/${world.DESKTOP_UNIT}/proxy${sub}`, init })
  const tryStartRun = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_config: [] }) } // 过了闸也只换来引擎的 400,不起 run

  let browser = null
  try {
    const opened = await openPhonePage({ world, native, locale: LOCALE, colorScheme: SCHEME })
    browser = opened.browser
    const { page, tap, pageErrors } = opened
    const boot = await page.evaluate(() => ({ native: window.Capacitor?.isNativePlatform?.() }))
    check('手机页走安卓 App 分支(Capacitor 自定义平台 isNativePlatform)', boot.native === true, JSON.stringify(boot))
    const self0 = await page.evaluate(() => window.tangu?.unitSelf?.())
    check('中继启动断言成立(原生 apiBase === 页面 cloudApiBase → relay ready)', self0?.relay === 'ready', JSON.stringify(self0))

    // ── B. UnitsSheet「在哪运行」→ 点那台电脑(执行设备的首次确认框先不答)──
    let releaseConfirm
    confirmGate = new Promise((r) => { releaseConfirm = r })
    await pickComputer({ page, tap, unitId: world.DESKTOP_UNIT })
    // 执行设备弹首次确认框(台架先不答):手机应显示「请在「K9 Studio Mac」上允许这台手机」
    await until(() => world.confirms.length > 0, 10_000, 250)
    await page.waitForSelector(`[data-run-row="${world.DESKTOP_UNIT}"][data-status="awaitingConfirm"]`, { timeout: 8000 }).catch(() => {})
    const waiting = await page.evaluate((u) => { const r = document.querySelector(`[data-run-row="${u}"]`); return r ? { status: r.getAttribute('data-status'), sub: r.querySelector('.us-row-sub')?.textContent || '' } : null }, world.DESKTOP_UNIT)
    const phoneUnit = native.identity?.unitId
    const phoneRow = phoneUnit ? world.hub.units.get(phoneUnit) : null
    check('本机懒登记为 kind=phone、登记名 = 设备名(随后在名册里被改名为「Renamed phone」)', phoneRow?.kind === 'phone' && phoneRow.registeredName === PHONE_NAME && phoneRow.name === RENAMED, JSON.stringify(phoneRow && { kind: phoneRow.kind, registeredName: phoneRow.registeredName, name: phoneRow.name }))
    const c0 = world.confirms[0]
    check('K4 首次确认 + R-25:执行设备弹框,名字取名册登记名「K9 Pixel」而不是改过的名字', world.confirms.length === 1 && c0.message.includes(PHONE_NAME) && !`${c0.message}${c0.detail}`.includes(RENAMED) && /Phone|手机/.test(c0.detail), JSON.stringify(world.confirms.map((c) => c.message)))
    check('确认前手机显示「请在那台电脑上允许」(awaitingConfirm)', waiting?.status === 'awaitingConfirm', JSON.stringify(waiting))
    // K8(M1B):等电脑确认的这段时间,「本机」一行应已写登记名 —— ensureSelf 刚登记过;修前要等 runOn 整个结束(电脑上点了允许)才刷新
    const selfSel = '[data-units-sheet] [data-this-phone] .us-self-text'
    await page.waitForFunction(([sel, name]) => (document.querySelector(sel)?.textContent || '').includes(name), [selfSel, PHONE_NAME], { timeout: 5000 }).catch(() => {})
    const selfText = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, selfSel)
    check('K8:等电脑确认时「本机」一行已写登记名「K9 Pixel」(ensureSelf 之后即刷新,不再是「尚未登记」)', !!selfText && selfText.includes(PHONE_NAME) && !/尚未登记|Not registered/.test(selfText), selfText)
    await page.screenshot({ path: path.join(SHOT_DIR, `remotechain-awaiting-confirm-${SHOT_TAG}.png`) })
    // 确认框还开着:经中继起 run → 执行设备的会话闸须拒(403 REMOTE_CALLER_UNCONFIRMED,state pending);hub 那侧确认这条带着手机的票
    const ledgerAt = world.hub.ledger.proxy.length
    const pre = await relayed(page, '/engine/agent/runs', tryStartRun)
    const preHub = world.hub.ledger.proxy.slice(ledgerAt).find((x) => x.method === 'POST' && x.path.startsWith('/engine/agent/runs'))
    check('K4:确认前经中继起 run → 403 REMOTE_CALLER_UNCONFIRMED{state:pending}(hub 上这条带着手机的票)', pre.status === 403 && pre.json?.code === 'REMOTE_CALLER_UNCONFIRMED' && pre.json?.state === 'pending' && preHub?.callerUnit === phoneUnit, JSON.stringify({ pre, hubCaller: preHub?.callerUnit ?? null }))
    releaseConfirm()
    await page.waitForFunction(() => window.__forsionEngineTargets?.focusRef().kind === 'unit', null, { timeout: 30_000 }).catch(() => {})
    const focus = await page.evaluate(() => window.__forsionEngineTargets.focusRef())
    check('手机上点允许后整端切到那台电脑(setFocusTarget)', focus.kind === 'unit' && focus.unitId === world.DESKTOP_UNIT, JSON.stringify(focus))
    const post = await relayed(page, '/engine/agent/runs', tryStartRun)
    check('K4:允许之后同一请求穿过会话闸到了引擎(引擎自己的 400「agent_config must be an object」,不起 run)', post.status === 400 && /agent_config must be an object/.test(post.json?.detail || ''), JSON.stringify(post))

    // ── B2. K8 S10:本机已登记,重开「在哪运行」——名册里有这台手机也不列出 ──
    await closeUnitsSheet(page)
    const sheetRowsAfterReopen = async () => {
      const at = world.hub.ledger.unitLists.length
      await openUnitsSheet({ page, tap, waitRow: world.DESKTOP_UNIT })
      await sleep(400)
      const rows = await page.evaluate(() => [...document.querySelectorAll('[data-units-sheet] [data-run-row]')].map((r) => r.getAttribute('data-run-row')))
      const lists = world.hub.ledger.unitLists.slice(at)
      await closeUnitsSheet(page)
      return { rows, listed: lists.flatMap((l) => l.rows).filter((r) => r.id === phoneUnit) }
    }
    const s10a = await sheetRowsAfterReopen()
    check('K8 S10:重开「在哪运行」,名册里确有这台手机(kind=phone)也不列出', !!phoneUnit && s10a.listed.some((r) => r.kind === 'phone') && !s10a.rows.includes(phoneUnit) && s10a.rows.includes(world.DESKTOP_UNIT), JSON.stringify(s10a))
    world.hub.cfg.listOmitKindFor.add(phoneUnit)
    const s10b = await sheetRowsAfterReopen()
    world.hub.cfg.listOmitKindFor.delete(phoneUnit)
    check('K8 S10:老 server 名册不带 kind(按电脑算)时,仍按本机 id 滤掉这台手机', s10b.listed.some((r) => r.kind === null) && !s10b.rows.includes(phoneUnit) && s10b.rows.includes(world.DESKTOP_UNIT), JSON.stringify(s10b))
    await closeOverlays(page)
    await page.waitForFunction(() => window.__forsionStore.getState().connState === 'ok', null, { timeout: 20_000 }).catch(() => {})

    // ── C. 发附件 + 一句话(真 UI:添加 › 文件 → 系统文件选择器)──
    await compose(page, `把附件转成大写 ${MARK}`, { name: ATTACH_NAME, mimeType: 'text/plain', buffer: Buffer.from(ATTACH_TEXT) })
    await page.screenshot({ path: path.join(SHOT_DIR, `remotechain-compose-${SHOT_TAG}.png`) })
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
    check('审批卡来源行 = 远程会话 · 登记名「K9 Pixel」、不是改过的名字(K1 + R-25:hub → unitHost → unitWeb → 引擎一路带到)', !!card && card.source.includes(PHONE_NAME) && !card.source.includes(RENAMED), card?.source)
    await page.addStyleTag({ content: '.ach-toast,.ntf-wrap{display:none!important}' })
    await page.screenshot({ path: path.join(SHOT_DIR, `remotechain-approval-${SHOT_TAG}.png`) })
    // K3 执行设备侧:approvalDelivery 从引擎 /agent/approvals/stream 收到这条远程待批 → 系统通知(不含命令);60s(快进)没人批 → 投收件箱提醒
    const sid0 = await page.evaluate(() => window.__forsionStore.getState().activeId)
    await until(() => world.delivery.pending().some((x) => x.sessionId === sid0), 6000, 150)
    const pend = world.delivery.pending().find((x) => x.sessionId === sid0)
    check('K3:电脑的 approvalDelivery 收到这条远程待批(调用方 = 手机)', !!pend && pend.kind === 'approval' && pend.tool === 'run_bash' && pend.remote?.callerUnit === phoneUnit, JSON.stringify(pend && { tool: pend.tool, remote: pend.remote }))
    const note = world.notes.find((n) => n.title.includes(PHONE_NAME))
    check('K3:电脑弹系统通知「K9 Pixel 上的远程会话等你批准」,正文不含命令', !!note && !note.body.includes('find') && !note.body.includes('tr '), JSON.stringify(note && { title: note.title, body: note.body }))
    await until(() => world.hub.ledger.attention.length > 0, 9000, 150)
    const att = world.hub.ledger.attention[0]
    check('K3:没人批 → 投收件箱提醒:只带 {sessionId, count, kinds}(无标题 / 工具 / 命令),设备密钥双闸', !!att && JSON.stringify(Object.keys(att.body || {}).sort()) === '["count","kinds","sessionId"]' && att.body.sessionId === sid0 && att.body.count === 1 && JSON.stringify(att.body.kinds) === '["approval"]' && att.unit === world.DESKTOP_UNIT, att?.raw)
    await sleep(600) // 托盘换卡冷却(ARM_MS 350ms)
    const approveBtn = page.locator('.approval-card .approval-actions .btn.primary').first()
    if (await approveBtn.count()) await tap(approveBtn)

    // ── E. run 跑完 ──
    await page.waitForFunction((mark) => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).some((m) => m.role === 'assistant' && m.status === 'done' && m.content.includes(mark)) }, MARK, { timeout: 60_000 }).catch(() => {})
    const st = await page.evaluate(() => { const s = window.__forsionStore.getState(); return { sid: s.activeId, msgs: (s.messagesBySession[s.activeId] || []).map((m) => ({ role: m.role, st: m.status, c: String(m.content).slice(0, 80) })) } })
    check('K3:手机批完 → 电脑的待批条目撤掉、系统通知关掉', !world.delivery.pending().some((x) => x.sessionId === st.sid) && !!note?.closed, JSON.stringify({ left: world.delivery.pending().length, closed: note?.closed }))
    check('run 在那台电脑上跑完、结果回到手机', st.msgs.some((m) => m.role === 'assistant' && m.st === 'done' && m.c.includes(MARK)), JSON.stringify(st.msgs))
    await page.screenshot({ path: path.join(SHOT_DIR, `remotechain-done-${SHOT_TAG}.png`) })

    // 引擎侧的账:run 行、事件
    const sid = st.sid
    const runsOf = (s) => { const dbh = world.db(); try { return dbh.prepare('SELECT id, user_id, session_id, status, input FROM agent_runs WHERE session_id = ? ORDER BY created_at ASC').all(s) } finally { dbh.close() } }
    const eventsOf = (runId, types) => { const dbh = world.db(); try { return dbh.prepare(`SELECT type, payload FROM agent_run_events WHERE run_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY seq`).all(runId, ...types).map((e) => ({ type: e.type, p: JSON.parse(e.payload) })) } finally { dbh.close() } }
    const runRow = runsOf(sid).at(-1) || null
    const events = runRow ? eventsOf(runRow.id, ['approval_request', 'approval_result', 'tool_result']) : []
    const input = runRow ? JSON.parse(runRow.input || '{}') : {}
    check('引擎 run 带远程污点且调用方 = 手机 unit(input.remote.callerUnit)', input.remote?.via === 'tunnel' && input.remote?.marked === true && input.remote?.callerUnit === phoneUnit, JSON.stringify(input.remote))
    const arp = events.find((e) => e.type === 'approval_request')?.p || null
    check('approval_request.remote = {via:tunnel, callerUnit: 手机, callerKind: phone, callerName: 登记名「K9 Pixel」}', arp?.remote?.via === 'tunnel' && arp.remote.callerUnit === phoneUnit && arp.remote.callerKind === 'phone' && arp.remote.callerName === PHONE_NAME && arp.reason?.mode === 'auto-edit', JSON.stringify(arp && { remote: arp.remote, reason: arp.reason }))
    const resp = events.find((e) => e.type === 'approval_result')?.p || null
    check('approval_result.by = {via:tunnel, callerUnit: 手机}(K3:谁批的)', resp?.action === 'approve' && resp?.by?.via === 'tunnel' && resp.by.callerUnit === phoneUnit, JSON.stringify(resp))
    info('run_bash 结果', String(events.find((e) => e.type === 'tool_result')?.p?.result ?? '(无)').slice(0, 120))

    // ── E2. 第二轮(同一会话,远程污点):模型先 remember(远端须硬拒),再 run_bash;这次在执行设备本机批 → by = local ──
    await compose(page, `再核对一下产物 ${MARK2}`)
    await page.keyboard.press('Enter')
    const pend2 = await until(() => world.delivery.pending().find((x) => x.sessionId === st.sid) || null, 20_000, 200)
    await page.waitForFunction(() => document.querySelectorAll('.approval-card').length > 0 && [...document.querySelectorAll('.approval-card')].some((c) => !c.classList.contains('resolved')), null, { timeout: 20_000 }).catch(() => {})
    const localAns = pend2 ? await world.engineApi(`/agent/runs/${pend2.runId}/approvals/${pend2.id}`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) }) : null
    check('电脑本机批准(无远程头,本机令牌)被引擎接受', localAns?.status === 200, JSON.stringify(localAns))
    await page.waitForFunction((m) => { const s = window.__forsionStore.getState(); return (s.messagesBySession[s.activeId] || []).some((x) => x.role === 'assistant' && x.status === 'done' && x.content.includes(m)) }, MARK2, { timeout: 45_000 }).catch(() => {})
    await page.waitForSelector('.t2-apv-update [data-answered-by]', { timeout: 10_000 }).catch(() => {})
    // K3 规格:手机上写「在执行的电脑上」。托盘模式(approval_tray,各端恒开)下卡只在待批时挂在托盘里,答完即撤;聊天流里留下的是
    // <approval_update> 结局行(每张一行)—— 「谁批的」写在那一行上(渲染层按 approval_result.by 补,不进给模型看的回灌正文)。
    // 第一行是手机自己批的(本页就是答复方 → 不写),最后一行是电脑本机批的(→「在执行的电脑上(K9 Studio Mac)」)。
    const answered = await page.evaluate(() => ({
      cards: [...document.querySelectorAll('.approval-card.resolved [data-answered-by]')].map((e) => (e.textContent || '').trim()),
      // 「在哪批的」是紧跟在那一行后面的说明行([data-answered-by]);没有 = 本页自己答的 / 本机会话
      rows: [...document.querySelectorAll('.t2-apv-update-row')].map((r) => { const n = r.nextElementSibling; return { by: n?.matches('[data-answered-by]') ? (n.textContent || '').trim() : '', text: (r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90) } }),
    }))
    const hostRow = answered.rows.at(-1)
    check('K3 反方向:手机聊天流结局行写明「在执行的电脑上(K9 Studio Mac)」批的', !!hostRow && /在执行的电脑上|on the host computer/.test(hostRow.by) && hostRow.by.includes(DESKTOP_NAME),
      `结局行 ${JSON.stringify(answered.rows)};resolved 卡 ${JSON.stringify(answered.cards)}`)
    check('K3:手机自己批的那一行不写「在哪答的」(本页就是答复方)', answered.rows.length >= 2 && answered.rows[0].by === '', JSON.stringify(answered.rows.map((r) => r.by)))
    const upd = page.locator('.t2-apv-update').last()
    if (await upd.count()) { await upd.scrollIntoViewIfNeeded().catch(() => {}); await page.screenshot({ path: path.join(SHOT_DIR, `remotechain-answered-on-host-${SHOT_TAG}.png`) }) }
    const run2 = runsOf(st.sid).at(-1) || null
    const ev2 = run2 ? eventsOf(run2.id, ['approval_result', 'tool_result']) : []
    const byLocal = ev2.filter((e) => e.type === 'approval_result').at(-1)?.p?.by ?? null
    check('K3 反方向:approval_result.by = {via:local}', byLocal?.via === 'local' && !byLocal.callerUnit, JSON.stringify(byLocal))
    const rememberOffered = world.hub.ledger.brain.some((c) => c.cacheKey === sid && c.tools.includes('remember'))
    info('远程 run 主调用的工具面', JSON.stringify(world.hub.ledger.brain.find((c) => c.cacheKey === sid && c.tools.includes('run_bash'))?.tools || []))
    const remRes = ev2.find((e) => e.type === 'tool_result' && e.p.name === 'remember')?.p || null
    if (rememberOffered) check('G7:远程 run 调 remember → 硬拒(Remote sessions cannot … long-term memory)', !!remRes && remRes.isError === true && /Remote sessions cannot/.test(String(remRes.result)), JSON.stringify(remRes && { isError: remRes.isError, result: String(remRes.result).slice(0, 140) }))
    else check('G7:远程 run 的工具面里没有 remember(同样写不进长期记忆)', !remRes, JSON.stringify(remRes))

    // ── F. 下载产物(真 UI):手机右侧栏「工作区」→「本会话的文件」组(远端会话沙箱:附件 / 产物,经 /engine/agent/workspace/list)
    //    → 点产物行尾的下载键 → downloadWorkspaceFile 按会话路由到那台电脑 → 中继带手机的票 → blob 保存。
    for (let i = 0; i < 4 && !(await page.locator('.mb-drawer--right.open').count()); i++) { await tap(page.locator('.mb-topbar [aria-label="right panel"]')).catch(() => {}); await sleep(700) }
    const drawer = page.locator('.mb-drawer--right.open')
    const views = await drawer.locator('select.mb-drawer-select option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent }))).catch(() => [])
    const wsOpt = views.find((o) => /工作区|Workspace/.test(o.t || ''))
    if (wsOpt) await drawer.locator('select.mb-drawer-select').selectOption(wsOpt.v)
    const group = drawer.locator('[data-ws-scope="session"]')
    await group.locator(`[data-ws-file="/${RESULT_NAME}"]`).first().waitFor({ timeout: 10_000 }).catch(() => {})
    const sessFiles = await group.locator('[data-ws-file]').evaluateAll((els) => els.map((e) => e.getAttribute('data-ws-file'))).catch(() => [])
    check('手机右侧栏「工作区」列出远端会话沙箱的文件(手机发的附件 + run_bash 的产物)', sessFiles.includes(`/${RESULT_NAME}`) && sessFiles.some((p) => p.endsWith(ATTACH_NAME)),
      `本会话的文件 ${JSON.stringify(sessFiles)};抽屉视图 ${JSON.stringify(views.map((o) => o.t))}`)
    await page.screenshot({ path: path.join(SHOT_DIR, `remotechain-workspace-${SHOT_TAG}.png`) })
    const want = ATTACH_TEXT.toUpperCase()
    const dlAt = world.hub.ledger.proxy.length
    const dlEvent = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null)
    const dlBtn = group.locator(`[data-ws-file="/${RESULT_NAME}"] [data-download]`).first()
    const hasBtn = (await dlBtn.count()) > 0
    if (hasBtn) await tap(dlBtn)
    const d = hasBtn ? await dlEvent : null
    let downloaded = null
    if (d) { const p = await d.path().catch(() => null); if (p) downloaded = fs.readFileSync(p, 'utf8') }
    const dlReq = world.hub.ledger.proxy.slice(dlAt).find((x) => /^\/engine\/agent\/workspace\/download\?/.test(x.path))
    check('下载产物(手机 UI:工作区 › 本会话的文件 › 下载 → 按会话路由到那台电脑 → 中继带手机的票)= 附件经 run_bash 处理后的内容',
      hasBtn && downloaded === want && !!dlReq && dlReq.unit === world.DESKTOP_UNIT && dlReq.callerUnit === phoneUnit,
      JSON.stringify({ button: hasBtn, file: d?.suggestedFilename?.() ?? null, got: downloaded === null ? null : String(downloaded).slice(0, 60), req: dlReq && { unit: dlReq.unit === world.DESKTOP_UNIT ? '那台电脑' : dlReq.unit, caller: dlReq.callerUnit === phoneUnit ? '手机' : dlReq.callerUnit, path: dlReq.path.slice(0, 90) } }))
    const listReq = world.hub.ledger.proxy.find((x) => /^\/engine\/agent\/workspace\/list\?/.test(x.path) && x.path.includes(sid))
    check('列表请求经中继发往那台电脑、带手机的票(/engine/agent/workspace/list?sessionId=本会话)', !!listReq && listReq.unit === world.DESKTOP_UNIT && listReq.callerUnit === phoneUnit, JSON.stringify(listReq && { unit: listReq.unit === world.DESKTOP_UNIT, caller: listReq.callerUnit === phoneUnit }))
    await closeOverlays(page)

    // ── G1:发往 unit 目标的中继语法面请求全部带有效调用方票 ──
    const relayRe = /^\/(engine($|[/?])|unit\/remote-access($|\/request$))/
    const toDesktop = world.hub.ledger.proxy.filter((x) => x.unit === world.DESKTOP_UNIT)
    const grammar = toDesktop.filter((x) => relayRe.test(x.path))
    const bad = grammar.filter((x) => !x.callerHeader || x.callerUnit !== phoneUnit)
    check('G1:手机发往那台电脑的中继面请求全部带有效 X-Forsion-Caller(= 手机 unit)', grammar.length > 5 && bad.length === 0, `${grammar.length} 条,缺 / 错 ${bad.length} 条${bad.length ? ':' + bad.slice(0, 4).map((x) => `${x.method} ${x.path.slice(0, 60)}`).join(', ') : ''}`)
    const other = toDesktop.filter((x) => !relayRe.test(x.path))
    info('不在中继语法面的隧道请求(照设计匿名:unit/config、unit/host*)', `${other.length} 条:${[...new Set(other.map((x) => x.path.replace(/\?.*$/, '')))].join(', ')}`)
    check('中继面没有被 hub 拒掉的票(403 UNIT_CALLER_*)', !grammar.some((x) => x.rejected), grammar.filter((x) => x.rejected).map((x) => x.rejected).join(','))
    // 凭据不进页面:替身从不把凭据交给页面,这里查不出任何东西 —— 真证据在 mobile/scripts/unit-relay-emu.cjs(原生那半)
    const leaked = await page.evaluate(({ secret, cs }) => Object.values(localStorage).some((v) => (secret && v.includes(secret)) || (cs && v.includes(cs)) || v.includes('fuc1.')), { secret: native.identity?.secret || '', cs: native.identity?.callerSecret || '' })
    info('凭据不进页面 JS(本台架证不了:原生层是 Node 替身、从不把凭据交给页面;证据归 unit-relay-emu)', `localStorage 里${leaked ? '有 ← 查!' : '没有'}凭据串`)

    // ── G7:远程 run 的用量归属 ──
    // 本会话的 LLM 调用按 cacheKey(= sessionId,引擎给同会话请求的缓存路由键)认;同一台电脑上别的后台 run(Muse 等)不算
    const sessionCalls = world.hub.ledger.brain.filter((c) => c.cacheKey === sid)
    const mainCalls = sessionCalls.filter((c) => c.tools.includes('run_bash'))
    const phoneClient = String(input.client || '')
    check('G7:run 行 client = 手机的 mobile/<版本>(不是执行设备的 desktop/…)', /^mobile\//.test(phoneClient), phoneClient || '(空)')
    const tag = serverClientTag(SERVER_DIR)
    if (!tag) info('G7:server clientTag 判定(SKIP)', `找不到 ${SERVER_DIR || '(未指定 server 目录)'}/src/utils/clientTag.ts`)
    else check('G7:server 收这个 client 值(clientTagOf / usageClientTagOf 原样返回;否则生产「端」列落 NULL)', tag.clientTagOf(phoneClient) === phoneClient && tag.usageClientTagOf(phoneClient) === phoneClient, `${phoneClient} → clientTagOf ${tag.clientTagOf(phoneClient) ?? 'undefined'} / usageClientTagOf ${tag.usageClientTagOf(phoneClient) ?? 'undefined'}`)
    check('G7:远程 run 的每次 LLM 调用:账号 = 两台设备所属账号、client = 手机的 mobile/<版本>', mainCalls.length >= 2 && mainCalls.every((c) => c.user === world.USER && c.client === phoneClient), JSON.stringify(mainCalls.map((c) => ({ u: c.user, client: c.client }))))
    const head = (c) => text(((c.messages || []).find((x) => x.role === 'system') || c.messages?.[0])?.content).replace(/\s+/g, ' ').slice(0, 70)
    const has = (c, m) => JSON.stringify(c.messages || []).includes(m)
    const others = world.hub.ledger.brain.filter((c) => c.cacheKey !== sid || !c.tools.includes('run_bash'))
    info('本会话之外 / 无工具的 LLM 调用(标题 / Historian / Muse …)', JSON.stringify(others.map((c) => ({ u: c.user, client: c.client, key: c.cacheKey === sid ? 'this' : c.cacheKey ? 'other' : null, head: head(c) }))))
    check('G7:电脑上所有 LLM 调用都归本账号(不串到别的账号)', world.hub.ledger.brain.every((c) => c.user === world.USER), JSON.stringify([...new Set(world.hub.ledger.brain.map((c) => c.user))]))
    // 派生调用(本会话的标题 / Historian)按设计继承 run 的 input.client;电脑本机自己的后台 run(Muse)不许被手机的标签盖到
    const muse = others.filter((c) => /^You are Muse/.test(head(c)))
    const derivedOf = (m) => others.filter((c) => /^(Write a title|You are the persistent background Historian)/.test(head(c)) && has(c, m))
    const derived = derivedOf(MARK)
    check('G7:本会话的派生调用(标题 / Historian)同样记在手机的 client 下', derived.length > 0 && derived.every((c) => c.client === phoneClient), JSON.stringify(derived.map((c) => c.client)))
    check('G7:电脑本机的后台 run(Muse)没有被盖上手机的 client', muse.every((c) => c.client !== phoneClient), JSON.stringify(muse.map((c) => c.client)))
    // standalone 引擎是单用户(本机 'local',--user-id 缺省):远程调用方不会在引擎里长出第二个身份;agent = 手机选的(缺省 xyra)
    const slug = input.agentConfig?.agentSlug ?? input.agent_config?.agentSlug ?? null
    check('G7:run 归属本机引擎的单用户(local)、agent = 默认 xyra(远程调用方不在引擎里另起身份 / 串 agent)', runRow?.user_id === 'local' && (slug === null || slug === 'xyra'), JSON.stringify({ user: runRow?.user_id, slug }))

    // ── G7:记忆归属 —— 远程轮次一律不进长期记忆(代码闸),正对照证明探针看得见写入 ──
    const englog = () => { try { return fs.readFileSync(world.engineLog, 'utf8') } catch { return '' } }
    const remoteRoundLogged = await until(() => /第 1 轮来自远端设备,本轮不写长期记忆/.test(englog()), 20_000, 250)
    const remoteJudge = world.hub.ledger.brain.find((c) => /^You are the persistent background Historian/.test(head(c)) && has(c, '[Task: judge]') && has(c, MARK))
    check('G7:Historian 把远程会话的第 1 轮认作远端、不写长期记忆(日志)', !!remoteRoundLogged, remoteRoundLogged ? '' : `引擎日志里没有「来自远端设备」;historian 行:${englog().split('\n').filter((l) => /historian/i.test(l)).slice(-4).join(' ‖ ')}`)
    check('G7:这一轮判官照样被问到、假判官交出了含本次标记的记忆候选(闸在代码里,不在提示词)', !!remoteJudge, remoteJudge ? head(remoteJudge) : '没有含 MARK 的判官调用')
    // 本机正对照:同一套剧本,本机起 run(无远程头)→ remember 落 MEMORY.md、判官候选落 .memory-raw.md
    const lsid = crypto.randomUUID()
    const lstart = await world.engineApi('/agent/runs', { method: 'POST', body: JSON.stringify({ session_id: lsid, model_id: 'k9-model', message: `记住我的代号 ${LMARK}`, client: HOST_CLIENT }) })
    const agentsDir = path.join(world.home, 'agents')
    const localDone = await until(async () => {
      // 本机会话若有要批的(档位缺省),照本机用户批掉 —— 正对照只关心记忆写得进去
      const lp = world.delivery.pending().find((x) => x.sessionId === lsid)
      if (lp) await world.engineApi(`/agent/runs/${lp.runId}/approvals/${lp.id}`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) })
      const hitsNow = filesContaining(agentsDir, LMARK)
      return hitsNow.some((f) => f.endsWith('MEMORY.md')) && hitsNow.some((f) => f.endsWith('.memory-raw.md')) ? hitsNow : null
    }, 30_000, 300)
    const lrun = runsOf(lsid).at(-1) || null
    check('G7 正对照:本机会话同一套剧本 → remember 落 MEMORY.md、Historian 候选落 .memory-raw.md(探针看得见写入)', !!localDone, JSON.stringify({ start: lstart.status, run: lrun?.status, files: filesContaining(agentsDir, LMARK), remember: lrun ? String(eventsOf(lrun.id, ['tool_result']).find((e) => e.p.name === 'remember')?.p?.result ?? '(无)').slice(0, 80) : '(无 run)' }))
    const lDerived = world.hub.ledger.brain.filter((c) => /^(Write a title|You are the persistent background Historian)/.test(head(c)) && has(c, LMARK))
    check('G7 正对照:本机会话的派生调用记在执行设备自己的 client 下(不是手机的)', lDerived.length > 0 && lDerived.every((c) => c.client === HOST_CLIENT), JSON.stringify(lDerived.map((c) => c.client)))
    const remoteHits = [...new Set([...filesContaining(agentsDir, MARK), ...filesContaining(agentsDir, MARK2)])]
    check('G7:agents/** 下任何文件(MEMORY.md / .memory-raw.md / 工作笔记 …)都没有远程会话的标记', remoteHits.length === 0, remoteHits.join(', ') || `扫了 ${agentsDir}`)
    info('hub 收到的云端记忆 / 日志写入(standalone 记忆本机优先,结构上恒为 0,不作断言)', `${world.hub.ledger.memoryWrites.length} 条`)
    // Muse 是执行设备本机的后台 agent(不带远程污点):它的周期提示词里有没有远程会话的原话 —— 有 = 远程内容能经 Muse 进 Journal / TODO / remember
    const museSeen = world.hub.ledger.brain.filter((c) => /^You are Muse/.test(head(c)) && (has(c, MARK) || has(c, MARK2)))
    const around = (c) => { const j = JSON.stringify(c.messages); const i = Math.max(j.indexOf(MARK), j.indexOf(MARK2)); return j.slice(Math.max(0, i - 160), i + 40).replace(/\\n/g, ' ') }
    info('G7:Muse 周期提示词里的远程会话原话(Muse 不带远程污点;见 openIssues)', museSeen.length ? `${museSeen.length} 次;例:…${around(museSeen[0])}…` : '没有')

    // ── KNOWN-GAP:附件对 host 模式的模型不可见 ──
    const blob = mainCalls[0] ? JSON.stringify(mainCalls[0].messages) : ''
    const visible = blob.includes(ATTACH_NAME) || blob.includes(world.sandboxDir)
    gap('host 模式的模型看得到手机发来的附件', visible, `模型第一轮请求里${visible ? '有' : '没有'}附件名 / 会话沙箱路径;附件实际落在 ${path.relative(world.out, world.sandboxDir)}/<hash>/${ATTACH_NAME},host 模式工具的 cwd = ${path.relative(world.out, world.workspace)}`)

    check('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
    if (world.hub.ledger.unknown.length) info('hub 未实现的路由', JSON.stringify([...new Set(world.hub.ledger.unknown.map((x) => `${x.method} ${x.path}`))]))
    console.log(`screenshots → ${SHOT_DIR}`)
  } finally {
    if (browser) await browser.close().catch(() => {})
    await world.close({ keep: results.some((r) => !r.ok) })
    home.close()
  }
  const failed = results.filter((r) => !r.ok)
  const passLine = `${results.length - failed.length}/${results.length} 通过${NEGCTL ? `(负对照 ${NEGCTL}:期望有红)` : ''}`
  if (failed.length) { console.log(`\n${passLine}`); process.exit(1) }
  if (gaps.length) {
    console.log(`\n${passLine};M1 exit criteria NOT met(${gaps.length} KNOWN-GAP:${gaps.join(';')})—— 退出码 2`)
    process.exit(2)
  }
  console.log(`\n${passLine};无 KNOWN-GAP`)
  process.exit(0)
}

main().catch((e) => { console.error('✗', e?.stack || e); process.exit(1) })
