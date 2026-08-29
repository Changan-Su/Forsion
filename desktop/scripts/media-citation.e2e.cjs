/**
 * 媒体时刻 / 块锚 / Office 引用条整链 e2e:真 Electron × 真组件 × 可编剧假引擎
 * (file-citation.e2e / pdf-citation.e2e / web-citation.e2e 的姊妹篇,骨架逐字同源)。
 *
 * 这一轮新开的三条引用形态,各自都有一种**静默失败**的前科,断言就是冲它们去的:
 *   M1  `[[素材/lecture.wav#t=95]]` 库内媒体 —— 本轮之前渲染成**灰色未解析链**
 *   M2  点开落在 amadeus-media 视图并**真的停在 95 秒**(量 currentTime,不量 src:
 *       时刻从来不写进 src,量 src 是一条恒绿的假断言)
 *   M3  同一份媒体的第二个时刻 → 就地 seek,**播放器不重挂**(重挂 = 整段视频重新起流)
 *   M4  `[[/abs/talk.wav#t=20]]` 库外媒体 —— 本轮之前能打开但**时间戳被静默吃掉**
 *       (fileCite 的 isHostPath 分支只排除 .pdf,把媒体锚抢走了,从 0 秒起播,零报错)
 *   M5  `[[资料/报告.docx]]` 库内 Office —— 本轮之前恒灰(fileCite 只认带 #L 的)
 *   M6  老消息里的 `[[资料/报告.docx#page=3]]` 要优雅降级(照样打开,页码忽略)
 *   M7  `[[笔记/长文.md#^blk7]]` 块锚 —— 本轮之前只开笔记不跳
 *   M8  负对照:`[[笔记/长文.md#t=90]]` **不许**被媒体分支抢走(非音视频后缀 = 标题锚)
 *
 * 需先 npm run build(e2e 吃 out/ 产物,不重建 = 在验旧代码)。用法:npm run e2e:mediacite
 * ⚠️ 有 dev 版 Electron 在跑会「启动失败」(单实例锁):pkill -f "node_modules/electron/dist/Electron.app"
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 's1', title: '媒体引用会话', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
  created_at: '2026-08-28 09:00:00', updated_at: '2026-08-28 09:00:00',
}

/** 200 秒 8kHz 静音 wav —— 免 ffmpeg,Chromium 一定认,且够 seek 到 95 秒(抄 media-embed.e2e)。 */
function silentWav(seconds) {
  const rate = 8000
  const n = rate * seconds
  const buf = Buffer.alloc(44 + n)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34)
  buf.write('data', 36); buf.writeUInt32LE(n, 40)
  buf.fill(128, 44)
  return buf
}

/** 轮询等 Desk 里的播放器就位并 seek 到位(最长 20s)。
 *  ⚠️ 量的是 `currentTime` 而**不是** src —— 时刻锚从来不写进 src(实现就不是那么做的),
 *     量 src 会得到一条永远绿的假断言(media-embed.check.cjs 文件头同款教训)。
 *  `mark` 是给「不重挂」用的身份戳:同一个 DOM 元素才留得住它。 */
async function waitSeek(win, sel, want, ms = 20_000) {
  const t0 = Date.now()
  let snap = { found: false, at: null, count: 0, mark: null }
  while (Date.now() - t0 < ms) {
    snap = await win.evaluate((s) => {
      const els = [...document.querySelectorAll(s)]
      const el = els[0]
      return {
        found: !!el,
        at: el ? el.currentTime : null,
        ready: el ? el.readyState : -1,
        count: els.length,
        mark: el ? el.dataset.e2emark || null : null,
      }
    }, sel).catch(() => snap)
    if (snap.found && snap.at != null && Math.abs(snap.at - want) < 1.5) return snap
    await win.waitForTimeout(400)
  }
  return snap
}

