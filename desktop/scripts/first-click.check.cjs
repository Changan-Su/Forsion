/**
 * U-41「切 Space 后第一次点会话行偶尔没反应」的观测仪器(真 Electron + 桩引擎)。
 * 正典:docs/ToBeImproved/UIUX评审_2026-09-25.md U-41(FEEL-7)。
 *
 * 未复现的偶发 bug,先建观测:每一轮 = Tangu → 收件箱 → 切回 Tangu(真鼠标点 ribbon)→ 等 d 毫秒 →
 * 用**真鼠标**(mouse.move/down/up,走 Chromium 的 hit-test;element.click() 看不见遮罩)点一条
 * 当前**未激活**的会话行,然后判结局(行变 .active)。d 扫 0 / 50 / 150 / 300 / 600ms,每档 ROUNDS 次。
 *
 * 每一击采集三类失败指纹 + 一条几何:
 *   remount    按下时的那个行元素,抬起后已不在 DOM(挂载后重排 / 重挂,click 落在被换掉的节点上)
 *   moved      mousedown → mouseup 之间行的 rect 变了(|Δtop| 或 |Δheight| > 1px:行在手指下挪走了)
 *   intercept  按下点的 elementFromPoint 不在该行里(遮罩 / 浮层 / 过渡层拦截)
 *   dragstart  这一击起了 HTML5 拖拽(误起拖拽;阈值归 Chromium,本仪器不自定义阈值)
 *   noclick    mousedown / mouseup 至少一个落在行上,却没有派发到行上的 click(常见于 down/up 目标不同)
 * 另记一条时间线:切回后 `.t2s-srow` 的增删(行挂出来之后又被整批删 = 重挂窗口,即便本轮没撞上)。
 *
 *   nospace / preactive  仪器自身的前置失败(没真切走 / 切回;目标行点之前已激活)—— 出现即判红,防真空通过
 * 断言:① 每一击都成功(行变 .active);② 零指纹。失败时整张表打印出来,按指纹再定修法。
 * 「未复现」本身是有效结果:全绿即说明桩夹具下这条路稳,表照样打印,供与真机对照。
 *
 * 为什么桩引擎:只量渲染层接线,会话数据来自哪不影响被钉的东西(同 check:orbitside)。
 * 选择器契约:会话行 = 左栏 `.t2sw` 里的 `.t2s-srow`(按标题文案认,夹具标题是英文,与界面语言无关);
 *   激活态 = 行上的 `.active`;项目组头 = `.t2s-group`;ribbon Space 钮 = `.rb-space`。
 *
 * 跑法:npx electron-vite build && npm run check:firstclick
 * 旋钮:U41_ROUNDS(每档几次,缺省 3)/ U41_DELAYS(逗号分隔,缺省 0,50,150,300,600)/ U41_PRESS_MS(按住多久,缺省 70)/
 *   U41_NEGATIVE=veil|moved|remount(负对照,每条指纹通道各证一次自己能红;`1` 等同 veil):
 *     veil    切换后铺 400ms 透明遮罩 → 短延迟档必须报 intercept + MISS
 *     moved   按下会话行的那一刻把行 translateY(8px) → 必须报 moved
 *     remount 按下会话行的那一刻把行换成一份克隆(React 管不到的死节点)→ 必须报 remount + MISS
 *             (intercept / noclick 会跟着亮:命中的是克隆不是原行、down/up 目标不同 —— 读表时 remount 优先)
 *   /
 *   U41_LIST_DELAY(给 GET /agent/sessions* 加多少 ms 延迟,模拟慢引擎:名册晚到时行会不会在手指下被整批重挂)
 */
const path = require('path')
const { sleep, shotDir, makeReporter, launch, boot, enterSpace, SPACE_NAMES, activeSpace, captureWindow } = require('./lib/uiux-electron.cjs')

const ROUNDS = Math.max(1, Number(process.env.U41_ROUNDS || 3)) // 0 轮 = 什么都没量却全绿,不允许
const DELAYS = (process.env.U41_DELAYS || '0,50,150,300,600').split(',').map(Number)
const PRESS_MS = Number(process.env.U41_PRESS_MS || 70)
const TITLES = ['Probe session one', 'Probe session two', 'Probe session three']
const R = makeReporter()

/** 页内事件探针(只装一次;每轮用 RESET 清零):
 *  - 捕获阶段记 mousedown/mouseup/click/dragstart 的目标是不是在某条会话行里;
 *  - MutationObserver 记 `.t2s-srow` 节点的增删(churn):行首次出现之后又被删 = 行被整批重挂,
 *    横跨这个时刻的一击会落在死节点上 —— 即使本轮没撞上,这条时间线也说明窗口有多宽。 */
