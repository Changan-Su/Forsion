/**
 * Chat View 运行态 Shimmer —— 真 Electron × 真组件/store × 可编剧假引擎。
 *
 * 钉住三处产品契约:
 *  ① 工具组 + Pin Summary 不再出现旋转 Loader 或椭圆标记；
 *  ②「正在思考」使用同一套 shimmer,且不再带 streaming-caret 方块；
 *  ③ 每段运行文案只有一层不重复的窄光,扫出后保留停顿再重启。
 * 同时检查 aria-busy / role=status 与 reduced-motion 静止回退。
 *
 * 需先 npm run build。用法:npm run e2e:chatshimmer
 * 负对照:node scripts/chat-shimmer.e2e.cjs --nc(运行时禁用动画,动画/位移断言必须转红)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const SHOTS = {
  light: path.join(os.tmpdir(), 'forsion-chat-shimmer-light.png'),
  dark: path.join(os.tmpdir(), 'forsion-chat-shimmer-dark.png'),
  toolLight: path.join(os.tmpdir(), 'forsion-chat-shimmer-tool-light.png'),
  taskLight: path.join(os.tmpdir(), 'forsion-chat-shimmer-summary-light.png'),
  toolDark: path.join(os.tmpdir(), 'forsion-chat-shimmer-tool-dark.png'),
  taskDark: path.join(os.tmpdir(), 'forsion-chat-shimmer-summary-dark.png'),
  thinkingLight: path.join(os.tmpdir(), 'forsion-chat-shimmer-thinking-light.png'),
  thinkingDark: path.join(os.tmpdir(), 'forsion-chat-shimmer-thinking-dark.png'),
}
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'shimmer-s1', title: 'Shimmer 验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/shimmer-demo', project_name: 'shimmer-demo',
  created_at: '2026-08-22 09:00:00', updated_at: '2026-08-22 09:00:00',
}

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40; i++) {
    if (await ta.isEnabled().catch(() => false)) break
    await win.waitForTimeout(500)
  }
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
}

/** 假后端没有云同步端点会弹常驻错误；它与本用例无关,截图前收掉,免得遮住 Pin Summary。 */
async function dismissNotifications(win) {
  const close = win.locator('.ntf-close')
  await close.evaluateAll((buttons) => buttons.forEach((button) => button.click())).catch(() => {})
  await win.waitForTimeout(250)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const stub = await startStubEngine({
    sessions: [SESSION],
    messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off', 'low'] }],
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chat-shimmer-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })

  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1600, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(1000)
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    await win.locator('.t2s-srow', { hasText: 'Shimmer 验收' }).first().click()
    await win.waitForTimeout(900)

    stub.script([
      { type: 'tool_call', delay: 3500, payload: { id: 'shimmer-tool', name: 'read_file', arguments: JSON.stringify({ path: '/tmp/shimmer-demo/README.md' }) } },
      { type: '__hold' },
    ])
    await send(win, '检查运行中的 Shimmer')
    if (NEGATIVE_CONTROL) {
      await win.addStyleTag({ content: '.chat-run-shimmer-text{animation:none!important}' })
    }
    await win.waitForSelector('.chat-thinking-live.chat-run-shimmer-text', { timeout: 1500 })

    const thinkingProbe = await win.evaluate(() => {
      const thinking = document.querySelector('.chat-thinking-live')
      const css = thinking ? getComputedStyle(thinking) : null
      const after = thinking ? getComputedStyle(thinking, '::after') : null
      return {
        present: !!thinking,
        role: thinking?.getAttribute('role'),
        animation: css?.animationName,
        backgroundRepeat: css?.backgroundRepeat,
        gradientCount: (css?.backgroundImage.match(/linear-gradient/g) || []).length,
        hasCaretClass: thinking?.classList.contains('streaming-caret') ?? true,
        afterContent: after?.content,
        markCount: thinking?.querySelectorAll('.chat-run-shimmer-mark').length ?? -1,
        width: thinking?.getBoundingClientRect().width ?? -1,
        parentWidth: thinking?.parentElement?.getBoundingClientRect().width ?? -1,
      }
    })
    check('「正在思考」已改用 Shimmer', thinkingProbe.present && thinkingProbe.animation === 'chat-run-shimmer', JSON.stringify(thinkingProbe))
    check('「正在思考」末尾不再渲染长方形光标', !thinkingProbe.hasCaretClass && ['none', 'normal', '""'].includes(thinkingProbe.afterContent),
      JSON.stringify({ hasCaretClass: thinkingProbe.hasCaretClass, afterContent: thinkingProbe.afterContent }))

    await win.evaluate(() => {
      const animation = document.querySelector('.chat-thinking-live')?.getAnimations().find((a) => a.animationName === 'chat-run-shimmer')
      if (animation) { animation.pause(); animation.currentTime = 760 }
    })
    if (!NEGATIVE_CONTROL) await win.locator('.chat-thinking-live').screenshot({ path: SHOTS.thinkingLight })
    await win.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.dataset.mode = 'dark' })
    if (!NEGATIVE_CONTROL) await win.locator('.chat-thinking-live').screenshot({ path: SHOTS.thinkingDark })
    await win.evaluate(() => {
      document.documentElement.classList.remove('dark')
      document.documentElement.dataset.mode = 'light'
      document.querySelector('.chat-thinking-live')?.getAnimations().forEach((a) => a.play())
    })

    await win.waitForSelector('.tool-group [aria-busy="true"] .chat-run-shimmer-text', { timeout: 10_000 })
    await win.waitForSelector('.t2-tsum.show .t2-tsum-state.running .chat-run-shimmer-text', { timeout: 10_000 })
    await dismissNotifications(win)
    await win.waitForTimeout(350)

    const probe = await win.evaluate(() => {
      const group = document.querySelector('.tool-group')
      const task = document.querySelector('.t2-tsum-state.running')
      const groupHead = group?.querySelector('.tool-group-head')
      const groupText = groupHead?.querySelector('.chat-run-shimmer-text')
      const taskText = task?.querySelector('.chat-run-shimmer-text')
      const style = (el) => el ? getComputedStyle(el) : null
      const shimmerSpec = (el) => {
        const css = style(el)
        return {
          animation: css?.animationName,
          backgroundRepeat: css?.backgroundRepeat,
          gradientCount: (css?.backgroundImage.match(/linear-gradient/g) || []).length,
          backgroundPosition: css?.backgroundPosition,
        }
      }
      const keyframes = Array.from(document.styleSheets).flatMap((sheet) => {
        try { return Array.from(sheet.cssRules) } catch { return [] }
      }).find((rule) => rule instanceof CSSKeyframesRule && rule.name === 'chat-run-shimmer')
      return {
        group: !!group,
        task: !!task,
        groupSpinner: group?.querySelectorAll('.spin').length ?? -1,
        taskSpinner: task?.querySelectorAll('.spin').length ?? -1,
        ovalCount: document.querySelectorAll('.chat-run-shimmer-mark').length,
        groupVisibleShimmerCount: groupHead?.querySelectorAll('.chat-run-shimmer-text').length ?? -1,
        groupTextWidth: groupText?.getBoundingClientRect().width ?? -1,
        groupHeadWidth: groupHead?.getBoundingClientRect().width ?? -1,
        taskTextWidth: taskText?.getBoundingClientRect().width ?? -1,
        taskWidth: task?.getBoundingClientRect().width ?? -1,
        groupBusy: group?.querySelector('.tool-group-head')?.getAttribute('aria-busy'),
        taskBusy: document.querySelector('.t2-tsum')?.getAttribute('aria-busy'),
        taskRole: task?.getAttribute('role'),
        groupText: shimmerSpec(groupText),
        taskText: shimmerSpec(taskText),
        keyframes: keyframes ? Array.from(keyframes.cssRules).map((frame) => ({
          keyText: frame.keyText,
          backgroundPosition: frame.style.backgroundPosition,
        })) : [],
      }
    })
    check('工具调用与 Pin Summary 的运行态都已出现', probe.group && probe.task, JSON.stringify({ group: probe.group, task: probe.task }))
    check('两处运行态都不再渲染 spinner', probe.groupSpinner === 0 && probe.taskSpinner === 0,
      JSON.stringify({ group: probe.groupSpinner, task: probe.taskSpinner }))
    check('工具调用与 Pin Summary 均已移除椭圆标记', probe.ovalCount === 0, `ovalCount=${probe.ovalCount}`)
    check('工具折叠头只由一个元素承载 Shimmer', probe.groupVisibleShimmerCount === 1, `count=${probe.groupVisibleShimmerCount}`)
    check('动画层收缩到文案宽度,不在整行空白中扫动',
      thinkingProbe.width < thinkingProbe.parentWidth
      && probe.groupTextWidth < probe.groupHeadWidth
      && probe.taskTextWidth < probe.taskWidth,
      JSON.stringify({ thinking: [thinkingProbe.width, thinkingProbe.parentWidth], group: [probe.groupTextWidth, probe.groupHeadWidth], task: [probe.taskTextWidth, probe.taskWidth] }))
    check('三处文字均使用 chat-run-shimmer 动画',
      [thinkingProbe.animation, probe.groupText.animation, probe.taskText.animation].every((x) => x === 'chat-run-shimmer'),
      JSON.stringify([thinkingProbe.animation, probe.groupText.animation, probe.taskText.animation]))
    check('每处 Shimmer 都只有一个不重复的渐变层',
      [thinkingProbe, probe.groupText, probe.taskText].every((x) => x.backgroundRepeat === 'no-repeat' && x.gradientCount === 1),
      JSON.stringify([thinkingProbe, probe.groupText, probe.taskText]))
    check('流光扫出后停顿再重启', probe.keyframes.length === 3
      && probe.keyframes[1].keyText === '72%'
      && probe.keyframes[1].backgroundPosition === probe.keyframes[2].backgroundPosition,
    JSON.stringify(probe.keyframes))
    check('运行状态保留 aria-busy / status 语义',
      probe.groupBusy === 'true' && probe.taskBusy === 'true' && probe.taskRole === 'status',
      JSON.stringify({ groupBusy: probe.groupBusy, taskBusy: probe.taskBusy, taskRole: probe.taskRole }))

    const moved = await win.evaluate(() => {
      const sample = (selector) => {
        const el = document.querySelector(selector)
        const animation = el?.getAnimations().find((a) => a.animationName === 'chat-run-shimmer')
        if (!el || !animation) return null
        animation.pause()
        animation.currentTime = 100
        const from = getComputedStyle(el).backgroundPositionX
        animation.currentTime = 1000
        const to = getComputedStyle(el).backgroundPositionX
        animation.currentTime = 760
        return { from, to }
      }
      return {
        group: sample('.tool-group-head .chat-run-shimmer-text'),
        task: sample('.t2-tsum-state.running .chat-run-shimmer-text'),
      }
    })
    check('单束流光按从左到右的方向横向扫过', moved.group && moved.task
      && parseFloat(moved.group.from) > parseFloat(moved.group.to)
      && parseFloat(moved.task.from) > parseFloat(moved.task.to), JSON.stringify(moved))

    if (!NEGATIVE_CONTROL) {
      await win.locator('.t2-chat-view').first().screenshot({ path: SHOTS.light })
      await win.locator('.tool-group').last().screenshot({ path: SHOTS.toolLight })
      await win.locator('.t2-tsum-in').first().screenshot({ path: SHOTS.taskLight })
    }

    await win.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await win.evaluate(() => {
      const text = document.querySelector('.tool-group .chat-run-shimmer-text')
      return {
        textAnimation: getComputedStyle(text).animationName,
        textFill: getComputedStyle(text).webkitTextFillColor,
      }
    })
    check('减少动态效果时 Shimmer 静止且文字保持可读',
      reduced.textAnimation === 'none' && reduced.textFill !== 'rgba(0, 0, 0, 0)',
      JSON.stringify(reduced))

    await win.emulateMedia({ reducedMotion: 'no-preference' })
    await win.evaluate(() => {
      document.documentElement.classList.add('dark')
      document.documentElement.dataset.mode = 'dark'
    })
    await win.waitForTimeout(350)
    await dismissNotifications(win)
    if (!NEGATIVE_CONTROL) {
      await win.locator('.t2-chat-view').first().screenshot({ path: SHOTS.dark })
      await win.locator('.tool-group').last().screenshot({ path: SHOTS.toolDark })
      await win.locator('.t2-tsum-in').first().screenshot({ path: SHOTS.taskDark })
      for (const shot of Object.values(SHOTS)) console.log(`截图: ${shot}`)
    }
  } finally {
    await app.close().catch(() => {})
    try { stub.close?.() } catch { /* best-effort test cleanup */ }
    fs.rmSync(home, { recursive: true, force: true })
  }

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
