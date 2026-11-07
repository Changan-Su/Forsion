/** 动效主题 × 按钮长出的面板(动效第三轮,2026-11-06;DESIGN §3「动效主题」):真 Electron(out/ 构建)里,
 *  Space 悬停预览、头像账号卡、Mini 胶囊下拉、Ribbon「+N」都要按 <html data-motion-theme> 走 openPanel ——
 *  #477 那三处原来直接调 emergeDroplet,拉伸 / 平移主题下照样流液滴(Ribbon.tsx 合并后还丢了导入,一悬停就渲染崩溃)。
 *  逐帧采样:
 *   · 拉伸:出现 .lcl-stretch、从不出现 .lcl-droplet,停稳后真面板接手(没有 pouring、底层藏起);
 *     悬停预览的底层颜色 = 卡的 ::before 材质(不传 color 就是透明,形状看不见);
 *     预览开着换图标不重播;账号卡开着变高,倒放按现在的矩形(底层与面板偏差 ≤ 2px);
 *   · 平移:两种层都不出现,面板上有透明度 + 缩放动画;
 *   · 两种主题下开到 60ms 就收:内容只淡不先蹦出来。
 *   · 收起途中再点源 = 从这一帧掉头、停在打开,不撤掉从头重来(拉伸 / 平移 / 只淡入淡出;11-06 用户选的观感);
 *     拉伸接手后描边从透明淡进来(同液滴)。
 *  负对照:拿只补了导入、没改走 openPanel 的构建跑,拉伸 / 平移两条必须报红。
 *  用法:npm run build && node scripts/panel-themes.e2e.cjs   截图 → outputs/panel-themes/ */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'outputs', 'panel-themes')
