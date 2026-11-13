// 长会话里程序滚动停得住(真 Electron + 假引擎):消息带 content-visibility,往上一滚刚进视口的才量出真实高度、内容变高。
// ① 吸底时用户往上滚不许被 follow 拽回底部;②④⑤ 覆盖真实目录的程序跳转。
// 程序导航由 scrollToElement 发出明确意图,不能从 scrollTop 变化猜测(浏览器布局修正也会改变它)。
// ② 点目录中间那一项要落在那一项上(被跳过的消息进视口把目标挤开约 850px,滚动锚定那时不补 → scrollToElement 落地再补);
// ③ 回到底部吸底照常恢复;④ 连点两项落在后一项;⑤ 点完目录马上回到底部,补正不许把人拉回去。用法:npm run check:chatscrollhold(先 npm run build)
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U

const answer = (i) => [`## 小节 ${i}`, '正文第一段,足够长,让它在聊天列里折成两行。'.repeat(3), '- 列表一\n  - 嵌套一\n- 列表二', '> 引用', i % 2 ? '```ts\nconst a = 1\n```' : '| A | B |\n|---|---|\n| 1 | 2 |', '最后一段。'].join('\n\n')
const MESSAGES = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'model' : 'user', content: i % 2 ? answer(i) : `问题 ${i}:这样写对吗?`, timestamp: i + 1 }))

let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  | ${JSON.stringify(detail)}`}`) }

;(async () => {
  const { app, win, close } = await U.launch({ tag: 'scrollhold', messages: MESSAGES })
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click({ timeout: 10_000 })
    await sleep(3500)
    const st = () => win.evaluate(() => { const s = document.querySelector('.t2-stream'); return { top: Math.round(s.scrollTop), gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) } })
    check('打开后在底部', (await st()).gap < 40, await st())

    await win.locator('.t2-stream').first().hover()
    for (let k = 0; k < 3; k++) { await win.mouse.wheel(0, -834); await sleep(150) }
    await sleep(800)
    const held = await st()
    check('① 用户往上滚三屏停得住(没被拽回底部)', held.gap > 1500, held)

    // A Space switch destroys/rebuilds the View, unlike a tab's DOM detach.
    const readingAnchor = () => win.evaluate(() => {
      const root = document.querySelector('.t2-stream'), rect = root.getBoundingClientRect()
      const node = [...root.querySelectorAll('[id^="tocmsg-"]')].find(el => el.getBoundingClientRect().bottom > rect.top + 1)
      return { id: node?.id, offset: node ? Math.round(node.getBoundingClientRect().top - rect.top) : null }
    })
    const beforeSpace = await readingAnchor()
    for (let round = 0; round < 2; round++) {
      const away = await U.enterSpace(win, 'home', { real: true })
      const back = await U.enterSpace(win, 'tangu', { real: true })
      await sleep(1800)
      const afterSpace = await readingAnchor()
      check(`Space 往返 ${round + 1} 保留原消息和偏移`, away && back && afterSpace.id === beforeSpace.id && Math.abs(afterSpace.offset - beforeSpace.offset) <= 4, { beforeSpace, afterSpace, ...(await st()) })
    }
    if (process.env.CHAT_READING_SHOT) await win.screenshot({ path: process.env.CHAT_READING_SHOT })


    await win.locator('.lcl-ftoc').first().hover(); await sleep(400)
    const items = win.locator('.lcl-ftoc-item')
    const pick = items.nth(Math.floor((await items.count()) / 3))
    const want = await pick.getAttribute('title')
    await pick.click(); await win.mouse.move(900, 500); await sleep(2500)
    await win.locator('.lcl-ftoc').first().hover(); await sleep(400) // 行只在展开时才有
    const now = await win.evaluate(() => document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title || '')
    await win.mouse.move(900, 500); await sleep(600)
    check('② 点目录里靠前的一项,落地后它是当前项', now === want, { want, now, ...(await st()) })

    // ④ 前一跳的补正还没完就点下一项:落在后点的那项(每个滚动容器只留一个补正)
    await win.locator('.lcl-ftoc').first().hover(); await sleep(300)
    const a = items.nth(Math.floor((await items.count()) / 4)), b = items.nth(Math.floor((await items.count()) * 3 / 4))
    const wantB = await b.getAttribute('title')
    await a.click(); await b.click(); await win.mouse.move(900, 500); await sleep(2500)
    await win.locator('.lcl-ftoc').first().hover(); await sleep(400)
    const nowB = await win.evaluate(() => document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title || '')
    await win.mouse.move(900, 500); await sleep(600)
    check('④ 连点两项,落在后点的那项', nowB === wantB, { wantB, nowB })

    // ⑤ 点完目录马上点「回到底部」:跳转那边的补正不许再把人拉回去
    await win.locator('.lcl-ftoc').first().hover(); await sleep(300)
    await items.nth(Math.floor((await items.count()) / 5)).click(); await sleep(150)
    await win.mouse.move(900, 500); await win.locator('.t2-jump').first().click({ timeout: 3000 }); await sleep(2500)
    check('⑤ 点完目录马上回到底部,停在底部', (await st()).gap < 40, await st())

    await win.evaluate(() => { const s = document.querySelector('.t2-stream'); s.scrollTop = s.scrollHeight }); await sleep(800)
    await win.evaluate(() => { const s = document.querySelector('.t2-stream'); s.scrollTop = s.scrollHeight }); await sleep(800)
    check('③ 回到底部后还在底部', (await st()).gap < 40, await st())

    // openSession publishes activeId before opening its new tab: that synchronous
    // interval must not put the destination session into the original View's history.
    const navState = () => win.evaluate(() => [...document.querySelectorAll('[data-view-nav]')]
      .filter(el => el.getBoundingClientRect().width > 0)
      .map(el => ({ id: el.dataset.viewNav, buttons: [...el.querySelectorAll('button')].map(b => [b.dataset.press, b.disabled, b.title]) })))
    const originalNav = await navState()
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session two' }).first().click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
    await sleep(800)
    await win.locator('.dv-tab').filter({ hasText: 'Probe session one' }).first().click()
    await sleep(800)
    const returnedNav = await navState()
    check('另开会话标签不污染原 View 的导航历史', JSON.stringify(originalNav) === JSON.stringify(returnedNav), { originalNav, returnedNav })
  } finally { await close() }
  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
