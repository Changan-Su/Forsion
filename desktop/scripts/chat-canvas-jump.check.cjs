// 画布里双击一张卡 → 切回对话、落到那一轮(真 Electron + 桩引擎)。check:chatcanvas 的 D1 抓不到:那边内容短、整段一屏放得下,
// 而且双击的是别的支(换会话)。这里一段会话三轮、每轮回答好几屏高,双击同一会话里的第 1 / 2 / 3 轮:
// 那条提问要落在视口顶部附近(scrollToElement 的 24px)、闪的那一下看得见,停稳后也不被拽回底部;再双击第 1 轮,还要再闪一次。
// 10-20 录 2.13.5 实录时实测:第 1、2 轮停在底部不动,目标在视口上方 −659 / −175px;第 3 轮(最新)正常。
// 根因:从底部起跳的平滑滚动第一帧只挪 1px,吸底被重新挂上,follow 把它拽回底部(时序有关,修前 u1 三跑三红、u2/u3 时红时绿);
// 闪光的类被 effect 清理掐掉了摘除定时器,再跳同一条不闪(修前必红)。
// 用法:npm run check:chatcanvasjump(量的是 out/ 产物,改了源码先 npm run build)
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U

const R = '5c1e0a52-0000-4000-8000-0000000000d1'
const T = Date.now() - 60 * 60_000
const long = (n) => Array.from({ length: 60 }, (_, i) => `${i + 1}. 第 ${n} 轮第 ${i + 1} 条:同步基线、对账器、合并器,每条都要写清楚为什么这样做、改了哪些模块。`).join('\n')
const msg = (id, role, mins, content) => ({ id, role, timestamp: T + mins * 60_000, content })
const MSGS = [
  msg('u1', 'user', 0, '第一轮:离线同步怎么做?'), msg('a1', 'model', 1, `第一轮回答。\n\n${long(1)}\n\n第一轮完。`),
  msg('u2', 'user', 2, '第二轮:按行三方合并展开说?'), msg('a2', 'model', 3, `第二轮回答。\n\n${long(2)}\n\n第二轮完。`),
  msg('u3', 'user', 4, '第三轮:合不了的时候用户看到什么?'), msg('a3', 'model', 5, `第三轮回答。\n\n${long(3)}\n\n第三轮完。`),
]

let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  | ${JSON.stringify(detail)}`}`) }

;(async () => {
  let projectDir = ''
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = () => ({ id: R, title: '长回答三轮', summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: projectDir, project_name: 'Forsion', projectless: false, created_at: at(61), updated_at: at(1) })
  const { app, win, close, projectDir: pd } = await U.launch({
    tag: 'canvasjump',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: [row()] }
      if (p === `/agent/sessions/${R}/messages` && method === 'GET') return { messages: MSGS }
      if (p === `/agent/sessions/${R}/asides` && method === 'GET') return { asides: [] }
      if (p === `/agent/sessions/${R}/detail`) return { session: { ...row(), kind: 'user', delegate_running: false } }
      return undefined
    },
  })
  projectDir = pd
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.locator(`.t2s-srow[data-sel-id="${R}"]`).first().click({ timeout: 20_000 })
    await win.locator('#tocmsg-a3').waitFor({ timeout: 15_000 })
    await sleep(1500)
    const seg = win.locator('[data-testid="chat-canvas-seg"]').first()
    const sh = await win.evaluate(() => { const s = document.querySelector('.t2-stream'); return { sh: s.scrollHeight, ch: s.clientHeight } })
    check('前提:整段对话远高于一屏(每轮回答好几屏)', sh.sh > sh.ch * 6, sh)

    // 目标(那一轮的提问)相对对话视口顶部的位置;离底部多远
    const where = (mid) => win.evaluate((mid) => {
      const s = document.querySelector('.t2-stream'), el = document.getElementById(`tocmsg-${mid}`)
      if (!s || !el) return null
      const r = el.getBoundingClientRect(), top = Math.round(r.top - s.getBoundingClientRect().top), bottom = top + Math.round(r.height)
      const anim = el.getAnimations().some((a) => a.animationName === 't2JumpFlash' && a.playState === 'running')
      return { top, gap: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight), flash: anim, bottom, vh: s.clientHeight }
    }, mid)

    for (const [i, mid] of ['u1', 'u2', 'u3', 'u1'].entries()) {
      // 每一跳都从底部起跳(在读最新那条回答时切去画布):bug 只在起点离底部 40px 以内时出现
      await win.evaluate(() => { const s = document.querySelector('.t2-stream'); s.scrollTop = s.scrollHeight })
      await sleep(500)
      await seg.getByRole('tab').nth(1).click()
      await win.locator('.t2cv').waitFor({ timeout: 10_000 })
      const card = win.locator(`.t2cv-card[data-cv-node="${R}:${mid}"]`)
      await card.waitFor({ timeout: 10_000 })
      await sleep(1200) // 落位 + 落位后 1.5s 的跟随窗口
      // Playwright 平移不了画布:用滚轮(= 平移)把卡头挪到舞台中间再双击
      const d = await win.evaluate((sel) => {
        const c = document.querySelector(sel).getBoundingClientRect(), s = document.querySelector('.t2cv-stage').getBoundingClientRect()
        return { mx: s.left + s.width / 2, my: s.top + s.height / 2, dx: c.left + c.width / 2 - (s.left + s.width / 2), dy: c.top + 40 - (s.top + s.height / 2) }
      }, `.t2cv-card[data-cv-node="${R}:${mid}"]`)
      await win.mouse.move(d.mx, d.my)
      await win.mouse.wheel(d.dx, d.dy)
      await sleep(400)
      await card.locator('.t2cv-q').dblclick()
      await win.waitForFunction(() => !document.querySelector('.t2cv'), null, { timeout: 5_000 })
      const samples = []
      for (const t of [100, 400, 900, 1400, 2500]) { await sleep(t - (samples.at(-1)?.t || 0)); samples.push({ t, ...(await where(mid)) }) }
      const seen = samples.find((x) => x.flash && x.bottom > 0 && x.top < x.vh - 60) // 闪着的时候它露在视口里(机器忙时平滑滚动慢,落地前就得看得见)
      const last = samples.at(-1)
      check(`${mid}${i === 3 ? '(再来一次)' : ''} 双击后那一轮落在视口顶部附近、闪的时候看得见`, !!seen && Math.abs(last.top - 24) <= 40, samples.map((x) => `${x.t}ms top=${x.top} gap=${x.gap}${x.flash ? ' ⚡' : ''}`).join(' · '))
      await win.mouse.move(700, 450)
    }
  } finally { await close() }
  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
