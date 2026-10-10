/**
 * 手机上的语音通话(2026-10-10)浏览器台架 —— 手机形态(390×844、触屏),web 路径(mobileShim 非原生分支)。
 *
 * 通话连的是云网关的 ws /api/agent/realtime(Forsion 服务端 microserver/agent-core/realtime.ts);这里用假的通话端点
 * (page.routeWebSocket)+ 假麦克风,钉渲染端这一半:
 *   A. 云端目录没有通话模型 → 没有通话键(改之前手机永远是这样:网关的目录不带 realtimeModel);
 *   B. 目录带了、用户从没动过那个开关 → 输入框空着时发送键就是通话键(默认开);
 *   C. 按下去:建会话 → 页面顶上出通话条(没有 Mini 窗),聊天区照常在;
 *   D. 登录令牌走子协议、不进 URL;start 帧带会话 id、通话模型、缺省音色、app_id=tangu 与委派参数;
 *   E. 接通后麦克风帧在上传;静音键能按;
 *   F. 通话中打的字进电话(同一个窗口里的事件直送),不另起一个 Tangu run;通话中在药丸上换模型,之后交办的任务跟着换;
 *   G. 挂断:连接由这边关掉,通话条收起,输入框回到平时的样子;
 *   H. 离开前台(visibilitychange)→ 挂断,条上留着原因;这时再按通话键 = 重拨,不是哑的。
 * 另出两张真实截图(亮 / 暗)给人眼看(DESIGN §8)。
 *
 * 跑法:npm run build && npm run e2e:voicecall。SHOT_DIR 指定截图目录(缺省系统临时目录)。
 * 机制照抄 units-runon.e2e.cjs(假 token 过登录闸,/api/** 缺省 abort;端口经 lib/preview.cjs)。
 * 真引擎 × 真模型的那一半在 tangu-agent 的 check:realtime(假上游)与 live 台架 --only realtime;
 * 网关那一半在 server 的 microserver/agent-core/realtime.test.ts。
 */
const os = require('os')
const fs = require('fs')
const path = require('path')
const { startPreview } = require('./lib/preview.cjs')
const { chromium } = (() => {
  try { return require('playwright-core') } catch { /* 落到 desktop */ }
  return require(path.resolve(__dirname, '../../desktop/node_modules/playwright-core'))
})()

