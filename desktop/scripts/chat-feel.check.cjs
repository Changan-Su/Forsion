/** Real Electron:Chat 手感四件(借鉴 Comma 方案第一轮「Chat 手感」,2026-10-24)。
 * 钉住:
 *   1. 流式尾巴淡入 —— 流式期间 CSS.highlights 里有 t2-reveal-* 的 Range、只落在 .t2-content 的字上;流完 300ms 内全部清空;挂上时已有的字不淡入。
 *   2. 过程行滚动替换 —— 工具从第一步换到第二步时,折叠的过程行里新行带 .is-in、旧行 .is-out 叠在同一格,放完旧行拆掉。
 *   3. 开关拉伸 —— 旋钮按左右两条边走、后沿晚出发:途中旋钮比 14px 宽,落定回到 14px、在另一头。
 *   4. 划线条顺着拖选方向进 —— 从左往右拖 data-dir=forward、反过来 backward,双击没有 data-dir;有方向时进场动画是 selbar-in。
 * npm run build && npm run check:chatfeel        截图落在 SHOT_DIR(缺省系统临时目录 forsion-chat-feel-shots)
 */
const path = require('path')
const { launch, boot, makeReporter, shotDir, sleep } = require('./lib/uiux-electron.cjs')

const T = Date.now() - 10 * 60_000
const PARA = 'The lexer should stay a pure function of its input, and the parser recovers from errors.'
const MESSAGES = [
  { id: 'u1', role: 'user', timestamp: T, content: '解析器怎么拆?' },
  { id: 'a1', role: 'model', timestamp: T + 1000, content: PARA },
]

/** 真鼠标在第一处 `text` 上拖选:forward = 从头拖到尾,backward = 从尾拖到头。 */
async function drag(win, text, backward) {
  const at = await win.evaluate((text) => {
    window.getSelection()?.removeAllRanges()
    for (const root of document.querySelectorAll('.t2-content')) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(text)
        if (i < 0) continue
        const a = document.createRange(); a.setStart(n, i); a.setEnd(n, i + 1)
        const b = document.createRange(); b.setStart(n, i + text.length - 1); b.setEnd(n, i + text.length)
        const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect()
        return { x0: ra.left + 1, y0: ra.top + ra.height / 2, x1: rb.right - 1, y1: rb.top + rb.height / 2 }
      }
    }
    return null
  }, text)
  if (!at) throw new Error(`text not found: ${text}`)
  const [from, to] = backward ? [[at.x1, at.y1], [at.x0, at.y0]] : [[at.x0, at.y0], [at.x1, at.y1]]
  await win.mouse.move(from[0], from[1])
  await win.mouse.down()
  await win.mouse.move(to[0], to[1], { steps: 8 })
  await win.mouse.up()
}
const barInfo = (win) => win.evaluate(() => {
  const el = document.querySelector('[data-testid="selection-bar"]:not([data-lcl-exit])')
  if (!el) return null
  return { dir: el.getAttribute('data-dir'), anim: el.getAnimations().map((a) => a.animationName), travel: getComputedStyle(el).getPropertyValue('--selbar-travel').trim() }
})
async function dismissBar(win) {
  await win.mouse.click(5, 450)
  await win.evaluate(() => window.getSelection()?.removeAllRanges())
  await sleep(300)
}

