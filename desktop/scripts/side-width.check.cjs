/**
 * U-20「侧栏宽度在同一个 Space 里也会跳(345 → 280)」的观测仪器(真 Electron + 桩引擎)。
 * 正典:docs/ToBeImproved/UIUX评审_2026-09-25.md U-20(NAV-7)。
 *
 * 按 Space 分别记宽是刻意设计(spaceRegistry.switchSpace → setSideProfile);本仪器钉的是**同一个
 * Tangu Space 内**,用户拖出来的左栏宽经各种往返后不变:
 *   0  左栏 sash 拖到 TARGET(320)→ DOM 宽 ≈320,且 localStorage `lcl.sideWidth2.tangu`.left ≈320
 *      (拆两条:「根本没记下」与「记下后被冲掉」是两种病)
 *   1  开设置浮窗(ribbon 设置钮 → 独立 BrowserWindow)→ 关掉 → 宽不变
 *   2  切收件箱 → 切回 Tangu(真鼠标点 ribbon)→ 宽不变;连做 3 轮(偶发的只有多轮才见)
 *   3  「从别的 Space 切回来」:Note / 日历 各往返一次 → 宽不变
 *   4  窗口 resize:缩到 1100 再放回 1440 → 宽不变(记住 320 时 computeSideWidth 的上限是 min(680, 0.6W),不该钳)
 *   5  整轮下来 tangu 的存档宽从没被改写成别的值;切回途中逐帧采样的宽**没有**先跳到别的值再弹回
 *      (用户看见的「跳」可能只是过渡帧,终态却对 —— 两种都要记)
 *
 * 取证手段:页内包一层 Storage.prototype.setItem,记下每一次 `lcl.sideWidth2.*` 写入的值 + 调用栈 +
 * 当时的活动 Space。宽被冲掉时,那条写入的栈就是根因所在的那一行(不再靠纸面推演三个候选)。
 * FAIL 时逐条打印这份日志。
 *
 * 为什么桩引擎:侧栏内容不影响被钉的几何;managed 本地引擎在新 worktree 里常起不来(同 check:orbitside 注释)。
 * 选择器契约:左栏组 = 含 `.t2sw` 的最靠左 `.dv-groupview`;sash = 与其右缘对齐的竖 `.dv-sash`;
 *   ribbon Space 钮 = `.rb-space`(认 title / .rb-label,zh/en 都给);设置钮 = `.rb-btn[title=设置|Settings]`。
 *
 * 跑法:npx electron-vite build && npm run check:sidewidth   (SHOT_DIR=<目录> 指定截图落点)
 * 旋钮:U20_TARGET(拖到多宽,缺省 345)/ U20_WIN_W(窗宽,缺省 1600:黄金分割被钳在 280 = 实报数)/
 *   U20_VERBOSE=1(总是打印写入日志)/ U20_NEGATIVE=1(负对照:中途删掉存档,2.x 必须红)。
 */
const path = require('path')
const { sleep, shotDir, makeReporter, launch, boot, enterSpace, SPACE_NAMES, activeSpace, captureWindow } = require('./lib/uiux-electron.cjs')

/** 复现用户实报那组数:拖到 345,窗口 1600 宽(黄金分割 0.191W 被钳在左栏上限 280 = 实报的「跳到 280」)。 */
const TARGET = Number(process.env.U20_TARGET || 345)
const WIN_W = Number(process.env.U20_WIN_W || 1600)
const WIN_H = 960
const TOL = 4
const R = makeReporter()

/** 页内:左栏组宽 + 两份存档(tangu / 当前 Space)。 */
const MEASURE = `(() => {
  const groups = Array.from(document.querySelectorAll('.dv-groupview')).filter((g) => g.querySelector('.t2sw, .t2s-side, .t2o') || g.getBoundingClientRect().left < 120)
  const vis = groups.filter((g) => g.getBoundingClientRect().width > 0)
  const left = vis.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0] || null
  const read = (k) => { try { const v = localStorage.getItem('lcl.sideWidth2.' + k); return v ? JSON.parse(v) : null } catch { return null } }
  const active = localStorage.getItem('forsion_tangu_active_space')
  return {
    active,
    width: left ? Math.round(left.getBoundingClientRect().width) : null,
    left: left ? Math.round(left.getBoundingClientRect().left) : null,
    hasT2: !!(left && left.querySelector('.t2sw')),
    store: { tangu: read('tangu'), [active]: read(active) },
    viewport: window.innerWidth,
  }
})()`