/** 点引用条前先把指针挪开并等悬停浮卡撤掉:引用条彼此挨着,上一条点完指针停在原地 →
 *  `.amx-hoverprev` 弹出来盖住下一条 → Playwright 报「subtree intercepts pointer events」并轮询到超时。
 *  (这不是产品 bug:真人点完会移开手;台架的指针不会自己动。) */
async function clickChip(win, chips, i) {
  await win.mouse.move(1200, 1320) // 挪到输入框那边,别停在引用条上
  for (let k = 0; k < 15 && (await win.locator('.amx-hoverprev').count().catch(() => 0)); k++) await win.waitForTimeout(200)
  try {
    await chips.nth(i).click({ timeout: 5000 })
  } catch {
    // 浮卡赖着不走时的兜底:直接派发 click(绕过命中测试)。**只有台架会走到这条** ——
    // 真人点完会把手移开、浮卡自己退;而 force:true 没用(它按坐标点,坐标上最顶的还是浮卡)。
    await chips.nth(i).dispatchEvent('click')
  }
}

/** 笔记类引用条点开后主区变成笔记,聊天面被顶掉 —— 侧栏点回该会话,等引用条重新在场。 */
async function backToChat(win) {
  if (process.env.MEDIACITE_DEBUG) {
    const d = await win.evaluate(() => ({
      srows: document.querySelectorAll('.t2s-srow').length,
      search: document.querySelectorAll('.t2s-search input').length,
      t2: document.querySelectorAll('.t2-content').length,
      back: [...document.querySelectorAll('button,[role=button]')].map((b) => b.className?.toString?.() || '').filter((c) => /back|nav|prev/i.test(c)).slice(0, 8),
    }))
    console.log('BACKDBG', JSON.stringify(d))
  }
  // 走标签页的**后退**按钮(.dv-nav-btn 第一枚)。刻意不点侧栏会话行:笔记占据主区时
  // 侧栏那份会话列表是空的(实测 srows=0 而搜索框还在),点不到。
  await win.locator('.dv-nav-btn').first().click().catch(() => {})
  await win.waitForSelector('.t2-content a.wikilink', { timeout: 30_000 })
  await win.waitForTimeout(600)
}

/** 200 秒纯色静音 mp4(抄 media-embed.e2e)。ffmpeg 缺席 → null,视频档整体 SKIP:
 *  音频与视频走的是同一条码路(同一个 MediaPlayer / 同一个 seek),音频档已覆盖逻辑;
 *  视频档多验的是「video 元素也认」与观感。**通过条数会因此变少,别把少一条当成全绿**。 */
