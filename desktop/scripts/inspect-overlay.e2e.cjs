/**
 * 「检视台」插件的真 DOM 台架 —— 验的是 check.mjs(mock ctx)结构性看不见的那半。
 *
 * 插件有两档,形态相反,各有各的必守纪律:
 *   · 短按 F = HUD 档:铺满视口的一层**透明、鼠标穿透**画布,刀在右下、副手在左下,当前 Space
 *     照常用,耍完自动收刀。
 *     ⚠️这一层**绝不能** `-webkit-app-region: no-drag` —— 它盖在 Shell 的拖窗区上,写了等于把那块
 *       从拖窗区抠掉,用户从此拖不动窗口(与全屏面板的要求正好相反)。T3 就钉这条。
 *   · 长按 F = 面板档:全屏详情页,**必须** no-drag(否则与拖窗区重叠的部分点不动)。T6 钉这条。
 *
 * 头号防线仍是输入态守卫(T7/T8/T9):宿主的 installHotkeys 没有输入焦点闸,插件自挂 keydown
 * 的守卫一旦漏一条,用户在聊天框打个 "f" 就当场糊一层东西上来 —— 只有真键盘事件 + 真焦点验得出。
 *
 * 用法:node scripts/inspect-overlay.e2e.cjs [插件目录]
 *   HARNESS_URL 可指向已起的台架(缺省自己拉 vite frontend)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const DIR = process.argv[2] || path.resolve(__dirname, '../../../Forsion-Instrumentality-Project/forsion-plugin-inspect')
const MAIN = path.join(DIR, 'main.js')
const SHOT_DIR = process.env.INSPECT_SHOT_DIR || ''

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + String(detail).slice(0, 180) : ''}`)
}

const ping = () =>
  new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })

const MODEL = { id: 'claude-opus-5', name: 'Claude Opus 5' }
/** 台架的用量快照。面板上那三行(品质=思考档 / 最大上下文 / 本会话已用)全靠它。 */
const SESSION = { contextWindow: 200000, contextTokens: 12000, sessionTokens: 30500, effort: 'xhigh' }