const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir()
const TOKEN = 'e2e-voice-token'
const SID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const CHAT_MODEL = 'e2e/alpha'
const OTHER_MODEL = { id: 'e2e/beta', name: 'Beta 2' }
const CALL_MODEL = { id: 'pr-voice1', name: 'Forsion Voice', apiModelId: 'qwen3.5-omni-flash-realtime' }
const catalog = (withCall) => JSON.stringify({
  models: [{ id: CHAT_MODEL, name: 'Alpha 1', provider: 'e2e', source: 'forsion', modelType: 'llm' }, { ...OTHER_MODEL, provider: 'e2e', source: 'forsion', modelType: 'llm' }],
  directProviders: [], defaultModelId: CHAT_MODEL, ...(withCall ? { realtimeModel: CALL_MODEL } : {}),
})
const json = (body) => ({ status: 200, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify(body) })

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const roots = [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) {
        const exe = path.join(root, d, rel)
        if (fs.existsSync(exe)) return exe
      }
    }
  }
  for (const exe of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']) {
    if (fs.existsSync(exe)) return exe
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const fails = []
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  | ${detail}`}`)
  if (!cond) fails.push(name)
}
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** 一个登录着的手机页面。withCall = 云端目录带不带通话模型。返回页面与假通话端点收到的东西。 */
async function phone(browser, url, { withCall, mode = 'light' }) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'zh-CN', colorScheme: mode, permissions: ['microphone'],
  })
  await ctx.addInitScript(({ token, mode }) => {
    try {
      localStorage.setItem('forsion_tangu_onboarding_done', '1')
      localStorage.setItem('forsion_token', token)
      localStorage.setItem('tangu_locale', 'zh')
      localStorage.setItem('forsion_theme_pref', mode)
    } catch { /* ignore */ }
  }, { token: TOKEN, mode })
  const page = await ctx.newPage()
  const seen = { frames: [], binary: 0, closed: 0, opened: 0, sessions: [], runs: [], errors: [] }
  page.on('pageerror', (e) => seen.errors.push(e.message))
  seen.api = [] // 页面打过的 /api/ 请求(通话键没出来时先看这里:目录到底拉没拉、拉的是哪条)
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.includes('/api/')) seen.api.push(`${r.method()} ${u.pathname}`) })
  await page.route('**/api/**', (r) => r.abort())
  // ⚠️ 后注册的先匹配:具体的路由都写在整片 abort 之后。
  await page.route('**/api/auth/me', (r) => r.fulfill(json({ id: 'u1', username: 'e2e' })))
  // 连上(/health)之后才拉目录:不答这一条,通话键出不来的原因就成了「没连上」,测不到要测的东西。
  await page.route('**/api/health', (r) => r.fulfill(json({ ok: true, sandbox: 'none' })))
  await page.route('**/api/agent/models*', (r) => r.fulfill(json(catalog(withCall))))
  let session = null
  await page.route(/\/api\/agent\/sessions(\?.*)?$/, (r) => {
    if (r.request().method() !== 'POST') return r.fulfill(json({ sessions: session ? [session] : [] }))
    const body = JSON.parse(r.request().postData() || '{}')
    seen.sessions.push(body)
    const now = new Date().toISOString()
    session = { id: SID, title: '', app_id: 'tangu', model_id: null, agent_config: body.agent_config || {}, created_at: now, updated_at: now }
    return r.fulfill(json({ session }))
  })
  await page.route(/\/api\/agent\/runs(\?.*)?$/, (r) => { if (r.request().method() === 'POST') seen.runs.push(r.request().postData()); return r.abort() })
  // 假的通话端点:收到 start 就回 ready(真引擎是接通上游之后才回)。
  await page.routeWebSocket(/\/agent\/realtime/, (ws) => {
    seen.opened++
    seen.server = ws
    ws.onMessage((m) => {
      if (typeof m !== 'string') { seen.binary++; return }
      const f = JSON.parse(m)
      seen.frames.push(f)
      if (f.type === 'start') ws.send(JSON.stringify({ type: 'ready' }))
    })
    ws.onClose(() => { seen.closed++ })
  })
  const cdp = await ctx.newCDPSession(page)
  // body 有 zoom,Playwright 的可点性判定在 zoom 下会判「视口外」→ 套件口径:CDP 触摸打 boundingBox。
  const tap = async (locator, what) => {
    const b = await locator.boundingBox()
    if (!b) throw new Error(`目标不可见: ${what}`)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
    await new Promise((r) => setTimeout(r, 60))
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(350)
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(4000)
  // 记下页面是怎么开 WebSocket 的(地址 + 子协议;假端点那一侧看不到子协议)。⚠️ 必须在页面起来之后包:
  // routeWebSocket 自己会在初始化脚本里换掉全局的 WebSocket,包早了被它盖掉(实测:一条都记不到)。
  await page.evaluate(() => {
    window.__sockets = []
    const Routed = window.WebSocket
    window.WebSocket = class extends Routed {
      constructor(u, p) { window.__sockets.push({ url: String(u), protocols: p === undefined ? null : [].concat(p) }); super(u, p) }
    }
  })
  return { ctx, page, seen, tap }
}

