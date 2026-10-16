/**
 * 换 Space 的过渡(lcl/engine/spaceTransition.ts + engine.css「换 Space 的过渡」)—— 真 Electron + 真 Space + 假引擎。
 *
 * 方向判定有单测(spaceTransition.test.ts);这里验只有真应用才看得到的:
 *   · 点 ribbon 往下的 Space = next、往上 = prev,工作区真的被起名并跑了推移动画,ribbon 不动;播完属性收掉、名字摘掉;
 *   · 过渡中途再点别的 Space(真鼠标)点得动 —— 过渡期间命中一律落在 <html>,靠 spaceTransition 跳过过渡 + 把点击转给 ribbon 按钮;
 *   · 过渡中在 ribbon 上按下、拖开再松手 = 不触发;同一刻连点两下:落在后一个,属性最后也收掉;点了别的又立刻点回当前这个 = 留在当前、不播;
 *   · 系统「减少动态效果」:只整页淡入,不推;
 *   · 观感:--shot 把过渡暂停在 0 / 60 / 120 / 200ms 各截一张整窗(亮 / 暗),自己看(DESIGN §8)。
 *
 * 跑(先在本检出 `npm run build`):
 *   node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="Space 切换过渡" --eta=3 -- node scripts/space-switch.electron.cjs --shot
 *   (devlock 路径按仓根算;在 worktree 里换成仓根的 .claude/hooks/devlock.cjs)
 */
const path = require('path')
const { sleep, shotDir, makeReporter, launch, boot, activeSpace, captureWindow } = require('./lib/uiux-electron.cjs')

const SHOT = process.argv.includes('--shot')
const { check, note, summary } = makeReporter()

/** 条上某个 Space 图标的中心(视口坐标)。 */
const spot = (win, id) => win.evaluate((sid) => {
  const b = [...document.querySelectorAll(`.rb [data-space-id="${sid}"]`)].find((x) => x.getBoundingClientRect().height > 0 && !x.closest('.rb-recent'))
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}, id)
/** 等过渡的动画出来,返回 { motion, work: 工作区那几条动画的名字, ribbon: ribbon 组有没有动画 }。 */
const waitTransition = (win) => win.evaluate(async () => {
  const end = performance.now() + 2000
  while (performance.now() < end) {
    const anims = document.getAnimations().filter((a) => a.effect?.pseudoElement?.startsWith('::view-transition'))
    if (anims.some((a) => a.effect.pseudoElement.includes('space-work')) || (anims.length && document.documentElement.dataset.spaceSwitch === 'fade')) {
      return {
        motion: document.documentElement.dataset.spaceSwitch,
        work: anims.filter((a) => a.effect.pseudoElement.includes('space-work')).map((a) => `${a.effect.pseudoElement}:${a.animationName}`).sort(),
        ribbon: anims.filter((a) => a.effect.pseudoElement.includes('space-ribbon')).length,
        all: anims.length,
      }
    }
    await new Promise((r) => requestAnimationFrame(r))
  }
  return { motion: document.documentElement.dataset.spaceSwitch ?? null, work: [], ribbon: 0, all: 0 }
})
const pauseAt = (win, ms) => win.evaluate((t) => { for (const a of document.getAnimations()) if (a.effect?.pseudoElement?.startsWith('::view-transition')) { a.pause(); a.currentTime = t } }, ms)
const finish = (win) => win.evaluate(() => { for (const a of document.getAnimations()) if (a.effect?.pseudoElement?.startsWith('::view-transition')) a.finish() })
/** 播完:属性收掉、工作区的名字摘掉。 */
const settled = (win) => win.evaluate(async () => {
  const end = performance.now() + 2000
  while (performance.now() < end && document.documentElement.dataset.spaceSwitch) await new Promise((r) => setTimeout(r, 30))
  return { attr: document.documentElement.dataset.spaceSwitch ?? null, name: getComputedStyle(document.querySelector('.shell-work')).viewTransitionName }
})