async function main() {
  if (!fs.existsSync(MAIN)) { console.error(`找不到 ${MAIN} —— 先在插件目录跑 npm run build`); process.exit(1) }
  let vite = null
  if (!(await ping())) {
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 500)); up = await ping() }
    if (!up) { console.error('vite 没起来'); vite.kill(); process.exit(1) }
  }

  const code = fs.readFileSync(MAIN, 'utf8')
  const browser = await chromium.launch({ executablePath: findChromium() })
  const errors = []

  /** 每条用例开一张干净的页:插件在 window 上挂 keydown,复用同一页会叠好几份。 */
  const fresh = async (tangu = [MODEL, 'tangu', SESSION], src = code) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction('!!window.__ep')
    // 探针必须早于 loadPlugin —— ctx.tangu 的有无是在建 context 那一刻定的(同生产)。
    await page.evaluate(([m, s, sess]) => window.__ep.setTangu(m, s, sess), tangu)
    await page.evaluate((c) => window.__ep.loadPlugin(c, { id: 'inspect', name: '检视台' }), src)
    await page.waitForTimeout(120)
    return page
  }
  /** ⚠️台架起来时焦点在真编辑器(contenteditable)里 —— 不主动 blur 的话每条「按 F」用例
   *  都会被输入态守卫拦下,后面几条会以**假绿**通过。第一版就栽在这。 */
  const defocus = (page) => page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur() })
  const nHud = (page) => page.locator('.fi-hud').count()
  const nPanel = (page) => page.locator('.fi-root').count()
  const tapF = async (page) => { await page.keyboard.press('f'); await page.waitForTimeout(240) }
  /** 长按:按下 → 超过 420ms 门槛 → 松开。 */
  const holdF = async (page) => {
    await page.keyboard.down('f')
    await page.waitForTimeout(620)
    await page.keyboard.up('f')
    await page.waitForTimeout(240)
  }
  const appRegion = (loc) =>
    loc.evaluate((el) => getComputedStyle(el).webkitAppRegion || getComputedStyle(el).getPropertyValue('-webkit-app-region') || 'none')

  // ── HUD 档 ──────────────────────────────────────────────────────────────────
  {
    const page = await fresh()
    await defocus(page)
    await tapF(page)
    check('T1 短按 F → HUD 出现,且**不是**那个全屏面板(CS 是对战中检视,不另开界面)',
      (await nHud(page)) === 1 && (await nPanel(page)) === 0, `hud=${await nHud(page)} panel=${await nPanel(page)}`)

    const hud = page.locator('.fi-hud')
    check('T2 HUD 鼠标穿透(pointer-events: none)—— 耍刀时页面照常点得动',
      (await hud.evaluate((el) => getComputedStyle(el).pointerEvents)) === 'none')

    // ⚠️反向纪律:HUD 盖在 Shell 的拖窗区上,写 no-drag 会把那块从拖窗区抠掉。
    check('T3 HUD **没有** no-drag(写了会把拖窗区抠掉,用户拖不动窗口)',
      (await appRegion(hud)) !== 'no-drag', `computed=${await appRegion(hud)}`)

    // 铺满视口是**故意的**:CS 的构图是右手持刀在右下、左手在左下,画布只给右下一角的话
    // 左手会落在屏幕正中央凭空一只手。反正整层透明且穿透,铺满不占地方。
    const rect = await hud.boundingBox()
    const vp = page.viewportSize()
    check('T4 HUD 铺满视口(透明穿透层,左右两只手才落得下)',
      rect.x < 2 && rect.y < 2 && Math.abs(rect.width - vp.width) < 2 && Math.abs(rect.height - vp.height) < 2,
      JSON.stringify(rect))

    // 观感回归入口:按参考录像的四个动作节点留真截图。默认不写文件;需要时传 INSPECT_SHOT_DIR。
    // tapF 已等了约 .24s,所以下面的累计时点约为 deploy .59s / inspect .39s / 2.59s / 4.19s。
    if (SHOT_DIR) {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      await page.waitForTimeout(350)
      await page.screenshot({ path: path.join(SHOT_DIR, '01-deploy-flick.png') })
      await page.waitForTimeout(850)
      await page.screenshot({ path: path.join(SHOT_DIR, '02-inspect-upright.png') })
      await page.waitForTimeout(2200)
      await page.screenshot({ path: path.join(SHOT_DIR, '03-inspect-diagonal.png') })
      await page.waitForTimeout(1600)
      await page.screenshot({ path: path.join(SHOT_DIR, '04-inspect-return.png') })
      if (process.env.INSPECT_SHOT_ONLY === '1') {
        await page.close()
        await browser.close()
        if (vite) vite.kill()
        console.log(`\n动作证据帧已写入 ${SHOT_DIR}`)
        return
      }
    }

    // 耍完自动收刀:deploy 1.05 + flourish 5.15 + holster .26 ≈ 6.46s,给足余量
    await page.waitForTimeout(7500)
    check('T5 耍完自动收刀(HUD 不常驻,DOM 里也不留)', (await nHud(page)) === 0)
    await page.close()
  }

  // ── 面板档 ──────────────────────────────────────────────────────────────────
  {
    const page = await fresh()
    await defocus(page)
    await holdF(page)
    const panel = page.locator('.fi-root')
    const name = (await nPanel(page)) ? await page.locator('.fi-name').innerText() : ''
    check('T6 长按 F → 全屏详情面板,标题是当前模型名', (await nPanel(page)) === 1 && name === MODEL.name, `panel=${await nPanel(page)} name=${name}`)
    check('T7 面板根 **是** no-drag(与 HUD 相反:全屏浮层不抠就点不动)',
      (await nPanel(page)) === 1 && (await appRegion(panel)) === 'no-drag', `computed=${await appRegion(panel)}`)
    check('T8 面板是 body 的最后一个子节点(no-drag 差集只对 DOM 顺序晚于 Shell 的生效)',
      await page.evaluate(() => document.body.lastElementChild?.classList.contains('fi-root') === true))
    // 品质那一栏 = 当前思考档(用户 2026-08-29 拍板),不是哈希抽出来的稀有度。
    const stats = await page.locator('.fi-stats').innerText()
    check('T9 面板展示会话实况:品质=思考档 / 最大上下文 / 本会话已用 token',
      /xhigh/.test(stats) && /隐秘|Covert/.test(stats) && /200,000/.test(stats) && /30,500/.test(stats) && /12,000/.test(stats),
      JSON.stringify(stats))
    check('T10 磨损 / 花纹号 / StatTrak 已从面板撤走(换成了真有用的数)',
      !/磨损|EXTERIOR|StatTrak|PATTERN/.test(stats), JSON.stringify(stats))
    if (SHOT_DIR) {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      await page.waitForTimeout(500)
      await page.screenshot({ path: path.join(SHOT_DIR, '08-panel-session-stats.png') })
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    check('T11 Esc 关面板(退场动画跑完后真的从 DOM 摘掉)', (await nPanel(page)) === 0)
    await page.close()
  }

  // 旧宿主:ctx.tangu 在、但探针给不出用量(session 返回 null)。那三行必须**整段不画**,
  // 而不是显示 0 / NaN —— 面板本身照常开。
  {
    const page = await fresh([MODEL, 'tangu', undefined])
    await defocus(page)
    await holdF(page)
    const stats = await page.locator('.fi-stats').innerText()
    check('T12 旧宿主(拿不到用量)→ 面板照常开,只是不画那三行',
      (await nPanel(page)) === 1 && !/最大上下文|CONTEXT WINDOW/.test(stats) && /标识|MODEL ID/.test(stats),
      JSON.stringify(stats))
    await page.close()
  }

  // ── 输入态守卫(头号防线) ───────────────────────────────────────────────────
  {
    const page = await fresh()
    await page.evaluate(() => {
      const i = document.createElement('input')
      i.id = 'probe-input'
      document.body.appendChild(i)
      i.focus()
    })
    await page.keyboard.type('fofofo')
    await page.waitForTimeout(240)
    check('T13 焦点在 <input> 里打 f → 两档都不出现,字照常进输入框',
      (await nHud(page)) === 0 && (await nPanel(page)) === 0 && (await page.locator('#probe-input').inputValue()) === 'fofofo',
      `hud=${await nHud(page)} panel=${await nPanel(page)} value=${await page.locator('#probe-input').inputValue()}`)

    await page.evaluate(() => {
      document.getElementById('probe-input')?.remove()
      const d = document.createElement('div')
      d.id = 'probe-ce'
      d.contentEditable = 'true'
      document.body.appendChild(d)
      d.focus()
    })
    await tapF(page)
    check('T14 焦点在 contenteditable 里按 F → 不出现', (await nHud(page)) === 0 && (await nPanel(page)) === 0)
    await page.close()
  }

  {
    const page = await fresh()
    await defocus(page)
    // Playwright 的 keyboard.press 造不出 isComposing=true;直接派发一枚合成中的事件。
    // 中文输入法下用户敲 f 选字时,浏览器给的正是 isComposing=true / keyCode=229。
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, isComposing: true }))
    })
    await page.waitForTimeout(240)
    check('T15 输入法合成中(isComposing)按 f → 不出现', (await nHud(page)) === 0)
    await page.close()
  }

  // ── 门控 ────────────────────────────────────────────────────────────────────
  {
    const page = await fresh([MODEL, 'amadeus'])
    await defocus(page)
    await tapF(page)
    check('T16 不在 Tangu Space 时按 F → 不出现(缺省门控;设置里可放开)', (await nHud(page)) === 0)
    await page.close()
  }
  {
    const before = errors.length
    const page = await fresh([null, null])
    await defocus(page)
    await tapF(page)
    check('T17 宿主没有 ctx.tangu(纯 Amadeus 壳)→ 不出现、不抛',
      (await nHud(page)) === 0 && errors.length === before, errors.slice(before).join(' | '))
    await page.close()
  }

  // ── 设置绑定 + 蝴蝶刀链路 ────────────────────────────────────────────────
  {
    const page = await fresh()
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'inspect-settings-host'
      host.className = 'plugin-card'
      document.body.appendChild(host)
      const view = window.__ep.settingsViews().find((v) => v.id === 'model-knife-bindings')
      window.__inspectSettingsDispose = view?.mount(host)
    })
    await page.waitForTimeout(180)
    const row = page.locator('.fi-binding-row').first()
    check('T18 插件设置页列出现有模型,默认是普通刀 + 自动色',
      (await row.count()) === 1
        && (await row.locator('.fi-binding-type').inputValue()) === 'standard'
        && (await row.locator('.fi-binding-auto').getAttribute('class')).includes('is-on'))

    await row.locator('.fi-binding-type').selectOption('butterfly')
    await row.locator('.fi-binding-color-input').evaluate((el) => {
      el.value = '#e5484d'
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    check('T19 刀型和自定义颜色可以绑定,且自动色状态随之取消',
      (await row.locator('.fi-binding-type').inputValue()) === 'butterfly'
        && !(await row.locator('.fi-binding-auto').getAttribute('class')).includes('is-on'))

    // 「往哪儿放刀皮文件」这一行是随包技能的落地前提:技能里写的「设置页第一行就是绝对路径」
    // 一旦没画出来,agent 做好的 .skin.json 就没地方装。
    const folder = await page.locator('.fi-folder-text').innerText()
    check('T20 设置页画出工作文件夹与两列自制内容下拉(刀皮预设 / 检视动作)',
      /检视台/.test(folder) && (await row.locator('.fi-binding-preset').count()) === 1
        && (await row.locator('.fi-binding-motion').count()) === 1, JSON.stringify(folder))

    if (SHOT_DIR) {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      await page.locator('#inspect-settings-host').scrollIntoViewIfNeeded()
      await page.locator('#inspect-settings-host').screenshot({ path: path.join(SHOT_DIR, '05-settings-bindings.png') })
    }
    await page.evaluate(() => {
      window.__inspectSettingsDispose?.()
      document.getElementById('inspect-settings-host')?.remove()
    })
    await defocus(page)
    await tapF(page)
    check('T21 绑定一路接到渲染台:蝴蝶刀使用自己的切刀/检视轨',
      await page.locator('.fi-hud canvas').getAttribute('data-knife-type') === 'butterfly')
    if (SHOT_DIR) {
      await page.waitForTimeout(300)
      await page.screenshot({ path: path.join(SHOT_DIR, '06-butterfly-deploy.png') })
      await page.waitForTimeout(850)
      await page.screenshot({ path: path.join(SHOT_DIR, '07-butterfly-inspect.png') })
    }
    // 蝴蝶刀:deploy 1.18 + **单次** inspect 2.28 + holster .26 ≈ 3.72s。
    await page.waitForTimeout(3900)
    check('T22 蝴蝶刀检视只播一遍就收刀(没把视频后面的第二遍复制进来)', (await nHud(page)) === 0)
    await page.close()
  }

  // ── 自制内容全链路 + 冷启动竞速回归(2026-08-29 P1) ─────────────────────────
  // 这一段是唯一能照到「.skin.json / .motion.json 到底有没有生效」的仪器:check.mjs 只验解析器。
  // 台架自带内存 vault(harnessBridge 的 window.__vault)—— 往里塞文件 = 「库恢复了」;
  // 再补一个 localStorage 版的 readPluginData/writePluginData(**必须 addInitScript**:
  // harnessBridge 只是把自己 spread 在已有对象之上,晚一步就被覆盖),绑定才能活过 reload。
  const FAKE_ASSETS = {
    '检视台/frost.skin.json': JSON.stringify({ name: '霜刃', knife: 'butterfly', primary: '#5ec8ff', secondary: '#123a52' }),
    '检视台/spin.motion.json': JSON.stringify({
      name: '慢转一圈',
      hand: [
        { t: 0, p: [0.54, -0.40, -1.02], r: [0.16, -0.34, 1.02] },
        { t: 1.2, p: [0.34, -0.10, -0.95], r: [0.10, -0.20, 0.14] },
        { t: 2.4, p: [0.54, -0.40, -1.02], r: [0.16, -0.34, 1.02] },
      ],
      weapon: [
        { t: 0, p: [0, -0.25, 0], r: [0, 0, 0] },
        { t: 1.6, p: [0, -0.25, 0], r: [0, 6.283, 0] },
        { t: 2.4, p: [0, -0.25, 0], r: [0, 6.283, 0] },
      ],
    }),
  }
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.addInitScript(() => {
      window.amadeus = {
        readPluginData: async () => localStorage.getItem('__fakePluginData'),
        writePluginData: async (_id, text) => localStorage.setItem('__fakePluginData', text),
      }
    })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction('!!window.__ep')
    await page.evaluate(() => localStorage.removeItem('__fakePluginData'))
    /** 与生产同序:插件在启动期同步装载,那时**库还没恢复**(vault 恢复是懒的)。 */
    const boot = async () => {
      await page.evaluate(([m, sp, sess]) => window.__ep.setTangu(m, sp, sess), [MODEL, 'tangu', SESSION])
      await page.evaluate((c) => window.__ep.loadPlugin(c, { id: 'inspect', name: '检视台' }), code)
      await page.waitForTimeout(160)
    }
    /** …之后库才起来:文件进内存 vault,pageStore 的 vaultRoot 也随之落地。 */
    const vaultUp = (files) => page.evaluate((f) => {
      for (const [k, v] of Object.entries(f)) window.__vault.set(k, v)
      window.__pageStore.setState({ vaultRoot: '/fake/vault' })
    }, files)

    await boot()
    await vaultUp(FAKE_ASSETS)

    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'inspect-settings-host'
      document.body.appendChild(host)
      window.__inspectSettingsDispose = window.__ep.settingsViews().find((v) => v.id === 'model-knife-bindings')?.mount(host)
    })
    await page.waitForTimeout(300)
    const row2 = page.locator('.fi-binding-row').first()
    const presetOpts = await row2.locator('.fi-binding-preset option').allInnerTexts()
    const motionOpts = await row2.locator('.fi-binding-motion option').allInnerTexts()
    check('T24 库里的 .skin.json / .motion.json 进了设置页下拉(按文件里的 name 显示)',
      presetOpts.some((o) => o.includes('霜刃')) && motionOpts.some((o) => o.includes('慢转一圈')),
      JSON.stringify([presetOpts, motionOpts]))

    await row2.locator('.fi-binding-preset').selectOption('检视台/frost.skin.json')
    await row2.locator('.fi-binding-motion').selectOption('检视台/spin.motion.json')
    await page.waitForTimeout(150)
    check('T25 选了刀皮预设 → 同一行的刀型/颜色控件置灰(那两项此刻由文件说了算)',
      (await row2.locator('.fi-binding-type').isDisabled()) && (await row2.locator('.fi-binding-color-input').isDisabled()))
    await page.evaluate(() => {
      window.__inspectSettingsDispose?.()
      document.getElementById('inspect-settings-host')?.remove()
    })

    const knifeOf = () => page.locator('.fi-hud canvas').getAttribute('data-knife-type')
    const motionOf = () => page.locator('.fi-hud canvas').getAttribute('data-motion')
    await defocus(page)
    await tapF(page)
    check('T26 预设决定刀型、动作接到渲染台(自制内容真的生效了)',
      (await knifeOf()) === 'butterfly' && (await motionOf()) === 'custom',
      `knife=${await knifeOf()} motion=${await motionOf()}`)

    // ⚠️冷启动竞速回归(这一轮的头号 P1):插件装载那一刻库还没恢复 → listFiles 给空数组,
    //   且**连一条 problems 都不产生**(静默)。修复前短按 F 这条路永不重读,整个会话都用内置刀 +
    //   内置动作,只有长按开面板或打开设置页才会碰巧自愈。同型事故 08-28 在青鸟收藏夹上真发生过。
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction('!!window.__ep')
    check('T27 重开后内存 vault 是空的(证明下一条不是"本来就读到了")',
      (await page.evaluate(() => window.__vault.size)) === 0)
    await boot()                 // 绑定从 localStorage 读回来;此刻库仍未恢复
    await vaultUp(FAKE_ASSETS)   // 库这才起来 —— 全程没有打开过设置页/面板
    await defocus(page)
    await tapF(page)
    check('T28 冷启动(装载时无库)之后库恢复 → 第一次短按 F 就用上绑定的刀皮与动作',
      (await knifeOf()) === 'butterfly' && (await motionOf()) === 'custom',
      `knife=${await knifeOf()} motion=${await motionOf()}`)
    await page.close()
  }

  // ── 负对照:守卫真的有牙 ────────────────────────────────────────────────────
  // 把产物里的输入态守卫拆掉(isEditing 恒 false),T13 那条必须当场变红。
  // 没有这一条,T13 只能证明「现在没弹」,证明不了「是守卫拦住的」。
  {
    const broken = code.replace(/\.isComposing/g, '.NOPE_isComposing')
      .replace(/"INPUT"|'INPUT'/g, '"__NOPE__"')
      .replace(/"TEXTAREA"|'TEXTAREA'/g, '"__NOPE2__"')
      .replace(/\.isContentEditable/g, '.NOPE_isContentEditable')
    const page = await fresh([MODEL, 'tangu'], broken)
    await page.evaluate(() => {
      const i = document.createElement('input')
      i.id = 'probe-input'
      document.body.appendChild(i)
      i.focus()
    })
    await page.keyboard.type('f')
    await page.waitForTimeout(240)
    check('T29 负对照:拆掉输入态守卫后,在输入框打 f 必须弹出来(证明 T13/T14 不是恒绿)',
      (await page.locator('.fi-hud').count()) === 1)
    await page.close()
  }

  await browser.close()
  if (vite) vite.kill()

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  if (errors.length) console.log('页面异常:\n  ' + errors.slice(0, 5).join('\n  '))
  if (bad.length) console.log('未通过:' + bad.map((r) => r.name).join(' / '))
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
