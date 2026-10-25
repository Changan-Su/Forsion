/**
 * 子会话药丸 + 托盘清单(方案「借鉴 Comma」第三轮 2.2 / 2.6)的真 Electron 台架。桩引擎回一份会话名册:
 * 主会话 P 开了三个子会话(在跑 / 等你 / 做完了没看),后面又聊了十几轮,子会话块被顶到上面去;另一个主会话 Q 的子会话都做完了。
 * 断言:
 *  P1 块在视野里 → 不露药丸;P2 滚到底 → 输入框上方露「子会话 · 1 个在跑 · 1 个等你」,在「N 件等你」那一排里;
 *  P3 点药丸 → 滚回子会话块(块进可见区)并闪(t2-jump-flash);P4 滚走再滚到底 → 药丸又在;
 *  P5 子会话都做完的会话滚到底也不露;T1 渲染层经 tray:sessions 报给主进程的清单 = 在跑 / 等你那几条(等你在前)。
 * 截图(亮色 + 暗色)自己看。量的是 out/ 产物:改了源码先 `npx electron-vite build`。
 *   node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="子会话药丸台架" --eta=3 -- npm run check:childpill
 *   SHOT_DIR=… 指定截图目录;LANG_EN=1 拍英文
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir, sleep } = require('./lib/uiux-electron.cjs')

const P = '0b6f8c2e-2a20-4c4e-9b11-0000000000a1'
const K = ['0b6f8c2e-2a20-4c4e-9b11-0000000000c1', '0b6f8c2e-2a20-4c4e-9b11-0000000000c2', '0b6f8c2e-2a20-4c4e-9b11-0000000000c3']
const Q = '0b6f8c2e-2a20-4c4e-9b11-0000000000b1'
const QK = '0b6f8c2e-2a20-4c4e-9b11-0000000000d1'
const LONE = '0b6f8c2e-2a20-4c4e-9b11-0000000000f1'
const T = Date.now() - 30 * 60_000

function sessions(dir) {
  const base = { summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: dir, project_name: 'Forsion', projectless: false }
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = (id, title, mins, extra = {}) => ({ ...base, id, title, created_at: at(mins + 60), updated_at: at(mins), ...extra })
  return [
    row(P, '三家笔记软件的离线同步怎么做', 1),
    row(K[0], '查 Obsidian Sync 的冲突处理', 2, { parent_session_id: P, busy: true }),
    row(K[1], '查 Notion 离线模式', 3, { parent_session_id: P, awaiting_user: true }),
    row(K[2], '查 Logseq 的同步', 4, { parent_session_id: P }),
    row(Q, '日历显示优化', 8),
    row(QK, '日历标签切走再切回来跳到 8 月', 9, { parent_session_id: Q }),
    row(LONE, '桌面端冷启动慢了 0.8 秒', 6, { awaiting_user: true }),
  ]
}

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const res = (id, name, content) => ({ tool_call_id: id, name, content, isError: false })
const filler = (prefix, n) => Array.from({ length: n }, (_, i) => [
  { id: `${prefix}u${i}`, role: 'user', timestamp: T + (i + 2) * 60_000, content: `第 ${i + 1} 轮:顺便再看看 Amadeus 这边离线编辑时块级合并会不会丢格式?` },
  { id: `${prefix}a${i}`, role: 'model', timestamp: T + (i + 2) * 60_000 + 30_000, content: `第 ${i + 1} 轮的回答。块级合并按段落三方比对,标题和列表的标记跟着段落走,不会单独丢。\n\n- 段落内的行内格式按字符区间合并\n- 两边都改了同一段就两份都留,标出冲突\n- 表格按单元格合并,结构变了退回整表两份` },
]).flat()
const parentMsgs = [
  // 前面先垫几轮:块要能被滚到可见区底边附近(P6)
  ...filler('pre', 3).map((m, i) => ({ ...m, timestamp: T - (10 - i) * 60_000 })),
  { id: 'u1', role: 'user', timestamp: T, content: '帮我查一下 Obsidian、Notion、Logseq 这三家怎么处理离线编辑和冲突。' },
  { id: 'a1', role: 'model', timestamp: T + 60_000,
    tool_calls: K.map((_, i) => call(`s${i}`, 'start_session', { title: `t${i}`, message: 'brief' })),
    tool_results: K.map((k, i) => res(`s${i}`, 'start_session', `Started child session "t${i}" (id ${k}). It is working on its own.`)),
    content: '三家各查各的,我分成三个子会话同时查。它们查完会回来告诉我。' },
  ...filler('p', 8),
]
const qMsgs = [
  { id: 'qu1', role: 'user', timestamp: T, content: '日历显示的两个问题分头查一下。' },
  { id: 'qa1', role: 'model', timestamp: T + 60_000,
    tool_calls: [call('q0', 'start_session', { title: 'q', message: 'brief' })],
    tool_results: [res('q0', 'start_session', `Started child session "q" (id ${QK}). It is working on its own.`)],
    content: '开了一个子会话去查。' },
  ...filler('qf', 8),
]

async function main() {
  const r = makeReporter()
  const dir = shotDir('child-pill')
  let projectDir = ''
  const ctx = await launch({
    tag: 'child-pill',
    fixtures: { agents: [], sessions: [] },
    stubOverride: ({ path: p, method }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: sessions(projectDir) }
      let m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: m[1] === P ? parentMsgs : m[1] === Q ? qMsgs : [] }
      m = /^\/agent\/sessions\/([^/]+)\/detail$/.exec(p)
      if (m) { const s = sessions(projectDir).find((x) => x.id === m[1]); if (s) return { session: { ...s, kind: 'user' } } }
      return undefined
    },
  })
  projectDir = ctx.projectDir
  const { app, win } = ctx
  try {
    // 旁听渲染层报给托盘的清单(主进程自己的 handler 照常收;这里只多挂一个监听)
    await app.evaluate(({ ipcMain }) => { ipcMain.on('tray:sessions', (_e, rows) => { globalThis.__trayRows = rows }) })
    await boot(app, win, { space: 'tangu', width: 1280, height: 820 })
    await win.evaluate(({ unread, en }) => {
      localStorage.setItem('forsion_tangu_unread_sessions', JSON.stringify(unread))
      if (en) localStorage.setItem('tangu_locale', 'en')
    }, { unread: [K[2]], en: !!process.env.LANG_EN })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    const row = (id) => win.locator(`.t2s-srow[data-sel-id="${id}"]`).first()
    await row(P).waitFor({ timeout: 20_000 })

    // ── T1 托盘清单 ──
    await sleep(1200)
    const tray = await app.evaluate(() => globalThis.__trayRows || null)
    const trayIds = (tray || []).map((x) => `${x.state}:${x.id.slice(-2)}`)
    r.check('T1 报给托盘的清单 = 等你(私聊等回答 / 子会话等你)在前,在跑在后;做完了的不在', JSON.stringify(trayIds) === JSON.stringify(['wait:c2', 'wait:f1', 'run:c1']) || JSON.stringify(trayIds) === JSON.stringify(['wait:f1', 'wait:c2', 'run:c1']), JSON.stringify(trayIds))
    r.check('T1b 清单带显示标题', (tray || []).some((x) => x.title === '查 Notion 离线模式'), '')

    // ── 主会话 P ──
    await row(P).click()
    await win.locator('#tocmsg-a1 .t2-childs').waitFor({ timeout: 15_000 })
    await win.locator(`#tocmsg-pa7`).waitFor({ timeout: 15_000 })
    const pill = win.locator('.t2-childpill')
    const scrollTo = async (where) => {
      await win.evaluate(({ where }) => {
        const block = document.querySelector('#tocmsg-a1 .t2-childs')
        let el = block
        while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement
        if (!el) return
        if (where === 'bottom') el.scrollTop = el.scrollHeight
        else if (where === 'top') el.scrollTop = 0
        else block.scrollIntoView({ block: 'center' })
      }, { where })
      await sleep(500)
    }
    await scrollTo('block')
    r.check('P1 子会话块在视野里 → 不露药丸', await pill.count() === 0, String(await pill.count()))

    await scrollTo('bottom')
    await pill.waitFor({ timeout: 3000 }).catch(() => {})
    const info = await win.evaluate(() => {
      const b = document.querySelector('.t2-childpill')
      return b ? {
        data: b.getAttribute('data-child-pill'), text: (b.innerText || '').replace(/\s+/g, ' ').trim(),
        inRow: !!b.closest('.t2-deckpill-row'), aboveComposer: !!b.closest('.composer-anchor'),
        run: !!b.querySelector('.t2s-st.run'), wait: !!b.querySelector('.t2s-st.wait'),
        runColor: getComputedStyle(b.querySelector('.t2s-st.run'), '::before').borderTopColor,
        waitColor: getComputedStyle(b.querySelector('.t2s-st.wait'), '::before').backgroundColor,
      } : null
    })
    const want = process.env.LANG_EN ? 'Child sessions · 1 running · 1 needs you' : '子会话 · 1 个在跑 · 1 个等你'
    r.check('P2 滚到底 → 药丸露出,计数 1 在跑 · 1 等你', !!info && info.data === '1:1' && info.text === want, JSON.stringify(info))
    r.check('P2b 药丸在输入区上方「N 件等你」那一排里', !!info && info.inRow && info.aboveComposer, '')
    r.check('P2c 在跑 = 主题色转圈,等你 = 警示色点', !!info && info.run && info.wait && info.runColor !== info.waitColor, `${info?.runColor} / ${info?.waitColor}`)

    // 截图:亮色
    const shot = async (name) => {
      const anchor = await win.locator('.composer-anchor').boundingBox()
      if (anchor) await win.screenshot({ path: path.join(dir, `${name}.png`), clip: { x: Math.max(0, anchor.x - 20), y: Math.max(0, anchor.y - 80), width: anchor.width + 40, height: anchor.height + 100 } })
      await win.screenshot({ path: path.join(dir, `${name}-full.png`) })
    }
    await win.mouse.move(5, 400)
    await shot('pill-light')

    // P3 点了滚回块并闪
    await pill.click()
    let flashed = false
    for (let i = 0; i < 20 && !flashed; i++) { flashed = await win.evaluate(() => !!document.querySelector('#tocmsg-a1 .t2-childs.t2-jump-flash')); if (!flashed) await sleep(80) }
    await sleep(900)
    const back = await win.evaluate(() => {
      const block = document.querySelector('#tocmsg-a1 .t2-childs')
      let el = block
      while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement
      const br = block.getBoundingClientRect(), rr = el.getBoundingClientRect()
      const cover = parseFloat(getComputedStyle(el).getPropertyValue('--t2-composer-h')) || 96
      return { top: Math.round(br.top - rr.top), bottom: Math.round(rr.bottom - cover - br.bottom), visible: br.top >= rr.top - 1 && br.bottom <= rr.bottom - cover + 1 }
    })
    r.check('P3 点药丸 → 滚回子会话块(整块在可见区)', back.visible, JSON.stringify(back))
    r.check('P3b 到位后块闪了(t2-jump-flash)', flashed, '')
    await sleep(400)
    r.check('P3c 块回到视野后药丸收起', await pill.count() === 0, String(await pill.count()))

    await scrollTo('bottom')
    r.check('P4 再滚到底 → 药丸又在', await pill.count() === 1, '')

    // P6 输入区变高把块压住 → 药丸露出;草稿清掉、块又露出来 → 收起(可见范围跟着输入区实高走,不是建观察器那一刻的值)
    await win.evaluate(() => {
      const block = document.querySelector('#tocmsg-a1 .t2-childs')
      let el = block
      while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement
      const cover = parseFloat(getComputedStyle(el).getPropertyValue('--t2-composer-h')) || 96
      const rr = el.getBoundingClientRect(), br = block.getBoundingClientRect()
      el.scrollTop += br.top - (rr.bottom - cover) + 40 // 块只露出顶上 40px,其余在输入区后面
    })
    await sleep(500)
    const beforeGrow = await pill.count()
    const g0 = await win.evaluate(() => (() => { const block = document.querySelector('#tocmsg-a1 .t2-childs'); let el = block; while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement; const rr = el.getBoundingClientRect(), br = block.getBoundingClientRect(); return { h: getComputedStyle(el).getPropertyValue('--t2-composer-h'), top: Math.round(br.top - rr.top), bottom: Math.round(br.bottom - rr.top), rootH: Math.round(rr.height), st: Math.round(el.scrollTop) } })())
    await win.locator('.t2c-ta').first().fill('多行草稿\n'.repeat(8))
    await sleep(600)
    const grown = await pill.count()
    const g1 = await win.evaluate(() => (() => { const block = document.querySelector('#tocmsg-a1 .t2-childs'); let el = block; while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement; const rr = el.getBoundingClientRect(), br = block.getBoundingClientRect(); return { h: getComputedStyle(el).getPropertyValue('--t2-composer-h'), top: Math.round(br.top - rr.top), bottom: Math.round(br.bottom - rr.top), rootH: Math.round(rr.height), st: Math.round(el.scrollTop) } })())
    await win.locator('.t2c-ta').first().fill('')
    await sleep(600)
    r.check('P6 块只露一角时不露;输入区变高把它压住 → 药丸露出', beforeGrow === 0 && grown === 1, `${beforeGrow} → ${grown} ${JSON.stringify(g0)} ${JSON.stringify(g1)}`)
    r.check('P6b 草稿清掉、块又露出来 → 药丸收起', await pill.count() === 0, String(await pill.count()))
    await scrollTo('bottom')

    // 暗色截图
    await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') })
    await sleep(400)
    await shot('pill-dark')
    await win.evaluate(() => { const e = document.documentElement; delete e.dataset.mode; e.classList.remove('dark') })

    // ── P5 子会话都做完了的会话:滚到底也不露 ──
    await row(Q).click()
    await win.locator('#tocmsg-qa1 .t2-childs').waitFor({ timeout: 15_000 }).catch(async () => {
      await win.screenshot({ path: path.join(dir, 'p5-debug.png') })
      console.log('P5 debug', await win.evaluate(() => ({ ids: [...document.querySelectorAll('[id^=tocmsg-]')].map((e) => e.id).slice(0, 6), childs: document.querySelectorAll('.t2-childs').length })))
      throw new Error('Q 会话的子会话块没出来')
    })
    await win.locator('#tocmsg-qfa7').waitFor({ timeout: 15_000 })
    await win.evaluate(() => {
      const block = document.querySelector('#tocmsg-qa1 .t2-childs')
      let el = block
      while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement
      if (el) el.scrollTop = el.scrollHeight
    })
    await sleep(700)
    r.check('P5 子会话都做完的会话:滚到底也不露药丸', await pill.count() === 0, String(await pill.count()))
    r.check('P5b 那一排空着时不占位(:empty 收掉)', await win.evaluate(() => [...document.querySelectorAll('.t2-deckpill-row')].every((e) => e.children.length > 0 || getComputedStyle(e).display === 'none')), '')
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