const INSTALL = `(() => {
  if (window.__u41inst) return true
  window.__u41inst = true
  window.__u41 = { events: [], churn: [] }
  const rowOf = (el) => (el && el.closest ? el.closest('.t2s-srow') : null)
  const titleOf = (row) => row ? ((row.querySelector('.t2s-srow-title') || row).textContent || '').trim().slice(0, 40) : null
  const clsOf = (el) => (el && el.getAttribute ? (el.getAttribute('class') || el.nodeName) : String(el && el.nodeName)).split(' ')[0]
  for (const type of ['mousedown', 'mouseup', 'click', 'dragstart']) {
    window.addEventListener(type, (e) => {
      const row = rowOf(e.target)
      window.__u41.events.push({ type, t: Math.round(performance.now()), row: titleOf(row), cls: clsOf(e.target), space: !!(e.target && e.target.closest && e.target.closest('.rb-space')) })
    }, true)
  }
  const count = (nodes) => { let n = 0; for (const x of nodes) { if (x.nodeType !== 1) continue; if (x.matches('.t2s-srow')) n += 1; n += x.querySelectorAll('.t2s-srow').length } return n }
  new MutationObserver((ms) => {
    const t = Math.round(performance.now())
    for (const m of ms) {
      const add = count(m.addedNodes); const rem = count(m.removedNodes)
      if (add) window.__u41.churn.push({ t, kind: 'add', n: add })
      if (rem) window.__u41.churn.push({ t, kind: 'remove', n: rem })
    }
  }).observe(document.body, { childList: true, subtree: true })
  return true
})()`
const RESET = `(() => { window.__u41.events = []; window.__u41.churn = []; return true })()`
/** 负对照(U41_NEGATIVE):人为造出某一类失败,对应指纹必须亮 —— 亮不了说明那条采集通道是空的
 *  (check-negative-control 纪律:仪器先证明自己能红)。每一击前装一次、用完即卸。 */
const NEGATIVE_MODE = (() => {
  const v = process.env.U41_NEGATIVE
  if (!v) return null
  if (v === '1' || v === 'veil') return 'veil'
  if (v === 'moved' || v === 'remount') return v
  throw new Error(`U41_NEGATIVE 只认 veil / moved / remount(1 = veil),收到 ${v}`)
})()
const NEGATIVE_ARM = (mode) => `(() => {
  const mode = ${JSON.stringify(mode)}
  if (mode === 'veil') {
    // 下一次点 Space 钮后铺一层 400ms 的透明遮罩
    window.addEventListener('click', (e) => {
      if (!(e.target && e.target.closest && e.target.closest('.rb-space'))) return
      const veil = document.createElement('div')
      veil.className = 'u41-negative-veil'
      veil.style.cssText = 'position:fixed;inset:0;z-index:99999;background:transparent'
      document.body.appendChild(veil)
      setTimeout(() => veil.remove(), 400)
    }, { capture: true, once: true })
    return true
  }
  // moved / remount:下一次在会话行上按下时动手(捕获阶段,先于探针的 MID 采样)
  const onDown = (e) => {
    const row = e.target && e.target.closest ? e.target.closest('.t2s-srow') : null
    if (!row) return
    window.removeEventListener('mousedown', onDown, true)
    if (mode === 'moved') row.style.transform = 'translateY(8px)'
    else row.replaceWith(row.cloneNode(true))
  }
  window.addEventListener('mousedown', onDown, true)
  return true
})()`

/** 找标题为 title 的会话行(可见的那条),返回几何;同时在页内留住元素引用供之后判 isConnected。 */
const LOCATE = (title) => `(() => {
  const rows = Array.from(document.querySelectorAll('.t2sw .t2s-srow')).filter((r) => r.getBoundingClientRect().height > 0)
  const row = rows.find((r) => ((r.querySelector('.t2s-srow-title') || r).textContent || '').trim().startsWith(${JSON.stringify(title)}))
  if (!row) return null
  window.__u41row = row
  const b = row.getBoundingClientRect()
  return { x: b.left + Math.min(b.width / 2, 120), y: b.top + b.height / 2, top: b.top, h: b.height, active: row.classList.contains('active') }
})()`

/** 按下后、抬起前:同一个元素还在不在、rect 变没变、按下点的命中元素是不是在行里。 */
const MID = (x, y) => `(() => {
  const row = window.__u41row
  const hit = document.elementFromPoint(${x}, ${y})
  const b = row && row.isConnected ? row.getBoundingClientRect() : null
  return {
    connected: !!(row && row.isConnected),
    top: b ? b.top : null, h: b ? b.height : null,
    hitInRow: !!(row && hit && row.contains(hit)),
    hitCls: hit ? String(hit.className || hit.nodeName).slice(0, 60) : null,
  }
})()`

