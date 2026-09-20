/**
 * Chat View 生图运行态 —— 真 Electron × 真 ToolGroup/store × 可编剧假引擎。
 *
 * 钉住：generate_image 独占点阵、动效、reduced-motion、点击贪吃蛇、键盘控制语义，
 * 以及工具完成后动画退场并由真实 InlineFiles 图片接棒。
 *
 * 需先 npm run build。用法：node scripts/image-generation-loader.e2e.cjs
 * 负对照：node scripts/image-generation-loader.e2e.cjs --nc（把工具改成 read_file，存在断言必须转红）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const TOOL = NEGATIVE_CONTROL ? 'read_file' : 'generate_image'
const SHOTS = {
  ambientLight: path.join(os.tmpdir(), 'forsion-image-generation-ambient-light.png'),
  snakeDark: path.join(os.tmpdir(), 'forsion-image-generation-snake-dark.png'),
  resultLight: path.join(os.tmpdir(), 'forsion-image-generation-result-light.png'),
}
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'imagegen-loader-s1', title: '生图动画验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/imagegen-loader-demo', project_name: 'imagegen-loader-demo',
  created_at: '2026-09-20 09:00:00', updated_at: '2026-09-20 09:00:00',
}

const fixtureSvg = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="280" height="280" viewBox="0 0 280 280">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#4277d9"/><stop offset="1" stop-color="#d88472"/></linearGradient></defs>
    <rect width="280" height="280" rx="24" fill="url(#g)"/><circle cx="140" cy="140" r="52" fill="white" fill-opacity=".72"/>
  </svg>
`).toString('base64')

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40; i++) {
    if (await ta.isEnabled().catch(() => false)) break
    await win.waitForTimeout(250)
  }
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
}

async function openChatSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1000)
  await win.evaluate((names) => {
    const button = [...document.querySelectorAll('button.rb-space')]
      .find((item) => names.some((name) => (item.getAttribute('title') || item.textContent || '').includes(name)))
    button?.click()
  }, ['Agent', 'Tangu'])
  await win.waitForTimeout(1500)
  if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
    await win.click('.dv-edge-left').catch(() => {})
    await win.waitForTimeout(700)
  }
  const picker = win.locator('.t2sw-mode-picker').first()
  if (await picker.count().catch(() => 0)) {
    await picker.locator('.t2sw-mode-trigger').click().catch(() => {})
    await picker.locator('[data-workspace-mode="sessions"]').click().catch(() => {})
    await win.waitForTimeout(900)
  }
  const row = win.locator('.t2s-srow', { hasText: '生图动画验收' }).first()
  if (!(await row.count().catch(() => 0))) throw new Error('没有找到生图动画验收会话')
  await row.click()
  await win.waitForTimeout(900)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('缺 out/main/main.js —— 先跑 npm run build')
  const stub = await startStubEngine({
    sessions: [SESSION], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off', 'low'] }],
  })
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-imagegen-loader-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(tempHome, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: tempHome, TANGU_BACKEND_URL: stub.url },
  })

  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1440, height: 920 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.locator(`text=${label}`).first()
      if (await button.count().catch(() => 0)) { await button.click().catch(() => {}); break }
    }
    await openChatSession(win)

    // Run 1 stays active so the animation and easter egg can be inspected.
    stub.script([
      { type: 'tool_call', payload: { id: 'imagegen-live', name: TOOL, arguments: JSON.stringify({ prompt: '一颗漂浮在海上的蓝色星球' }) }, delay: 250 },
      { type: '__hold' },
    ])
    await send(win, '生成一张蓝色星球图片')
    const loader = win.locator('.image-generation-loader').first()
    await loader.waitFor({ timeout: 8_000 })

    const ambient = await loader.evaluate((el) => {
      const canvas = el.querySelector('canvas')
      const stage = el.querySelector('button')
      return {
        state: el.getAttribute('data-image-generation'),
        width: canvas?.getBoundingClientRect().width,
        height: canvas?.getBoundingClientRect().height,
        pixels: canvas?.toDataURL(),
        label: stage?.getAttribute('aria-label'),
        busy: el.parentElement?.getAttribute('aria-busy'),
      }
    })
    await win.waitForTimeout(220)
    const ambientLater = await loader.locator('canvas').evaluate((canvas) => canvas.toDataURL())
    check('generate_image 运行时出现正方形点阵画布', ambient.state === 'ambient' && ambient.width > 220 && Math.abs(ambient.width - ambient.height) < 1,
      JSON.stringify({ state: ambient.state, width: ambient.width, height: ambient.height }))
    check('点阵运行态保留 busy 与无障碍入口', ambient.busy === 'true' && /贪吃蛇|Snake/.test(ambient.label || ''), JSON.stringify({ busy: ambient.busy, label: ambient.label }))
    check('常态点阵随时间流动', ambient.pixels !== ambientLater)
    if (!NEGATIVE_CONTROL) await loader.screenshot({ path: SHOTS.ambientLight })

    await win.emulateMedia({ reducedMotion: 'reduce' })
    await win.waitForTimeout(120)
    const reducedA = await loader.locator('canvas').evaluate((canvas) => canvas.toDataURL())
    await win.waitForTimeout(220)
    const reducedB = await loader.locator('canvas').evaluate((canvas) => canvas.toDataURL())
    check('减少动态效果时常态点阵静止', reducedA === reducedB)
    await win.emulateMedia({ reducedMotion: 'no-preference' })

    await loader.locator('button').click()
    await win.waitForFunction(() => document.querySelector('.image-generation-loader')?.getAttribute('data-image-generation') === 'snake')
    await win.keyboard.press('ArrowDown')
    await win.waitForTimeout(180)
    const snake = await loader.evaluate((el) => ({
      state: el.getAttribute('data-image-generation'),
      label: el.querySelector('button')?.getAttribute('aria-label'),
      status: el.querySelector('[role="status"]')?.textContent,
    }))
    check('点击点阵切换为贪吃蛇', snake.state === 'snake' && /贪吃蛇|Snake/.test(snake.status || ''), JSON.stringify(snake))
    check('贪吃蛇声明方向键、WASD 与滑动控制', /WASD/.test(snake.label || '') && /滑动|swipe/i.test(snake.label || ''), snake.label)

    await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    await win.waitForTimeout(180)
    if (!NEGATIVE_CONTROL) await loader.screenshot({ path: SHOTS.snakeDark })

    // Stop clears the active-only surface even if the unfinished tool never emits tool_result.
    await win.locator('.t2c-stop').first().click()
    await win.waitForFunction(() => !document.querySelector('.image-generation-loader'), null, { timeout: 5_000 })
    check('停止任务后点阵与游戏立即退场', await win.locator('.image-generation-loader').count() === 0)

    // Run 2 completes: the generated image must take over the same conversation surface.
    await win.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.dataset.mode = 'light' })
    stub.script([
      { type: 'tool_call', payload: { id: 'imagegen-done', name: 'generate_image', arguments: JSON.stringify({ prompt: '蓝色星球' }) }, delay: 120 },
      { type: 'display_file', payload: { name: 'blue-planet.svg', mime: 'image/svg+xml', dataUrl: `data:image/svg+xml;base64,${fixtureSvg}` }, delay: 500 },
      { type: 'tool_result', payload: { id: 'imagegen-done', result: 'Generated blue-planet.svg' }, delay: 120 },
      { type: 'done', payload: {} },
    ])
    await send(win, '再生成一张并显示结果')
    const resultImage = win.locator('.inline-file-img[title="blue-planet.svg"]').first()
    await resultImage.waitFor({ timeout: 8_000 })
    await win.waitForFunction(() => !document.querySelector('.image-generation-loader'), null, { timeout: 5_000 })
    const result = await resultImage.evaluate((img) => ({ width: img.getBoundingClientRect().width, complete: img.complete, src: img.getAttribute('src') }))
    check('生图完成后动画退场并由结果图片接棒', result.complete && result.width > 200 && result.src?.startsWith('data:image/svg+xml'), JSON.stringify(result))
    if (!NEGATIVE_CONTROL) await resultImage.screenshot({ path: SHOTS.resultLight })

    if (!NEGATIVE_CONTROL) for (const shot of Object.values(SHOTS)) console.log(`截图: ${shot}`)
  } finally {
    await app.close().catch(() => {})
    try { stub.close() } catch { /* best effort */ }
    fs.rmSync(tempHome, { recursive: true, force: true })
  }

  const bad = results.filter((item) => !item.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
