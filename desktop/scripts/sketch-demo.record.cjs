/**
 * sketch 演示录像(10-09,对标 ChatGPT Intelligent UI):真 Electron + 桩引擎,把真模型写出来的卡按 tool_stream 一段段喂进去,
 * 录下「草稿卡边生成边长出来 → 终稿换上 → 点卡里的按钮把追问当用户消息发出去」。不是台架,没有断言,只出视频。
 *   npm run build && node scripts/sketch-demo.record.cjs [卡片 html 路径]
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

    // 第一轮:正文 → 卡按 tool_stream 流式长出来(真模型 gpt-6-luna 在 live 台架里写的那张卡,按 60 段、每段 110ms 喂)→ 终稿 → 收尾
    const args = JSON.stringify({ title: '三种部署方式', html: cardHtml })
    const n = 60, step = Math.ceil(args.length / n)
    const deltas = []
    for (let i = 0; i < args.length; i += step) deltas.push({ type: 'tool_stream', payload: { id: 'sk1', name: 'sketch', delta: args.slice(i, i + step) }, delay: 110 })
    stub.script([
      { type: 'token', payload: { delta: '三种部署方式各有取舍，' }, delay: 600 },
      { type: 'token', payload: { delta: '我先画一张对比卡，' }, delay: 350 },
      { type: 'token', payload: { delta: '卡里每一种下面都有一个按钮，点了我就展开那一种。' }, delay: 350 },
      ...deltas,
      { type: 'tool_call', payload: { id: 'sk1', name: 'sketch', arguments: args }, delay: 200 },
      { type: 'tool_result', payload: { id: 'sk1', result: 'Sketch card rendered in the conversation.' } },
      { type: 'token', payload: { delta: '评分是演示数据；想细看哪一种，点卡里的按钮。' }, delay: 500 },
    ])
    // 第二轮(点按钮触发):追问当用户消息发出 → 助手接着答
    stub.script([
      { type: 'token', payload: { delta: '好，展开本地部署的取舍：' }, delay: 900 },
      { type: 'token', payload: { delta: '\n\n- **适用场景**：数据不能出境、对延迟和可控性有硬要求\n' }, delay: 500 },
      { type: 'token', payload: { delta: '- **优势**：数据边界清楚，容量和架构自己说了算\n' }, delay: 400 },
      { type: 'token', payload: { delta: '- **成本与风险**：要自备运维、容量规划和灾备，初期投入高' }, delay: 400 },
    ])
    await send(win, '本地部署、云托管、混合，小团队该怎么选？')
    await win.waitForTimeout(13_000)
    const card = win.locator('[data-sketch-call-id="sk1"]').last()
    await card.scrollIntoViewIfNeeded().catch(() => {})
    await win.waitForTimeout(1500)
    let frame = null
    for (const fr of win.frames()) { try { if (await fr.locator('.fs-button').count()) { frame = fr; break } } catch { /* ignore */ } }
    if (frame) { const btn = frame.locator('.fs-button').first(); await btn.hover(); await win.waitForTimeout(700); await btn.click() }
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
  try {
    execSync(`ffmpeg -y -loglevel error -i "${src}" -movflags +faststart -pix_fmt yuv420p -vf "scale=1280:-2" "${path.join(OUT, 'demo.mp4')}"`)
    execSync(`ffmpeg -y -loglevel error -i "${src}" -vf "fps=10,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" "${path.join(OUT, 'demo.gif')}"`)
  } catch (e) { console.error('ffmpeg 失败:', e.message) }
  console.log('录像:', OUT, fs.readdirSync(OUT).join(', '))
}
main().catch((e) => { console.error(e); process.exit(1) })
