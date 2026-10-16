// 长会话里程序滚动停得住(真 Electron + 假引擎):消息带 content-visibility,往上一滚刚进视口的才量出真实高度、内容变高。
// ① 吸底时程序往上滚(目录跳转就是程序滚动)不许被 follow 拽回底部(10-16 实报的回归:原来只认手势才松开吸底);
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

    for (let k = 0; k < 3; k++) { await win.evaluate(() => { const s = document.querySelector('.t2-stream'); s.scrollTop -= s.clientHeight }); await sleep(150) }
    await sleep(800)
    const held = await st()
    check('① 程序往上滚三屏停得住(没被拽回底部)', held.gap > 1500, held)

    await win.locator('.lcl-ftoc').first().hover(); await sleep(400)
    const items = win.locator('.lcl-ftoc-item')
    const pick = items.nth(Math.floor((await items.count()) / 3))
    const want = await pick.getAttribute('title')
    await pick.click(); await win.mouse.move(900, 500); await sleep(2500)
    const now = await win.evaluate(() => document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title || '')
    check('② 点目录里靠前的一项,落地后它是当前项', now === want, { want, now, ...(await st()) })

    // ④ 前一跳的补正还没完就点下一项:落在后点的那项(每个滚动容器只留一个补正)
    await win.locator('.lcl-ftoc').first().hover(); await sleep(300)
    const a = items.nth(Math.floor((await items.count()) / 4)), b = items.nth(Math.floor((await items.count()) * 3 / 4))
    const wantB = await b.getAttribute('title')
    await a.click(); await b.click(); await win.mouse.move(900, 500); await sleep(2500)
    const nowB = await win.evaluate(() => document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title || '')
    check('④ 连点两项,落在后点的那项', nowB === wantB, { wantB, nowB })

    // ⑤ 点完目录马上点「回到底部」:跳转那边的补正不许再把人拉回去
    await win.locator('.lcl-ftoc').first().hover(); await sleep(300)
    await items.nth(Math.floor((await items.count()) / 5)).click(); await sleep(150)
    await win.mouse.move(900, 500); await win.locator('.t2-jump').first().click({ timeout: 3000 }); await sleep(2500)
    check('⑤ 点完目录马上回到底部,停在底部', (await st()).gap < 40, await st())

    await win.evaluate(() => { const s = document.querySelector('.t2-stream'); s.scrollTop = s.scrollHeight }); await sleep(800)
    await win.evaluate(() => { const s = document.querySelector('.t2-stream'); s.scrollTop = s.scrollHeight }); await sleep(800)
    check('③ 回到底部后还在底部', (await st()).gap < 40, await st())
  } finally { await close() }
  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