const ACTIVE_OF = (title) => `(() => {
  const row = Array.from(document.querySelectorAll('.t2sw .t2s-srow')).find((r) => ((r.querySelector('.t2s-srow-title') || r).textContent || '').trim().startsWith(${JSON.stringify(title)}))
  return { found: !!row, active: !!(row && row.classList.contains('active')), sameEl: !!(row && row === window.__u41row) }
})()`

/** 会话行在项目组里,组可能是收起的:没看见行就点开组头(只做一次,展开态随布局持久)。 */
async function ensureRowsVisible(win) {
  const n = await win.evaluate(`Array.from(document.querySelectorAll('.t2sw .t2s-srow')).filter((r) => r.getBoundingClientRect().height > 0 && /Probe session/.test(r.textContent || '')).length`)
  if (n >= 2) return n
  await win.evaluate(`(() => { const g = Array.from(document.querySelectorAll('.t2sw .t2s-group')).find((e) => (e.textContent || '').includes('Probe Project')); if (g) (g.querySelector('.t2s-group-label') || g).click() })()`)
  await sleep(900)
  return win.evaluate(`Array.from(document.querySelectorAll('.t2sw .t2s-srow')).filter((r) => r.getBoundingClientRect().height > 0 && /Probe session/.test(r.textContent || '')).length`)
}

async function trial(win, delay, title) {
  await enterSpace(win, SPACE_NAMES.inbox, { real: true })
  await sleep(1200)
  // 没真的切走 = 这一击不是「切 Space 后首击」,不能算 ok(否则普通点击也会把本仪器刷绿)。
  const away = await activeSpace(win)
  if (away !== 'inbox') return { delay, title, ok: false, fp: ['nospace'], waited: 0, churn: `away=${away}` }
  await win.evaluate(INSTALL)
  await win.evaluate(RESET)
  if (NEGATIVE_MODE) await win.evaluate(NEGATIVE_ARM(NEGATIVE_MODE))
  const t0 = Date.now()
  await enterSpace(win, SPACE_NAMES.tangu, { real: true })
  if (delay) await sleep(delay)
  // 行还没挂出来就轮询(d=0 时常见),记下等了多久 —— 用户的手指不会等,这段时长本身就是指纹之一。
  let loc = null
  const waitStart = Date.now()
  while (Date.now() - waitStart < 3000) {
    loc = await win.evaluate(LOCATE(title))
    if (loc) break
    await sleep(16)
  }
  if (!loc) return { delay, title, ok: false, fp: ['norow'], waited: Date.now() - waitStart }
  const back = await activeSpace(win)
  if (back !== 'tangu') return { delay, title, ok: false, fp: ['nospace'], waited: Date.now() - waitStart, churn: `back=${back}` }
  // 目标行点之前就是激活态 → 结局不可判(点没点中都「active」),记成前置失败而不是 ok。
  if (loc.active) return { delay, title, ok: false, fp: ['preactive'], waited: Date.now() - waitStart }
  const waited = Date.now() - waitStart
  await win.mouse.move(loc.x, loc.y)
  await win.mouse.down()
  const mid0 = await win.evaluate(MID(loc.x, loc.y))
  await sleep(PRESS_MS)
  const mid1 = await win.evaluate(MID(loc.x, loc.y))
  await win.mouse.up()
  await sleep(500)
  const after = await win.evaluate(ACTIVE_OF(title))
  const log = await win.evaluate(() => window.__u41)
  const ev = log.events
  const spaceClick = ev.find((e) => e.type === 'click' && e.space)
  const rowDown = ev.find((e) => e.type === 'mousedown' && e.row && e.row.startsWith(title))
  const rowUp = ev.find((e) => e.type === 'mouseup' && e.row && e.row.startsWith(title))
  const anyDown = ev.find((e) => e.type === 'mousedown' && !e.space)
  const t0p = spaceClick ? spaceClick.t : null
  const rel = (t) => (t0p == null ? null : t - t0p)
  // 行 churn:切换点之后,第一次 add 之后还有 remove = 行出现后又被整批换掉(重挂)。
  const post = log.churn.filter((c) => t0p == null || c.t >= t0p)
  const firstAdd = post.find((c) => c.kind === 'add')
  const lateRemovals = firstAdd ? post.filter((c) => c.kind === 'remove' && c.t > firstAdd.t) : []
  const fp = []
  if (!mid1.connected || !after.sameEl) fp.push('remount')
  if (mid1.connected && (Math.abs(mid1.top - loc.top) > 1 || Math.abs(mid1.h - loc.h) > 1)) fp.push('moved')
  if (!mid0.hitInRow) fp.push('intercept')
  if (ev.some((e) => e.type === 'dragstart')) fp.push('dragstart')
  const clickOnRow = ev.some((e) => e.type === 'click' && e.row && e.row.startsWith(title))
  // down / up 至少有一个落在行上,却没有派发到行上的 click(down、up 目标不同 → Chromium 把 click 发给公共祖先或不发)
  if ((rowDown || rowUp) && !clickOnRow) fp.push('noclick')
  return {
    delay, title, ok: after.active, fp, waited,
    downAt: anyDown ? rel(anyDown.t) : null,
    churn: post.map((c) => `${c.kind[0]}${c.n}@${rel(c.t)}`).join(' '),
    lateRemovals: lateRemovals.map((c) => rel(c.t)),
    hit: mid0.hitCls,
    events: ev.filter((e) => !e.space).map((e) => `${e.type}@${e.row ? 'row' : e.cls}`).join(','),
  }
}

