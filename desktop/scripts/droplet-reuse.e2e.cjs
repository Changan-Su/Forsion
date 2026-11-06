/** 液滴复用第一批(2026-11-05,DESIGN §3「液滴展开」):Space 悬停预览、头像账号卡、Mini 胶囊下拉都从发起它的控件里
 *  流出来(lcl/engine/droplet.ts),收起倒放缩回。真 Electron(out/ 构建)逐帧采样:
 *   · 倾倒期液体可见、面板自身无底色(预览卡的材质在 ::before 上,一起看)、clip-path 在变,0.9D 后真面板一帧接手;
 *   · 收起 = 倒放:液体重新出现、面板随后卸载;再点源按钮 / Esc 也走倒放;
 *   · 预览已开着时换图标:卡不重挂、不重播液滴,之后收起缩回的是新图标;
 *   · 反复开合不空屏(内容不透明度 1);倒放到一半又悬停 / 又点源按钮 = 重新流出来、停在打开(同悬浮目录)。
 *  --neg 负对照:倾倒期让面板自己上底色,上面那条必须报红(退出码非 0 = 负对照成立)。
 *  用法:npm run build && node scripts/droplet-reuse.e2e.cjs [--neg]   截图 → outputs/droplet-reuse/ */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'outputs', 'droplet-reuse')