const callKey = (page) => page.locator('.t2c-send.t2c-live-control:visible').first()
const bar = (page) => page.locator('.vc-bar')
const barState = (page) => page.evaluate(() => {
  const el = document.querySelector('.vc-bar')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return {
    phase: el.getAttribute('data-phase'), status: el.querySelector('.vc-status-text')?.textContent || '',
    error: !!el.querySelector('.vc-status.is-error'), muted: el.querySelector('.vc-mute')?.getAttribute('aria-pressed'),
    top: Math.round(r.top), left: Math.round(r.left), right: Math.round(window.innerWidth - r.right), height: Math.round(r.height),
  }
})
/** 聊天流顶上留了多少(CSS px)。通话条在的时候要比平时多出条的高度,头几句转写才不被压住。 */
const streamPad = (page) => page.evaluate(() => {
  const el = document.querySelector('.mb-view[data-view="chat"] .t2-stream')
  return el ? parseFloat(getComputedStyle(el).paddingTop) : null
})
const barHeight = (page) => page.evaluate(() => document.querySelector('.vc-bar')?.offsetHeight ?? null)
const placeholder = (page) => page.evaluate(() => [...document.querySelectorAll('textarea')].find((t) => t.offsetParent)?.getAttribute('placeholder') || '')

async function main() {
  const root = path.resolve(__dirname, '..')
  if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
    console.error('✗ 没有 dist/,先跑 npm run build')
    process.exit(1)
  }
  const preview = await startPreview(root)
  let browser = null
  try {
    await preview.ready()
    browser = await chromium.launch({
      executablePath: findChromium(), headless: true,
      args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    })

    // A. 目录不带通话模型(改之前网关的目录就是这样)→ 没有通话键
    {
      const { ctx, page, seen } = await phone(browser, preview.url, { withCall: false })
      ok('A 云端目录没有通话模型 → 没有通话键', (await callKey(page).count()) === 0 && (await page.locator('.t2c-send:visible').count()) > 0,
        `通话键 ${await callKey(page).count()} 个,发送键 ${await page.locator('.t2c-send:visible').count()} 个`)
      ok('A 没有未捕获异常', seen.errors.length === 0, seen.errors.join(' / '))
      await ctx.close()
    }

    const { ctx, page, seen, tap } = await phone(browser, preview.url, { withCall: true })
    // B. 默认开:从没动过那个开关 + 已登录 + 目录里有通话模型
    const stored = await page.evaluate(async () => { const c = await window.tangu.getConfig(); return { unset: c.realtimeModelUnset, id: c.realtimeModelId ?? null } })
    ok('B 从没动过通话开关(realtimeModelUnset)', stored.unset === true && !stored.id, JSON.stringify(stored))
    ok('B 输入框空着 → 发送键就是通话键', (await until(async () => (await callKey(page).count()) === 1)) === true,
      `通话键 ${await callKey(page).count()} 个;登录态 ${JSON.stringify(await page.evaluate(() => window.tangu.authStatus()))};请求 ${[...new Set(seen.api)].join(', ')}`)

    // C. 按下去:建会话 + 通话条
    await tap(callKey(page), '通话键')
    await until(async () => (await bar(page).count()) === 1)
    ok('C 建了一个会话', seen.sessions.length === 1 && seen.sessions[0].app_id === 'tangu', JSON.stringify(seen.sessions).slice(0, 200))
    ok('C 页面顶上出了通话条', (await bar(page).count()) === 1)
    ok('C 没有走 Mini 窗(手机没有那个接口)', (await page.evaluate(() => typeof window.tangu.openMini)) === 'undefined')

    // D. 连的是谁、令牌怎么带、start 帧
    await until(() => seen.frames.some((f) => f.type === 'start'))
    const sock = (await page.evaluate(() => window.__sockets)).find((s) => /\/agent\/realtime/.test(s.url))
    ok('D 连云网关的 /api/agent/realtime', !!sock && new URL(sock.url).pathname === '/api/agent/realtime' && /^wss?:$/.test(new URL(sock.url).protocol), sock && sock.url)
    ok('D 登录令牌走子协议', !!sock && JSON.stringify(sock.protocols) === JSON.stringify(['forsion.bearer', TOKEN]), JSON.stringify(sock && sock.protocols))
    ok('D 令牌不进 URL', !!sock && !sock.url.includes(TOKEN) && !new URL(sock.url).search, sock && sock.url)
    const start = seen.frames.find((f) => f.type === 'start') || {}
    ok('D start 帧:会话 id + 通话模型 + 按家族补的缺省音色', start.session_id === SID && start.model === CALL_MODEL.id && start.voice === 'Tina', JSON.stringify(start).slice(0, 300))
    ok('D start 帧:委派参数带 app_id=tangu 与这个会话的模型', start.run && start.run.app_id === 'tangu' && start.run.model_id === CHAT_MODEL && typeof start.run.agent_config === 'object',
      JSON.stringify(start.run).slice(0, 300))

    // E. 接通:状态、麦克风在上传、静音
    await until(async () => (await barState(page))?.phase === 'listening')
    const live = await barState(page)
    ok('E 接通后是「在听」', live?.phase === 'listening' && !live.error, JSON.stringify(live))
    ok('E 麦克风帧在上传', (await until(() => seen.binary > 3)) === true, `二进制帧 ${seen.binary}`)
    ok('E 通话条在顶栏下面、两侧留边、没有顶出屏幕', !!live && live.top >= 40 && live.left >= 8 && live.right >= 8 && live.height >= 44, JSON.stringify(live))
    ok('E 聊天输入框还在,并提示打的字会进电话', /通话中/.test(await until(async () => (/通话中/.test(await placeholder(page)) ? await placeholder(page) : ''))), await placeholder(page))
    const padInCall = await streamPad(page)
    const barH = await barHeight(page)
    await page.screenshot({ path: path.join(SHOT_DIR, 'voice-call-bar-light.png') })
    await tap(page.locator('.vc-bar .vc-mute'), '静音键')
    const muted = await barState(page)
    ok('E 静音键能按(通话还在)', muted?.muted === 'true' && muted.phase === 'muted', JSON.stringify(muted))
    await tap(page.locator('.vc-bar .vc-mute'), '静音键')

    // F. 通话中打的字进电话
    const box = page.locator('textarea:visible').first()
    await box.fill('帮我看看明天的日程')
    await tap(page.locator('.t2c-send:visible').first(), '发送键')
    const typed = await until(() => seen.frames.find((f) => f.type === 'text'))
    ok('F 打的字进了电话', !!typed && typed.text === '帮我看看明天的日程', JSON.stringify(seen.frames.map((f) => f.type)))
    await page.waitForTimeout(2300) // 等过「通话没确认就改发 Tangu」的 2s 超时
    ok('F 没有另起一个 Tangu run', seen.runs.length === 0, `${seen.runs.length} 个`)
    ok('F 输入框清空了', (await box.inputValue()) === '')
    // 通话中换模型:条上没有模型那一行,跟的是输入框里这个会话的设置 —— 引擎要收到带新模型的委派参数
    await tap(page.locator('.model-pill-btn:visible').first(), '模型药丸')
    await tap(page.locator('.cm-model-row:visible').first(), '菜单里的「模型」一行') // 药丸打开的是会话设置菜单,模型在里面那一行的下一级
    const pick = page.getByText(OTHER_MODEL.name, { exact: true }).locator('visible=true').first()
    if (!(await until(async () => (await pick.count()) > 0, 4000))) {
      // 菜单没出来 / 换了写法:把点完药丸之后页面上带模型名的元素列出来,别只留一句「目标不可见」
      throw new Error(`模型菜单里找不到「${OTHER_MODEL.name}」;页面上带模型名的元素: ${JSON.stringify(await page.evaluate((names) => [...document.querySelectorAll('body *')]
        .filter((e) => !e.children.length && names.some((n) => (e.textContent || '').includes(n))).slice(0, 12)
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ').join('.')} «${(e.textContent || '').trim().slice(0, 30)}» ${e.offsetParent ? '' : '(隐藏)'} < ${String(e.parentElement && e.parentElement.className)}`), ['Alpha 1', 'Beta 2']))}`)
    }
    await tap(pick, `模型 ${OTHER_MODEL.name}`)
    const switched = await until(() => seen.frames.filter((f) => f.type === 'run').find((f) => f.run && f.run.model_id === OTHER_MODEL.id), 4000)
    ok('F 通话中换模型 → 之后交办的任务用新模型', !!switched, JSON.stringify(seen.frames.filter((f) => f.type === 'run').map((f) => f.run && f.run.model_id)))

    // G. 挂断
    await tap(page.locator('.vc-bar .vc-hangup'), '挂断键')
    await until(async () => (await bar(page).count()) === 0)
    ok('G 通话条收起', (await bar(page).count()) === 0)
    ok('G 连接由这边关掉', (await until(() => seen.closed === 1)) === true, `closed=${seen.closed}`)
    const padIdle = await streamPad(page)
    ok('G 通话条在的时候聊天流让出了它的高度(头几句转写不被压住),收起后还回去',
      padInCall !== null && padIdle !== null && barH !== null && padInCall - padIdle >= barH + 6, `通话中 ${padInCall} / 平时 ${padIdle} / 条高 ${barH}`)
    ok('G 输入框回到平时的样子,通话键回来了', !/通话中/.test(await placeholder(page)) && (await until(async () => (await callKey(page).count()) === 1)) === true, await placeholder(page))

    // H. 离开前台 → 挂断;再按 = 重拨
    await tap(callKey(page), '通话键')
    await until(async () => (await barState(page))?.phase === 'listening')
    ok('H 同一个会话里再打一通(不新建会话)', seen.opened === 2 && seen.sessions.length === 1, `opened=${seen.opened} sessions=${seen.sessions.length}`)
    // 无头浏览器里页面恒为 visible:改写 document.hidden 再派发事件,走的是同一个监听。
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
    await until(() => seen.closed === 2)
    const gone = await barState(page)
    ok('H 离开前台 → 挂断', seen.closed === 2, `closed=${seen.closed}`)
    ok('H 条上留着原因', !!gone && gone.error && /离开 Forsion/.test(gone.status), JSON.stringify(gone))
    await page.evaluate(() => { delete document.hidden })
    await tap(callKey(page), '通话键')
    ok('H 这时再按通话键 = 重拨(不是哑的)', (await until(async () => seen.opened === 3 && (await barState(page))?.phase === 'listening')) === true,
      `opened=${seen.opened} ${JSON.stringify(await barState(page))}`)
    await tap(page.locator('.vc-bar .vc-hangup'), '挂断键')
    ok('没有未捕获异常', seen.errors.length === 0, seen.errors.join(' / '))
    await ctx.close()

    // 暗色截图(同一条路走到接通)
    {
      const d = await phone(browser, preview.url, { withCall: true, mode: 'dark' })
      await until(async () => (await callKey(d.page).count()) === 1)
      await d.tap(callKey(d.page), '通话键')
      await until(async () => (await barState(d.page))?.phase === 'listening')
      await d.page.waitForTimeout(600)
      await d.page.screenshot({ path: path.join(SHOT_DIR, 'voice-call-bar-dark.png') })
      await d.ctx.close()
    }
    console.log(`截图 → ${SHOT_DIR}/voice-call-bar-{light,dark}.png`)
  } catch (e) {
    fails.push(String((e && e.stack) || e))
    console.log(`FAIL  ${String((e && e.message) || e)}`)
  } finally {
    if (browser) await browser.close()
    preview.kill()
  }
  console.log(fails.length ? `\n✗ ${fails.length} 条未通过` : '\n✓ 全绿')
  process.exit(fails.length ? 1 : 0)
}

main()