/** 装 setItem 探针(幂等)。每条:{ key, value, active, t, stack }。 */
const SPY = `(() => {
  if (window.__u20log) return true
  window.__u20log = []
  const orig = Storage.prototype.setItem
  Storage.prototype.setItem = function (k, v) {
    if (typeof k === 'string' && k.startsWith('lcl.sideWidth2.')) {
      const stack = (new Error().stack || '').split('\\n').slice(2, 9).map((s) => s.trim().replace(/\\(?(file|app):\\/\\/[^)]*\\/assets\\//, '(')).join(' < ')
      window.__u20log.push({ key: k, value: v, active: localStorage.getItem('forsion_tangu_active_space'), t: Math.round(performance.now()), stack })
    }
    return orig.call(this, k, v)
  }
  return true
})()`

/** 逐帧采样左栏宽,持续 ms(用于捕获「先跳再弹回」的过渡帧)。返回 [ { t, w } ](仅宽变化时记)。 */
const sampleFrames = (ms) => `new Promise((resolve) => {
  const out = []; const t0 = performance.now(); let last = null
  const probe = () => {
    const gs = Array.from(document.querySelectorAll('.dv-groupview')).filter((g) => g.getBoundingClientRect().width > 0)
    const left = gs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]
    const w = left ? Math.round(left.getBoundingClientRect().width) : null
    const active = localStorage.getItem('forsion_tangu_active_space')
    const key = active + ':' + w
    if (key !== last) { out.push({ t: Math.round(performance.now() - t0), w, active }); last = key }
    if (performance.now() - t0 < ${ms}) requestAnimationFrame(probe); else resolve(out)
  }
  requestAnimationFrame(probe)
})`

async function dragLeftSashTo(win, target) {
  const g = await win.evaluate(`(() => {
    const gs = Array.from(document.querySelectorAll('.dv-groupview')).filter((g) => g.querySelector('.t2sw') && g.getBoundingClientRect().width > 0)
    const left = gs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]
    if (!left) return null
    const r = left.getBoundingClientRect(); const edge = r.right
    let best = null
    for (const s of document.querySelectorAll('.dv-sash')) {
      const b = s.getBoundingClientRect()
      if (b.height < 100 || b.width > 20) continue
      const d = Math.abs(b.left + b.width / 2 - edge)
      if (!best || d < best.d) best = { d, x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }
    return best && best.d < 24 ? { ...best, width: r.width } : null
  })()`)
  if (!g) return null
  const dx = target - g.width
  await win.mouse.move(g.x, g.y)
  await win.mouse.down()
  await win.mouse.move(g.x + dx / 2, g.y, { steps: 6 })
  await win.mouse.move(g.x + dx, g.y, { steps: 6 })
  await win.mouse.up()
  await sleep(900)
  return { from: Math.round(g.width), dx: Math.round(dx) }
}

const leftW = (st) => (st.store.tangu && typeof st.store.tangu.left === 'number' ? st.store.tangu.left : null)
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= TOL

async function roundTrip(win, other, label, frames = true) {
  const went = await enterSpace(win, SPACE_NAMES[other], { real: true })
  await sleep(1500)
  const away = await win.evaluate(MEASURE)
  const sampler = frames ? win.evaluate(sampleFrames(1600)) : null
  const back = await enterSpace(win, SPACE_NAMES.tangu, { real: true })
  const seq = sampler ? await sampler : []
  await sleep(600)
  const st = await win.evaluate(MEASURE)
  return { label, went, back, away, st, seq }
}