async function main() {
  const shots = SHOT ? shotDir('space-switch') : null
  const { app, win, close } = await launch({ tag: 'space-switch' })
  try {
    await boot(app, win)
    const errors = []
    win.on('console', (m) => { if (m.type() === 'error' && /space|transition/i.test(m.text())) errors.push(m.text()) })

    // ── 往下:Tangu → 日历 = next ──
    let at = await spot(win, 'calendar')
    check('条上找得到日历', !!at)
    await win.mouse.click(at.x, at.y)
    let t = await waitTransition(win)
    check('往下点 = next', t.motion === 'next', JSON.stringify(t))
    check('工作区跑的是淡出 + 推出 / 淡入 + 推入', ['lcl-space-fade-in', 'lcl-space-fade-out', 'lcl-space-push-in', 'lcl-space-push-out'].every((n) => t.work.some((w) => w.endsWith(':' + n))), t.work.join(' '))
    check('ribbon 不动画', t.ribbon === 0, `ribbon 动画 ${t.ribbon}`)
    if (shots) for (const ms of [0, 60, 120, 200]) { await pauseAt(win, ms); await sleep(120); await captureWindow(app, path.join(shots, `next-light-${ms}.png`)) }
    await finish(win)
    let s = await settled(win)
    check('播完属性收掉、工作区不再带名字', !s.attr && s.name === 'none', JSON.stringify(s))
    check('落在日历', (await activeSpace(win)) === 'calendar')

    // ── 往上:日历 → 主页 = prev(暗色拍一组)──
    // 暗色走真的明暗偏好(手改 data-mode 会在换 Space 时被 Space 外观重新解析回浅色);reload 前把启动 Space 钉成眼前这个(boot 钉的是 Tangu)
    if (shots) { await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'dark'); localStorage.setItem('forsion_default_space', localStorage.getItem('forsion_tangu_active_space')) }); await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 30_000 }); await sleep(2000) }
    check('起点 = 日历', (await activeSpace(win)) === 'calendar')
    at = await spot(win, 'home')
    await win.mouse.click(at.x, at.y)
    t = await waitTransition(win)
    check('往上点 = prev', t.motion === 'prev', JSON.stringify(t))
    if (shots) for (const ms of [0, 60, 120, 200]) { await pauseAt(win, ms); await sleep(120); await captureWindow(app, path.join(shots, `prev-dark-${ms}.png`)) }
    await finish(win)
    await settled(win)
    check('落在主页', (await activeSpace(win)) === 'home')
    if (shots) { await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'light'); localStorage.setItem('forsion_default_space', localStorage.getItem('forsion_tangu_active_space')) }); await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 30_000 }); await sleep(2000) }

    // ── 过渡中途再点(真鼠标):主页 → 笔记,停在 80ms 时点 Tangu ──
    check('起点 = 主页', (await activeSpace(win)) === 'home')
    at = await spot(win, 'amadeus')
    await win.mouse.click(at.x, at.y)
    await waitTransition(win)
    await pauseAt(win, 80)
    at = await spot(win, 'tangu')
    await win.mouse.click(at.x, at.y)
    await sleep(100)
    await finish(win)
    await settled(win)
    await sleep(300)
    await finish(win)
    s = await settled(win)
    check('过渡中途点别的 Space 点得动', (await activeSpace(win)) === 'tangu', `活动 = ${await activeSpace(win)}`)
    check('中途被打断后属性也收掉', !s.attr && s.name === 'none', JSON.stringify(s))

    // ── 过渡中在 ribbon 上按下、拖到工作区再松手 = 取消,不触发那颗按钮 ──
    at = await spot(win, 'calendar')
    await win.mouse.click(at.x, at.y)
    await waitTransition(win)
    await pauseAt(win, 80)
    at = await spot(win, 'amadeus')
    await win.mouse.move(at.x, at.y)
    await win.mouse.down()
    await win.mouse.move(700, 450, { steps: 4 })
    await win.mouse.up()
    await sleep(300)
    await finish(win)
    s = await settled(win)
    check('按下后拖开再松手 = 不触发', (await activeSpace(win)) === 'calendar' && !s.attr, `活动 = ${await activeSpace(win)} ${JSON.stringify(s)}`)
    at = await spot(win, 'tangu')
    await win.mouse.click(at.x, at.y)
    await waitTransition(win)
    await finish(win)
    await settled(win)

    // ── 同一刻连点两下:落在后一个 ──
    check('起点 = Tangu', (await activeSpace(win)) === 'tangu')
    await win.evaluate(() => {
      const b = (id) => [...document.querySelectorAll(`.rb [data-space-id="${id}"]`)].find((x) => x.getBoundingClientRect().height > 0 && !x.closest('.rb-recent'))
      b('calendar').click(); b('amadeus').click()
    })
    await sleep(800)
    s = await settled(win)
    check('连点两下落在后一个', (await activeSpace(win)) === 'amadeus', `活动 = ${await activeSpace(win)}`)
    check('连点后属性收掉', !s.attr, JSON.stringify(s))

    // ── 点了别的又立刻点回当前这个(笔记):留在笔记,工作区不推 ──
    const back = await win.evaluate(async () => {
      const b = (id) => [...document.querySelectorAll(`.rb [data-space-id="${id}"]`)].find((x) => x.getBoundingClientRect().height > 0 && !x.closest('.rb-recent'))
      b('calendar').click(); b('amadeus').click()
      let pushed = 0
      const end = performance.now() + 600
      while (performance.now() < end) {
        pushed = Math.max(pushed, document.getAnimations().filter((a) => a.effect?.pseudoElement?.includes('space-work')).length)
        await new Promise((r) => requestAnimationFrame(r))
      }
      return { pushed, attr: document.documentElement.dataset.spaceSwitch ?? null }
    })
    check('点回当前 = 留在原地、不推、属性收掉', (await activeSpace(win)) === 'amadeus' && back.pushed === 0 && !back.attr, `活动 = ${await activeSpace(win)} ${JSON.stringify(back)}`)

    // ── 减少动态效果:只整页淡入 ──
    await win.emulateMedia({ reducedMotion: 'reduce' })
    at = await spot(win, 'tangu')
    await win.mouse.click(at.x, at.y)
    t = await waitTransition(win)
    check('减少动态效果 = fade、工作区不推', t.motion === 'fade' && t.work.length === 0, JSON.stringify(t))
    await finish(win)
    await settled(win)
    check('减少动态效果下照样切过去', (await activeSpace(win)) === 'tangu')
    await win.emulateMedia({ reducedMotion: 'no-preference' })

    check('控制台没有切换相关的报错', errors.length === 0, errors.slice(0, 3).join(' | '))
    if (shots) note('截图', shots)
  } finally {
    await close()
  }
  process.exit(summary() ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
