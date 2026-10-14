/**
 * Space 左面板悬停预览 —— 真应用那一半(真 Electron + 真 Space / 真左栏 View + 假引擎)。
 *
 * 接线与规则已由 check:spacepeek(浏览器台架,替身 View)和 spacePeekRules.test.ts 钉住。这里只验替身验不了的:
 *   · 真的左栏 View 脱离 Dockview、拿着合成 leaf 能不能渲染出来(每个有左栏的内置 Space 过一遍,不许塌成错误面);
 *   · 真的会话行在卡里点得动;在别的 Space 的卡里点会话 / Agent = 不切 Space,开成当前标签旁边的新标签
 *     (Agent 资料页的打开法自己会先切 Space,要被拦下);把会话拖进标签栏 = 落点处多一个标签;
 *   · 左面板展开着:当前 Space 不弹,别的 Space 照弹(卡片盖在眼前这块左栏上);
 *   · 观感:--shot 存整窗截图(亮 / 暗),自己看(DESIGN §8:几何断言全绿 ≠ 看起来对)。
 *
 * 跑(先在本检出 `npx electron-vite build`):
 *   node .claude/hooks/devlock.cjs run --vehicle=e2e --what="Space 悬停预览" --eta=4 -- node scripts/space-peek.electron.cjs --shot
 */
const path = require('path')
const { sleep, shotDir, makeReporter, launch, boot, enterSpace, activeSpace, captureWindow } = require('./lib/uiux-electron.cjs')

const SHOT = process.argv.includes('--shot')
const MUST = ['amadeus', 'calendar', 'inbox', 'agents']
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
/** 主区的标签文字(按组、组内按次序;带图标页签的是侧栏组,不算)。 */
const mainTabs = (win) => win.evaluate(() => [...document.querySelectorAll('.dv-groupview')]
  .filter((g) => g.getBoundingClientRect().height > 0 && !g.querySelector('.wb-tab--icon'))
  .flatMap((g) => [...g.querySelectorAll('.dv-tab')].map((t) => (t.textContent || '').trim())))
