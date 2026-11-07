/** 动效第三轮逐帧探针(2026-11-06,DESIGN §3「液滴展开」/「动效主题」):不是门禁,是检查用的量具。
 *  真 Electron(out/ 构建)里把按钮长出的面板一个个过一遍:Space 悬停预览、头像账号卡、Ribbon「+N」、Mini 两个下拉,
 *  每个面 × 动效主题(genesis / droplet / stretch / glide / fade)× 亮暗 × 界面缩放(1 / 1.1),逐帧记:
 *   · 首帧:面板在 pouring 之前有没有自己的底色(闪一下)
 *   · 源是否始终压在液体 / 拉伸底上(源中心的命中测试)、源与面板的缝、液体本体与面板矩形的偏差
 *   · 接手前后同一像素的颜色(截图取色,0.85D vs 收尾)—— 跳色
 *   · 打断:开到 t = 60 / 150 / 300ms 收,内容透明度是否单调不增(提前收时内容会不会先蹦出来再淡掉)
 *   · 倒放中途再触发、收完的清理(液体层 / pouring / 源的 z-index / position 还原)
 *  主题与只淡入淡出直接写 <html data-motion-theme / data-motion-fade>(没合 #481 的树上写了也无害,全部按 Genesis 走)。
 *  另有 ⌘P 分类胶囊(seg):逐帧量滑块两条边 —— 过冲、落点、窄于一格、水滴主题融球是不是从上一格长出来、中途改目标收敛。
 *  用法:npm run build && npm run probe:motion -- [--themes=genesis,stretch] [--modes=light] [--zooms=1,1.1]
 *        [--surfaces=seg,peek,account,more,mini] [--strips] [--out=<目录>]
 *  ⚠️ 量具不是门禁:报出来的每条都要回到截图 / 帧条上认(第三轮里「1.1 缩放下账号卡离头像 66px」就是量具没设 --uiz 造成的)。
 *  输出:<out>/probe.json(每个组合的逐帧数据与判定)、<out>/strip-*.png(--strips:同一毫秒的帧条)。 */
const fs = require('fs'), os = require('os'), path = require('path')
const { PNG } = require('pngjs')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3).split(',') : d }
const THEMES = arg('themes', ['genesis', 'droplet', 'stretch', 'glide', 'fade'])
const MODES = arg('modes', ['light', 'dark'])
const ZOOMS = arg('zooms', ['1', '1.1']).map(Number)
const SURFACES = arg('surfaces', ['seg', 'peek', 'account', 'more', 'mini'])
const STRIPS = process.argv.includes('--strips')
const OUT = (arg('out', [path.join(ROOT, 'outputs', 'motion-r3')]))[0]
fs.mkdirSync(OUT, { recursive: true })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-motion-r3-'))
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const report = []
const STRIP_MS = [0, 40, 90, 150, 210, 280, 380, 470]

/** 页内:设主题 / 只淡入淡出 / 亮暗 / 界面缩放。 */
const setEnv = (page, { theme, mode, zoom }) => page.evaluate(({ theme, mode, zoom }) => {
  const r = document.documentElement
  if (theme === 'fade') { r.dataset.motionTheme = 'genesis'; r.dataset.motionFade = 'on' } else { r.dataset.motionTheme = theme; delete r.dataset.motionFade }
  r.dataset.mode = mode; r.classList.toggle('dark', mode === 'dark')
  // 同 uiZoom.ts apply():body zoom + --uiz(壳用 calc(100vh / var(--uiz)) 反补偿),再发约定事件让浮层重算
  document.body.style.zoom = zoom === 1 ? '' : String(zoom)
  if (zoom === 1) r.style.removeProperty('--uiz'); else r.style.setProperty('--uiz', String(zoom))
  window.dispatchEvent(new Event('forsion:uizoom'))
}, { theme, mode, zoom })

