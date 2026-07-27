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
  const p = await browser.newPage()
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

  await browser.close()
  stopCodePreview()
  const failed = results.filter((x) => !x.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error('CHECK CRASH:', e); process.exit(1) })
