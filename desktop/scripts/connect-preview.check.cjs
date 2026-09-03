/**
 * Forsion Connect 预览态 AI 链路契约(真 Chromium + 真云端往返)。
 *
 * 为什么存在:「agent 写的网页能直接用 Forsion 的 AI」这条产品承诺,坏一环就整体不成立,
 * 而它跨了四层:预览服务器供 /forsion-connect.js → local SDK → /__forsion/* 主进程代理 → 云端。
 * 07-26 实测事故(tangu-session-9d1fa366):令牌根(Agent Desk / wsfile / 笔记预览)漏挂 Connect
 * 端点,普通聊天里生成的 AI 页面 window.forsion 直接 404。本仪器用**真实模块**(sucrase register
 * 直载 electron/*.ts,零复制)拼出与 main.ts 一字不差的接线,在真 Chromium 里从令牌根打一整条:
 * SDK 注入 → user()(登录态)→ models() → ai.chat() 流式(断言 onDelta 真的到了)。
 *
 * 前置:dev server 在跑(npm run server:dev)+ 桌面 dev 登录过(~/.forsion-dev/auth.json 有 token)。
 * 云端不可达时 exit 2(环境未就绪,区别于断言失败的 exit 1)。
 *
 * 跑:npm run check:connect   (CHROMIUM_EXE / FORSION_HOME 可覆盖)
 */
require('sucrase/register/ts')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

const { servePathRoot, setForsionPreviewHooks, stopCodePreview } = require('../electron/codePreview')
const { FORSION_CONNECT_LOCAL_SDK } = require('../electron/forsionConnectLocal')
const { makePreviewProxy } = require('../electron/forsionConnect')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

/** 与 main.ts resolveConnectCloud 同源:auth.json 的 cloudUrl+token(dev 家优先,FORSION_HOME 可覆盖)。 */
function resolveCloud() {
  const home = process.env.FORSION_HOME ||
    (fs.existsSync(path.join(os.homedir(), '.forsion-dev')) ? path.join(os.homedir(), '.forsion-dev') : path.join(os.homedir(), '.forsion'))
  let creds = {}
  try { creds = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')) } catch { /* 未登录 */ }
  return { home, base: String(creds.cloudUrl || 'http://localhost:3001').replace(/\/+$/, ''), token: creds.token || '' }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  // 请求体见证(先于 SDK 挂):防「SDK 回归为客户端选模型」的假绿(codex 评审#5)——
  // 响应出文本 ≠ 请求形态正确,必须直接看见 model_id 缺席。
  window.__aiBodies = { chat: [], agent: [] };
  (function () {
    var f = window.fetch;
    window.fetch = function (u, o) {
      try {
        var s = String(u);
        if (o && o.body && s.indexOf('/__forsion/chat') === 0) window.__aiBodies.chat.push(JSON.parse(o.body));
        if (o && o.body && s.indexOf('/__forsion/agent') === 0 && s.indexOf('agent-events') < 0) window.__aiBodies.agent.push(JSON.parse(o.body));
      } catch (e) {}
      return f.apply(this, arguments);
    };
  })();
</script>
<script src="/forsion-connect.js"></script>
<script>
  // 报告对象在外层:任一步抛错只补 error 字段,**不抹掉已成功步骤的字段**——
  // 否则「provider key 失效」会把「SDK 注入成功」也染成 FAIL,定位不到断在哪一环。
  const r = { hasSDK: false, deltas: 0 }
  window.__report = (async () => {
    r.hasSDK = !!window.forsion
    r.mode = window.forsion && window.forsion.mode
    if (!window.forsion) return r
    r.user = await forsion.user()
    r.models = (await forsion.models()).map((m) => m.id)
    // dev 库的平台默认模型可能是上游 key 已死的测试条目(实测:default_model_id=EEE)——
    // 默认失败就顺着模型列表逐个试:仪器要测的是「链路能出 AI 文本」,不是「dev 数据永远干净」。
    let cfgDefault = null
    try { cfgDefault = (await (await fetch('/__forsion/config')).json()).defaultModel } catch (e) {}
    const candidates = [...new Set([cfgDefault, ...r.models].filter(Boolean))] // 死 key 秒败,全量试;首个出文本即停

    r.tried = []
    for (const m of candidates) {
      try {
        r.deltas = 0
        const chat = await forsion.ai.chat({
          prompt: 'Reply with exactly the single word: PONG',
          maxTokens: 16,
          model: m,
          onDelta: () => { r.deltas++ },
        })
        r.text = chat.text
        r.model = chat.model
        if (chat.text && chat.text.trim()) break
      } catch (e) { r.tried.push(m + ': ' + String(e && e.message || e)) }
    }

    // 不传 model:SDK 该把 model_id 整个省略,由服务端按 Connect 策略现填(chat.ts 新闸的活体验证)
    try {
      const df = await forsion.ai.chat({ prompt: 'Reply with exactly the single word: PONG', maxTokens: 16 })
      r.defaultFill = { text: df.text, model: df.model }
    } catch (e) { r.defaultFill = { error: String(e && e.message || e) } }
    r.defaultFillBody = window.__aiBodies.chat[window.__aiBodies.chat.length - 1] || null

    // agent 通道:云 fleet 派发。dev 常无 worker(503 NO_AGENT_WORKERS)→ 外层按环境 SKIP;
    // 120s 兜底防 evaluate 永挂(agent run 真跑起来也不该超,这只是 PONG)。
    try {
      r.agentDeltas = 0
      const ag = await Promise.race([
        forsion.ai.agent({ input: 'Reply with exactly the single word: PONG', onDelta: () => { r.agentDeltas++ } }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('agent 超时(120s)')), 120000)),
      ])
      r.agent = { text: ag.text, session: ag.session }
    } catch (e) { r.agent = { error: String(e && e.message || e) } }
    r.agentBody = window.__aiBodies.agent[0] || null
    return r
  })().catch((e) => { r.error = String(e && e.message || e); return r })