async function main() {
  const r = makeReporter()
  const dir = shotDir('chat-feel')
  const ctx = await launch({ tag: 'chat-feel', messages: MESSAGES })
  const { app, win } = ctx
  try {
    await boot(app, win, { width: 1280, height: 860 })
    await win.addStyleTag({ content: '.sync-setup-backdrop { display: none !important; }' }) // 登录后首次同步卡会盖住(同 btw.check)
    await win.locator('text=Probe session one').first().click()
    await win.locator('.t2-content', { hasText: 'pure function' }).first().waitFor({ timeout: 15_000 })
    await sleep(400)

    // ── 4. 划线条方向 ──
    await drag(win, 'pure function of its input', false)
    const fwd = await win.waitForFunction(() => document.querySelector('[data-testid="selection-bar"]:not([data-lcl-exit])'), null, { timeout: 4000 }).then(() => barInfo(win))
    r.check('4a 从左往右拖:data-dir=forward、进场是 selbar-in、从左边来', fwd?.dir === 'forward' && fwd.anim.includes('selbar-in') && fwd.travel === '-8px', JSON.stringify(fwd))
    await sleep(300)
    await win.screenshot({ path: path.join(dir, 'selbar-forward.png') })
    await dismissBar(win)
    await drag(win, 'pure function of its input', true)
    const back = await win.waitForFunction(() => document.querySelector('[data-testid="selection-bar"]:not([data-lcl-exit])'), null, { timeout: 4000 }).then(() => barInfo(win))
    r.check('4b 从右往左拖:data-dir=backward、从右边来', back?.dir === 'backward' && back.anim.includes('selbar-in') && back.travel === '8px', JSON.stringify(back))
    await dismissBar(win)
    const word = await win.evaluate(() => {
      for (const root of document.querySelectorAll('.t2-content')) {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const i = n.data.indexOf('lexer')
          if (i < 0) continue
          const a = document.createRange(); a.setStart(n, i + 1); a.setEnd(n, i + 2)
          const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
        }
      }
      return null
    })
    await win.mouse.dblclick(word.x, word.y)
    const dbl = await win.waitForFunction(() => document.querySelector('[data-testid="selection-bar"]:not([data-lcl-exit])'), null, { timeout: 4000 }).then(() => barInfo(win))
    r.check('4c 双击选词:没有方向,照旧菜单进场', !!dbl && dbl.dir === null && !dbl.anim.includes('selbar-in'), JSON.stringify(dbl))
    await dismissBar(win)

    // ── 3. 开关拉伸(全局样式,探针按钮直接用产品的 .settings-switch) ──
    await win.evaluate(() => {
      const b = document.createElement('button')
      b.className = 'settings-switch'; b.id = 'feel-switch'
      b.style.cssText = 'position:fixed;left:40px;top:40px;z-index:99999'
      b.appendChild(document.createElement('span'))
      b.onclick = () => b.classList.toggle('active')
      document.body.appendChild(b)
    })
    await win.mouse.move(600, 600)
    const sw = await win.evaluate(() => new Promise((res) => {
      const b = document.getElementById('feel-switch'); const k = b.firstElementChild
      const box = () => { const kb = k.getBoundingClientRect(); const bb = b.getBoundingClientRect(); return { l: kb.left - bb.left, w: kb.width } }
      const before = box(); const widths = []; const t0 = performance.now()
      b.click()
      const f = () => { widths.push(box().w); if (performance.now() - t0 < 260) requestAnimationFrame(f); else res({ before, widths, after: box() }) }
      requestAnimationFrame(f)
    }))
    const maxW = Math.max(...sw.widths)
    r.check('3a 途中旋钮被拉长(后沿晚出发)', maxW > sw.before.w + 3, `before=${sw.before.w} max=${maxW.toFixed(1)}`)
    r.check('3b 落定:回到原宽、在另一头', Math.abs(sw.after.w - sw.before.w) < 0.5 && sw.after.l > sw.before.l + 12, JSON.stringify(sw.after))

    // ── 1 + 2. 流式尾巴淡入 + 过程行滚动替换 ──
    const tokens = 'Tokens arrive in small bursts so the tail of the answer fades in instead of popping. '.repeat(3).match(/.{1,7}/g)
    ctx.stub.script([
      { type: 'tool_call', payload: { id: 't1', name: 'read_file', arguments: JSON.stringify({ path: 'src/lexer.ts' }) } },
      { type: 'tool_result', delay: 900, payload: { id: 't1', result: 'ok', elapsedMs: 9 } },
      { type: 'tool_call', payload: { id: 't2', name: 'read_file', arguments: JSON.stringify({ path: 'src/parser.ts' }) } },
      { type: 'tool_result', delay: 900, payload: { id: 't2', result: 'ok', elapsedMs: 9 } },
      ...tokens.map((delta) => ({ type: 'token', delay: 70, payload: { delta } })),
    ])
    // 帧采样:过程行的 is-in / is-out、高亮里的 Range 数(以及它们是不是都在 .t2-content 里)
    const probe = win.evaluate(() => new Promise((res) => {
      const out = { rollIn: 0, rollOut: 0, overlap: 0, maxRanges: 0, outsideContent: 0, frames: 0, cleared: null }
      const t0 = performance.now()
      const f = () => {
        out.frames++
        const head = [...document.querySelectorAll('.t2-asst[data-streaming] .tool-group-head .tool-roll')].pop()
        if (head) {
          const ins = head.querySelectorAll('.tool-roll-item.is-in').length; const outs = head.querySelectorAll('.tool-roll-item.is-out').length
          if (ins) out.rollIn++
          if (outs) out.rollOut++
          if (ins && outs) out.overlap++
        }
        let n = 0
        for (const [name, h] of CSS.highlights) {
          if (!name.startsWith('t2-reveal-')) continue
          for (const range of h) { n++; if (!range.startContainer.parentElement?.closest('.t2-content')) out.outsideContent++ }
        }
        out.maxRanges = Math.max(out.maxRanges, n)
        const streaming = !!document.querySelector('.t2-asst[data-streaming]')
        if (!streaming && performance.now() - t0 > 1500) {
          setTimeout(() => {
            let left = 0
            for (const [name, h] of CSS.highlights) if (name.startsWith('t2-reveal-')) left += h.size
            out.cleared = left === 0
            res(out)
          }, 300)
          return
        }
        if (performance.now() - t0 < 15_000) requestAnimationFrame(f); else res(out)
      }
      requestAnimationFrame(f)
    }))
    const ta = win.locator('.t2c-ta').first()
    await ta.click()
    await ta.fill('读一下 lexer 和 parser')
    await win.keyboard.press('Enter')
    // 流到一半拍一张
    await win.locator('.t2-asst[data-streaming] .t2-content', { hasText: 'Tokens arrive' }).first().waitFor({ timeout: 10_000 })
    await sleep(500)
    await win.screenshot({ path: path.join(dir, 'stream-mid.png') })
    const p = await probe
    r.check('2a 过程行换步:新行 is-in 入场,旧行 is-out 叠在同一格', p.rollIn > 0 && p.rollOut > 0 && p.overlap > 0, JSON.stringify(p))
    r.check('1a 流式期间有淡入高亮', p.maxRanges > 0, JSON.stringify(p))
    r.check('1b 高亮只落在正文(.t2-content)上', p.outsideContent === 0, String(p.outsideContent))
    r.check('1c 流完 300ms 内高亮清空', p.cleared === true, String(p.cleared))
    const lingering = await win.evaluate(() => document.querySelectorAll('.tool-roll-item.is-out').length)
    r.check('2b 放完后旧行拆掉', lingering === 0, String(lingering))

    // ── 5. 插话等待区不透明 + 6. 任务清单展开 / 收起有入场 ──
    // 10-25 用户报「插话面板变成透明的」:它悬浮在正文之上,原来垫的是 0.04 的 --overlay-light。
    ctx.stub.script([
      { type: 'todo', payload: { todos: [{ content: 'Read the lexer', status: 'completed' }, { content: 'Split the parser', status: 'in_progress' }, { content: 'Add tests', status: 'pending' }] } },
      { type: 'token', payload: { delta: 'Working on it. ' } },
      { type: '__hold' },
    ])
    await ta.fill('拆一下解析器')
    await win.keyboard.press('Enter')
    await win.locator('.t2c-stop').first().waitFor({ timeout: 10_000 })
    await ta.fill('顺便看下 tokenizer')
    await win.keyboard.press('Enter')
    const steer = win.locator('.t2c-steer').first()
    await steer.waitFor({ timeout: 5000 })
    await win.addStyleTag({ content: '.ach-toast{display:none!important}' }) // 首条消息的成就浮层会盖住等待区(同 e2e:queue)
    const steerBg = await steer.evaluate((el) => getComputedStyle(el).backgroundColor)
    const alpha = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m ? m[1].split(/[ ,/]+/).filter(Boolean) : []; return p.length > 3 ? parseFloat(p[3]) : m ? 1 : 0 }
    r.check('5a 插话等待区底色不透明', alpha(steerBg) === 1, steerBg)
    // 正文滚到等待区底下再拍:透不透一眼可见
    await win.evaluate(() => { const s = document.querySelector('.t2-stream'); if (s) s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 90) })
    await sleep(250)
    await win.screenshot({ path: path.join(dir, 'steer-over-text.png') })

    const animOf = (sel) => win.evaluate((sel) => { const el = document.querySelector(sel); return el ? el.getAnimations().map((a) => a.animationName) : null }, sel)
    const strip = win.locator('.t2-tail .todo-strip').first()
    await strip.waitFor({ timeout: 5000 })
    r.check('6a 任务清单刚出现不放入场(新建 / 恢复不动)', !(await animOf('.t2-tail .todo-strip'))?.includes('ui-enter'), JSON.stringify(await animOf('.t2-tail .todo-strip')))
    await strip.click()
    const cardAnim = await animOf('.t2-tail .todo-card')
    r.check('6b 点开:整张清单放入场', !!cardAnim?.includes('ui-enter'), JSON.stringify(cardAnim))
    await sleep(60)
    await win.screenshot({ path: path.join(dir, 'todo-opening.png') })
    await sleep(300)
    await win.locator('.t2-tail .todo-fold').first().click()
    const stripAnim = await animOf('.t2-tail .todo-strip')
    r.check('6c 收起:那一行放入场', !!stripAnim?.includes('ui-enter'), JSON.stringify(stripAnim))
    ctx.stub.finish(ctx.stub.seen.runs.at(-1).runId)

    // ── 7. 宿主自动给的动效(插件同一个页面,标准写法即得;base.css「统一入场」)──
    const auto = await win.evaluate(async () => {
      const box = document.createElement('div')
      box.style.cssText = 'position:fixed;left:40px;top:80px;z-index:99999;background:var(--bg-card);padding:8px'
      box.innerHTML = '<details id="fx-d"><summary>More</summary><p>Hidden body</p></details><div id="fx-slot"></div>'
      document.body.appendChild(box)
      const d = box.querySelector('#fx-d')
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      await frame()
      const before = document.getAnimations().length
      d.open = true
      await frame()
      const detailsAnims = document.getAnimations().filter((a) => a.effect?.pseudoElement === '::details-content').map((a) => a.transitionProperty)
      const reveal = document.createElement('div'); reveal.dataset.motion = 'enter'; reveal.textContent = 'revealed'
      box.querySelector('#fx-slot').appendChild(reveal)
      const enter = reveal.getAnimations().map((a) => a.animationName)
      const dlg = document.createElement('dialog'); dlg.textContent = 'dialog'; document.body.appendChild(dlg); dlg.showModal()
      const dialog = dlg.getAnimations().map((a) => a.animationName)
      dlg.close(); dlg.remove(); box.remove()
      return { before, detailsAnims, enter, dialog }
    })
    r.check('7a 原生 <details> 展开:内容区淡入(只动透明度)', auto.detailsAnims.includes('opacity'), JSON.stringify(auto.detailsAnims))
    r.check('7b data-motion="enter" 挂上即入场', auto.enter.includes('ui-enter'), JSON.stringify(auto.enter))
    r.check('7c 原生 <dialog> 打开:命令面板那档进场', auto.dialog.includes('ui-menu-enter'), JSON.stringify(auto.dialog))

    // ── 8. 侧栏「已归档」展开与会话分组同一个折叠动效(AnimatedCollapse) ──
    const archived = win.locator('.t2s-archived-toggle').first()
    if (await archived.count()) {
      await archived.click()
      const mid = await win.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const wrap = document.querySelector('.t2s-archived-toggle')?.nextElementSibling
        res(wrap ? { h: wrap.getBoundingClientRect().height, full: wrap.scrollHeight, overflow: getComputedStyle(wrap).overflow } : null)
      }))))
      r.check('8a 点「已归档」:列表从 0 长出来(不是一下子出现)', !!mid && mid.overflow === 'hidden' && mid.h < mid.full, JSON.stringify(mid))
      await sleep(400)
      await win.screenshot({ path: path.join(dir, 'sidebar-archived.png') })
    } else r.note('8 跳过', '夹具里没有已归档会话')
    r.note('截图', dir)
  } finally {
    await ctx.close()
  }
  process.exit(r.summary() ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