/** 页内逐帧采样。act = 页内要做的动作(字符串:'click:<sel>' / 'key:Escape' / 'none'),retractAt = 开始后多少 ms 再做 act2。 */
const sample = (page, spec) => page.evaluate(async ({ panelSel, srcSel, act, act2, act2At, ms }) => {
  const doAct = (a) => {
    if (!a || a === 'none') return
    const [k, v] = [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)]
    if (k === 'click') document.querySelector(v)?.click()
    if (k === 'key') window.dispatchEvent(new KeyboardEvent('keydown', { key: v, bubbles: true }))
    if (k === 'over') { const el = document.querySelector(v); el?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) }
  }
  const raf = () => new Promise(requestAnimationFrame)
  const src0 = document.querySelector(srcSel)
  const srcStyle0 = src0 ? { z: src0.style.zIndex, pos: src0.style.position } : null
  doAct(act)
  if (!act || act === 'none') { const w0 = performance.now(); while (!document.querySelector(panelSel) && performance.now() - w0 < 1500) await raf() }
  const t0 = performance.now(), frames = []
  let did2 = false
  while (performance.now() - t0 < ms) {
    if (act2 && !did2 && performance.now() - t0 >= act2At) { doAct(act2); did2 = true; frames.push({ mark: 'act2', t: Math.round(performance.now() - t0) }) }
    await raf()
    const p = document.querySelector(panelSel), src = document.querySelector(srcSel)
    const layer = document.querySelector('.lcl-droplet, .lcl-stretch')
    const cs = p && getComputedStyle(p), before = p && getComputedStyle(p, '::before')
    const f = { t: Math.round(performance.now() - t0), exists: !!p }
    if (p) {
      f.pouring = p.classList.contains('lcl-droplet-pouring')
      f.bg = cs.backgroundColor
      f.beforeBg = before && before.content !== 'none' && +before.opacity > 0 ? before.backgroundColor : null
      f.clip = cs.clipPath === 'none' ? 'none' : 'set'
      f.vis = cs.visibility
      f.op = +cs.opacity
      f.kids = Math.min(...[...p.children].map((k) => +getComputedStyle(k).opacity), 1)
      const pr = p.getBoundingClientRect()
      f.rect = [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)]
      if (src) {
        const s = src.getBoundingClientRect()
        // 缝:面板与源在主轴上的距离(右侧 = 面板左 − 源右;下方 = 面板上 − 源下;上方 = 源上 − 面板下)
        f.gap = Math.round(pr.left >= s.right - 1 ? pr.left - s.right : pr.right <= s.left + 1 ? s.left - pr.right : pr.top >= s.bottom - 1 ? pr.top - s.bottom : s.top - pr.bottom)
        const hit = document.elementFromPoint(s.left + s.width / 2, s.top + s.height / 2)
        f.srcTop = !hit ? 'none' : (src === hit || src.contains(hit)) ? 'src' : layer?.contains(hit) ? 'layer' : p.contains(hit) ? 'panel' : (hit.className?.baseVal ?? hit.className ?? hit.tagName).toString().slice(0, 40)
      }
    }
    if (layer) {
      f.layer = layer.className + (getComputedStyle(layer).display === 'none' ? ':hidden' : '')
      f.hole = 'hole' in layer.dataset
      const body = layer.classList.contains('lcl-droplet') ? layer.querySelectorAll('i')[1] : layer.querySelector('i')
      if (body && p && getComputedStyle(layer).display !== 'none') {
        const x = body.getBoundingClientRect(), y = p.getBoundingClientRect()
        f.geo = Math.round(Math.max(Math.abs(x.left - y.left), Math.abs(x.top - y.top), Math.abs(x.width - y.width), Math.abs(x.height - y.height)))
      }
    }
    frames.push(f)
  }
  const src = document.querySelector(srcSel)
  const tail = {
    layers: document.querySelectorAll('.lcl-droplet, .lcl-stretch').length,
    pouringLeft: document.querySelectorAll('.lcl-droplet-pouring').length,
    srcStyle: src ? { z: src.style.zIndex, pos: src.style.position } : null,
    srcStyle0,
    panelBox: (() => { const p = document.querySelector(panelSel); if (!p) return null; const c = getComputedStyle(p); return { border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`, shadow: c.boxShadow, bg: c.backgroundColor, radius: c.borderTopLeftRadius } })(),
  }
  return { frames, tail }
}, spec)

/** 冻在第 t 毫秒拍一张(液体层 / 面板挂上的那一刻暂停全部动画)。 */
const armFreeze = (page, t, panelSel) => page.evaluate(({ t, panelSel }) => {
  window.__frozen = false
  const go = () => { document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t }); window.__frozen = true }
  if (t === 0 && document.querySelector(panelSel)) return
  const mo = new MutationObserver(() => {
    if (!document.querySelector('.lcl-droplet, .lcl-stretch') && !document.querySelector(panelSel)?.getAnimations().length) return
    mo.disconnect(); go()
  })
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
}, { t, panelSel })

/** 截图里取三处的颜色:面板里(右下角内缩 12px,内容一般不到那)、面板描边(右沿往里 0.5px、半高)、影子(下沿往外 5px、半宽)。 */
const SPOTS = (r) => ({ inner: { x: r.right - 14, y: r.bottom - 14 }, edge: { x: r.right - 1, y: r.top + r.height / 2 }, shadow: { x: r.left + r.width / 2, y: r.bottom + 4 } })
async function pixels(page, rect) {
  const out = {}
  const vw = await page.evaluate(() => [innerWidth, innerHeight])
  for (const [k, at] of Object.entries(SPOTS(rect))) {
    if (at.x < 0 || at.y < 0 || at.x > vw[0] - 3 || at.y > vw[1] - 3) { out[k] = null; continue }
    const buf = await page.screenshot({ clip: { x: Math.round(at.x), y: Math.round(at.y), width: 2, height: 2 } })
    const png = PNG.sync.read(buf)
    let r = 0, g = 0, b = 0
    for (let i = 0; i < png.data.length; i += 4) { r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2] }
    const n = png.data.length / 4
    out[k] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
  }
  return out
}
const pxDelta = (a, b) => Object.fromEntries(Object.keys(a).filter((k) => a[k] && b[k]).map((k) => [k, Math.max(...a[k].map((v, i) => Math.abs(v - b[k][i])))]))
const rectOf = (page, sel) => page.evaluate((s) => { const p = document.querySelector(s); if (!p) return null; const r = p.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }, sel)

function judge(name, open, d) {
  const F = open.frames.filter((f) => f.exists)
  const issues = []
  // 首帧:倾倒类主题,面板第一次出现时就该挂 pouring(不然先画了一帧自己的底色)
  if (/genesis|droplet|stretch/.test(d.theme) && F[0] && !F[0].pouring && F[0].op > 0) issues.push(`首帧面板没挂 pouring(先画了自己的底色): ${JSON.stringify(F[0])}`)
  const mid = F.filter((f) => f.pouring)
  if (mid.some((f) => f.srcTop && f.srcTop !== 'src' && !(f.srcTop === 'layer' && f.hole))) issues.push(`倾倒中源被盖住: ${JSON.stringify(mid.find((f) => f.srcTop !== 'src'))}`)
  if (mid.some((f) => f.geo > 2)) issues.push(`液体本体偏离面板 >2px: ${JSON.stringify(mid.map((f) => f.geo))}`)
  const end = F.at(-1)
  if (end && (end.gap < -1 || end.gap > 12)) issues.push(`源与面板的缝 ${end.gap}px(>12)`)
  if (end && (end.pouring || end.kids < 1 || end.vis === 'hidden' || (end.layer && !/hidden/.test(end.layer)))) issues.push(`开好后状态不对: ${JSON.stringify(end)}`)
  return issues
}

async function runSurface(page, sf, d, out) {
  const key = `${sf.name}/${d.theme}/${d.mode}/z${d.zoom}`
  const rec = { key, ...d, surface: sf.name, issues: [] }
  await sf.reset(page)
  // ① 完整开 → 停稳 → 完整收
  const open = await sample(page, { ...sf.sel, act: sf.open, ms: 650 })
  rec.open = open.frames
  rec.issues.push(...judge(sf.name, open, d))
  // 接手跳色:冻在 0.85D 取一次色、放开停稳后再取一次
  if (!/glide|fade/.test(d.theme)) {
    const at = await rectOf(page, sf.sel.panelSel)
    if (at) {
      const settled = await pixels(page, at)
      await sf.close(page); await sf.reset(page)
      await armFreeze(page, Math.round(0.85 * (d.theme === 'stretch' ? 380 : 420)), sf.sel.panelSel)
      await sf.openReal(page)
      await page.waitForFunction(() => window.__frozen, null, { timeout: 3000 }).catch(() => {})
      await pause(60)
      const pre = await pixels(page, at)
      await page.evaluate(() => document.getAnimations().forEach((a) => a.play()))
      await pause(500)
      rec.handoff = { pre, settled, delta: pxDelta(pre, settled) }
      for (const [k, v] of Object.entries(rec.handoff.delta)) if (v > 4) rec.issues.push(`接手 ${k} 跳色 Δ${v}: ${JSON.stringify([rec.handoff.pre[k], rec.handoff.settled[k]])}`)
    }
  }
  const close = await sample(page, { ...sf.sel, act: sf.closeAct, ms: 600 })
  rec.close = close.frames
  if (close.frames.at(-1)?.exists && sf.unmounts) rec.issues.push('收起后面板没卸载')
  if (close.tail.layers || close.tail.pouringLeft) rec.issues.push(`收完有残留: ${JSON.stringify(close.tail)}`)
  const base = open.tail.srcStyle0
  rec.panelBox = open.tail.panelBox
  if (close.tail.srcStyle && base && (close.tail.srcStyle.z !== base.z || close.tail.srcStyle.pos !== base.pos)) rec.issues.push(`源的内联样式没还原: ${JSON.stringify({ after: close.tail.srcStyle, before: base })}`)
  // ② 打断:开到 t 就收,内容透明度不该先升再降(收的那一刻起单调不增)
  rec.interrupt = {}
  for (const t of [60, 150, 300]) {
    await sf.reset(page)
    const r = await sample(page, { ...sf.sel, act: sf.open, act2: sf.closeAct, act2At: t, ms: 700 })
    const i = r.frames.findIndex((f) => f.mark === 'act2')
    const after = r.frames.slice(i + 1).filter((f) => f.exists && f.kids !== undefined)
    let rise = 0
    for (let k = 1; k < after.length; k++) rise = Math.max(rise, after[k].kids - after[k - 1].kids)
    const firstJump = after.length && i > 0 ? after[0].kids - (r.frames.slice(0, i).filter((f) => f.exists).at(-1)?.kids ?? after[0].kids) : 0
    rec.interrupt[t] = { rise: +rise.toFixed(2), firstJump: +firstJump.toFixed(2), seq: after.slice(0, 8).map((f) => +f.kids.toFixed(2)), end: r.frames.at(-1), tail: r.tail }
    if (rise > 0.05 || firstJump > 0.05) rec.issues.push(`开到 ${t}ms 就收:内容先蹦出来再淡(升 ${Math.max(rise, firstJump).toFixed(2)}): ${JSON.stringify(rec.interrupt[t].seq)}`)
    if (sf.unmounts && r.frames.at(-1)?.exists) rec.issues.push(`开到 ${t}ms 就收:最后没卸载`)
    if (r.tail.layers || r.tail.pouringLeft) rec.issues.push(`开到 ${t}ms 就收:残留 ${JSON.stringify(r.tail)}`)
  }
  // ③ 倒放中途再触发 = 重新流出、停在打开
  await sf.reset(page)
  await sample(page, { ...sf.sel, act: sf.open, ms: 520 })
  const re = await sample(page, { ...sf.sel, act: sf.closeAct, act2: sf.reopen ?? sf.open, act2At: 90, ms: 750 })
  const reEnd = re.frames.at(-1)
  rec.reopen = { end: reEnd, gone: re.frames.some((f) => f.exists === false) }
  if (!reEnd?.exists || reEnd.pouring || reEnd.kids < 1 || reEnd.vis === 'hidden') rec.issues.push(`倒放中途再触发没停在打开: ${JSON.stringify(reEnd)}`)
  await sf.close(page)
  await pause(600)
  // ④ 帧条
  if (STRIPS) {
    const shots = []
    for (const t of STRIP_MS) {
      await sf.reset(page)
      await armFreeze(page, t, sf.sel.panelSel)
      await sf.openReal(page)
      await page.waitForFunction(() => window.__frozen, null, { timeout: 2000 }).catch(() => {})
      await pause(50)
      const clip = await sf.clip(page)
      const f = path.join(out, `strip-${key.replace(/[/.]/g, '_')}-${t}.png`)
      await page.screenshot({ path: f, clip })
      shots.push(f)
      await page.evaluate(() => document.getAnimations().forEach((a) => a.play()))
      await pause(480)
      await sf.close(page)
    }
    rec.strip = shots
  }
  report.push(rec)
  console.log(`${rec.issues.length ? 'ISSUE' : 'ok   '} ${key}${rec.issues.length ? '\n   - ' + rec.issues.join('\n   - ') : ''}`)
}


/** 分段胶囊(真应用 ⌘P 分类胶囊 .amx-qf-seg):点第 to 格(可选 60ms 后改点 to2),逐帧记滑块两条边(相对胶囊)、可见性、融球层。 */
const segRun = (page, pillSel, to, to2 = null) => page.evaluate(async ({ pillSel, to, to2 }) => {
  const raf = () => new Promise(requestAnimationFrame)
  const pill = document.querySelector(pillSel), thumb = pill.querySelector('.t2s-vaultseg-thumb, .lcl-vmode-thumb')
  const btns = [...pill.querySelectorAll(':scope > button')]
  const pr = () => pill.getBoundingClientRect()
  const cell = (i) => { const b = btns[i].getBoundingClientRect(), p = pr(); return [b.left - p.left, b.right - p.left] }
  const from = btns.findIndex((b) => b.classList.contains('on') || b.getAttribute('aria-selected') === 'true')
  const box = () => { const r = thumb.getBoundingClientRect(), p = pr(), fl = pill.querySelector('.lcl-flow'); const is = fl ? [...fl.querySelectorAll(':scope > i')].map((i) => { const q = i.getBoundingClientRect(); return [Math.round((q.left - p.left) * 10) / 10, Math.round((q.right - p.left) * 10) / 10] }) : null
    return { l: Math.round((r.left - p.left) * 10) / 10, r: Math.round((r.right - p.left) * 10) / 10, hidden: getComputedStyle(thumb).visibility === 'hidden', flow: is } }
  const cells = btns.map((_, i) => cell(i))
  const frames = [box()]
  btns[to].click()
  const t0 = performance.now()
  let did2 = false
  while (performance.now() - t0 < 650) {
    if (to2 !== null && !did2 && performance.now() - t0 >= 60) { btns[to2].click(); did2 = true }
    await raf(); frames.push({ t: Math.round(performance.now() - t0), ...box() })
  }
  return { from, to, to2, cells, frames, widths: cells.map(([a, b]) => Math.round((b - a) * 10) / 10) }
}, { pillSel, to, to2 })

function judgeSeg(r, theme) {
  const issues = []
  const target = r.cells[r.to2 ?? r.to], end = r.frames.at(-1)
  if (Math.abs(end.l - target[0]) > 1.5 || Math.abs(end.r - target[1]) > 1.5) issues.push(`终点不准: 滑块 [${end.l}, ${end.r}] vs 格 [${target[0].toFixed(1)}, ${target[1].toFixed(1)}]`)
  if (end.hidden) issues.push('停稳后滑块还藏着')
  if (end.flow) issues.push('停稳后融球层没撤')
  const lo = Math.min(...r.cells.flat()) - 1, hi = Math.max(...r.cells.flat()) + 1
  const vis = r.frames.filter((f) => !f.hidden)
  if (vis.some((f) => f.l < lo || f.r > hi)) issues.push(`越出胶囊: ${JSON.stringify(vis.find((f) => f.l < lo || f.r > hi))}`)
  // 过冲:单向移动时,任一条边越过终点再回来
  if (r.to2 === null) {
    const dir = Math.sign(target[0] - r.cells[r.from][0])
    const over = vis.filter((f) => dir > 0 ? f.r > target[1] + 0.8 : f.l < target[0] - 0.8)
    if (over.length) issues.push(`过冲 ${Math.max(...over.map((f) => dir > 0 ? f.r - target[1] : target[0] - f.l)).toFixed(1)}px`)
  }
  // 宽度不得比一格还窄(拉伸中途改目标塌成一条缝,#476 修过)
  const minCell = Math.min(...r.widths)
  if (theme !== 'droplet' && vis.some((f) => f.r - f.l < minCell - 1.5)) issues.push(`滑块窄于一格: ${Math.min(...vis.map((f) => f.r - f.l)).toFixed(1)} < ${minCell}`)
  if (theme === 'droplet' && r.to2 === null) {
    const first = r.frames.find((f) => f.flow)
    if (!first) issues.push('水滴主题没有融球层')
    else {
      const src = r.cells[r.from], tail = first.flow[0]
      // 融球从上一格长出来(segFlow 按「各格等宽」推上一格):格不等宽时这里会偏
      const off = Math.max(Math.abs(tail[0] - src[0]), Math.abs(tail[1] - src[1]))
      if (off > 2.5) issues.push(`融球不是从上一格长出来: 尾 [${tail}] vs 上一格 [${src.map((x) => x.toFixed(1))}] 偏 ${off.toFixed(1)}px`)
    }
  }
  // 只淡入淡出:点了下一帧就在(第一次点的那一格)—— 中途改目标那一轮,第 2 帧还在第一个目标上
  const first = r.cells[r.to]
  if (theme === 'fade' && r.frames.length > 2 && (Math.abs(r.frames[2].l - first[0]) > 1.5)) issues.push(`只淡入淡出下滑块没直接到位: 第 2 帧 ${r.frames[2].l} vs ${first[0].toFixed(1)}`)
  return issues
}

async function runSeg(page, d) {
  const key = `seg-qf/${d.theme}/${d.mode}/z${d.zoom}`
  const rec = { key, ...d, surface: 'seg-qf', issues: [] }
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+p' : 'Control+p')
  const pill = '.amx-qf-seg'
  await page.waitForSelector(pill, { timeout: 4000 })
  await pause(400)
  const n = await page.evaluate((s) => document.querySelectorAll(`${s} > button`).length, pill)
  // 先回第 0 格,再 0 → 末格、末格 → 1、1 → 末格中途改点 0
  await page.evaluate((s) => document.querySelector(`${s} > button`).click(), pill); await pause(500)
  const runs = [await segRun(page, pill, n - 1), await segRun(page, pill, 1), await segRun(page, pill, n - 1, 0)]
  rec.seg = runs
  for (const r of runs) rec.issues.push(...judgeSeg(r, d.theme).map((x) => `${r.from}→${r.to}${r.to2 !== null ? '→' + r.to2 : ''}: ${x}`))
  rec.widths = runs[0].widths
  await page.keyboard.press('Escape'); await pause(300)
  report.push(rec)
  console.log(`${rec.issues.length ? 'ISSUE' : 'ok   '} ${key} 格宽 ${JSON.stringify(rec.widths)}${rec.issues.length ? '\n   - ' + rec.issues.join('\n   - ') : ''}`)
}

async function main() {
  const userData = path.join(temp, 'userdata')
  const session = (id) => ({ id, title: id, created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z', agent_config: { execMode: 'host' } })
  const stub = await startStubEngine({ sessions: [session('r3-a'), session('r3-b')] })
  fs.mkdirSync(userData + '-dev', { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'r3-test-token' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    // 台架窗一律压在普通窗口之下(-1),含之后开的 Mini
    await app.evaluate(({ app: a }) => {
      if (process.platform !== 'darwin') return
      a.on('browser-window-created', (_e, w) => { const orig = w.setAlwaysOnTop.bind(w); w.setAlwaysOnTop = (flag) => orig(flag, 'normal', -1); orig(true, 'normal', -1) })
    })
    const win = await app.firstWindow(), errors = []
    win.on('pageerror', (e) => errors.push(`main: ${e.message}`))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1512, 1000))
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    await skipOnboarding(win)
    await win.waitForSelector('.rb [data-space-id]', { timeout: 30000 })
    await win.waitForTimeout(800)
    const away = async (p) => { await p.mouse.move(1100, 600); }
    const centerOf = (p, sel) => p.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }, sel)
    const peekId = await win.evaluate(() => { const cur = document.querySelector('.rb .rb-space.on')?.dataset.spaceId; return [...document.querySelectorAll('.rb .rb-strip-in [data-space-id]')].map((b) => b.dataset.spaceId).find((id) => id !== cur) })
    const iconA = `.rb .rb-strip-in [data-space-id="${peekId}"]`
    const waitGone = (p, sel) => p.waitForFunction((sel) => !document.querySelector(sel) && !document.querySelector('.lcl-droplet, .lcl-stretch, .lcl-droplet-pouring'), sel, { timeout: 3000 }).catch(() => {})
    const avatar = '.ribbon-account, .account-card'
    const S = {
      peek: {
        name: 'peek', page: win, unmounts: true,
        sel: { panelSel: '.rb-peek', srcSel: iconA },
        // 悬停要真指针(onMouseOver + 300ms 计时):open 在页外移指针,页内采样从卡出现开始
        open: 'none', closeAct: 'key:Escape',
        reset: async (p) => { await away(p); await waitGone(p, '.rb-peek'); await pause(250) },
        openReal: async (p) => { const c = await centerOf(p, iconA); await p.mouse.move(c.x, c.y, { steps: 3 }) },
        close: async (p) => { await p.keyboard.press('Escape'); await waitGone(p, '.rb-peek') },
        clip: async () => ({ x: 0, y: 0, width: 520, height: 560 }),
      },
      account: {
        name: 'account', page: win, unmounts: true,
        sel: { panelSel: '.account-pop', srcSel: '.ribbon-account .account-avatar, .account-card .account-avatar' },
        open: `click:${avatar}`, closeAct: `click:${avatar}`,
        reset: async (p) => { await waitGone(p, '.account-pop'); await pause(150) },
        openReal: (p) => p.evaluate((s) => document.querySelector(s).click(), avatar),
        close: async (p) => { if (await p.$('.account-pop')) await p.keyboard.press('Escape'); await waitGone(p, '.account-pop') },
        clip: async (p) => { const v = await p.evaluate(() => innerHeight); return { x: 0, y: Math.max(0, v - 420), width: 380, height: 420 } },
      },
      more: {
        name: 'more', page: win, unmounts: true,
        sel: { panelSel: '.rb-more-fly', srcSel: '.rb-bottom .rb-more' },
        open: 'click:.rb-bottom .rb-more', closeAct: 'click:.rb-bottom .rb-more',
        reset: async (p) => { await waitGone(p, '.rb-more-fly'); await pause(150) },
        openReal: (p) => p.evaluate(() => document.querySelector('.rb-bottom .rb-more').click()),
        close: async (p) => { if (await p.$('.rb-more-fly')) await p.keyboard.press('Escape'); await waitGone(p, '.rb-more-fly') },
        clip: async (p) => { const v = await p.evaluate(() => innerHeight); return { x: 0, y: Math.max(0, v - 460), width: 360, height: 460 } },
      },
    }
    // 悬停预览的 open 在页外:包一层,先移指针再在页内采样(采样从卡挂上开始)
    const peekSample = async (p, spec) => {
      if (spec.act === 'none' && !spec.act2) { await S.peek.openReal(p); return sample(p, { ...spec, act: 'none' }) }
      return sample(p, spec)
    }
    let mini = null
    const combos = []
    for (const theme of THEMES) for (const mode of MODES) for (const zoom of ZOOMS) combos.push({ theme, mode, zoom })
    for (const d of combos) {
      await setEnv(win, d)
      await pause(250)
      if (SURFACES.includes('seg')) { try { await runSeg(win, d) } catch (e) { console.log(`ERROR seg ${e.message.split('\n')[0]}`); await win.keyboard.press('Escape').catch(() => {}) } }
      for (const name of SURFACES.filter((n) => S[n])) {
        const sf = S[name]
        try {
        if (name === 'peek') {
          // 悬停:open = 移到图标、等卡挂上;interrupt / reopen 的 act2 用 Escape / 再移回图标
          const sfp = { ...sf, open: 'none' }
          const origSample = sample
          await runSurfaceWith(win, sfp, d, peekSample, origSample)
        } else await runSurface(win, sf, d, OUT)
        } catch (e) { report.push({ key: `${name}/${d.theme}/${d.mode}/z${d.zoom}`, issues: [`探针出错: ${e.message.split('\n')[0]}`] }); console.log(`ERROR ${name}/${d.theme}/${d.mode}/z${d.zoom} ${e.message.split('\n')[0]}`); await win.keyboard.press('Escape').catch(() => {}); await pause(700) }
      }
      if (SURFACES.includes('mini')) {
        if (!mini) {
          await win.evaluate(() => window.tangu.openMini({ sessionId: 'r3-a' }))
          for (let i = 0; i < 200; i++) { mini = app.windows().find((w) => w.url().includes('window=mini')); if (mini) break; await pause(50) }
          if (!mini) throw new Error('Mini window missing')
          mini.on('pageerror', (e) => errors.push(`mini: ${e.message}`))
          await mini.waitForSelector('.mini-card-space', { timeout: 30000 }); await mini.waitForTimeout(800)
        }
        await setEnv(mini, d)
        await pause(200)
        const spaceEnabled = await mini.evaluate(() => !document.querySelector('.mini-card-space').disabled)
        for (const srcSel of spaceEnabled ? ['.mini-card-space', '.mini-card-picker'] : ['.mini-card-picker']) {
          if (!(await mini.$(srcSel))) continue
          await runSurface(mini, {
            name: `mini${srcSel.replace('.mini-card', '')}`, unmounts: true,
            sel: { panelSel: '.mini-card-popover', srcSel },
            open: `click:${srcSel}`, closeAct: `click:${srcSel}`,
            reset: async (p) => { await waitGone(p, '.mini-card-popover'); await pause(150) },
            openReal: (p) => p.evaluate((s) => document.querySelector(s).click(), srcSel),
            close: async (p) => { if (await p.$('.mini-card-popover')) await p.keyboard.press('Escape'); await waitGone(p, '.mini-card-popover') },
            clip: async (p) => p.evaluate(() => { const r = document.querySelector('.mini-card-shell').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 320) } }),
          }, d, OUT)
        }
      }
    }
    report.push({ key: 'errors', errors })
  } finally {
    fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(report, null, 1))
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
  const bad = report.filter((r) => r.issues?.length)
  console.log(`\n${report.length - 1} 组,${bad.length} 组有问题;明细 ${path.join(OUT, 'probe.json')}`)
}

/** 悬停预览专用:open 在页外移指针。interrupt / reopen 走同样的流程,只是 act 换成页外动作。 */
async function runSurfaceWith(page, sf, d, peekSample) {
  const key = `${sf.name}/${d.theme}/${d.mode}/z${d.zoom}`
  const rec = { key, ...d, surface: sf.name, issues: [] }
  const iconA = sf.sel.srcSel
  await sf.reset(page)
  const open = await peekSample(page, { ...sf.sel, act: 'none', ms: 650 })
  // 卡挂上之前那几帧 exists=false,judge 只看存在的帧
  rec.open = open.frames
  rec.issues.push(...judge(sf.name, open, d))
  if (!/glide|fade/.test(d.theme)) {
    const at = await rectOf(page, sf.sel.panelSel)
    if (at) {
      const settled = await pixels(page, at)
      await sf.close(page); await sf.reset(page)
      await armFreeze(page, Math.round(0.85 * (d.theme === 'stretch' ? 380 : 420)), sf.sel.panelSel)
      await sf.openReal(page)
      await page.waitForFunction(() => window.__frozen, null, { timeout: 3000 }).catch(() => {})
      await pause(60)
      const pre = await pixels(page, at)
      await page.evaluate(() => document.getAnimations().forEach((a) => a.play()))
      await pause(500)
      rec.handoff = { pre, settled, delta: pxDelta(pre, settled) }
      for (const [k, v] of Object.entries(rec.handoff.delta)) if (v > 4) rec.issues.push(`接手 ${k} 跳色 Δ${v}: ${JSON.stringify([rec.handoff.pre[k], rec.handoff.settled[k]])}`)
    }
  }
  const close = await sample(page, { ...sf.sel, act: 'key:Escape', ms: 600 })
  rec.close = close.frames
  if (close.frames.at(-1)?.exists) rec.issues.push('收起后面板没卸载')
  if (close.tail.layers || close.tail.pouringLeft) rec.issues.push(`收完有残留: ${JSON.stringify(close.tail)}`)
  const base = open.tail.srcStyle0
  rec.panelBox = open.tail.panelBox
  if (close.tail.srcStyle && base && (close.tail.srcStyle.z !== base.z || close.tail.srcStyle.pos !== base.pos)) rec.issues.push(`源的内联样式没还原: ${JSON.stringify({ after: close.tail.srcStyle, before: base })}`)
  rec.interrupt = {}
  for (const t of [60, 150, 300]) {
    await sf.reset(page)
    // 等卡挂上的那一刻再开始计时,到 t 按 Esc
    await sf.openReal(page)
    const r = await page.evaluate(async ({ panelSel, t }) => {
      const raf = () => new Promise(requestAnimationFrame)
      const w0 = performance.now()
      while (!document.querySelector(panelSel) && performance.now() - w0 < 1500) await raf()
      const t0 = performance.now(), frames = []
      let did = false
      while (performance.now() - t0 < 700) {
        if (!did && performance.now() - t0 >= t) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); did = true; frames.push({ mark: 'act2' }) }
        await raf()
        const p = document.querySelector(panelSel)
        frames.push({ t: Math.round(performance.now() - t0), exists: !!p, kids: p ? Math.min(...[...p.children].map((k) => +getComputedStyle(k).opacity), 1) : undefined })
      }
      return { frames, tail: { layers: document.querySelectorAll('.lcl-droplet, .lcl-stretch').length, pouringLeft: document.querySelectorAll('.lcl-droplet-pouring').length } }
    }, { panelSel: sf.sel.panelSel, t })
    const i = r.frames.findIndex((f) => f.mark === 'act2')
    const after = r.frames.slice(i + 1).filter((f) => f.exists)
    let rise = 0
    for (let k = 1; k < after.length; k++) rise = Math.max(rise, after[k].kids - after[k - 1].kids)
    const prev = r.frames.slice(0, i).filter((f) => f.exists).at(-1)?.kids
    const firstJump = after.length && prev !== undefined ? after[0].kids - prev : 0
    rec.interrupt[t] = { rise: +rise.toFixed(2), firstJump: +firstJump.toFixed(2), seq: after.slice(0, 8).map((f) => +f.kids.toFixed(2)), tail: r.tail }
    if (rise > 0.05 || firstJump > 0.05) rec.issues.push(`开到 ${t}ms 就收:内容先蹦出来再淡(升 ${Math.max(rise, firstJump).toFixed(2)}): ${JSON.stringify(rec.interrupt[t].seq)}`)
    if (r.frames.at(-1)?.exists) rec.issues.push(`开到 ${t}ms 就收:最后没卸载`)
    if (r.tail.layers || r.tail.pouringLeft) rec.issues.push(`开到 ${t}ms 就收:残留 ${JSON.stringify(r.tail)}`)
    await page.mouse.move(1100, 600)
  }
  if (STRIPS) {
    const shots = []
    for (const t of STRIP_MS) {
      await sf.reset(page)
      await armFreeze(page, t, sf.sel.panelSel)
      await sf.openReal(page)
      await page.waitForFunction(() => window.__frozen, null, { timeout: 2000 }).catch(() => {})
      await pause(50)
      const f = path.join(OUT, `strip-${key.replace(/[/.]/g, '_')}-${t}.png`)
      await page.screenshot({ path: f, clip: await sf.clip(page) })
      shots.push(f)
      await page.evaluate(() => document.getAnimations().forEach((a) => a.play()))
      await pause(480)
      await sf.close(page)
    }
    rec.strip = shots
  }
  await sf.close(page)
  report.push(rec)
  console.log(`${rec.issues.length ? 'ISSUE' : 'ok   '} ${key}${rec.issues.length ? '\n   - ' + rec.issues.join('\n   - ') : ''}`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
