/**
 * 演示舞台(插件的 ctx.stage,electron/pluginStage.ts)的端到端契约:真 Electron 父进程 + 它真起的舞台子进程。
 * 方案:仓根 docs/ToBeImproved/沙箱开放给插件方案_2026-11-20。
 *
 * 证的是:
 *   0 声明了 stage 的插件拿得到 ctx.stage,没声明的拿不到
 *   1 第一次 open 弹确认框:点「不允许」→ denied、不起进程;点「允许」→ 记住,第三次不再问
 *   2 起来的舞台:窗口尺寸 / 像素密度按参数(1280×800 @2 → 截图 2560×1600 的 PNG,不透明),点名的插件在、Space 切得过去,
 *     时钟定在参数给的那一刻(被拍插件的视图把 new Date() 写在页面上,read 读得到)
 *   3 隔离:舞台目录在 <forsionHome>/stages/<插件 id>;演示库来自插件包的 fixture/vault;用户的笔记库一个文件都没多;
 *     被拍插件在用户那份的插件数据(plugins-data/<id>.json 里的标记)没进舞台;没有沙箱条
 *   4 selector 截一块:尺寸 = 那个元素的矩形 × 密度
 *   5 录像:录本窗口 2 秒(中间点一下,带假指针)→ mp4 / webm 字节,宽 = 窗口像素;有 ffprobe 时数帧数
 *   6 脚本回放引擎:engine 'scripted' → 舞台里发一句话 → 页面上出现 engine.json 里写的回复
 *   7 互斥:舞台开着时别的插件 open → busy
 *   8 负对照:fixture 带 `..` → invalid;点名没装的插件 → plugin-missing
 *   10 真实的内置插件(forsion-calendar)也能上舞台:open 认得、切得到日历 Space、能截图;
 *      个人日历读 fixture 的 human/CALENDAR.db(engine 'scripted'),那条日程画在日历上
 *   9 close → 舞台进程退出,再调 → closed
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 跑:node .claude/hooks/devlock.cjs run --vehicle=e2e --what="plugin stage" -- npm run check:pluginstage
 * `SHOT_DIR=<目录>` 落舞台截图与录像(自查首屏有没有引导 / 弹窗这类噪音)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-stage-'))
const UD = path.join(home, 'userdata')
const VAULT = path.join(home, 'vault')
const DIRECTOR = 'stage-director'
const RIVAL = 'stage-rival'
const EXTRA = 'stage-extra'
const STAGE_ROOT = path.join(home, 'stages', DIRECTOR)
const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : null
const REPLY = 'STAGE_SCRIPTED_REPLY Here is the plan for Friday.'
const USER_DATA_MARK = 'USER_PLUGIN_DATA_MARK_7f3a'

function writePlugin(id, manifest, mainJs, files = {}) {
  const dir = path.join(home, 'plugins', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, version: '0.1.0', apiVersion: 1, main: 'main.js', ...manifest }))
  fs.writeFileSync(path.join(dir, 'main.js'), mainJs)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
}

function setup() {
  // 导演:声明 stage,把 ctx.stage 挂到 window 上给台架调(插件和宿主同一个渲染层)
  writePlugin(DIRECTOR, { name: 'Stage director', capabilities: ['stage'] }, `window.__stageApi = ctx.stage || null\nreturn () => {}\n`, {
    'fixtures/demo/vault/Welcome.md': '# Demo welcome\n\nThis note comes from the fixture.\n',
    'fixtures/demo/vault/Projects/Launch.md': '# Launch plan\n',
    'fixtures/demo/engine.json': JSON.stringify(engineScript()),
    // 第 10 步:个人日历来自 fixture 的 human/CALENDAR.db(和真引擎家目录里那份同一个位置),回放引擎照真引擎的报文给舞台
    'fixtures/calendar/vault/Agenda.md': '# Agenda\n',
    'fixtures/calendar/engine.json': JSON.stringify({ runs: [] }),
    'fixtures/calendar/human/CALENDAR.db': JSON.stringify(calendarFixture()),
  })
  // 另一个声明了 stage 的插件:舞台被导演占着时它 open → busy
  writePlugin(RIVAL, { name: 'Stage rival', capabilities: ['stage'] }, `window.__rivalStageApi = ctx.stage || null\nreturn () => {}\n`)
  // 被拍的插件:带一个 Space,视图把「现在」写在页面上(验时钟),有一块固定 id 的区域(验 selector 截图)
  writePlugin(EXTRA, { name: 'Stage extra' }, `
ctx.registerView({ id: 'extra-view', title: 'Extra view', mount(el) {
  const h = document.createElement('h1'); h.textContent = 'Extra view on stage'
  const now = document.createElement('p'); now.id = 'stage-extra-now'; now.textContent = 'NOW ' + new Date().toISOString().slice(0, 10)
  const card = document.createElement('div'); card.id = 'stage-extra-card'; card.style.cssText = 'width:300px;height:120px;background:#3d6b57;color:#fff;padding:12px'
  card.textContent = 'Card to capture'
  const btn = document.createElement('button'); btn.textContent = 'Extra action'; btn.onclick = () => { btn.textContent = 'Extra action done' }
  el.append(h, now, card, btn)
  return () => { h.remove(); now.remove(); card.remove(); btn.remove() }
} })
window.__extraNoStage = !ctx.stage
return () => {}
`, {
    'spaces/extra-space/space.json': JSON.stringify({
      id: 'extra-space', name: 'Extra space', icon: 'boxes', version: '1.0.0',
      layout: { main: [{ type: `plugin:${EXTRA}:extra-view` }], left: [], right: [] }, requires: { views: [`plugin:${EXTRA}:extra-view`] },
    }),
  })
  // 用户那份里,被拍插件的私有数据:不许跟进舞台
  fs.mkdirSync(path.join(home, 'plugins-data'), { recursive: true })
  fs.writeFileSync(path.join(home, 'plugins-data', `${EXTRA}.json`), JSON.stringify({ secret: USER_DATA_MARK }))
  fs.mkdirSync(VAULT, { recursive: true })
  fs.writeFileSync(path.join(VAULT, 'mine.md'), '# my note\n')
  fs.mkdirSync(`${UD}-dev`, { recursive: true })
  fs.writeFileSync(path.join(`${UD}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ localVault: VAULT, lastVault: VAULT }))
}

/** 脚本回放:舞台里发的第一句话回一段写死的流式回复。事件形状同 scripts/lib/stub-engine.cjs。 */
function engineScript() {
  return {
    models: [{ id: 'demo', name: 'Demo model', provider: 'openai', contextWindow: 400000 }],
    runs: [{ events: [
      { type: 'token', payload: { delta: REPLY.slice(0, 20) }, delay: 60 },
      { type: 'token', payload: { delta: REPLY.slice(20) }, delay: 60 },
    ] }],
  }
}