fs.mkdirSync(OUT, { recursive: true })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-panel-themes-'))
const results = []
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ' ' + String(detail).slice(0, 300)}`) }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页内逐帧记:哪种层在、面板状态、底层与面板的偏差、面板上的动画属性。act:先点哪个;close:t 毫秒后做什么。 */
const sample = (page, sel, { act = null, ms = 650, close = null, t = 0 } = {}) => page.evaluate(async ({ sel, act, ms, close, t }) => {
  const raf = () => new Promise(requestAnimationFrame)
  if (act) document.querySelector(act)?.click()
  const w0 = performance.now()
  while (!document.querySelector(sel) && performance.now() - w0 < 1500) await raf()
  const t0 = performance.now(), frames = []
  let closed = false
  while (performance.now() - t0 < ms) {
    if (close && !closed && performance.now() - t0 >= t) {
      closed = true
      if (close.startsWith('key:')) window.dispatchEvent(new KeyboardEvent('keydown', { key: close.slice(4), bubbles: true }))
      else document.querySelector(close)?.click()
      frames.push({ mark: 'close' })
    }
    await raf()
    const p = document.querySelector(sel), st = document.querySelector('.lcl-stretch'), dr = document.querySelector('.lcl-droplet')
    const f = { t: Math.round(performance.now() - t0), exists: !!p, stretch: !!st && getComputedStyle(st).display !== 'none', droplet: !!dr && getComputedStyle(dr).display !== 'none' }
    if (p) {
      const cs = getComputedStyle(p)
      f.pouring = p.classList.contains('lcl-droplet-pouring'); f.vis = cs.visibility; f.bc = cs.borderTopColor
      // 内容实际透明度:平移主题动的是面板本身;收完到卸载之间面板 visibility: hidden(那一帧透明度已回 1),算 0
      f.kids = cs.visibility === 'hidden' ? 0 : +cs.opacity * Math.min(1, ...[...p.children].map((k) => +getComputedStyle(k).opacity))
      f.props = [...new Set(p.getAnimations().flatMap((a) => a.effect?.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !['offset', 'easing', 'composite', 'computedOffset'].includes(x))) ?? []))].sort().join(',')
      f.mark = p.dataset.probe ?? null
      const body = st?.querySelector('i')
      if (body && f.stretch) {
        const a = body.getBoundingClientRect(), b = p.getBoundingClientRect()
        f.geo = Math.round(Math.max(Math.abs(a.left - b.left), Math.abs(a.top - b.top), Math.abs(a.width - b.width), Math.abs(a.height - b.height)))
        f.fill = getComputedStyle(body).backgroundColor
      }
    }
    frames.push(f)
  }
  return frames
}, { sel, act, ms, close, t })
const waitGone = (page, sel) => page.waitForFunction((sel) => !document.querySelector(sel) && !document.querySelector('.lcl-droplet, .lcl-stretch, .lcl-droplet-pouring'), sel, { timeout: 3000 }).catch(() => {})

function verifyStretch(frames, name) {
  const F = frames.filter((f) => f.exists)
  check(`${name}: 拉伸主题出 .lcl-stretch、不出液滴`, F.some((f) => f.stretch) && !F.some((f) => f.droplet), JSON.stringify(F.slice(0, 3)))
  const end = F.at(-1)
  check(`${name}: 拉伸停稳后真面板接手`, !!end && !end.pouring && !end.stretch && end.kids === 1 && end.vis !== 'hidden', JSON.stringify(end))
  // 接手那一帧描边不整条一帧出现:从透明淡进来(同液滴,11-06 用户选的观感)
  const li = F.findIndex((f) => !f.pouring && f.t > 50)
  if (end?.bc && !/rgba\(0, 0, 0, 0\)|transparent/.test(end.bc)) check(`${name}: 拉伸接手后描边从透明淡进来`, li > 0 && F[li].bc !== end.bc, JSON.stringify({ land: F[li]?.bc, end: end.bc }))
}
/** 面板此刻看得见多少(0–100):clip-path 露出的面积 × 透明度;inset 按 1–4 个值展开(Chrome 按 margin 简写序列化)。 */
const READ_VIS = `(sel) => {
  const p = document.querySelector(sel); if (!p) return { exists: false, vis: 0 }
  const cs = getComputedStyle(p)
  if (cs.visibility === 'hidden') return { exists: true, vis: 0 }
  const iv = /inset\\(([^)]*)\\)/.exec(cs.clipPath)?.[1].split(' round ')[0].trim().split(/\\s+/).map(parseFloat)
  let area = 100
  if (iv) { const [t, r = t, b = t, l = r] = iv, W = p.offsetWidth, H = p.offsetHeight; area = 100 * Math.max(0, W - r - l) * Math.max(0, H - t - b) / (W * H) }
  return { exists: true, vis: Math.round(area * +cs.opacity), pouring: p.classList.contains('lcl-droplet-pouring'), kids: Math.min(1, ...[...p.children].map((k) => +getComputedStyle(k).opacity)) }
}`
/** 收起途中再点源(11-06 用户选的「掉头」):页内一气做完 —— 点开、停稳、点源收、等 wait 毫秒、再点源,逐帧记看得见多少。 */
const turnAround = (page, sel, src, wait) => page.evaluate(async ({ sel, src, wait, READ_VIS }) => {
  const raf = () => new Promise(requestAnimationFrame), read = (0, eval)(READ_VIS), click = () => document.querySelector(src)?.click()
  click()
  let t0 = performance.now(); while (performance.now() - t0 < 700) await raf()
  click()
  t0 = performance.now(); while (performance.now() - t0 < wait) await raf()
  const at = read(sel)
  click()
  const frames = []
  t0 = performance.now(); while (performance.now() - t0 < 700) { await raf(); frames.push(read(sel)) }
  return { at, frames }
}, { sel, src, wait, READ_VIS })
/** 掉头 = 再触发之后看得见的部分不塌回去(重来的话拉伸只剩一条缝、平移 / 淡入淡出透明度回到 0),最后停在打开。
 *  「当时正在收」:拉伸倒放挂着 pouring(前 80ms 形状几乎没缩,面积还在 99% 左右);平移 / 淡出看透明度已经降了。 */
function verifyTurn(r, name) {
  const lo = Math.min(...r.frames.slice(0, 6).map((f) => f.vis)), end = r.frames.at(-1)
  const closing = r.at.exists && (r.at.pouring || r.at.vis < 99) && r.at.vis > 30
  check(`${name}: 收起途中再点 = 从这一帧掉头(不塌回去重来)`, closing && lo >= Math.max(25, r.at.vis * 0.6), JSON.stringify({ at: r.at, first: r.frames.slice(0, 6).map((f) => f.vis) }))
  check(`${name}: 掉头后停在打开`, end.exists && end.vis >= 99 && !end.pouring && end.kids === 1, JSON.stringify(end))
}
function verifyGlide(frames, name) {
  const F = frames.filter((f) => f.exists)
  check(`${name}: 平移主题不出液滴 / 拉伸层`, F.length > 3 && !F.some((f) => f.stretch || f.droplet || f.pouring), JSON.stringify(F.find((f) => f.stretch || f.droplet || f.pouring)))
  check(`${name}: 平移主题面板淡入 + 微缩`, F.some((f) => /opacity/.test(f.props) && /scale/.test(f.props)), JSON.stringify(F.slice(0, 2).map((f) => f.props)))
}
/** 还没长满就变高、又马上收:重建要从同一个进度接着(不先跳成长满、内容不蹦到 1)。 */
const growThenClose = (page, sel, open) => page.evaluate(async ({ sel, open }) => {
  const raf = () => new Promise(requestAnimationFrame)
  const read = () => {
    const p = document.querySelector(sel); if (!p) return null
    const cs = getComputedStyle(p)
    // inset() 按 margin 简写序列化:左右相等时只写三个值,所以按 1–4 个值展开,别只认四个值的写法
    const iv = /inset\(([^)]*)\)/.exec(cs.clipPath)?.[1].split(' round ')[0].trim().split(/\s+/).map(parseFloat)
    const m = iv && [null, iv[0], iv[1] ?? iv[0], iv[2] ?? iv[0], iv[3] ?? iv[1] ?? iv[0]], W = p.offsetWidth, H = p.offsetHeight
    return { kids: cs.visibility === 'hidden' ? 0 : +cs.opacity * Math.min(1, ...[...p.children].map((k) => +getComputedStyle(k).opacity)), area: m ? Math.round(100 * Math.max(0, W - +m[2] - +m[4]) * Math.max(0, H - +m[1] - +m[3]) / (W * H)) : (cs.visibility === 'hidden' ? 0 : 100) }
  }
  document.querySelector(open)?.click()
  const w0 = performance.now(); while (!document.querySelector(sel) && performance.now() - w0 < 1500) await raf()
  const t0 = performance.now(); let grown = false
  while (performance.now() - t0 < 110) { await raf(); if (!grown && performance.now() - t0 >= 60) { const x = document.createElement('div'); x.style.height = '60px'; document.querySelector(sel).appendChild(x); grown = true } }
  const seq = [read()]
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const t1 = performance.now()
  while (performance.now() - t1 < 600) { await raf(); const r = read(); if (!r) break; seq.push(r) }
  return { seq: seq.slice(0, 6), gone: !document.querySelector(sel) }
}, { sel, open })
function verifyGrowClose(r, name) {
  let rise = 0, jump = 0
  for (let i = 1; i < r.seq.length; i++) { rise = Math.max(rise, r.seq[i].kids - r.seq[i - 1].kids); jump = Math.max(jump, r.seq[i].area - r.seq[i - 1].area) }
  check(`${name}: 没长满就变高又收,内容不先蹦出来、形状不先跳成长满`, rise <= 0.05 && jump <= 8 && r.gone, JSON.stringify(r))
}
function verifyEarly(frames, name) {
  const i = frames.findIndex((f) => f.mark === 'close')
  const seq = [frames.slice(0, i).filter((f) => f.exists).at(-1), ...frames.slice(i + 1).filter((f) => f.exists)].filter(Boolean).map((f) => f.kids)
  let rise = 0
  for (let k = 1; k < seq.length; k++) rise = Math.max(rise, seq[k] - seq[k - 1])
  check(`${name}: 开到 60ms 就收,内容只淡不先蹦出来(升 ≤ 0.05)`, seq.length > 1 && rise <= 0.05 && !frames.at(-1).exists, JSON.stringify(seq.slice(0, 6)))
}

async function main() {
  const userData = path.join(temp, 'userdata')
  const session = (id) => ({ id, title: id, created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z', agent_config: { execMode: 'host' } })
  const stub = await startStubEngine({ sessions: [session('pt-a'), session('pt-b')] })
  fs.mkdirSync(userData + '-dev', { recursive: true })
  fs.writeFileSync(path.join(userData + '-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'pt-token' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: temp, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1', PI_CU_SOCKET_PATH: path.join(temp, 'bridge.sock') } })
    // 台架窗(含之后开的 Mini)一律压在普通窗口之下(-1),不盖住用户在用的 App
    await app.evaluate(({ app: a }) => {
      if (process.platform !== 'darwin') return
      a.on('browser-window-created', (_e, w) => { const orig = w.setAlwaysOnTop.bind(w); w.setAlwaysOnTop = (flag) => orig(flag, 'normal', -1); orig(true, 'normal', -1) })
    })
    const win = await app.firstWindow(), errors = []
    win.on('pageerror', (e) => errors.push(`main: ${e.message}`))
    win.on('console', (m) => { if (m.type() === 'error' && /render crash|is not defined/.test(m.text())) errors.push(`main: ${m.text().slice(0, 160)}`) })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1512, 950))
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' })
    check('主窗口跳过引导', await skipOnboarding(win))
    await win.waitForSelector('.rb [data-space-id]', { timeout: 30000 })
    await win.waitForTimeout(800)
    const setTheme = (p, th) => p.evaluate((th) => { document.documentElement.dataset.motionTheme = th }, th)
    const away = () => win.mouse.move(1100, 600)
    const center = (sel) => win.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }, sel)
    const ids = await win.evaluate(() => { const cur = document.querySelector('.rb .rb-space.on')?.dataset.spaceId; return [...document.querySelectorAll('.rb .rb-strip-in [data-space-id]')].map((b) => b.dataset.spaceId).filter((id, i, a) => id !== cur && a.indexOf(id) === i) })
    const iconA = `.rb .rb-strip-in [data-space-id="${ids[0]}"]`, iconB = `.rb .rb-strip-in [data-space-id="${ids[1]}"]`
    const hover = async (sel) => { await away(); await waitGone(win, '.rb-peek'); await win.waitForTimeout(250); const c = await center(sel); await win.mouse.move(c.x, c.y, { steps: 3 }) }
    const avatar = '.ribbon-account, .account-card', more = '.rb-bottom .rb-more'

    for (const theme of ['stretch', 'glide']) {
      await setTheme(win, theme)
      const verify = theme === 'stretch' ? verifyStretch : verifyGlide
      // 悬停预览
      await hover(iconA)
      const pk = await sample(win, '.rb-peek')
      verify(pk, `悬停预览(${theme})`)
      if (theme === 'stretch') {
        const fills = pk.filter((f) => f.fill).map((f) => f.fill)
        check('悬停预览(stretch): 底层颜色 = 卡的 ::before 材质(不是透明)', fills.length > 0 && fills.every((c) => !/rgba\(0, 0, 0, 0\)|transparent/.test(c)), JSON.stringify(fills.slice(0, 2)))
        await win.evaluate(() => { document.querySelector('.rb-peek').dataset.probe = 'same' })
        const b = await center(iconB); await win.mouse.move(b.x, b.y, { steps: 3 })
        const sw = await sample(win, '.rb-peek', { ms: 300 })
        check('悬停预览(stretch): 换图标不重挂、不重播', sw.every((f) => f.exists && f.mark === 'same' && !f.stretch && !f.pouring), JSON.stringify(sw.find((f) => f.stretch || f.mark !== 'same')))
      }
      await win.keyboard.press('Escape'); await waitGone(win, '.rb-peek')
      await hover(iconA)
      verifyEarly(await sample(win, '.rb-peek', { close: 'key:Escape', t: 60, ms: 600 }), `悬停预览(${theme})`)
      await away(); await waitGone(win, '.rb-peek')
      // 账号卡
      verify(await sample(win, '.account-pop', { act: avatar }), `账号卡(${theme})`)
      if (theme === 'stretch') {
        // 开着时卡片变高(额度展开 / 账号列表异步长出):倒放要按现在的矩形,不能跳回展开时那块
        await win.evaluate(() => { const x = document.createElement('div'); x.style.height = '80px'; document.querySelector('.account-pop').appendChild(x) })
        await win.waitForTimeout(150)
        const grown = await sample(win, '.account-pop', { act: avatar, ms: 600 })
        const gl = grown.filter((f) => f.exists && f.stretch)
        check('账号卡(stretch): 开着变高,倒放按现在的矩形(偏差 ≤ 2px)', gl.length >= 3 && gl.every((f) => f.geo !== undefined && f.geo <= 2), JSON.stringify(gl.map((f) => f.geo)))
        check('账号卡(stretch): 变高后照样收完卸载', !grown.at(-1).exists)
        await waitGone(win, '.account-pop'); await win.waitForTimeout(150)
        verifyGrowClose(await growThenClose(win, '.account-pop', avatar), '账号卡(stretch)')
      } else { await win.keyboard.press('Escape') }
      await waitGone(win, '.account-pop'); await win.waitForTimeout(150)
      verifyEarly(await sample(win, '.account-pop', { act: avatar, close: avatar, t: 60, ms: 600 }), `账号卡(${theme})`)
      await waitGone(win, '.account-pop'); await win.waitForTimeout(150)
      // Ribbon「+N」(本来就走 openPanel,一起钉住)
      verify(await sample(win, '.rb-more-fly', { act: more }), `Ribbon「+N」(${theme})`)
      await win.keyboard.press('Escape'); await waitGone(win, '.rb-more-fly'); await win.waitForTimeout(150)
      verifyEarly(await sample(win, '.rb-more-fly', { act: more, close: more, t: 60, ms: 600 }), `Ribbon「+N」(${theme})`)
      await waitGone(win, '.rb-more-fly')
      // 截图:拉伸 / 平移各冻一帧(180ms)
      await win.evaluate(() => { window.__fz = false; const mo = new MutationObserver(() => { const p = document.querySelector('.account-pop'); if (!p || !p.getAnimations().length && !document.querySelector('.lcl-stretch')) return; mo.disconnect(); document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 180 }); window.__fz = true }); mo.observe(document.body, { childList: true, subtree: true }) })
      await win.evaluate((s) => document.querySelector(s).click(), avatar)
      await win.waitForFunction(() => window.__fz, null, { timeout: 3000 }).catch(() => {})
      await win.waitForTimeout(60)
      const vh = await win.evaluate(() => innerHeight)
      await win.screenshot({ path: path.join(OUT, `account-${theme}-180ms.png`), clip: { x: 0, y: vh - 380, width: 360, height: 380 } })
      await win.evaluate(() => document.getAnimations().forEach((a) => a.play()))
      await win.waitForTimeout(500); await win.keyboard.press('Escape'); await waitGone(win, '.account-pop')
      // 收起途中再点:拉伸倒放 266ms 里第 80ms、平移退场 80ms(先慢后快)里第 25ms 再点
      const w = theme === 'stretch' ? 80 : 25
      await win.waitForTimeout(150); verifyTurn(await turnAround(win, '.account-pop', avatar, w), `账号卡(${theme})`)
      await win.keyboard.press('Escape'); await waitGone(win, '.account-pop'); await win.waitForTimeout(150)
      verifyTurn(await turnAround(win, '.rb-more-fly', more, w), `Ribbon「+N」(${theme})`)
      await win.keyboard.press('Escape'); await waitGone(win, '.rb-more-fly'); await win.waitForTimeout(150)
      if (theme === 'stretch') {
        // 悬停预览:Esc 收到一半又回到图标。页内发事件(Ribbon 用 onMouseOver 认图标),省掉 Playwright 鼠标的几十毫秒:
        // 先在条上非图标处 mouseover 一次,清掉「指针停着的 Space」,回到图标才算重新进来
        await hover(iconA); await win.waitForSelector('.rb-peek'); await win.waitForTimeout(700)
        const r = await win.evaluate(async ({ R, icon }) => {
          const raf = () => new Promise(requestAnimationFrame), read = (0, eval)(R), over = (el) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
          over(document.querySelector('.rb'))
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          let t0 = performance.now(); while (performance.now() - t0 < 80) await raf()
          const at = read('.rb-peek')
          over(document.querySelector(icon))
          const frames = []
          t0 = performance.now(); while (performance.now() - t0 < 700) { await raf(); frames.push(read('.rb-peek')) }
          return { at, frames }
        }, { R: READ_VIS, icon: iconA })
        verifyTurn(r, '悬停预览(stretch)')
        await away(); await win.keyboard.press('Escape'); await waitGone(win, '.rb-peek'); await win.waitForTimeout(150)
      }
    }
    // 只淡入淡出(减少动态效果那支):Genesis 主题走 droplet.ts 的淡入淡出、拉伸主题走 panelMotion 的 fadeOnly
    for (const theme of ['genesis', 'stretch']) {
      await win.evaluate((th) => { const r = document.documentElement; r.dataset.motionTheme = th; r.dataset.motionFade = 'on' }, theme)
      verifyTurn(await turnAround(win, '.account-pop', avatar, 10), `账号卡(只淡入淡出 · ${theme})`) // 淡出 80ms 先快后慢:一帧之后就再点
      await win.keyboard.press('Escape'); await waitGone(win, '.account-pop'); await win.waitForTimeout(150)
    }
    await win.evaluate(() => { delete document.documentElement.dataset.motionFade })

    // Mini 胶囊下拉
    await win.evaluate(() => window.tangu.openMini({ sessionId: 'pt-a' }))
    let mini
    for (let i = 0; i < 200; i++) { mini = app.windows().find((w) => w.url().includes('window=mini')); if (mini) break; await pause(50) }
    if (!mini) throw new Error('Mini window missing')
    mini.on('pageerror', (e) => errors.push(`mini: ${e.message}`))
    await mini.waitForSelector('.mini-card-space', { timeout: 30000 }); await mini.waitForTimeout(800)
    const miniSrc = (await mini.evaluate(() => !document.querySelector('.mini-card-space').disabled)) ? '.mini-card-space' : '.mini-card-picker'
    for (const theme of ['stretch', 'glide']) {
      await setTheme(mini, theme)
      ;(theme === 'stretch' ? verifyStretch : verifyGlide)(await sample(mini, '.mini-card-popover', { act: miniSrc }), `Mini 下拉(${theme})`)
      await mini.keyboard.press('Escape'); await waitGone(mini, '.mini-card-popover'); await mini.waitForTimeout(150)
      verifyEarly(await sample(mini, '.mini-card-popover', { act: miniSrc, close: miniSrc, t: 60, ms: 600 }), `Mini 下拉(${theme})`)
      await waitGone(mini, '.mini-card-popover'); await mini.waitForTimeout(150)
      verifyTurn(await turnAround(mini, '.mini-card-popover', miniSrc, theme === 'stretch' ? 80 : 25), `Mini 下拉(${theme})`)
      await mini.keyboard.press('Escape'); await waitGone(mini, '.mini-card-popover'); await mini.waitForTimeout(150)
    }
    check('没有渲染层报错(含悬停预览的 ReferenceError)', errors.length === 0, JSON.stringify(errors))
    console.log(`SCREENSHOTS ${OUT}`)
  } finally { if (app) await app.close().catch(() => {}); await stub.close() }
  const pass = results.filter(Boolean).length
  console.log(`${pass}/${results.length} passed`)
  if (results.some((ok) => !ok)) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