async function setLeft(win, want) {
  const open = await win.evaluate(() => document.querySelector('.dv-edge-toggle')?.getAttribute('aria-pressed') === 'true')
  if (open !== want) await win.locator('.dv-edge-toggle').first().click()
  await sleep(700)
}
const collapseLeft = (win) => setLeft(win, false)

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
      // 这几个内置 Space 一定有左栏:不弹就是坏了,不能当成「没有左栏」放过去。
      if (!p) { if (MUST.includes(id)) check(`S ${id}:它有左栏,悬停应当弹出预览`, false); else note(`${id}:没有左栏,不弹`); continue }
      check(`S ${id}:它的左面板在卡里渲染出来了(不是错误面)`, p.space === id && !p.error && p.nodes > 3, JSON.stringify(p))
      if (shots) await captureWindow(app, path.join(shots, `${n++}-${id}-light.png`))
    }
    await win.mouse.move(900, 600, { steps: 4 })
    await sleep(500)

    // ── 别的 Space 的卡里操作:不切 Space,往主区开的开成当前标签旁边的新标签 ──
    if (await enterSpace(win, 'amadeus')) {
      await sleep(1200)
      await collapseLeft(win)
      const tabs0 = await mainTabs(win)
      await hoverSpace(win, 'tangu')
      p = await peek(win)
      check('X1 人在笔记里,悬停 Tangu 弹出它的会话列表', p?.space === 'tangu' && !p.error, JSON.stringify(p))
      await win.locator('.rb-peek').locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session three' }).first().click()
      await sleep(1500)
      const tabs1 = await mainTabs(win)
      check('⚠️X2 点会话 = 人还在笔记里,会话开成新标签(原来的标签都还在)',
        (await activeSpace(win)) === 'amadeus' && tabs1.length === tabs0.length + 1 && tabs1.some((t) => /Probe session three/.test(t)) && tabs0.every((t) => tabs1.includes(t)),
        `${await activeSpace(win)} / ${JSON.stringify(tabs0)} → ${JSON.stringify(tabs1)}`)
      await hoverSpace(win, 'agents')
      const roster = win.locator('.rb-peek .agents-roster-item').first()
      if (await roster.count()) {
        await roster.click()
        await sleep(1500)
        const tabs2 = await mainTabs(win)
        check('⚠️X3 点 Agent 名册 = 人还在笔记里,资料页开成新标签(它自己「先切到 Agents」那一下被拦下)',
          (await activeSpace(win)) === 'amadeus' && tabs2.length === tabs1.length + 1, `${await activeSpace(win)} / ${JSON.stringify(tabs2)}`)
        // 资料页是单例、带 reuseKey:'primary':照单例复用的老路,已开着的 A 会被就地换成 B(Codex 评审实证)
        await hoverSpace(win, 'agents')
        await win.locator('.rb-peek .agents-roster-item').nth(1).click()
        await sleep(1500)
        const tabs3 = await mainTabs(win)
        check('⚠️X3b 已经开着一个 Agent 的资料页,卡里再点另一个:再开一个标签,不把开着的那个换掉',
          (await activeSpace(win)) === 'amadeus' && tabs3.length === tabs2.length + 1, JSON.stringify(tabs3))
      } else check('X3 Agents 的卡里有名册行', false)
      await hoverSpace(win, 'tangu')
      const beforeNew = await mainTabs(win)
      await win.locator('.rb-peek [data-act="new-chat"]').first().click()
      await sleep(1500)
      const afterNew = await mainTabs(win)
      check('X3c 卡里点「新对话」:人还在笔记里,新对话开成新标签', (await activeSpace(win)) === 'amadeus' && afterNew.length === beforeNew.length + 1,
        `${await activeSpace(win)} / ${JSON.stringify(afterNew)}`)
      const dragSession = (title) => win.evaluate(async (title) => {
        const nap = (ms) => new Promise((r) => setTimeout(r, ms))
        const src = [...document.querySelectorAll('.rb-peek .t2s-srow, .rb-peek .t2o-row')].find((r) => r.textContent?.includes(title))
        const g = [...document.querySelectorAll('.dv-groupview')].find((x) => x.getBoundingClientRect().height > 0 && !x.querySelector('.wb-tab--icon'))
        const tab = g?.querySelector('.dv-tab')?.getBoundingClientRect()
        if (!src || !tab) return { err: `src ${!!src} / tab ${!!tab}` }
        const x = tab.left + 3, y = tab.top + tab.height / 2, dataTransfer = new DataTransfer()
        src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
        await nap(50)
        const el = document.elementFromPoint(x, y)
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y }))
        await nap(50)
        const hint = [...document.querySelectorAll('.wb-drop-line')].some((e) => getComputedStyle(e).display !== 'none')
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, clientX: x, clientY: y }))
        if (src.isConnected) src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
        return { hint }
      }, title)
      await hoverSpace(win, 'tangu')
      const before = await mainTabs(win)
      const drag = await dragSession('Probe session one')
      await sleep(1200)
      const after = await mainTabs(win)
      check('⚠️X4 把卡里的会话拖进标签栏(第一个标签的左半边)= 那个位置上多一个标签,人还在笔记里',
        !drag.err && drag.hint && (await activeSpace(win)) === 'amadeus' && after.length === before.length + 1 && /Probe session one/.test(after[0]),
        `${JSON.stringify(drag)} / ${await activeSpace(win)} / ${JSON.stringify(after)}`)
      const drag2 = await dragSession('Probe session three')
      await sleep(1200)
      const after2 = await mainTabs(win)
      check('X4b 拖一个已经开着的会话进标签栏:是把那个标签挪过去,不再开一份',
        !drag2.err && after2.length === after.length && /Probe session three/.test(after2[0]), `${JSON.stringify(drag2)} / ${JSON.stringify(after2)}`)
      if (shots) await captureWindow(app, path.join(shots, `${n++}-amadeus-opened-beside.png`))
    } else check('X0 进得了笔记 Space(跨 Space 那段的前提)', false)

    // ── 左面板展开着:当前 Space 不弹(它的左栏就在眼前),别的 Space 照弹 ──
    await win.mouse.move(900, 600, { steps: 4 })
    await sleep(500)
    await setLeft(win, true)
    const here = await activeSpace(win)
    const other = here === 'amadeus' ? 'tangu' : 'amadeus'
    const onHere = await hoverSpace(win, here)
    check(`L1 左面板展开着,悬停当前 Space(${here})不弹`, onHere && (await peek(win)) === null)
    await hoverSpace(win, other)
    p = await peek(win)
    check(`L2 左面板展开着,悬停别的 Space(${other})照弹它的左面板`, p?.space === other && !p.error && p.nodes > 3, JSON.stringify(p))
    const fit = await win.evaluate(() => {
      const c = document.querySelector('.rb-peek')?.getBoundingClientRect()
      const g = document.querySelector('.wb-view--left:not(.rb-peek .wb-view--left)')?.closest('.dv-groupview')?.getBoundingClientRect()
      return c && g ? { card: [c.left, c.top, c.right, c.bottom].map(Math.round), panel: [g.left, g.top, g.right, g.bottom].map(Math.round) } : null
    })
    check('L2b 卡片正好盖在眼前这块左栏上', !!fit && fit.card.every((v, i) => Math.abs(v - fit.panel[i]) <= 2) && fit.panel[3] - fit.panel[1] > 100, JSON.stringify(fit))
    // mac:卡片顶到了窗口最上,交通灯(原生 70×28,截图里看不到)压在它左上角 —— 头部的内容得让开。
    const head = await win.evaluate(() => {
      const first = document.querySelector('.rb-peek-head > *')?.getBoundingClientRect()
      return { mac: document.querySelector('[data-platform]')?.getAttribute('data-platform') === 'mac', left: first?.left ?? -1, top: first?.top ?? -1 }
    })
    if (head.mac) check('L2c mac:盖在左栏上的卡片,头部让开交通灯(内容起点 ≥ 70px)', head.top >= 28 || head.left >= 70, JSON.stringify(head))
    else note('L2c 非 mac,不验交通灯避让', JSON.stringify(head))
    if (shots) await captureWindow(app, path.join(shots, `${n++}-left-open-${other}.png`))
    await win.mouse.move(900, 600, { steps: 4 })
    await sleep(500)
    check('L3 指针回主区 → 收起,眼前还是原来那块左栏', (await peek(win)) === null && (await activeSpace(win)) === here)

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
