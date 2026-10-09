/**
 * sketch 演示录像(10-09,对标 ChatGPT Intelligent UI):真 Electron + 桩引擎,把真模型写出来的卡按 tool_stream 一段段喂进去,
 * 录下「卡边生成边长出来(单 iframe 原地补丁,不闪)→ 滑块 / 勾选 / 复制 → 第二张用统一部件 fs-compare / fs-choice → 点选项把追问当用户消息发出去」。
 * 不是台架,没有断言,只出视频。
 *   npm run build && node scripts/sketch-demo.record.cjs [第一张卡 html 路径] [第二张卡 html 路径]
 * 第一张缺省 fixtures/sketch-demo-card.html = 真模型(gpt-6-luna,live 台架 visualplan 场景)写的周末晚餐卡;
 * 第二张缺省 fixtures/sketch-demo-card2.html = 手写的 fs-compare + fs-choice JSON(演示统一部件,不是模型产物)。
 * 产物:outputs/sketch-demo/demo.mp4 / demo.gif(需 ffmpeg)。
 */
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'outputs/sketch-demo')
const cardPath = process.argv[2] || path.join(__dirname, 'fixtures/sketch-demo-card.html')
const cardHtml = fs.readFileSync(cardPath, 'utf8')
const card2Html = fs.readFileSync(process.argv[3] || path.join(__dirname, 'fixtures/sketch-demo-card2.html'), 'utf8')
/** 把一张卡切成 n 段 tool_stream(真引擎就是按模型输出切片发的) */
const streamOf = (id, args, n, delay) => {
  const step = Math.ceil(args.length / n), out = []
  for (let i = 0; i < args.length; i += step) out.push({ type: 'tool_stream', payload: { id, name: 'sketch', delta: args.slice(i, i + step) }, delay })
  return out
}
/** 找到含某选择器的卡内 frame */
async function frameWith(win, selector) {
  for (const fr of win.frames()) { try { if (await fr.locator(selector).count()) return fr } catch { /* ignore */ } }
  return null
}
const SESSION = {
  id: 's1', title: '可视化演示', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
  created_at: '2026-10-09 09:00:00', updated_at: '2026-10-09 09:00:00',
}
async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40; i++) { if (await ta.isEnabled().catch(() => false)) break; await win.waitForTimeout(500) }
  await ta.click(); await ta.pressSequentially(text, { delay: 35 }); await win.waitForTimeout(400); await win.keyboard.press('Enter')
}
async function main() {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true })
  const stub = await startStubEngine({ sessions: [SESSION], messages: [], models: [{ id: 'm1', name: 'GPT-6 Luna', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off', 'low', 'medium'] }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-sketchdemo-'))
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'demo' }))
  }
  const t0 = Date.now()
  let sendAt = 0 // 第一次发消息的时刻:成片从这里前 1.5s 起剪,去掉启动与导航那 30 多秒
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) { const b = win.locator(`text=${label}`).first(); if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break } }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(1000)
    await enterSpace(win, 'tangu')
    await win.waitForTimeout(1000)
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) { await win.click('.dv-edge-left').catch(() => {}); await win.waitForTimeout(600) }
    const row = win.locator(`.t2s-srow[data-sel-id="${SESSION.id}"]`).first()
    await row.waitFor({ timeout: 10_000 }); await row.click(); await win.waitForTimeout(1200)

    // 第一轮:正文 → 真模型写的晚餐卡按 tool_stream 流式长出来(60 段、每段 110ms)→ 终稿原地接上脚本 → 收尾
    const args1 = JSON.stringify({ title: '周末晚餐计划', html: cardHtml })
    stub.script([
      { type: 'token', payload: { delta: '四个人、三道菜，' }, delay: 600 },
      { type: 'token', payload: { delta: '我先给你一张能动的计划卡：' }, delay: 350 },
      { type: 'token', payload: { delta: '拖人数，用量跟着变；采购清单可以勾，也能一键复制。' }, delay: 350 },
      ...streamOf('sk1', args1, 60, 110),
      { type: 'tool_call', payload: { id: 'sk1', name: 'sketch', arguments: args1 }, delay: 200 },
      { type: 'tool_result', payload: { id: 'sk1', result: 'Sketch card rendered in the conversation.' } },
      { type: 'token', payload: { delta: '牛腩类的菜可以提前一天做；想换主菜就说。' }, delay: 500 },
    ])
    // 第二轮(用户追问):统一部件 fs-compare(每个选项自带「展开做法」)+ fs-choice
    const args2 = JSON.stringify({ title: '主菜换一换', html: card2Html })
    stub.script([
      { type: 'token', payload: { delta: '有，三种主菜并排给你看：' }, delay: 700 },
      ...streamOf('sk2', args2, 30, 110),
      { type: 'tool_call', payload: { id: 'sk2', name: 'sketch', arguments: args2 }, delay: 200 },
      { type: 'tool_result', payload: { id: 'sk2', result: 'Sketch card rendered in the conversation.' } },
      { type: 'token', payload: { delta: '点哪一种，我就展开那一种的做法。' }, delay: 400 },
    ])
    // 第三轮(点卡里的选项触发):追问当用户消息发出 → 助手接着答
    stub.script([
      { type: 'token', payload: { delta: '好，红烧牛腩的做法和时间安排：' }, delay: 900 },
      { type: 'token', payload: { delta: '\n\n- **周五晚**：牛腩焯水、炒糖色、加料炖 80 分钟，关火连汤放凉冷藏\n' }, delay: 500 },
      { type: 'token', payload: { delta: '- **周六开饭前 20 分钟**：撇掉表面的油，小火回热，收汁到挂勺\n' }, delay: 400 },
      { type: 'token', payload: { delta: '- **用量**：按卡上 6 人份是 1200 g，配 450 g 生米的米饭正好' }, delay: 400 },
    ])
    sendAt = Date.now()
    await send(win, '周末请四个朋友来吃饭，帮我安排三道菜')
    await win.waitForTimeout(12_000)
    const card = win.locator('[data-sketch-call-id="sk1"]').last()
    await card.scrollIntoViewIfNeeded().catch(() => {})
    await win.waitForTimeout(1200)
    // 卡里动一动:人数 4 → 6(用量跟着变)、勾两样、复制清单
    const f1 = await frameWith(win, '#dinner-people')
    if (f1) {
      const slider = f1.locator('#dinner-people')
      await slider.hover(); await win.waitForTimeout(500)
      for (const v of ['5', '6']) { await slider.fill(v); await win.waitForTimeout(650) }
      const boxes = f1.locator('.fs-checklist-items input')
      await boxes.nth(0).click(); await win.waitForTimeout(600)
      await boxes.nth(1).click(); await win.waitForTimeout(700)
      const copy = f1.locator('#dinner-copy'); await copy.hover(); await win.waitForTimeout(500); await copy.click(); await win.waitForTimeout(900)
    }
    await send(win, '主菜还有别的选择吗？')
    await win.waitForTimeout(8_000)
    const card2 = win.locator('[data-sketch-call-id="sk2"]').last()
    await card2.scrollIntoViewIfNeeded().catch(() => {})
    await win.waitForTimeout(1200)
    const f2 = await frameWith(win, '.fs-option .fs-button')
    if (f2) { const btn = f2.locator('.fs-option .fs-button').nth(1); await btn.hover(); await win.waitForTimeout(700); await btn.click() }
    await win.waitForTimeout(6500)
    await win.locator('.t2-asst').last().scrollIntoViewIfNeeded().catch(() => {})
    await win.waitForTimeout(2500)
    await win.screenshot({ path: path.join(OUT, 'final.png') }).catch(() => {})
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* 桩已关 */ }
  }
  const webm = fs.readdirSync(OUT).find((f) => f.endsWith('.webm'))
  if (!webm) throw new Error('没有录到视频')
  const src = path.join(OUT, webm)
  const from = Math.max(0, (sendAt - t0) / 1000 - 1.5).toFixed(1)
  try {
    execSync(`ffmpeg -y -loglevel error -ss ${from} -i "${src}" -movflags +faststart -pix_fmt yuv420p -vf "scale=1280:-2" "${path.join(OUT, 'demo.mp4')}"`)
    execSync(`ffmpeg -y -loglevel error -ss ${from} -i "${src}" -vf "fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" "${path.join(OUT, 'demo.gif')}"`)
  } catch (e) { console.error('ffmpeg 失败:', e.message) }
  console.log('录像:', OUT, fs.readdirSync(OUT).join(', '))
}
main().catch((e) => { console.error(e); process.exit(1) })
