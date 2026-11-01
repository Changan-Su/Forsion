#!/usr/bin/env node
/**
 * 长内容探针(报告式,不判红绿):长会话 / 长笔记在几件日常动作上,主线程花了多少、出没出长帧。
 * 真 Electron × 假引擎 × 隔离 home,量 out/ 产物(先 npx electron-vite build)。会抢前台窗口,套台架锁跑:
 *   node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="long-content probe" --eta=6 -- node scripts/long-content.probe.cjs [选项]
 * 选项:--msgs=400(对话条数) --blocks=3000(笔记顶层块数) --reps=2(每个动作量几次,报中位) --only=chat,note --json=<文件>
 *
 * 阶段(对话):打开长会话(点会话到最后一条画出来)/ 左栏收起 / 左栏展开(聊天列变宽变窄 = 整篇重排)/ 往上翻 / 流式(240 段,每段 25ms)
 * 阶段(笔记):打开长笔记 / 左栏收起 / 左栏展开 / 往下翻 / 在靠前的段落里打 60 个字
 * 列:墙钟 | 主线程自耗时 脚本/样式/布局/绘制 | 最长任务 | 样式重算次数 × 平均波及元素 | 长帧(>50ms)个数 | rAF 最慢帧
 *
 * 2026-10-16 为「长内容渲染机制」(docs/ToBeImproved/长内容渲染机制方案_2026-10-16)建,改前改后各跑一次对比;trace 解析与 check:fps 共用 lib/fps-trace.cjs。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const U = require('./lib/uiux-electron.cjs')
const { RECORDER, rafStats, parseTrace } = require('./lib/fps-trace.cjs')
// ⚠️ 最长任务一列恒 0:trace 没开 toplevel 类别;「rAF 最慢帧」就是最长那次停顿。
const { sleep } = U

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const MSGS = Number(arg('msgs', 400))
const BLOCKS = Number(arg('blocks', 3000))
const REPS = Number(arg('reps', 2))
const ONLY = arg('only', 'chat,note').split(',')
const JSON_OUT = arg('json', '')

// ── 夹具:按真实回答的样子造(小标题、段落、行内码、代码块、表格、公式、列表) ──
const sentence = (i, k) => `第 ${i} 条第 ${k} 段:这是一段把对话撑长的正文,有 **粗体**、\`行内代码\`、[一个链接](https://forsion.net),还有一句足够长的话,让它在七百像素宽的列里折成两三行,看起来就像真的回答。`
const code = (i) => '```ts\n' + Array.from({ length: 18 }, (_, k) => `const v${k} = items.slice(${i}, ${i + k}).map((x) => x * ${k}) // 第 ${k} 行`).join('\n') + '\n```'
const table = (i) => '| 列 A | 列 B | 列 C |\n|---|---|---|\n' + Array.from({ length: 5 }, (_, k) => `| ${i}-${k} | ${k * i} | 说明 ${k} |`).join('\n')
const answer = (i) => [`## 小节 ${i}`, sentence(i, 1), sentence(i, 2), i % 3 === 0 ? code(i) : '', sentence(i, 3), i % 5 === 0 ? table(i) : '', i % 7 === 0 ? '$$\\sum_{k=0}^{n} h_k \\cdot w_k = \\frac{a+b}{c}$$' : '', '- 一\n- 二\n- 三'].filter(Boolean).join('\n\n')
const MESSAGES = Array.from({ length: MSGS }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'model' : 'user', content: i % 2 ? answer(i) : `第 ${i} 个问题:这一段怎么改比较好?`, timestamp: i + 1 }))
const ASSISTANT_COUNT = MESSAGES.filter((m) => m.role === 'model').length
const NOTE_TITLE = '长笔记探针'
function longNote(n) {
  const out = []
  for (let i = 0; i < n; i++) {
    if (i % 20 === 0) out.push(`## 第 ${i / 20 + 1} 节`)
    else if (i % 15 === 7) out.push(code(i))
    else if (i % 40 === 13) out.push(`![[附件 ${i}.pdf]]`)
    else if (i % 6 === 3) out.push(`- 列表项 ${i},带一点 **强调** 和 \`代码\``)
    else out.push(sentence(i, 1))
  }
  return out.join('\n\n') + '\n'
}
const STREAM = Array.from({ length: 240 }, (_, k) => ({ type: 'token', delay: 25, payload: { delta: k % 40 === 39 ? '\n\n' : `第${k}段字,` } }))

const pad = (v, n) => String(v).padStart(n)
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }

async function main() {
  const { app, win, home, stub, close } = await U.launch({ tag: 'longcontent', messages: MESSAGES })
  fs.writeFileSync(path.join(home, 'vault', `${NOTE_TITLE}.md`), longNote(BLOCKS))
  fs.writeFileSync(path.join(home, 'vault', '短笔记.md'), '# 短笔记\n\n两次打开长笔记之间先开它,第二次才是真的重新挂载。\n')
  const results = []
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    const info = await app.evaluate(({ screen }) => ({ electron: process.versions.electron, chrome: process.versions.chrome, hz: screen.getPrimaryDisplay().displayFrequency }))
    console.log(`Electron ${info.electron} / Chromium ${info.chrome} | ${Math.round(info.hz)}Hz | 对话 ${MSGS} 条 / 笔记 ${BLOCKS} 块 | 每个动作 ${REPS} 次取中位 | 负载 ${os.loadavg()[0].toFixed(1)} / ${os.cpus().length} 核`)
    await win.evaluate(RECORDER)
    await app.evaluate(({ contentTracing }) => contentTracing.startRecording({ included_categories: ['benchmark', 'blink.user_timing', 'devtools.timeline', 'v8'] }))
    let seq = 0
    /** 一段:mark 圈起来 → 做动作(返回墙钟 ms 或 null)→ 等 settle 毫秒 → 收 rAF 与长帧。 */
    const phase = async (group, name, action, settle = 400) => {
      const id = `p${seq++}`
      const t0 = await win.evaluate((id) => { performance.mark(`fps|${id}|s`); return performance.now() }, id)
      const wall = await action()
      await sleep(settle)
      const r = await win.evaluate(([a, id]) => { performance.mark(`fps|${id}|e`); return { t: window.__fps.t.filter((x) => x >= a), loaf: window.__fps.loaf.filter((x) => x.s >= a).length, vis: document.visibilityState } }, [t0, id])
      results.push({ group, name, id, wall, raf: rafStats(r.t), loaf: r.loaf, vis: r.vis })
    }
    const key = (k) => async () => { await win.keyboard.press(k); return null }
    const row = (title) => win.locator('.t2s-srow, .t2o-row').filter({ hasText: title }).first()

    if (ONLY.includes('chat')) {
      // 「出齐」= 最后一条助手消息画出来(桌面先挂末尾时,「首屏」更早);墙钟在页面里按帧量,不受 playwright 往返影响
      const openSession = (title) => async () => {
        await win.evaluate((want) => {
          const t0 = performance.now(); const s = (window.__lc = { first: null, all: null })
          const old = document.querySelector('.t2-stream-inner') // 换会话时整条流重挂(ErrorBoundary 按会话 key):旧的那条还在就不算
          const loop = () => {
            const inner = document.querySelector('.t2-stream-inner')
            const n = inner && inner !== old ? inner.querySelectorAll(':scope > .t2-asst').length : 0
            if (n && s.first == null) s.first = performance.now() - t0
            if (n >= want) { s.all = performance.now() - t0; return }
            if (performance.now() - t0 < 20000) requestAnimationFrame(loop)
          }
          requestAnimationFrame(loop)
        }, ASSISTANT_COUNT)
        await row(title).click({ timeout: 10_000 })
        for (let i = 0; i < 200; i++) { if (await win.evaluate(() => window.__lc.all != null)) break; await sleep(100) }
        return win.evaluate(() => window.__lc)
      }
      await openSession('Probe session one')()
      await sleep(1500)
      for (let k = 0; k < REPS; k++) {
        await phase('对话', '打开长会话', openSession(k % 2 ? 'Probe session one' : 'Probe session two'), 800)
      }
      const counts = await win.evaluate(() => ({ nodes: document.querySelectorAll('.t2-stream-inner *').length, msgs: document.querySelectorAll('.t2-stream-inner > .t2-asst, .t2-stream-inner > .t2-userwrap').length }))
      console.log(`对话:流里 ${counts.msgs} 条消息、${counts.nodes} 个元素`)
      // 点目录里中间那一项,落地后它得是当前项:10-16 一版里先是被吸底拽回底部,修了又因为上方消息进视口才量出真实高度、被挤开 850px
      await win.locator('.lcl-ftoc').first().hover(); await sleep(400)
      const items = win.locator('.lcl-ftoc-item')
      const pick = items.nth(Math.floor((await items.count()) / 2))
      const want = await pick.getAttribute('title')
      await pick.click(); await win.mouse.move(760, 420); await sleep(2500)
      await win.locator('.lcl-ftoc').first().hover(); await sleep(400) // 行只在展开时才有
      const now = await win.evaluate(() => document.querySelector('.lcl-ftoc-item[aria-current="location"]')?.title || '')
      if (now !== want) console.log(`⚠️ 目录跳转没落准:点的是「${want}」,落地后当前项是「${now}」`)
      await win.evaluate(() => { const s = document.querySelector('.t2-stream'); s.scrollTop = s.scrollHeight }); await sleep(600)
      await win.mouse.move(760, 420)
      for (let k = 0; k < REPS; k++) {
        await phase('对话', '左栏收起', key('Meta+Slash'), 600)
        await phase('对话', '左栏展开', key('Meta+Slash'), 600)
      }
      for (let k = 0; k < REPS; k++) {
        await phase('对话', '往上翻', async () => { await win.mouse.move(760, 420); for (let i = 0; i < 40; i++) { await win.mouse.wheel(0, -240); await sleep(16) } return null }, 300)
        await win.evaluate(() => { const s = document.querySelector('.t2-stream'); if (s) s.scrollTop = s.scrollHeight })
        await sleep(400)
      }
      for (let k = 0; k < REPS; k++) {
        stub.script(STREAM)
        await phase('对话', '流式 240 段', async () => {
          const ta = win.locator('.t2c-ta').first()
          await ta.click(); await ta.fill(`流式第 ${k} 轮`); await win.keyboard.press('Enter')
          await sleep(STREAM.length * 25 + 1200)
          return null
        }, 600)
      }
    }

    if (ONLY.includes('note')) {
      await U.enterSpace(win, 'amadeus')
      await sleep(2500)
      if (!(await row(NOTE_TITLE).count().catch(() => 0))) { await win.click('.dv-edge-left').catch(() => {}); await sleep(700) }
      const openNote = async () => {
        await win.evaluate((want) => {
          const t0 = performance.now(); const s = (window.__lc = { first: null, all: null })
          const loop = () => {
            const pm = document.querySelector('.page-view .ProseMirror') // 编辑器实例可能复用:按首块是不是长笔记的「第 1 节」认
            const n = pm && pm.firstElementChild?.textContent?.includes('第 1 节') ? pm.childElementCount : 0
            if (n && s.first == null) s.first = performance.now() - t0
            if (n >= want) { s.all = performance.now() - t0; return }
            if (performance.now() - t0 < 20000) requestAnimationFrame(loop)
          }
          requestAnimationFrame(loop)
        }, Math.floor(BLOCKS * 0.9))
        await row(NOTE_TITLE).click({ timeout: 10_000 })
        for (let i = 0; i < 200; i++) { if (await win.evaluate(() => window.__lc.all != null)) break; await sleep(100) }
        return win.evaluate(() => window.__lc)
      }
      for (let k = 0; k < REPS; k++) {
        if (k) { await row('短笔记').click({ timeout: 10_000 }); await sleep(1500) }
        await phase('笔记', '打开长笔记', openNote, 1200)
      }
      const counts = await win.evaluate(() => ({ nodes: document.querySelectorAll('.page-view *').length, blocks: document.querySelector('.page-view .ProseMirror')?.childElementCount || 0 }))
      console.log(`笔记:${counts.blocks} 个顶层块、${counts.nodes} 个元素`)
      await win.mouse.move(760, 420)
      for (let k = 0; k < REPS; k++) {
        await phase('笔记', '左栏收起', key('Meta+Slash'), 600)
        await phase('笔记', '左栏展开', key('Meta+Slash'), 600)
      }
      for (let k = 0; k < REPS; k++) {
        await phase('笔记', '往下翻', async () => { await win.mouse.move(760, 420); for (let i = 0; i < 40; i++) { await win.mouse.wheel(0, 240); await sleep(16) } return null }, 300)
      }
      // 打字:点进视口里第一个普通段落的末尾
      await win.evaluate(() => { const p = document.querySelector('.amx-pane'); if (p) p.scrollTop = 1200 })
      await sleep(2000) // 附近的嵌入是进了一屏以内才懒挂的:等它们挂完再量,否则挂载算到打字头上
      for (let k = 0; k < REPS; k++) {
        const box = await win.evaluate(() => {
          const pane = document.querySelector('.amx-pane')?.getBoundingClientRect()
          const kids = [...document.querySelector('.page-view .ProseMirror').children]
          const i = kids.findIndex((el) => { const r = el.getBoundingClientRect(); return el.tagName === 'P' && pane && r.top > pane.top + 80 && r.bottom < pane.bottom - 80 && !el.textContent.includes('![[') })
          const r = kids[i]?.getBoundingClientRect(); return r ? { x: r.right - 4, y: r.bottom - 8, i, len: kids[i].textContent.length } : null
        })
        if (!box) { console.log('⚠️ 没找到能打字的段落'); break }
        await win.mouse.click(box.x, box.y); await win.keyboard.press('End')
        await phase('笔记', '打 60 个字', async () => { await win.keyboard.type('长笔记打字探针'.repeat(9).slice(0, 60), { delay: 30 }); return null }, 500)
        // 字真落进那一段末尾了才作数:10-16 一版 CSS 让打字落点错乱,这一项照样「0 长帧」—— 活少是因为字没打对
        const got = await win.evaluate((i) => document.querySelector('.page-view .ProseMirror').children[i]?.textContent || '', box.i)
        if (got.length - box.len !== 60 || !got.endsWith('长笔记打字探针'.repeat(9).slice(0, 60).slice(-7))) console.log(`⚠️ 打字没落对:段落长 ${box.len} → ${got.length},末尾「${got.slice(-12)}」—— 这一项的数字不作数`)
      }
    }

    const file = await app.evaluate(({ contentTracing }) => contentTracing.stopRecording())
    const tr = parseTrace(file)
    try { fs.rmSync(file) } catch { /* ignore */ }

    const vsync = 1000 / (info.hz || 60)
    console.log(`\n列:墙钟(首屏 / 出齐) | 主线程自耗时 ms:脚本/样式/布局/绘制 | 最长任务 | 样式重算 × 平均波及 | 长帧 | rAF 最慢帧  (${REPS} 次取中位)`)
    const summary = []
    for (const group of [...new Set(results.map((r) => r.group))]) {
      console.log(`\n== ${group} ==`)
      for (const name of [...new Set(results.filter((r) => r.group === group).map((r) => r.name))]) {
        const rs = results.filter((r) => r.group === group && r.name === name)
        const f = rs.map((r) => tr.out[r.id]).filter(Boolean)
        const m = (fn) => median(f.map(fn))
        const s = {
          group, name,
          first: median(rs.map((r) => r.wall?.first)), all: median(rs.map((r) => r.wall?.all)),
          script: m((x) => x.cpu.script), style: m((x) => x.cpu.style), layout: m((x) => x.cpu.layout), paint: m((x) => x.cpu.paint),
          maxTask: m((x) => x.maxTask), recalcs: m((x) => x.recalcs), recalcEls: m((x) => (x.recalcs ? x.recalcEls / x.recalcs : 0)),
          loaf: median(rs.map((r) => r.loaf)), rafMax: median(rs.map((r) => r.raf?.max ?? null)),
          hidden: rs.some((r) => r.vis !== 'visible'),
        }
        summary.push(s)
        const wall = s.all != null ? `${pad(Math.round(s.first), 5)} / ${pad(Math.round(s.all), 5)}ms` : pad('', 15)
        const n = (v) => pad(v == null ? '-' : Math.round(v), 4)
        console.log(`${name.padEnd(8)} ${wall} | ${n(s.script)}/${n(s.style)}/${n(s.layout)}/${n(s.paint)} | ${n(s.maxTask)}ms | ${n(s.recalcs)} × ${pad(Math.round(s.recalcEls || 0), 5)} | 长帧 ${n(s.loaf)} | ${n(s.rafMax)}ms${s.rafMax > vsync * 2.5 ? '!' : ' '}${s.hidden ? ' ⚠️窗口被遮' : ''}`)
      }
    }
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ info, msgs: MSGS, blocks: BLOCKS, reps: REPS, summary }, null, 1))
    console.log(`\n收场负载 ${os.loadavg()[0].toFixed(1)}`)
  } finally {
    await close()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