const CAL_EVENT = 'STAGE_CAL_EVENT Launch review'
/** 个人日历(human/CALENDAR.db,DbFile):舞台时钟那天下午一条日程。列 id 同 humanCalendarIo 的空日历。 */
function calendarFixture() {
  return {
    version: 2, name: 'My calendar',
    columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'date', name: 'Date', type: 'calendarDate' }, { id: 'done', name: 'Done', type: 'checkbox' }],
    rows: [{ id: 'ev1', cells: { name: CAL_EVENT, date: '2026-11-20T14:00/2026-11-20T15:00' } }],
  }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 600) : ''}`)
}
const listFiles = (dir) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)) } }; if (fs.existsSync(dir)) walk(dir); return out.sort() }
const grepTree = (dir, needle) => listFiles(dir).filter((f) => { try { return fs.statSync(path.join(dir, f)).size < 5e6 && fs.readFileSync(path.join(dir, f), 'utf8').includes(needle) } catch { return false } })
const pngSize = (b) => (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null)

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  setup()
  const vaultBefore = listFiles(VAULT)
  const stub = await startStubEngine({ sessions: [], messages: [] })
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${UD}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      timeout: 45_000,
    })
    const win = await app.firstWindow()
    win.setDefaultTimeout(15_000)
    await win.waitForSelector('#root', { state: 'attached', timeout: 45_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 45_000 })
    await win.waitForFunction(() => window.__stageApi !== undefined && window.__extraNoStage !== undefined, null, { timeout: 30_000 }).catch(() => {})

    // 确认框:台架里按 answers 依次回答,记下弹了几次
    await app.evaluate(({ dialog }) => {
      const orig = dialog.showMessageBox
      globalThis.__stageAsk = { asked: 0, answers: [1, 0] } // 第一次「不允许」,第二次「允许」
      dialog.showMessageBox = async (w, o) => {
        if ((o && o.title) === '演示舞台' || (o && o.title) === 'Demo stage') { const a = globalThis.__stageAsk; a.asked += 1; return { response: a.answers.shift() ?? 1, checkboxChecked: false } }
        return orig.call(dialog, w, o)
      }
    })
    const asked = () => app.evaluate(() => globalThis.__stageAsk.asked)

    check('0 声明了 stage 的插件有 ctx.stage,没声明的没有',
      await win.evaluate(() => !!window.__stageApi && typeof window.__stageApi.open === 'function' && window.__extraNoStage === true))

    const OPTS = { fixture: 'fixtures/demo', plugins: [EXTRA], theme: 'light', window: [1280, 800, 2], clock: '2026-11-20T10:00', engine: 'scripted' }
    const tryOpen = (api = '__stageApi', o = OPTS) => win.evaluate(async ([api, o]) => {
      try { const s = await window[api].open(o); window.__stage = s; return { ok: true, window: s.window, plugins: s.plugins, engine: s.engine } } catch (e) { return { ok: false, code: e.code, error: String(e.message) } }
    }, [api, o])

    // ── 1 确认框 ──
    const denied = await tryOpen()
    check('1a 第一次 open 弹确认框,点「不允许」→ denied,不起舞台', !denied.ok && denied.code === 'denied' && (await asked()) === 1 && !fs.existsSync(path.join(STAGE_ROOT, 'home')), JSON.stringify(denied))
    const t0 = Date.now()
    const opened = await tryOpen()
    const openMs = Date.now() - t0
    check('1b 再 open 点「允许」→ 起来了,参数如实回报', opened.ok && opened.window.width === 1280 && opened.window.height === 800 && opened.window.scale === 2 && opened.plugins.includes(EXTRA) && opened.engine === 'scripted',
      `${JSON.stringify(opened)} · ${openMs}ms`)
    check('1c 允许记住了(.grants.json 有它)', JSON.parse(fs.readFileSync(path.join(home, 'stages', '.grants.json'), 'utf8'))[DIRECTOR])
    if (!opened.ok) throw new Error('stage did not open; stopping here')

    // ── 2 截图尺寸 / 不透明 / Space / 时钟 ──
    const shot = await win.evaluate(async () => { const r = await window.__stage.capture(); return { b64: btoa(String.fromCharCode(...r.bytes.subarray(0, 64))), len: r.bytes.length, w: r.width, h: r.height, mime: r.mime, all: Array.from(r.bytes) } })
    const png = Buffer.from(shot.all)
    const sz = pngSize(png)
    check('2a 整窗截图 = 1280×800 @2 → 2560×1600 的 PNG', sz && sz.w === 2560 && sz.h === 1600 && shot.w === 2560 && shot.mime === 'image/png', `${JSON.stringify(sz)} ${shot.len}B`)
    if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); fs.writeFileSync(path.join(SHOT_DIR, 'stage-1-boot.png'), png) }
    const sp = await win.evaluate(async () => { try { return { ok: true, a: await window.__stage.space('Extra space') } } catch (e) { return { ok: false, code: e.code, error: e.message } } })
    check('2b 舞台里切到被拍插件的 Space', sp.ok, JSON.stringify(sp))
    const outline = await win.evaluate(async () => (await window.__stage.read()).outline)
    check('2c 时钟定在 2026-11-20(视图里 new Date() 写的日子)', /NOW 2026-11-20/.test(outline), outline.slice(0, 400))
    check('2d 被拍插件的视图在舞台里画出来了', /Extra view on stage/.test(outline))

    // ── 3 隔离 ──
    const stageVault = path.join(STAGE_ROOT, 'vault')
    check('3a 演示库来自插件包的 fixture/vault', fs.existsSync(path.join(stageVault, 'Welcome.md')) && fs.existsSync(path.join(stageVault, 'Projects', 'Launch.md')), listFiles(stageVault).join(', '))
    check('3b 用户的笔记库一个文件都没多', JSON.stringify(listFiles(VAULT)) === JSON.stringify(vaultBefore), listFiles(VAULT).join(', '))
    const leaked = grepTree(path.join(home, 'stages'), USER_DATA_MARK)
    check('3c 被拍插件在用户那份的插件数据没进舞台', leaked.length === 0 && fs.existsSync(path.join(STAGE_ROOT, 'home', 'plugins', EXTRA, 'manifest.json')), leaked.join(', '))
    check('3d 舞台里没有沙箱条', !/Report a problem|报告问题|Install in my Forsion|安装到我的 Forsion/.test(outline))

    // ── 4 selector 截一块 ──
    const part = await win.evaluate(async () => { try { const r = await window.__stage.capture({ selector: '#stage-extra-card' }); return { ok: true, w: r.width, h: r.height } } catch (e) { return { ok: false, error: e.message } } })
    check('4 selector 截一块 = 元素矩形 × 2(300×120 的卡 + 内边距)', part.ok && part.w >= 600 && part.w <= 680 && part.h >= 240 && part.h <= 300, JSON.stringify(part))

    // ── 5 录像 ──
    const vid = await win.evaluate(async () => {
      try {
        const rec = await window.__stage.record({ fps: 30, cursor: true })
        await window.__stage.click('Extra action')
        await new Promise((r) => setTimeout(r, 2000))
        const v = await rec.stop()
        return { ok: true, len: v.bytes.length, mime: v.mime, w: v.width, h: v.height, ms: v.durationMs, all: Array.from(v.bytes) }
      } catch (e) { return { ok: false, code: e.code, error: e.message } }
    })
    let frames = null
    let videoSec = null
    if (vid.ok) {
      const ext = /mp4/.test(vid.mime) ? 'mp4' : 'webm'
      const f = path.join(SHOT_DIR || home, `stage-rec.${ext}`)
      fs.writeFileSync(f, Buffer.from(vid.all))
      try { frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()) } catch { frames = null }
      try { videoSec = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()) } catch { videoSec = null }
    }
    // 窗口大半时间静着:不补帧的话页签录制不出帧,视频比录的短(11-20 抓到 2.6 秒录成 1.8 秒)
    check('5 录本窗口 2 秒:有字节、宽 = 窗口像素;静着的时候也有帧,视频时长跟得上', vid.ok && vid.len > 10_000 && vid.w === 2560 && vid.ms >= 1800 && (frames === null || frames >= 45) && (videoSec === null || videoSec >= vid.ms / 1000 - 0.5),
      vid.ok ? `${vid.mime} ${vid.w}×${vid.h} ${vid.len}B ${vid.ms}ms frames=${frames} video=${videoSec}s` : JSON.stringify(vid))
    const after = await win.evaluate(async () => (await window.__stage.read()).outline)
    check('5b 录像中的点击真点到了', /Extra action done/.test(after))

    // ── 6 脚本回放引擎 ──
    const chat = await win.evaluate(async (reply) => {
      const s = window.__stage
      const steps = []
      try {
        steps.push((await s.space('tangu')).did)
        await new Promise((r) => setTimeout(r, 1500))
        steps.push((await s.type('Plan Friday for me', { target: 'css:textarea' })).did)
        steps.push((await s.press('Enter')).did)
        for (let i = 0; i < 30; i++) { const o = (await s.read()).outline; if (o.includes(reply.slice(0, 20))) return { ok: true, steps }; await new Promise((r) => setTimeout(r, 500)) }
        return { ok: false, steps, outline: (await s.read()).outline.slice(0, 600) }
      } catch (e) { return { ok: false, steps, code: e.code, error: e.message } }
    }, REPLY)
    check('6 脚本回放:舞台里发一句话 → 出现 engine.json 写的回复', chat.ok, JSON.stringify(chat).slice(0, 700))
    if (SHOT_DIR) { const r = await win.evaluate(async () => Array.from((await window.__stage.capture()).bytes)); fs.writeFileSync(path.join(SHOT_DIR, 'stage-2-chat.png'), Buffer.from(r)) }

    // ── 7 互斥 ──
    const rival = await tryOpen('__rivalStageApi', { plugins: [] })
    check('7 舞台开着时别的插件 open → busy', !rival.ok && rival.code === 'busy', JSON.stringify(rival))

    // ── 8 负对照(各自独立,不碰开着的舞台:参数错在起进程之前就拦下) ──
    const bad1 = await win.evaluate(async () => { try { await window.__stageApi.open({ fixture: '../outside' }); return { ok: true } } catch (e) { return { ok: false, code: e.code } } })
    check('8a fixture 带 .. → invalid', bad1.code === 'invalid', JSON.stringify(bad1))
    const asks = await asked()
    check('8b 允许过的插件再 open 不再问', asks === 2, `asked=${asks}`)

    // ── 9 close ──
    await win.evaluate(() => window.__stage.close())
    const closedState = await win.evaluate(async () => { try { await window.__stage.capture(); return 'captured' } catch (e) { return e.code } })
    check('9 close 之后再调 → closed', closedState === 'closed', closedState)
    const missing = await win.evaluate(async () => { try { await window.__stageApi.open({ plugins: ['not-installed-plugin'] }); return { ok: true } } catch (e) { return { ok: false, code: e.code } } })
    check('8c 点名没装的插件 → plugin-missing', missing.code === 'plugin-missing', JSON.stringify(missing))

    // ── 10 真实的内置插件也能上舞台(演示插件拍日历要的就是这个):主实例启动时播种进隔离 home 的 forsion-calendar ──
    const calDir = path.join(home, 'plugins', 'forsion-calendar')
    if (!fs.existsSync(path.join(calDir, 'manifest.json'))) {
      check('10 内置日历插件上舞台(本构建没播种 forsion-calendar,无从测)', false, fs.existsSync(path.join(home, 'plugins')) ? fs.readdirSync(path.join(home, 'plugins')).join(', ') : 'no plugins dir')
    } else {
      const cal = await win.evaluate(async (needle) => {
        try {
          const s = await window.__stageApi.open({ fixture: 'fixtures/calendar', engine: 'scripted', plugins: ['forsion-calendar'], window: [1280, 800, 2], theme: 'light', clock: '2026-11-20T10:00' })
          const a = await s.space('日历').catch((e) => ({ err: e.code + ' ' + e.message }))
          let outline = ''
          for (let i = 0; i < 20; i++) { outline = (await s.read()).outline; if (outline.includes(needle)) break; await new Promise((r) => setTimeout(r, 500)) }
          const shot = await s.capture()
          await s.close()
          return { ok: true, plugins: s.plugins, a, seen: outline.includes(needle), outline: outline.slice(0, 1200), png: Array.from(shot.bytes) }
        } catch (e) { return { ok: false, code: e.code, error: e.message } }
      }, CAL_EVENT)
      if (cal.ok && SHOT_DIR) fs.writeFileSync(path.join(SHOT_DIR, 'stage-3-calendar.png'), Buffer.from(cal.png))
      check('10a 内置日历插件上舞台:open 认得、切得到日历 Space、能截图', cal.ok && cal.plugins.includes('forsion-calendar') && !cal.a?.err && cal.png.length > 10_000,
        cal.ok ? `${JSON.stringify(cal.a)} · ${cal.outline.slice(0, 200)}` : JSON.stringify(cal))
      check('10b 个人日历读的是 fixture 的 human/CALENDAR.db:那条日程出现在日历页上(周视图格子或右侧待办栏,截图另看)', cal.ok && cal.seen, cal.ok ? cal.outline : JSON.stringify(cal))
    }
  } catch (e) {
    check('台架本身没出错', false, e && e.stack || String(e))
  } finally {
    if (app) await app.close().catch(() => {})
    try { await stub.close?.() } catch { /* 已关 */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(' / ')}` : ''}`)
  if (!process.env.KEEP_HOME) fs.rmSync(home, { recursive: true, force: true }); else console.log('home kept at', home)
  process.exit(failed.length ? 1 : 0)
}
main()