function makeMp4(dst) {
  try {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=teal:s=480x270:d=200:r=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dst], { stdio: 'ignore' })
    return fs.existsSync(dst) ? dst : null
  } catch { return null }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-mediacite-'))
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(path.join(vaultDir, '素材'), { recursive: true })
  fs.mkdirSync(path.join(vaultDir, '资料'), { recursive: true })
  fs.mkdirSync(path.join(vaultDir, '笔记'), { recursive: true })
  fs.writeFileSync(path.join(vaultDir, '素材', 'lecture.wav'), silentWav(200))
  const mp4 = makeMp4(path.join(vaultDir, '素材', 'clip.mp4'))
  if (!mp4) console.log('  (没有 ffmpeg → 视频档 SKIP,音频档照跑)')
  // 库外音频:transcribe_audio 给的就是绝对路径,这是**主要**场景不是边角
  const hostWav = path.join(home, 'media', 'talk.wav')
  fs.mkdirSync(path.dirname(hostWav), { recursive: true })
  fs.writeFileSync(hostWav, silentWav(200))
  const badWav = path.join(home, 'media', 'bad.wav') // M9 专用:换一份文件,「照样打开」才是真断言
  fs.writeFileSync(badWav, silentWav(120))
  // Office 夹具:本用例只验「引用条解不解析 / 点开落不落 wsfile」,不验 docx 渲染本身
  // (那是既有能力)。所以这里刻意用一个假 docx —— 渲染失败卡片也是 wsfile 的合法形态。
  fs.writeFileSync(path.join(vaultDir, '资料', '报告.docx'), 'not a real docx')
  // 长笔记:块锚在很后面,滚没滚一目了然(同 file-citation 的标题锚夹具)
  const mdParts = ['# 长文', '', '开头一段。', '']
  for (let s = 1; s <= 30; s++) mdParts.push(`## 第${s}节`, '', `第 ${s} 节的内容,凑够行数。`, '正文再来一行。', '')
  mdParts.push('这一段是块锚的目标。 ^blk7', '')
  // 跨容器的光杆锚:`^blk9` 独占引用块的第一段 —— 文档序的上一块在**引用块外面**,
  // 「光杆锚指上一块」若不限定同父,就会跳到那段无关正文上。
  mdParts.push('上一段:不该跳到这里(普通段落)。', '', '> ^blk9', '>', '> 引用块里的正文。', '')
  fs.writeFileSync(path.join(vaultDir, '笔记', '长文.md'), mdParts.join('\n'))
  const udDev = path.join(home, 'userdata-dev')
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(path.join(udDev, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }))

  const stub = await startStubEngine({
    sessions: [SESSION],
    messages: [{
      id: 'hm1', role: 'model', timestamp: 1787100000000,
      content: '讲到重点在 [[素材/lecture.wav#t=95]],后面还有一处 [[素材/lecture.wav#t=140]];'
        + `外面那份录音 [[${hostWav}#t=20]];`
        + '报告见 [[资料/报告.docx]],老形态 [[资料/报告.docx#page=3]];'
        + '笔记里那段 [[笔记/长文.md#^blk7]];'
        + '非音视频的 [[笔记/长文.md#t=90]] 是标题锚不是时刻。'
        // 视频档挂在这儿:ffmpeg 缺席时少这一条,**前面**所有 chips.nth(i) 的序号不受影响;
        // 后面三条按 base 偏移取(见下面的 idxBad/idxSpan/idxBq)。
        + (mp4 ? '视频那段见 [[素材/clip.mp4#t=95]]。' : '')
        + `锚点写错的 [[${badWav}#t=1:35]];`   // 钟表形态判非法(Logseq #9920)
        + `区间的 [[${hostWav}#t=95,120]];`
        + '引用块里的 [[笔记/长文.md#^blk9]];'
        + '库内区间的 [[素材/lecture.wav#t=95,120]];'
        + `不带锚点重开 [[${hostWav}]];`
        + `区间终点写坏的 [[${hostWav}#t=95,80]]。`,
    }],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
  })
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.waitForTimeout(1200)
    // ⚠️ e2e 与用户 dev 实例共用 renderer 存储(dev userData 恒为 forsion-desktop-dev),
    // 「上次 Space」谁最后用谁说了算 —— 不显式切,断言会跑在根本没有聊天侧栏的界面上。
    const spaceBtn = win.locator('.rb-space[title="Tangu"]').first()
    if (await spaceBtn.count().catch(() => 0)) { await spaceBtn.click().catch(() => {}); await win.waitForTimeout(1000) }
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    await win.locator('.t2s-srow', { hasText: '媒体引用会话' }).first().click().catch(() => {})
    await win.waitForTimeout(1200)
    try {
      await win.waitForSelector('.t2-content a.wikilink', { timeout: 30_000 })
    } catch (e) {
      const f = await win.evaluate(() => ({
        links: document.querySelectorAll('.t2-content a.wikilink').length,
        gray: document.querySelectorAll('.t2-content .wikilink-unresolved').length,
        t2: document.querySelectorAll('.t2-content').length,
        srows: document.querySelectorAll('.t2s-srow').length,
      })).catch(() => null)
      console.log('FAILDBG', JSON.stringify(f))
      await win.screenshot({ path: '/tmp/mediacite-fail.png' }).catch(() => {})
      throw e
    }
    await win.waitForTimeout(800)

    // ── M1 七条引用条全部解析(一条灰的都不许有),文案逐字比对 ────────────────────────
    const base = mp4 ? 8 : 7 // 视频档在场时后面三条各后移一位
    const chips = win.locator('.t2-content a.wikilink')
    const n = await chips.count().catch(() => 0)
    const labels = await chips.allInnerTexts().catch(() => [])
    const gray = await win.locator('.t2-content .wikilink-unresolved').count().catch(() => 0)
    const want = 'lecture.wav @01:35|lecture.wav @02:20|talk.wav @00:20|报告.docx|报告.docx|长文 › ^blk7|长文 › t=90'
      + (mp4 ? '|clip.mp4 @01:35' : '')
      // 非法锚点那条**故意没有 `@`**:那就是「非法锚点不许静默变成 0 秒」在引用条上的可见形态
      + '|bad.wav|talk.wav @01:35–02:00|长文 › ^blk9|lecture.wav @01:35–02:00|talk.wav|talk.wav @01:35'
    check('M1 媒体/Office/块锚引用条全部解析,文案 = ' + want,
      n === (mp4 ? 14 : 13) && gray === 0 && labels.join('|') === want,
      `chips=${n} gray=${gray} labels=${labels.join('|')}`)

    // ── M2 库内媒体 → amadeus-media 视图,真的停在 95 秒 ───────────────────────────
    await clickChip(win, chips, 0)
    await win.waitForSelector('.agent-desk .amx-mediaview', { timeout: 20_000 }).catch(() => {})
    const s1 = await waitSeek(win, '.agent-desk .amx-mediaview audio', 95)
    check('M2 点库内时刻引用条 → Desk 开 amadeus-media 播放器并 seek 到 95 秒',
      s1.found && Math.abs((s1.at ?? -1) - 95) < 1.5, `found=${s1.found} at=${s1.at} ready=${s1.ready}`)
    // 载体校验:必须走 amadeus-asset:// 流式,而不是 WsFileView 的 blob:(GB 级视频的分水岭)
    const src1 = await win.evaluate(() => document.querySelector('.agent-desk .amx-mediaview audio')?.getAttribute('src') || '')
    check('M2b 载体是 amadeus-asset:// 流式协议(不是把整份文件读成 blob:)',
      src1.startsWith('amadeus-asset://'), `src=${src1.slice(0, 40)}`)

    // ── M3 同一份媒体的第二个时刻 → 就地 seek,播放器不重挂 ─────────────────────────
    await win.evaluate(() => { const el = document.querySelector('.agent-desk .amx-mediaview audio'); if (el) el.dataset.e2emark = 'keep' })
    await clickChip(win, chips, 1)
    const s2 = await waitSeek(win, '.agent-desk .amx-mediaview audio', 140)
    check('M3 同一份媒体的第二个时刻就地跳到 140 秒(播放器不重挂:身份戳还在、只有一个元素)',
      Math.abs((s2.at ?? -1) - 140) < 1.5 && s2.mark === 'keep' && s2.count === 1,
      `at=${s2.at} mark=${s2.mark} count=${s2.count}`)

    // ── M3b 库内的区间锚:**已挂载**的播放器收到带 to 的 goto,也要到点暂停 ────────────────
    // ⚠️ props 的 loc 是冷挂载那一次的锚,已挂载后 params 到不了视图 —— 只 seek 不更新 to
    //    = 到点不暂停,而且是静默的(Codex 二审)。所以必须在**同一个播放器**上点第二条区间引用。
    await clickChip(win, chips, base + 3)
    const s3b = await waitSeek(win, '.agent-desk .amx-mediaview audio', 95)
    const p3b = await win.evaluate(async () => {
      const el = document.querySelector('.agent-desk .amx-mediaview audio')
      if (!el) return null
      el.muted = true
      el.currentTime = 119.4
      await el.play().catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
      return { paused: el.paused, at: el.currentTime }
    }).catch(() => null)
    check('M3b 库内已挂载播放器收到区间锚 goto:seek 到 95 且到 120 秒自动暂停',
      Math.abs((s3b.at ?? -1) - 95) < 1.5 && !!p3b?.paused && (p3b.at ?? 0) >= 119.4,
      `seek=${s3b.at} ${JSON.stringify(p3b)}`)

    // 观感探针 A(音频档):DESIGN.md §8 —— 一条 40px 控制条独自浮在整格中央看着像没加载出来,
    // 这一张就是为了看见它。必须趁这会儿拍,后面点笔记引用条主区就换成笔记了。
    if (process.env.MEDIACITE_SHOT) {
      await win.waitForTimeout(3000) // 等 Desk 卡片入场动画 + 启动 toast 退场,否则拍到半透明残影
      await win.screenshot({ path: '/tmp/mediacite-audio.png' })
      console.log('  截图 /tmp/mediacite-audio.png')
    }

    // ── M2v 视频档:同一条码路,验 <video> 也认(ffmpeg 缺席则 SKIP)────────────────
    if (mp4) {
      await clickChip(win, chips, 7)
      const sv = await waitSeek(win, '.agent-desk .amx-mediaview video', 95)
      check('M2v 视频时刻引用条 → amadeus-media 里 <video> seek 到 95 秒',
        sv.found && Math.abs((sv.at ?? -1) - 95) < 1.5, `found=${sv.found} at=${sv.at} ready=${sv.ready}`)
    }

    // 观感探针 B(视频档)
    if (process.env.MEDIACITE_SHOT && mp4) {
      await win.waitForTimeout(2000)
      await win.screenshot({ path: '/tmp/mediacite-video.png' })
      console.log('  截图 /tmp/mediacite-video.png')
    }

    // ── M4 库外媒体 → WsFileView 也要 seek(本轮之前这里静默从 0 秒起播)────────────
    await clickChip(win, chips, 2)
    const s3 = await waitSeek(win, '.agent-desk .wsfile-media audio', 20)
    check('M4 库外绝对路径的时刻引用条 → WsFileView 里 seek 到 20 秒(不再静默吃掉时间戳)',
      s3.found && Math.abs((s3.at ?? -1) - 20) < 1.5, `found=${s3.found} at=${s3.at} ready=${s3.ready}`)

    // ── M9 非法锚点:不许静默变成 0 秒 —— 照样开播放器,但引用条上没有 `@`、title 明说无效 ────
    await clickChip(win, chips, base)
    let s9 = { found: false }
    for (let i = 0; i < 30; i++) {
      s9 = await win.evaluate(() => {
        const el = document.querySelector('.agent-desk .wsfile-media audio')
        return { found: !!el, dur: el ? el.duration : null, at: el ? el.currentTime : null }
      }).catch(() => s9)
      if (s9.found && s9.dur > 100 && s9.dur < 140) break // 120 秒那份 = bad.wav 换进来了
      await win.waitForTimeout(400)
    }
    const tip9 = await chips.nth(base).getAttribute('title').catch(() => '')
    check('M9 `#t=1:35`(钟表形态判非法)照样打开媒体,且引用条明说锚点无效(不是静默从 0 秒起播)',
      s9.found && s9.dur > 100 && s9.dur < 140 && (tip9 || '').includes('锚点无效'),
      `found=${s9.found} dur=${s9.dur} at=${s9.at} title=${tip9}`)

    // ── M10 区间锚 `#t=95,120`:库外那条也要「到点暂停」(库内走 MediaPlayer 本来就有)──────
    await clickChip(win, chips, base + 1)
    const s10 = await waitSeek(win, '.agent-desk .wsfile-media audio', 95)
    // 直接播到终点太慢:推到 119.4 秒再放,timeupdate 一到 120 就该 pause。muted 免得撞自动播放策略。
    const paused = await win.evaluate(async () => {
      const el = document.querySelector('.agent-desk .wsfile-media audio')
      if (!el) return null
      el.muted = true
      el.currentTime = 119.4
      await el.play().catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
      return { paused: el.paused, at: el.currentTime }
    }).catch(() => null)
    check('M10 区间锚的终点也传到了库外播放器:到 120 秒自动暂停',
      Math.abs((s10.at ?? -1) - 95) < 1.5 && !!paused?.paused && (paused.at ?? 0) >= 119.4,
      `seek=${s10.at} ${JSON.stringify(paused)}`)

    // ── M12 区间残留:普通(不带锚点)重开同一份库外媒体,上一条的暂停点必须**清掉** ───────
    // ⚠️ 区间锚注册的 timeupdate 监听会一直活着 —— 不清的话从文件面板正常打开这段视频,
    //    播到 120 秒还是自己停,界面上没有任何东西说明「还在区间模式」(Codex 三审)。
    await clickChip(win, chips, base + 4)
    await win.waitForTimeout(1500)
    const p12 = await win.evaluate(async () => {
      const el = document.querySelector('.agent-desk .wsfile-media audio')
      if (!el) return null
      el.muted = true
      el.currentTime = 119.4
      await el.play().catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
      return { paused: el.paused, at: el.currentTime }
    }).catch(() => null)
    check('M12 不带锚点重开同一份媒体 → 上一条区间锚的暂停点已清掉(能播过 120 秒)',
      !!p12 && !p12.paused && (p12.at ?? 0) > 120.2, JSON.stringify(p12))

    // ── M13 降级 ≠ 静默:终点写坏(`t=95,80`)时起点照用,但 title 要说明终点被忽略 ──────────
    // (不点击,只看 title —— 这条要证的就是「降级之后用户看得见」。)
    const tip13 = await chips.nth(base + 5).getAttribute('title').catch(() => '')
    check('M13 区间终点写坏 → 起点仍生效(@01:35)且 title 说明终点已忽略',
      (tip13 || '').includes('区间终点无效'), `title=${tip13}`)

    // ── M5/M6 Office 引用条:裸链与老 page= 链都能打开 ─────────────────────────────
    // 判据 = Desk 里真出现了这份文件(名字上屏)。用 innerText 而不是猜某个 class:
    // 前面那次 M2/M4 开的是别的文件,所以「Desk 里写着 报告.docx」足以证明这一次点开生效了。
    const deskHas = async (t) => {
      for (let i = 0; i < 24; i++) {
        const txt = await win.evaluate(() => document.querySelector('.agent-desk')?.innerText || '').catch(() => '')
        if (txt.includes(t)) return true
        await win.waitForTimeout(400)
      }
      return false
    }
    await clickChip(win, chips, 3)
    const office1 = await deskHas('报告.docx')
    check('M5 库内 Office 裸引用条能打开(本轮之前恒灰)', office1, `deskHas=${office1}`)
    // 换个别的文件再回来,免得 M6 拿 M5 的残留当绿灯(不换的话 Desk 里本来就写着 报告.docx)
    await clickChip(win, chips, 2)
    await deskHas('talk.wav')
    await clickChip(win, chips, 4)
    const office2 = await deskHas('报告.docx')
    check('M6 老形态 `[[…docx#page=3]]` 优雅降级:照样打开,页码忽略,不崩不灰', office2, `deskHas=${office2}`)

    // ── M8 负对照:非音视频后缀的 `#t=90` 不许被媒体分支抢走 ───────────────────────
    // ⚠️ **笔记类引用条一点就走**:openNote 在主区打开笔记 = 聊天视图连同这些引用条一起被顶掉,
    //    之后 chips.nth(n) 永远等不到(第一版红两次都是这个,不是断言写错)。所以每点一条笔记
    //    引用条,下一条之前必须 backToChat() 把聊天面切回来。媒体/Office 那几条开在 Desk 里
    //    (聊天不动),不受此限。
    // (M1 已逐字比对过 `长文 › t=90` 这条文案 —— 一旦被抢走会变成 `长文.md @01:30`。)
    await clickChip(win, chips, 6)
    await win.waitForTimeout(1500)
    const stolen = await win.evaluate(() => document.querySelectorAll('.agent-desk .amx-mediaview').length)
    check('M8 负对照:`[[笔记.md#t=90]]` 走笔记标题锚,没被媒体分支抢走(没开出播放器)',
      stolen === 0, `mediaViews=${stolen}`)

    await backToChat(win)

    // ── M7 块锚:笔记打开 + 目标块滚进视口 + 落点闪一下 ────────────────────────────
    // ⚠️ 覆盖片 `.am-citeflash` 1.4s 后自撤,事后轮询必扑空 —— 点击**之前**挂 MutationObserver
    //    记快照(file-citation 的 F7b 同款,那条注释写着这是相位敏感的)。
    await win.evaluate(() => {
      window.__flashSeen = null
      const mo = new MutationObserver(() => {
        const el = document.querySelector('.am-citeflash')
        if (el && !window.__flashSeen) {
          const r = el.getBoundingClientRect()
          window.__flashSeen = { top: r.top, bottom: r.bottom, h: r.height }
        }
      })
      mo.observe(document.body, { childList: true, subtree: true })
      window.__flashMo = mo
    })
    await clickChip(win, chips, 5)
    let blk = { seen: false }
    for (let i = 0; i < 40; i++) {
      blk = await win.evaluate(() => {
        const nodes = [...document.querySelectorAll('.ProseMirror p, .ProseMirror div')]
        const el = nodes.find((x) => (x.textContent || '').includes('这一段是块锚的目标'))
        if (!el) return { seen: false, flash: window.__flashSeen }
        const r = el.getBoundingClientRect()
        const sc = el.closest('.amx-pane, .dv-groupview') || document.documentElement
        const sr = sc.getBoundingClientRect()
        return { seen: true, inView: r.bottom > sr.top && r.top < sr.bottom, top: r.top, bottom: r.bottom, flash: window.__flashSeen }
      }).catch(() => blk)
      if (blk.seen && blk.inView && blk.flash) break
      await win.waitForTimeout(250)
    }
    check('M7 块锚 `#^blk7` → 笔记打开且目标块滚进视口', blk.seen && blk.inView, JSON.stringify({ seen: blk.seen, inView: blk.inView }))
    const overlap = blk.flash && blk.top != null && blk.flash.bottom > blk.top - 12 && blk.flash.top < blk.bottom + 12
    check('M7b 落点提醒覆盖片闪在**那个块**上(不是别处、不是没闪)', !!overlap,
      `flash=${JSON.stringify(blk.flash)} block=[${blk.top},${blk.bottom}]`)
    await win.evaluate(() => window.__flashMo?.disconnect())

    // ── M11 跨容器的光杆锚:`^blk9` 独占引用块首段,**不许**退到引用块外面那段 ─────────────
    // 判据用 DOM 选区(PM 的 setSelection 会同步到 window.getSelection),它能精确说出落在哪个块;
    // 两段在屏幕上紧挨着,拿几何/落点闪根本区分不开。
    await backToChat(win)
    await clickChip(win, chips, base + 2)
    let sel = null
    for (let i = 0; i < 40; i++) {
      sel = await win.evaluate(() => {
        const s = document.getSelection()
        const n = s && s.anchorNode
        const el = n && (n.nodeType === 1 ? n : n.parentElement)
        const blk = el && el.closest('p, li, blockquote')
        return blk ? { text: (blk.textContent || '').slice(0, 30), inQuote: !!blk.closest('blockquote') } : null
      }).catch(() => null)
      if (sel && (sel.inQuote || sel.text.includes('不该跳到'))) break
      await win.waitForTimeout(250)
    }
    check('M11 引用块里的光杆锚 `^blk9` 落在引用块内,没退到块外那段无关正文',
      !!sel && sel.inQuote && !sel.text.includes('不该跳到'), JSON.stringify(sel))

  } finally {
    await app.close().catch(() => {})
    try { await stub.close() } catch { /* 桩关不掉不该盖掉断言结果 */ }
  }
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