</script>
</body></html>`

;(async () => {
  const { home, base, token } = resolveCloud()
  // 环境预检:云端可达 + 已登录,缺一即 exit 2(不是链路的错,别染红断言)
  const up = await fetch(base + '/api/models?type=llm', { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false)
  if (!up) { console.error(`SKIP: 云端 ${base} 不可达 —— 先 npm run server:dev`); process.exit(2) }
  if (!token) { console.error(`SKIP: ${home}/auth.json 无 token —— 先在桌面 dev 登录 Forsion 账号`); process.exit(2) }

  // 与 electron/main.ts 的 setForsionPreviewHooks 调用一字不差(改那边记得同步这里)
  setForsionPreviewHooks({ sdkJs: FORSION_CONNECT_LOCAL_SDK, proxy: makePreviewProxy(async () => ({ base, token })) })

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-live-'))
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE)
  // 令牌根 = Agent Desk / wsfile / 笔记预览走的那台服务器(事故现场;Coding Space 主根由单测覆盖)
  const { origin } = await servePathRoot(dir)

  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN' })
  await p.goto(origin + '/index.html')
  const r = await p.evaluate(() => window.__report)

  check('页面拿到 window.forsion(令牌根供出了 SDK)', !!r.hasSDK, r.error)
  check('SDK 处于 preview 形态', r.mode === 'preview', `mode=${r.mode}`)
  check('登录态经代理可读(user 非空)', !!(r.user && r.user.username), r.user && r.user.username)
  check('模型列表非空', Array.isArray(r.models) && r.models.length > 0, (r.models || []).slice(0, 3).join(','))
  check('真 AI 往返出文本', typeof r.text === 'string' && r.text.trim().length > 0,
    (typeof r.text === 'string' && r.text.trim() ? `[${r.model}] ${r.text.trim().slice(0, 60)}` : null) ||
    r.error || (r.tried && r.tried.length ? '全部候选模型失败: ' + r.tried.join(' ; ').slice(0, 300) : '无候选模型'))
  check('流式增量真的到了(onDelta > 0)', (r.deltas || 0) > 0, `deltas=${r.deltas}`)
  check('chat 不传 model:请求体真无 model_id 且服务端代填出文本',
    !!(r.defaultFill && (r.defaultFill.text || '').trim()) && !!r.defaultFillBody && !('model_id' in r.defaultFillBody),
    r.defaultFill
      ? (r.defaultFill.error ||
        `[${r.defaultFill.model}] ${(r.defaultFill.text || '').trim().slice(0, 40)}${r.defaultFillBody && 'model_id' in r.defaultFillBody ? ' | 假绿:请求体带了 model_id!' : ''}`)
      : '未执行')
  // agent 请求形态:SDK 不许发 model_id(模型完全服务端决定)——POST 在 SKIP 场景也已发出,恒可断言
  check('agent 请求体不含 model_id(模型服务端决定)',
    !!(r.agentBody && r.agentBody.session_id && !('model_id' in r.agentBody)),
    r.agentBody ? Object.keys(r.agentBody).join(',') : '未捕获到 agent 请求')
  // agent 通道:无云端 worker 是环境状态不是链路故障 —— SKIP 不染红(有 worker 时才断言)
  const agErr = (r.agent && r.agent.error) || ''
  if (/NO_AGENT_WORKERS|暂无可用执行节点/.test(agErr)) {
    console.log(`SKIP  agent 通道(dev 未登记云端 worker,发布态同链路)  | ${agErr.slice(0, 120)}`)
  } else {
    check('agent 通道出终稿(云 worker 托管上下文/工具)', !!(r.agent && (r.agent.text || '').trim()),
      r.agent ? (r.agent.error || `[session=${String(r.agent.session || '').slice(0, 8)}] deltas=${r.agentDeltas} ${(r.agent.text || '').trim().slice(0, 60)}`) : '未执行')
  }

  await browser.close()
  stopCodePreview()
  const failed = results.filter((x) => !x.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error('CHECK CRASH:', e); process.exit(1) })