async function run(app, win, shots) {
  await boot(app, win, { space: 'tangu', width: 1440, height: 900 })
  await win.waitForSelector('.t2sw', { timeout: 30_000 })
  await sleep(1500)
  const visible = await ensureRowsVisible(win)
  R.check('前置:左栏会话行可见(≥2 条夹具会话)', visible >= 2, `visible=${visible}`)
  if (visible < 2) { await captureWindow(app, path.join(shots, 'firstclick-norows.png')); return }
  // 先点中一条,之后每一击都挑一条「当前未激活」的,结局才可判(点已激活的行看不出点没点中)。
  let current = TITLES[0]
  { const l = await win.evaluate(LOCATE(current)); if (l) { await win.mouse.click(l.x, l.y); await sleep(700) } }
  const rows = []
  let k = 0
  for (const delay of DELAYS) {
    for (let i = 0; i < ROUNDS; i += 1) {
      const title = TITLES.filter((x) => x !== current)[k++ % (TITLES.length - 1)]
      const r = await trial(win, delay, title)
      rows.push(r)
      if (r.ok) current = title
      else current = (await win.evaluate(`(() => { const a = document.querySelector('.t2sw .t2s-srow.active .t2s-srow-title'); return a ? a.textContent.trim() : null })()`)) || current
      if (!r.ok || r.fp.length) await captureWindow(app, path.join(shots, `firstclick-miss-d${delay}-${i + 1}.png`))
    }
  }
  console.log('\n delay | 结局 | 指纹              | 等行ms | 切换→按下ms | 行增删时间线(相对切换点 ms) | 按下命中 / 事件序')
  for (const r of rows) {
    console.log(` ${String(r.delay).padStart(5)} | ${r.ok ? ' ok ' : 'MISS'} | ${(r.fp.join(',') || '-').padEnd(17)} | ${String(r.waited).padStart(6)} | ${String(r.downAt).padStart(11)} | ${r.churn || '-'} | ${r.hit} / ${r.events}`)
  }
  const churned = rows.filter((r) => r.lateRemovals && r.lateRemovals.length)
  R.check('3 切回后会话行挂出来之后不再被整批重挂(行 churn 窗口 = 首击可能落空的窗口)', churned.length === 0,
    churned.map((r) => `d=${r.delay}: 出现后又删于 ${r.lateRemovals.join('/')}ms`).join(' ; ') || `${rows.length} 轮均无`)
  const misses = rows.filter((r) => !r.ok)
  const printed = rows.filter((r) => r.fp.length)
  R.check(`1 切回 Tangu 后首击会话行全部生效(${rows.length} 击,延迟 ${DELAYS.join('/')}ms 各 ${ROUNDS} 次)`, misses.length === 0,
    misses.map((r) => `d=${r.delay} ${r.title} fp=${r.fp.join(',') || '无指纹'}`).join(' ; ') || '0 次失手')
  for (const f of ['remount', 'moved', 'intercept', 'dragstart', 'noclick', 'nospace', 'preactive']) {
    const hit = printed.filter((r) => r.fp.includes(f))
    R.check(`2 指纹「${f}」零出现`, hit.length === 0, hit.map((r) => `d=${r.delay}(${r.ok ? 'ok' : 'MISS'})`).join(' ') || '0')
  }
  await captureWindow(app, path.join(shots, 'firstclick-final.png'))
}

async function main() {
  const shots = shotDir('firstclick')
  const listDelay = Number(process.env.U41_LIST_DELAY || 0)
  if (listDelay) console.log(`NOTE  会话名册 GET /agent/sessions* 人为延迟 ${listDelay}ms(模拟慢引擎)`)
  const env = await launch({ tag: 'firstclick', delay: listDelay ? { match: /^\/agent\/sessions/, ms: listDelay } : null })
  try { await run(env.app, env.win, shots) }
  catch (e) { console.error(e); R.check('runner 未捕获异常', false, String((e && e.message) || e)) }
  finally { await env.close() }
  console.log(`SHOTS ${shots}`)
  process.exit(R.summary() ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