fs.mkdirSync(OUT, { recursive: true })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-droplet-reuse-'))
const NEG = process.argv.includes('--neg')
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' ' + detail}`) }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
// 系统窗口列表里本进程各窗口的层级(同 quiet-focus.check):台架窗都该在普通窗口之下(< 0),不盖住用户在用的 App
const LAYERS_JXA = `ObjC.import('CoreGraphics'); function run(a) { return JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))).filter((w) => w.kCGWindowOwnerPID == a[0]).map((w) => [w.kCGWindowLayer, w.kCGWindowBounds.Width])) }`
const layersOf = (pid) => JSON.parse(require('child_process').execFileSync('osascript', ['-l', 'JavaScript', '-e', LAYERS_JXA, String(pid)]).toString())

/** 等 sel 出现后逐帧记状态 ms 毫秒。act:在页面里先做的动作(点哪个元素),省掉 Playwright 自己约 100ms 的点击开销。 */
const sample = (page, sel, { ms = 650, act = null, key = null } = {}) => page.evaluate(async ({ sel, ms, act, key }) => {
  if (act) document.querySelector(act)?.click()
  if (key) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  const raf = () => new Promise(requestAnimationFrame)
  const t0 = performance.now()
  if (!act && !key) while (!document.querySelector(sel) && performance.now() - t0 < 1500) await raf()
  const t1 = performance.now(), frames = []
  while (performance.now() - t1 < ms) {
    await raf()
    const p = document.querySelector(sel), layer = document.querySelector('.lcl-droplet')
    const cs = p && getComputedStyle(p), before = p && getComputedStyle(p, '::before')
    frames.push({ t: Math.round(performance.now() - t1), exists: !!p, pouring: !!p?.classList.contains('lcl-droplet-pouring'),
      bg: cs?.backgroundColor, beforeShown: !!before && before.content !== 'none' && +before.opacity > 0 && !/rgba\(0, 0, 0, 0\)|transparent/.test(before.backgroundColor),
      layer: !!layer && getComputedStyle(layer).display !== 'none', clip: cs?.clipPath, vis: cs?.visibility,
      kids: p ? [...p.children].map((k) => +getComputedStyle(k).opacity) : [], mark: p?.dataset.probe ?? null, hole: !!layer && 'hole' in layer.dataset,
      // 液体本体(第二个 <i>,按面板矩形摆)与面板此刻矩形的最大偏差:液滴量到的若是面板定位前的矩形,这里会差出一截
      geo: (() => { const b = layer?.querySelectorAll('i')[1]; if (!b || !p) return null; const x = b.getBoundingClientRect(), y = p.getBoundingClientRect(); return Math.round(Math.max(Math.abs(x.left - y.left), Math.abs(x.top - y.top), Math.abs(x.width - y.width), Math.abs(x.height - y.height))) })(),
      drop: (() => { const i = layer?.querySelector('i'); if (!i) return null; const r = i.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 } })() })
  }
  return frames
}, { sel, ms, act, key })

function verifyPour(frames, name) {
  const mid = frames.filter((f) => f.t > 50 && f.t < 300 && f.exists)
  check(`${name}: 倾倒期液体可见、面板挂 pouring`, mid.length >= 3 && mid.every((f) => f.pouring && f.layer), JSON.stringify(mid.slice(0, 2)))
  // 真面板不能早于液体停稳出现(10-29 打回):pouring 期间面板自己(含 ::before 材质)没有底色
  check(`${name}: 倾倒期面板自身无底色`, mid.every((f) => /rgba\(0, 0, 0, 0\)|transparent/.test(f.bg) && !f.beforeShown), JSON.stringify(mid[0]))
  check(`${name}: clip-path 跟着液体`, new Set(mid.map((f) => f.clip)).size >= 3)
  check(`${name}: 液体长成的就是面板最终的位置(偏差 ≤ 2px)`, mid.every((f) => f.geo !== null && f.geo <= 2), JSON.stringify(mid.map((f) => f.geo)))
  const end = frames.at(-1)
  check(`${name}: 0.9D 后真面板接手`, end.exists && !end.pouring && !end.layer && end.clip === 'none' && end.kids.every((o) => o === 1), JSON.stringify(end))
}
function verifyRetract(frames, name) {
  check(`${name}: 收起倒放(液体重新出现)`, frames.some((f) => f.exists && f.layer && f.pouring), JSON.stringify(frames.slice(0, 2)))
  check(`${name}: 倒放完卸载`, !frames.at(-1).exists, JSON.stringify(frames.at(-1)))
}
/** 冻结在倾倒的某一毫秒拍一张(DESIGN §8 观感交付要真截图),拍完放开。先等上一滴(含倒放)清场,再在液体层挂上的
 *  那一刻(MutationObserver,早于下一帧)暂停全部动画 —— 等 Playwright 看到面板再冻,抓到的可能是上一次还没倒放完的那滴。 */
const waitNoDrop = (page) => page.waitForFunction(() => !document.querySelector('.lcl-droplet, .lcl-droplet-pouring'), null, { timeout: 3000 })
const armFreeze = (page, t) => page.evaluate((t) => {
  window.__frozen = false
  const mo = new MutationObserver(() => {
    if (!document.querySelector('.lcl-droplet')) return
    mo.disconnect(); document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t }); window.__frozen = true
  })
  mo.observe(document.body, { childList: true, subtree: true })
}, t)
async function freezeShot(page, file, clip) {
  await page.waitForFunction(() => window.__frozen, null, { timeout: 3000 })
  await page.waitForTimeout(60)
  await page.screenshot({ path: path.join(OUT, file), clip })
  await page.evaluate(() => document.getAnimations().forEach((a) => a.play()))
}
/** 倒放到一半再触发一次:应当重新流出来、最后停在打开(面板在、没在倒、内容不透明度 1)。 */
function verifyRepour(frames, name) {
  const end = frames.at(-1)
  check(`${name}: 倒放中途再触发 = 重新流出、停在打开`, frames.every((f) => f.exists) && !end.pouring && !end.layer && end.vis !== 'hidden' && end.kids.every((o) => o === 1), JSON.stringify(frames.find((f) => !f.exists) ?? end))
}
/** 重新流出之后源还压在液体上:旧那滴倒放的收尾晚一拍才到,不许把新那滴给源抬的 z-index 撤掉(Codex 评审 P2)。 */
const srcStillRaised = async (page, src, name) => {
  const z = await page.evaluate((src) => document.querySelector(src)?.style.zIndex ?? null, src)
  check(`${name}: 重新流出后源的层级没被旧倒放撤掉`, !!z, `zIndex=${JSON.stringify(z)}`)
}
const midRetract = (page, sel) => page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('lcl-droplet-pouring'), sel, { timeout: 2000, polling: 'raf' })
const NEG_CSS = `.lcl-droplet-pouring.account-pop, .lcl-droplet-pouring.mini-card-popover { background-color: #c33 !important }
  .rb-peek.lcl-droplet-pouring::before { opacity: 1 !important }`

async function main() {
  const userData = path.join(temp, 'userdata')
  const session = (id) => ({ id, title: id, created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:00:00Z', agent_config: { execMode: 'host' } })
  const stub = await startStubEngine({ sessions: [session('droplet-a'), session('droplet-b')] })
  fs.mkdirSync(userData + '-dev', { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'droplet-test-token' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    const win = await app.firstWindow(), errors = []
    win.on('pageerror', (e) => errors.push(`main: ${e.message}`))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1512, 950))
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    check('主窗口跳过引导', await skipOnboarding(win))
    await win.waitForSelector('.rb [data-space-id]', { timeout: 30000 })
    await win.waitForTimeout(800)
    if (NEG) await win.addStyleTag({ content: NEG_CSS })
    const away = () => win.mouse.move(1100, 600)
    const center = (sel) => win.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }, sel)
    const setMode = (m) => win.evaluate((m) => { const r = document.documentElement; r.dataset.mode = m; r.classList.toggle('dark', m === 'dark') }, m)

    // ── 1 Space 悬停预览 ──
    // 要一个「不是当前 Space」的图标:当前的那颗不弹(它的左栏就在眼前)
    const peekIds = await win.evaluate(() => { const cur = document.querySelector('.rb .rb-space.on')?.dataset.spaceId; return [...document.querySelectorAll('.rb .rb-strip-in [data-space-id]')].map((b) => b.dataset.spaceId).filter((id, i, a) => id !== cur && a.indexOf(id) === i) })
    const [A, B] = peekIds
    check('找到两个可预览的 Space', !!A && !!B, JSON.stringify(peekIds))
    const iconA = `.rb .rb-strip-in [data-space-id="${A}"]`, iconB = `.rb .rb-strip-in [data-space-id="${B}"]`
    await away(); await win.waitForTimeout(300)
    let pa = await center(iconA)
    await win.mouse.move(pa.x, pa.y, { steps: 3 })
    const peekPour = await sample(win, '.rb-peek')
    verifyPour(peekPour, '悬停预览')
    check('悬停预览: 图标压得过液体,不挖洞', peekPour.every((f) => !f.hole))
    await win.evaluate(() => { document.querySelector('.rb-peek').dataset.probe = 'same-card' })
    const pb = await center(iconB)
    await win.mouse.move(pb.x, pb.y, { steps: 3 })
    const sw = await sample(win, '.rb-peek', { ms: 300 })
    check('悬停预览: 换图标不重挂、不重播液滴', sw.every((f) => f.exists && f.mark === 'same-card' && !f.layer && !f.pouring), JSON.stringify(sw.find((f) => f.layer || f.mark !== 'same-card')))
    await away()
    const rb = await sample(win, '.rb-peek', { ms: 700 })
    verifyRetract(rb, '悬停预览(移开)')
    const firstDrop = rb.find((f) => f.layer && f.drop)?.drop
    check('悬停预览: 收起缩回的是新图标', !!firstDrop && Math.abs(firstDrop.cy - pb.y) < 24, JSON.stringify({ firstDrop, iconB: pb }))
    // Esc 也是倒放;反复开合不空屏
    await win.waitForTimeout(200); pa = await center(iconA); await win.mouse.move(pa.x, pa.y, { steps: 3 })
    await sample(win, '.rb-peek', { ms: 520 })
    verifyRetract(await sample(win, '.rb-peek', { ms: 600, key: 'Escape' }), '悬停预览(Esc)')
    // 移开后倒放到一半又回到图标:重新流出来,不在指针底下收掉
    await away(); await win.waitForTimeout(200); pa = await center(iconA); await win.mouse.move(pa.x, pa.y, { steps: 3 })
    await sample(win, '.rb-peek', { ms: 520 })
    await away(); await midRetract(win, '.rb-peek'); await win.waitForTimeout(60)
    await win.mouse.move(pa.x, pa.y)
    verifyRepour(await sample(win, '.rb-peek', { ms: 700 }), '悬停预览')
    await srcStillRaised(win, iconA, '悬停预览')
    await win.keyboard.press('Escape'); await win.waitForTimeout(600)
    // 倒放收起到一半改了窗口(resize / 界面缩放):直接收完,不许撤掉倒放、卡又露出来留在那
    await away(); await win.waitForTimeout(200); pa = await center(iconA); await win.mouse.move(pa.x, pa.y, { steps: 3 })
    await sample(win, '.rb-peek', { ms: 520 })
    await win.keyboard.press('Escape'); await midRetract(win, '.rb-peek')
    await win.evaluate(() => window.dispatchEvent(new Event('resize')))
    await win.waitForTimeout(600)
    check('悬停预览: 倒放中改窗口 = 收完', await win.evaluate(() => !document.querySelector('.rb-peek')))
    // 截图:亮 / 暗各一张倾倒中段 + 接手后
    for (const m of ['light', 'dark']) {
      await setMode(m); await away(); await waitNoDrop(win); await win.waitForTimeout(400)
      await armFreeze(win, 130); pa = await center(iconA); await win.mouse.move(pa.x, pa.y, { steps: 3 })
      await freezeShot(win, `peek-pour-${m}.png`, { x: 0, y: 0, width: 520, height: 520 })
      await win.waitForTimeout(500); await win.screenshot({ path: path.join(OUT, `peek-open-${m}.png`), clip: { x: 0, y: 0, width: 520, height: 520 } })
    }
    await setMode('light'); await away(); await win.waitForTimeout(800)

    // ── 2 头像 → 账号卡 ──
    const avatarBtn = '.ribbon-account, .account-card'
    const accPour = await sample(win, '.account-pop', { act: avatarBtn })
    verifyPour(accPour, '账号卡')
    // 头像关在 .shell-host 的 isolation 里,z-index 抬不过 body 上的液体层 → 液体按头像轮廓挖洞,头像照样露在上面
    check('账号卡: 液体层在头像处挖洞', accPour.some((f) => f.layer && f.hole), JSON.stringify(accPour.find((f) => f.layer)))
    const gap = await win.evaluate(() => { const a = document.querySelector('.ribbon-account .account-avatar, .account-card .account-avatar').getBoundingClientRect(), p = document.querySelector('.account-pop').getBoundingClientRect(); return Math.round(a.top - p.bottom) })
    check('账号卡: 卡片贴着头像(缝 ≤ 12px)', gap >= -1 && gap <= 12, `gap=${gap}`)
    verifyRetract(await sample(win, '.account-pop', { act: avatarBtn, ms: 600 }), '账号卡(再点头像)')
    await sample(win, '.account-pop', { act: avatarBtn, ms: 520 })
    verifyRetract(await sample(win, '.account-pop', { key: 'Escape', ms: 600 }), '账号卡(Esc)')
    for (let i = 0; i < 10; i++) { await win.evaluate((s) => document.querySelector(s).click(), avatarBtn); await pause(30 + (i * 53) % 170) }
    await win.waitForTimeout(700)
    const acc = await win.evaluate(() => { const p = document.querySelector('.account-pop'); return p ? { vis: getComputedStyle(p).visibility, kids: [...p.children].map((k) => +getComputedStyle(k).opacity) } : 'closed' })
    if (acc === 'closed') { await win.evaluate((s) => document.querySelector(s).click(), avatarBtn); await win.waitForTimeout(700) }
    const acc2 = await win.evaluate(() => { const p = document.querySelector('.account-pop'); return p && { vis: getComputedStyle(p).visibility, kids: [...p.children].map((k) => +getComputedStyle(k).opacity) } })
    check('账号卡: 反复开合 10 次后不空屏', !!acc2 && acc2.vis !== 'hidden' && acc2.kids.every((o) => o === 1), JSON.stringify(acc2))
    await win.keyboard.press('Escape'); await win.waitForTimeout(600)
    // 再点头像收到一半又点:重新流出来
    await sample(win, '.account-pop', { act: avatarBtn, ms: 520 })
    await win.evaluate((s) => document.querySelector(s).click(), avatarBtn); await midRetract(win, '.account-pop'); await win.waitForTimeout(60)
    verifyRepour(await sample(win, '.account-pop', { act: avatarBtn, ms: 700 }), '账号卡')
    await srcStillRaised(win, '.ribbon-account .account-avatar, .account-card .account-avatar', '账号卡')
    // 开着时卡片变高(展开额度 / 账号列表异步长出来,OverlayAt 重新夹位置):倒放要按现在的矩形,不能跳回流出时那块
    await win.evaluate(() => { const x = document.createElement('div'); x.className = 'droplet-probe-grow'; x.style.height = '80px'; document.querySelector('.account-pop').appendChild(x) })
    await win.waitForTimeout(150)
    const grown = await sample(win, '.account-pop', { act: avatarBtn, ms: 600 })
    const gl = grown.filter((f) => f.exists && f.layer)
    check('账号卡: 开着时变高,倒放按现在的矩形(偏差 ≤ 2px)', gl.length >= 3 && gl.every((f) => f.geo !== null && f.geo <= 2), JSON.stringify(gl.length ? gl.map((f) => f.geo) : grown.slice(0, 4).map(({ kids, ...f }) => f)))
    check('账号卡: 变高后照样倒放完卸载', !grown.at(-1).exists)
    await win.waitForTimeout(300)
    for (const m of ['light', 'dark']) {
      await setMode(m); await waitNoDrop(win); await win.waitForTimeout(200)
      await armFreeze(win, 150); await win.evaluate((s) => document.querySelector(s).click(), avatarBtn)
      await freezeShot(win, `account-pour-${m}.png`, { x: 0, y: 600, width: 360, height: 350 })
      await win.waitForTimeout(500); await win.screenshot({ path: path.join(OUT, `account-open-${m}.png`), clip: { x: 0, y: 600, width: 360, height: 350 } })
      await win.keyboard.press('Escape'); await win.waitForTimeout(600)
    }
    await setMode('light')

    // ── 3 Mini 胶囊下拉 ──
    // Mini 本来就要浮在别的 App 上(构造 alwaysOnTop + setAlwaysOnTop(true,'floating')),主进程的 sinkForHarness 不压它
    // → 台架自己压:窗口一建出来就把它的置顶改写成普通窗口之下(-1),别盖住用户在用的 App(11-06 用户:「说好的 -1 层级呢」)
    await app.evaluate(({ app: a }) => {
      if (process.platform !== 'darwin') return
      a.on('browser-window-created', (_e, w) => {
        const orig = w.setAlwaysOnTop.bind(w)
        w.setAlwaysOnTop = (flag) => orig(flag, 'normal', -1)
        orig(true, 'normal', -1)
      })
    })
    await win.evaluate(() => window.tangu.openMini({ sessionId: 'droplet-a' }))
    let mini
    for (let i = 0; i < 200; i++) { mini = app.windows().find((w) => w.url().includes('window=mini')); if (mini) break; await pause(50) }
    if (!mini) throw new Error('Mini window missing')
    mini.on('pageerror', (e) => errors.push(`mini: ${e.message}`))
    await mini.waitForSelector('.mini-card-space', { timeout: 30000 }); await mini.waitForTimeout(800)
    if (process.platform === 'darwin') { const ls = layersOf(app.process().pid).filter(([, w]) => w > 100); check('台架窗(含 Mini)都压在普通窗口之下', ls.length >= 2 && ls.every(([l]) => l < 0), `[层级,宽] ${JSON.stringify(ls)}`) }
    if (NEG) await mini.addStyleTag({ content: NEG_CSS })
    const spaceEnabled = await mini.evaluate(() => !document.querySelector('.mini-card-space').disabled)
    const miniSrc = spaceEnabled ? '.mini-card-space' : '.mini-card-picker'
    verifyPour(await sample(mini, '.mini-card-popover', { act: miniSrc }), `Mini 下拉(${miniSrc})`)
    const mg = await mini.evaluate(() => { const c = document.querySelector('.mini-card-cap').getBoundingClientRect(), p = document.querySelector('.mini-card-popover').getBoundingClientRect(), z = (s) => +getComputedStyle(document.querySelector(s)).zIndex; return { gap: Math.round(p.top - c.bottom), chrome: z('.mini-card-chrome'), pop: z('.mini-card-popover'), bg: getComputedStyle(document.querySelector('.mini-card-popover')).backgroundColor } })
    check('Mini 下拉: 贴着胶囊(缝 ≤ 12px)', mg.gap >= 0 && mg.gap <= 12, JSON.stringify(mg))
    check('Mini 下拉: 胶囊层压在下拉 / 液体之上', mg.chrome > mg.pop, JSON.stringify(mg))
    check('Mini 下拉: 不透明卡面', /^rgb\(/.test(mg.bg), mg.bg)
    verifyRetract(await sample(mini, '.mini-card-popover', { act: miniSrc, ms: 600 }), 'Mini 下拉(再点按钮)')
    await sample(mini, '.mini-card-popover', { act: miniSrc, ms: 520 })
    verifyRetract(await sample(mini, '.mini-card-popover', { act: '.mini-card-dismiss', ms: 600 }), 'Mini 下拉(点遮罩)')
    await sample(mini, '.mini-card-popover', { act: miniSrc, ms: 520 })
    await mini.evaluate((s) => document.querySelector(s).click(), miniSrc); await midRetract(mini, '.mini-card-popover'); await mini.waitForTimeout(60)
    verifyRepour(await sample(mini, '.mini-card-popover', { act: miniSrc, ms: 700 }), 'Mini 下拉')
    await srcStillRaised(mini, miniSrc, 'Mini 下拉')
    await mini.keyboard.press('Escape'); await mini.waitForTimeout(600)
    const box = await mini.evaluate(() => { const r = document.querySelector('.mini-card-shell').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 300) } })
    for (const m of ['light', 'dark']) {
      await mini.evaluate((m) => { const r = document.documentElement; r.dataset.mode = m; r.classList.toggle('dark', m === 'dark') }, m); await waitNoDrop(mini); await mini.waitForTimeout(200)
      await armFreeze(mini, 140); await mini.evaluate((s) => document.querySelector(s).click(), miniSrc)
      await freezeShot(mini, `mini-pour-${m}.png`, box)
      await mini.waitForTimeout(500); await mini.screenshot({ path: path.join(OUT, `mini-open-${m}.png`), clip: box })
      await mini.keyboard.press('Escape'); await mini.waitForTimeout(600)
    }
    check('没有渲染层报错', errors.length === 0, JSON.stringify(errors))
    console.log(`SCREENSHOTS ${OUT}`)
  } finally { if (app) await app.close().catch(() => {}); await stub.close() }
  const pass = results.filter(Boolean).length
  console.log(`${pass}/${results.length} passed${NEG ? '(负对照:应有红)' : ''}`)
  if (results.some((ok) => !ok)) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