async function run(app, win, shots) {
  await boot(app, win, { space: 'tangu', width: WIN_W, height: WIN_H })
  await win.waitForSelector('.t2sw', { timeout: 30_000 })
  await sleep(1200)
  await win.evaluate(SPY)
  const st0 = await win.evaluate(MEASURE)
  R.note('起点', JSON.stringify(st0))
  if (st0.active !== 'tangu' || !st0.hasT2) { R.check('前置:落在 Tangu Space 且左栏是工作区侧栏', false, JSON.stringify(st0)); return }

  // ── 0 拖宽 ──
  const drag = await dragLeftSashTo(win, TARGET)
  const st1 = await win.evaluate(MEASURE)
  R.check(`0a 左栏 sash 拖得动,DOM 宽 ≈${TARGET}`, !!drag && near(st1.width, TARGET), JSON.stringify({ drag, width: st1.width }))
  R.check(`0b 拖完 lcl.sideWidth2.tangu.left 记下 ≈${TARGET}(不成立 = 「根本没记下」,不是「记下后被冲掉」)`, near(leftW(st1), TARGET), JSON.stringify(st1.store.tangu))
  await captureWindow(app, path.join(shots, 'sidewidth-0-dragged.png'))
  const W = st1.width

  // ── 1 设置浮窗 ──
  const btn = win.locator('.rb-btn[title="设置"], .rb-btn[title="Settings"]').first()
  const opened = app.waitForEvent('window', { timeout: 15_000 }).catch(() => null)
  let via = 'ribbon'
  if (await btn.count().catch(() => 0)) await btn.click()
  else { via = 'openFloatingPanel'; await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings' })) }
  const floating = await opened
  if (floating) { await floating.waitForSelector('.settings-page', { timeout: 20_000 }).catch(() => {}); await sleep(800) }
  const stOpen = await win.evaluate(MEASURE)
  if (floating) await floating.close().catch(() => {})
  await sleep(1200)
  const st2 = await win.evaluate(MEASURE)
  R.check(`1 开设置浮窗(${via})→ 关掉:左栏宽不变`, !!floating && near(stOpen.width, W) && near(st2.width, W) && near(leftW(st2), W),
    JSON.stringify({ floating: !!floating, whileOpen: stOpen.width, after: st2.width, stored: leftW(st2) }))

  // ── 2 收件箱往返 ×3 ──
  const trips = []
  // 负对照(U20_NEGATIVE=1):模拟「存档被冲掉」—— 删掉 tangu 的记宽再往返,2.x 必须红;红不了说明断言是空的。
  if (process.env.U20_NEGATIVE) await win.evaluate(() => localStorage.removeItem('lcl.sideWidth2.tangu'))
  for (let i = 1; i <= 3; i += 1) {
    const r = await roundTrip(win, 'inbox', `inbox#${i}`)
    trips.push(r)
    R.check(`2.${i} 切收件箱 → 切回 Tangu:左栏宽不变`, r.went && r.back && r.st.active === 'tangu' && near(r.st.width, W) && near(leftW(r.st), W),
      JSON.stringify({ went: r.went, away: { active: r.away.active, w: r.away.width, store: r.away.store }, back: r.st.width, stored: leftW(r.st) }))
  }
  await captureWindow(app, path.join(shots, 'sidewidth-2-after-inbox.png'))

  // ── 3 其它 Space 往返 ──
  for (const other of ['amadeus', 'calendar']) {
    const r = await roundTrip(win, other, other)
    trips.push(r)
    if (!r.went) { R.note(`3 ${other} 不在 ribbon 上,跳过`, ''); continue }
    R.check(`3 从 ${other} 切回 Tangu:左栏宽不变`, r.back && r.st.active === 'tangu' && near(r.st.width, W) && near(leftW(r.st), W),
      JSON.stringify({ away: { active: r.away.active, w: r.away.width }, back: r.st.width, stored: leftW(r.st) }))
  }

  // ── 4 窗口 resize ──
  const setSize = (w, h) => app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h), { w, h })
  await setSize(1100, 800)
  await sleep(1400)
  const stNarrow = await win.evaluate(MEASURE)
  await setSize(WIN_W, WIN_H)
  await sleep(1400)
  const stWide = await win.evaluate(MEASURE)
  R.check('4a 窗口缩到 1100:左栏宽不变(记住的宽低于 0.6W 上限,不该被钳)', near(stNarrow.width, W), JSON.stringify({ vp: stNarrow.viewport, w: stNarrow.width, stored: leftW(stNarrow) }))
  R.check(`4b 放回 ${WIN_W}:左栏宽不变、存档不变`, near(stWide.width, W) && near(leftW(stWide), W), JSON.stringify({ vp: stWide.viewport, w: stWide.width, stored: leftW(stWide) }))
  await captureWindow(app, path.join(shots, 'sidewidth-4-after-resize.png'))

  // ── 6 收起再展开左栏(mod+/ = toggle-left 命令)──
  await win.keyboard.press('Meta+Slash')
  await sleep(900)
  const stCollapsed = await win.evaluate(MEASURE)
  await win.keyboard.press('Meta+Slash')
  await sleep(1200)
  const stExpanded = await win.evaluate(MEASURE)
  R.check('6 收起再展开左栏:宽回到拖出来的那个', stCollapsed.width !== stExpanded.width && near(stExpanded.width, W) && near(leftW(stExpanded), W),
    JSON.stringify({ collapsed: stCollapsed.width, expanded: stExpanded.width, stored: leftW(stExpanded) }))

  // ── 6b 开合右栏 / 底部面板(lockOtherSide + pinSides 路径):左栏宽纹丝不动 ──
  const sideOps = []
  const edgeRight = win.locator('.dv-edge-right').first()
  if (await edgeRight.count().catch(() => 0)) {
    for (let i = 0; i < 2; i += 1) { await edgeRight.click().catch(() => {}); await sleep(900); sideOps.push({ op: `right#${i + 1}`, w: (await win.evaluate(MEASURE)).width }) }
  }
  for (let i = 0; i < 2; i += 1) { await win.keyboard.press('Meta+J'); await sleep(900); sideOps.push({ op: `bottom#${i + 1}`, w: (await win.evaluate(MEASURE)).width }) }
  const stOps = await win.evaluate(MEASURE)
  R.check('6b 开合右栏 / 底部面板各两次:左栏宽始终不变', sideOps.length >= 2 && sideOps.every((o) => near(o.w, W)) && near(leftW(stOps), W),
    JSON.stringify({ sideOps, stored: leftW(stOps) }))

  // ── 7 点一条会话行(主区换会话 → openView/pinSides 路径)──
  const row = win.locator('.t2sw .t2s-srow, .t2sw .t2o-row').first()
  if (await row.count().catch(() => 0)) {
    await row.click().catch(() => {})
    await sleep(1200)
    const stRow = await win.evaluate(MEASURE)
    R.check('7 点侧栏会话行(主区换内容):左栏宽不变', near(stRow.width, W) && near(leftW(stRow), W), JSON.stringify({ w: stRow.width, stored: leftW(stRow) }))
  } else R.note('7 侧栏里没有会话行,跳过', '')

  // ── 8 reload(≈重启渲染层):setSideProfile 从存档读回 ──
  const preLog = await win.evaluate(() => window.__u20log || []) // reload 会清掉页内日志,先取走
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('.t2sw', { timeout: 30_000 })
  await sleep(2200)
  await win.evaluate(SPY)
  const stReload = await win.evaluate(MEASURE)
  R.check('8 reload 后仍在 Tangu,左栏宽不变', stReload.active === 'tangu' && near(stReload.width, W), JSON.stringify({ active: stReload.active, w: stReload.width, stored: leftW(stReload) }))

  // ── 5 汇总:存档写入日志 + 过渡帧 ──
  const log = [...preLog, ...(await win.evaluate(() => window.__u20log || []))]
  const tanguWrites = log.filter((e) => e.key === 'lcl.sideWidth2.tangu').map((e) => ({ ...e, left: (() => { try { return JSON.parse(e.value).left } catch { return null } })() }))
  const clobber = tanguWrites.filter((e) => typeof e.left === 'number' && !near(e.left, W))
  const crossWrites = tanguWrites.filter((e) => e.active !== 'tangu')
  R.check('5a 整轮下来 tangu 的存档从没被改写成别的宽', clobber.length === 0, `tangu 写入 ${tanguWrites.length} 次,异值 ${clobber.length} 次`)
  R.check('5b 活动 Space 不是 tangu 时,没有任何写入落到 lcl.sideWidth2.tangu(跨 Space 串写)', crossWrites.length === 0, `${crossWrites.length} 次`)
  // 只看活动 Space 已切成 tangu 之后的帧(之前那几帧是离开的 Space 自己的宽,不是过渡)。
  const jumps = trips.filter((r) => r.seq.some((f) => f.active === 'tangu' && typeof f.w === 'number' && f.w > 0 && !near(f.w, W)))
  R.check('5c 切回 Tangu 途中逐帧采样:左栏没有先停在别的宽再弹回(过渡帧)', jumps.length === 0,
    jumps.map((r) => `${r.label}: ${JSON.stringify(r.seq)}`).join(' ; ') || `${trips.length} 次往返均无`)
  if (clobber.length || crossWrites.length || process.env.U20_VERBOSE) {
    console.log('\n── lcl.sideWidth2.* 写入日志 ──')
    for (const e of log) console.log(`  t=${e.t} active=${e.active} ${e.key}=${e.value}\n      ${e.stack}`)
  }
  for (const r of trips) R.note(`帧序 ${r.label}`, JSON.stringify(r.seq))
}

async function main() {
  const shots = shotDir('sidewidth')
  const env = await launch({ tag: 'sidewidth' })
  try { await run(env.app, env.win, shots) }
  catch (e) { console.error(e); R.check('runner 未捕获异常', false, String((e && e.message) || e)) }
  finally { await env.close() }
  console.log(`SHOTS ${shots}`)
  process.exit(R.summary() ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
