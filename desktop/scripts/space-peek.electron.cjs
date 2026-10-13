/**
 * Space 左面板悬停预览 —— 真应用那一半(真 Electron + 真 Space / 真左栏 View + 假引擎)。
 *
 * 接线与规则已由 check:spacepeek(浏览器台架,替身 View)和 spacePeekRules.test.ts 钉住。这里只验替身验不了的:
 *   · 真的左栏 View 脱离 Dockview、拿着合成 leaf 能不能渲染出来(每个有左栏的内置 Space 过一遍,不许塌成错误面);
 *   · 真的会话行在卡里点得动;在别的 Space 的卡里点会话 = 切到 Tangu 并打开那条;
 *   · 观感:--shot 存整窗截图(亮 / 暗),自己看(DESIGN §8:几何断言全绿 ≠ 看起来对)。
 *
 * 跑(先在本检出 `npx electron-vite build`):
 *   node .claude/hooks/devlock.cjs run --vehicle=e2e --what="Space 悬停预览" --eta=4 -- node scripts/space-peek.electron.cjs --shot
 */
const path = require('path')
const { sleep, shotDir, makeReporter, launch, boot, enterSpace, activeSpace, captureWindow } = require('./lib/uiux-electron.cjs')

const SHOT = process.argv.includes('--shot')
const { check, note, summary } = makeReporter()

const peek = (win) => win.evaluate(() => {
  const el = document.querySelector('.rb-peek')
  if (!el) return null
  const body = el.querySelector('.rb-peek-body')
  return { space: el.dataset.space, name: el.querySelector('.rb-peek-name')?.textContent, error: !!el.querySelector('.sk-error'), chars: (body?.textContent || '').trim().length, nodes: body?.querySelectorAll('*').length ?? 0 }
})
/** 真鼠标停到某个 Space 图标上(条上找不到 = 被收进「…」了,返回 false)。 */
async function hoverSpace(win, id) {
  const at = await win.evaluate((sid) => {
    const b = [...document.querySelectorAll(`.rb [data-space-id="${sid}"]`)].find((x) => x.getBoundingClientRect().height > 0)
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, id)
  if (!at) return false
  await win.mouse.move(900, 600, { steps: 3 })
  await sleep(300)
  await win.mouse.move(at.x, at.y, { steps: 5 })
  await sleep(900) // 300ms 弹出 + 入场 + 懒加载的 View
  return true
}
async function collapseLeft(win) {
  const open = await win.evaluate(() => document.querySelector('.dv-edge-toggle')?.getAttribute('aria-pressed') === 'true')
  if (open) await win.locator('.dv-edge-toggle').first().click()
  await sleep(700)
}

async function main() {
  const shots = SHOT ? shotDir('space-peek') : null
  const { app, win, close } = await launch({ tag: 'space-peek' })
  try {
    await boot(app, win)
    await collapseLeft(win)

    // ── 当前 Space(Tangu):真会话列表在卡里,点得动 ──
    check('T1 条上找得到 Tangu 图标', await hoverSpace(win, 'tangu'))
    let p = await peek(win)
    check('T2 悬停弹出 Tangu 的左面板,真 View 渲染出来了(不是错误面)', p?.space === 'tangu' && !p.error && p.nodes > 5, JSON.stringify(p))
    const rows = await win.locator('.rb-peek').locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session' }).count()
    check('T3 卡里列着会话', rows >= 3, `${rows} 行`)
    if (shots) await captureWindow(app, path.join(shots, '1-tangu-light.png'))
    await win.locator('.rb-peek').locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session two' }).first().click()
    await sleep(800)
    const tab = await win.evaluate(() => [...document.querySelectorAll('.dv-tab')].map((t) => t.textContent || '').join(' | '))
    check('T4 点卡里的会话 = 打开那条会话(主区标签跟着变)', /Probe session two/.test(tab), tab.slice(0, 120))
    check('T5 点完卡片还在(指针没离开)', (await peek(win))?.space === 'tangu')
    await win.mouse.move(900, 600, { steps: 4 })
    await sleep(500)
    check('T6 指针回主区 → 收起', (await peek(win)) === null)

    // ── 每个有左栏的内置 Space 过一遍:真 View 都得能在卡里活着 ──
    const ids = await win.evaluate(() => [...new Set([...document.querySelectorAll('.rb [data-space-id]')].filter((x) => x.getBoundingClientRect().height > 0).map((x) => x.dataset.spaceId))])
    note('条上露出的 Space', ids.join(', '))
    let n = 2
    for (const id of ids.filter((x) => x !== 'tangu')) {
      await hoverSpace(win, id)
      p = await peek(win)
      if (!p) { note(`${id}:没有左栏,不弹`); continue }
      check(`S ${id}:它的左面板在卡里渲染出来了(不是错误面)`, p.space === id && !p.error && p.nodes > 3, JSON.stringify(p))
      if (shots) await captureWindow(app, path.join(shots, `${n++}-${id}-light.png`))
    }
    await win.mouse.move(900, 600, { steps: 4 })
    await sleep(500)

    // ── 别的 Space 的卡里点会话 = 切到 Tangu 并打开那条 ──
    if (await enterSpace(win, 'amadeus')) {
      await sleep(1200)
      await collapseLeft(win)
      await hoverSpace(win, 'tangu')
      p = await peek(win)
      check('X1 人在笔记里,悬停 Tangu 弹出它的会话列表', p?.space === 'tangu' && !p.error, JSON.stringify(p))
      await win.locator('.rb-peek').locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session three' }).first().click()
      await sleep(1500)
      const tab2 = await win.evaluate(() => [...document.querySelectorAll('.dv-tab')].map((t) => t.textContent || '').join(' | '))
      check('X2 点一下 = 进 Tangu 并打开那条会话', (await activeSpace(win)) === 'tangu' && /Probe session three/.test(tab2), `${await activeSpace(win)} / ${tab2.slice(0, 120)}`)
    } else note('没进得了笔记 Space,跨 Space 那段跳过')

    // ── 另外两档只截图(观感自己看):当前主题的暗色、玻璃主题(材质画在 ::before 上,模糊要采得到卡片身后的像素) ──
    if (shots) {
      const theme0 = await win.evaluate(() => document.documentElement.dataset.theme || '')
      // 玻璃主题的明暗由主题自己锁(跟系统),所以只截它当下那一档。
      for (const [lang, mode] of [[theme0, 'dark'], ['genesis-glass', 'light']]) {
        await win.evaluate(([l, m]) => { if (l) localStorage.setItem('forsion_theme_lang', l); localStorage.setItem('forsion_theme_pref', m) }, [lang, mode])
        await win.reload({ waitUntil: 'domcontentloaded' })
        await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
        await sleep(2000)
        await collapseLeft(win)
        if (await hoverSpace(win, 'tangu')) await captureWindow(app, path.join(shots, `${n++}-tangu-${lang || 'default'}-${mode}.png`))
        note(`截图 ${lang || 'default'} / ${mode}`, await win.evaluate(() => `data-theme=${document.documentElement.dataset.theme};::before backdrop-filter=${getComputedStyle(document.querySelector('.rb-peek') || document.body, '::before').backdropFilter}`))
      }
      console.log(`截图:${shots}`)
    }
    process.exitCode = summary() ? 1 : 0
  } finally {
    await close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
