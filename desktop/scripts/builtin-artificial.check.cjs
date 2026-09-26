/**
 * 「造物 = 可拆卸的内置插件」的端到端契约(真 Electron)。
 *
 * Creations Space + `artificial`(栅格)/ `product`(单个作品)两个视图归内置插件 builtins/artificial,
 * 设置 → Forsion 插件 里可关。关掉必须**整条不见**(ribbon 图标、Space、视图),开回来必须原样回来。
 *
 * 判据:
 *   1 默认开:ribbon 有造物图标,点进去主区是造物栅格
 *   2 托管根里的项目会成为一件作品:卡片在场、id 是 `p_<12hex>`、名字 = 文件夹名、落在「网页应用」组
 *   3 点「打开」开出 product 视图,guest 的源是令牌根 `http://<32hex>.localhost:<port>/`
 *     —— 作品跑在**不可猜的真 http 源**上,不是 file://(fetch 在不透明源里一律被拦)
 *   4 关掉:ribbon 图标没了、栅格不再可见、活动 Space 已切走
 *   5 开回来:图标回来,还能再进去
 *   6 全程无渲染层异常
 *   7 **重启后同源**:整个 App 关掉再开,同一件作品的 guest 地址(token + 端口)一字不差,且它写进 localStorage 的值还在
 *      —— 稳定源这件事的全部意义(以前每次启动换源 = 作品的本地数据每次重启清零)。单测只证了模块,这条证整条链。
 * 截图:`SHOT_DIR=<目录> npm run check:artificial` 额外落真实截图(栅格 / 作品视图 / 暗色英文栅格),DESIGN.md §8 的自查用。
 *
 * ⚠️**本脚本额外覆写了 `HOME`**(其它 check 脚本只覆写 TANGU_HOME):产物的托管根是
 * `defaultWorkspaceDir()/Project` = `<home>/Forsion-Dev/Project`(dev 态,main.ts 的 setDevMode),
 * 而 node 的 os.homedir() 在 POSIX 上认 `$HOME` —— 这是让夹具项目进到托管根、同时不碰用户
 * 真实 ~/Forsion-Dev 的唯一办法。Windows 上 homedir() 不认 $HOME(认 USERPROFILE),
 * 届时这条得改成覆写 USERPROFILE。
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 跑:npm run check:artificial
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先把它关掉(同 check:homepage)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-artificial-'))
const UD = path.join(home, 'userdata') // 同一份 user-data-dir = 同一份 localStorage(开关要跨断言存活)
const PROJECTS = path.join(home, 'Forsion-Dev', 'Project') // = defaultWorkspaceDir()/Project(dev)
const FIXTURE_NAME = 'Pocket timer'
const FIXTURE = path.join(PROJECTS, FIXTURE_NAME)
const SPACE_NAMES = ['造物', 'Creations']

fs.mkdirSync(FIXTURE, { recursive: true })
fs.writeFileSync(path.join(FIXTURE, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>${FIXTURE_NAME}</title></head>
<body><h1 id="headline">Pocket timer</h1><p>Creations fixture.</p></body></html>`)

// 再放两件夹具让栅格像个样子(也顺带覆盖「已发布」角标与插件分组):一个发布过的网页、一个插件项目。
const SHIPPED = path.join(PROJECTS, 'Reading log')
fs.mkdirSync(SHIPPED, { recursive: true })
fs.writeFileSync(path.join(SHIPPED, 'index.html'), '<!doctype html><meta charset="UTF-8"><title>Reading log</title><h1>Reading log</h1>')
fs.writeFileSync(path.join(SHIPPED, '.forsion-connect.json'), JSON.stringify({ slug: 'reading-log' }))
const PLUGIN = path.join(PROJECTS, 'word-counter-plugin')
fs.mkdirSync(PLUGIN, { recursive: true })
fs.writeFileSync(path.join(PLUGIN, 'manifest.json'), JSON.stringify({ id: 'word-counter', name: 'Word counter', version: '0.1.0', apiVersion: 1, main: 'main.js' }))
fs.writeFileSync(path.join(PLUGIN, 'main.js'), 'return () => {}\n')

const SHOT_DIR = process.env.SHOT_DIR ? path.resolve(process.env.SHOT_DIR) : null
/** 真实截图走原生合成器(CDP 截图在 Retina 上会把 webview 表面画偏,同 coding-studio.e2e 的 shoot)。 */
async function shoot(app, win, name) {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await win.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await win.waitForTimeout(350)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  fs.writeFileSync(path.join(SHOT_DIR, `creations-${name}.png`), Buffer.from(png, 'base64'))
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** ribbon 上**全部** Space 名 = 上区条上的 + 「…」溢出浮层里的 + 主位槽里的那一个(同 check:homepage)。 */
async function ribbonSpaces(win) {
  const read = (root) => `[...document.querySelectorAll('${root} .rb-space')].map((b) => b.getAttribute('aria-label') || b.getAttribute('title') || b.querySelector('.rb-label')?.textContent || '')`
  const bar = await win.evaluate(read('.rb-top'))
  const slot = await win.evaluate(read('.rb-home'))
  const more = win.locator('.rb-top .rb-more').first()
  if (!(await more.count().catch(() => 0))) return [...bar, ...slot]
  await more.hover()
  await win.waitForTimeout(500)
  const hidden = await win.evaluate(read('.rb-fly'))
  await win.mouse.move(700, 700) // 移开,否则浮层挡住后续点击
  await win.waitForTimeout(400)
  return [...bar, ...slot, ...hidden]
}

/** 点 ribbon 上某个 Space(条上 / 主位槽 / 「…」三处都找)。 */
async function enterSpace(win, names) {
  const click = (root) => `(() => {
    const b = [...document.querySelectorAll('${root} .rb-space')].find((x) =>
      ${JSON.stringify(names)}.includes(x.getAttribute('aria-label') || x.getAttribute('title') || x.querySelector('.rb-label')?.textContent || ''))
    if (b) { b.click(); return true }
    return false
  })()`
  let hit = await win.evaluate(click('.rb-top')) || await win.evaluate(click('.rb-home'))
  if (!hit) {
    const more = win.locator('.rb-top .rb-more').first()
    if (await more.count().catch(() => 0)) {
      await more.hover()
      await win.waitForTimeout(500)
      hit = await win.evaluate(click('.rb-fly'))
    }
  }
  await win.waitForTimeout(1800) // lazy 分块 + productsList 一个来回
  return hit
}

/** 开/关内置插件:与设置页勾选框、跨窗同步同一条路径(builtins/index 的 storage 监听 → applyBuiltin)。 */
const toggle = (on) => `(() => {
  localStorage.setItem('builtin.artificial.enabled', ${on ? "'1'" : "'0'"})
  window.dispatchEvent(new StorageEvent('storage', { key: 'builtin.artificial.enabled' }))
})()`

/** 栅格快照:卡片 / 分组 / 状态位 + 产物视图的 guest 源。选择器一律走组件里的 data-* 锚点,不认中文文案。 */
const SNAP = `(() => {
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0).length
  const guest = document.querySelector('webview[data-product-id]')
  let guestUrl = ''
  try { guestUrl = guest ? (guest.getURL() || guest.getAttribute('src') || '') : '' }
  catch { guestUrl = guest ? (guest.getAttribute('src') || '') : '' }
  return {
    grid: vis('[data-artificial-root]'),
    cards: [...document.querySelectorAll('[data-artificial-card]')].map((c) => ({
      id: c.getAttribute('data-product-id'),
      kind: c.getAttribute('data-kind'),
      name: (c.querySelector('.art-card-name')?.textContent || '').trim(),
      group: c.closest('[data-kind-group]')?.getAttribute('data-kind-group') || null,
      actions: [...c.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action')),
    })),
    state: document.querySelector('[data-artificial-root] [data-state]')?.getAttribute('data-state') || null,
    productView: vis('[data-product-view]'),
    productStatus: document.querySelector('[data-product-view]')?.getAttribute('data-status') || null,
    guestUrl,
    active: localStorage.getItem('forsion_tangu_active_space'),
  }
})()`

async function boot() {
  const app = await electron.launch({
    args: [`--user-data-dir=${UD}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    // HOME 覆写见文件头的⚠️;TANGU_BACKEND_URL 指向死端口 = 不连任何引擎(本题不需要模型)。
    env: { ...process.env, HOME: home, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1500)
  return { app, win }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  let { app, win } = await boot()
  const errs = []
  win.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)))
  try {
    const entered = await enterSpace(win, SPACE_NAMES)
    const spaces = await ribbonSpaces(win)
    // 栅格是懒载的,再给 productsList 一点时间(首次扫盘会写 sidecar)。
    await win.waitForSelector('[data-artificial-card]', { timeout: 15_000 }).catch(() => {})
    const s1 = await win.evaluate(SNAP)
    check(
      '1 默认开:ribbon 有造物图标 + 点进去是造物栅格',
      entered && spaces.filter((n) => SPACE_NAMES.includes(n)).length === 1 && s1.grid === 1,
      JSON.stringify({ spaces, grid: s1.grid, state: s1.state }),
    )

    await shoot(app, win, 'grid-zh-light')
    const card = s1.cards.find((c) => c.name === FIXTURE_NAME)
    check(
      '2 托管根里的项目成为作品:id 形如 p_<12hex>、名字 = 文件夹名、落在「网页应用」组',
      !!card && /^p_[0-9a-f]{12}$/.test(card.id) && card.kind === 'web' && card.group === 'web'
        && card.actions.includes('open'),
      JSON.stringify(s1.cards),
    )

    // 夹具卡没出来就直接抛:否则下面的点击要等满选择器超时,最后报成一句没有诊断价值的「流程失败」。
    if (!card) throw new Error(`栅格里没有夹具作品「${FIXTURE_NAME}」:${JSON.stringify(s1.cards)} state=${s1.state}`)
    await win.click(`[data-artificial-card][data-product-id="${card.id}"] [data-action="open"]`)
    await win.waitForSelector('webview[data-product-id]', { timeout: 20_000 }).catch(() => {})
    await win.waitForTimeout(2500) // guest attach + 首帧
    const s2 = await win.evaluate(SNAP)
    check(
      '3 「打开」开出 product 视图,guest 跑在令牌根 http://<32hex>.localhost:<port>/',
      s2.productView === 1 && s2.productStatus === 'ready'
        && /^http:\/\/[0-9a-f]{32}\.localhost(:\d+)?\//.test(s2.guestUrl),
      JSON.stringify({ productView: s2.productView, status: s2.productStatus, guestUrl: s2.guestUrl }),
    )

    await shoot(app, win, 'product-zh-light')
    // 往作品自己的源里写一个值 —— 第 7 条重启后要原样读回来。
    const guestId = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() === 'webview' && /\.localhost/.test(w.getURL()))?.id ?? null)
    if (guestId != null) await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("localStorage.setItem('creations-probe','kept')"), guestId)

    await win.evaluate(toggle(false))
    await win.waitForTimeout(1500)
    const s3 = await win.evaluate(SNAP)
    const spacesOff = await ribbonSpaces(win)
    check(
      '4 关掉:ribbon 图标没了、栅格不见、活动 Space 已切走',
      spacesOff.filter((n) => SPACE_NAMES.includes(n)).length === 0 && s3.grid === 0 && s3.active !== 'artificial',
      JSON.stringify({ spaces: spacesOff, grid: s3.grid, active: s3.active }),
    )

    await win.evaluate(toggle(true))
    await win.waitForTimeout(1200)
    const backIn = await enterSpace(win, SPACE_NAMES)
    const spacesBack = await ribbonSpaces(win)
    const s4 = await win.evaluate(SNAP)
    // ⚠️判「Space 回来了」不能钉死在栅格上:第 3 条把 product 标签点成了活动标签,撤 Space 时
    //   那份现场被存进 space:artificial 命名布局 → 开回来 applyNamed 恢复的是**作品标签在前**,
    //   Dockview 会把非活动的栅格面板藏起来。这里要的是「回到了这个 Space 且主区有它自己的内容」。
    check(
      '5 开回来:图标回来,还能再进去(恢复的是它自己的布局)',
      backIn && spacesBack.filter((n) => SPACE_NAMES.includes(n)).length === 1
        && s4.active === 'artificial' && (s4.grid === 1 || s4.productView === 1),
      JSON.stringify({ spaces: spacesBack, grid: s4.grid, productView: s4.productView, active: s4.active }),
    )

    check('6 全程无渲染层异常', errs.length === 0, errs.join('; ').slice(0, 800))

    // ── 7 重启后同源 ──
    await app.close().catch(() => {})
    ;({ app, win } = await boot())
    win.on('pageerror', (e) => errs.push(String(e && e.message ? e.message : e)))
    await enterSpace(win, SPACE_NAMES)
    // 第 5 条留下的布局可能是作品标签在前;没有就从栅格再点开一次。
    if (!(await win.locator('webview[data-product-id]').count())) {
      await win.waitForSelector('[data-artificial-card]', { timeout: 15_000 }).catch(() => {})
      await win.click(`[data-artificial-card][data-product-id="${card.id}"] [data-action="open"]`).catch(() => {})
    }
    await win.waitForSelector('webview[data-product-id]', { timeout: 20_000 }).catch(() => {})
    await win.waitForTimeout(2500)
    const s5 = await win.evaluate(SNAP)
    const guestId2 = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((w) => w.getType() === 'webview' && /\.localhost/.test(w.getURL()))?.id ?? null)
    const kept = guestId2 == null ? null : await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("localStorage.getItem('creations-probe')"), guestId2)
    check(
      '7 重启后同源:guest 地址一字不差,作品写进 localStorage 的值还在',
      !!s2.guestUrl && s5.guestUrl === s2.guestUrl && kept === 'kept',
      JSON.stringify({ before: s2.guestUrl, after: s5.guestUrl, kept }),
    )

    if (SHOT_DIR) { // 暗色 + 英文再看一眼栅格(走真的持久化偏好 + 启动装载器,不手搓 token)
      await win.evaluate(() => { localStorage.setItem('forsion_theme_pref', 'dark'); localStorage.setItem('tangu_locale', 'en') })
      await win.reload()
      await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
      await win.waitForTimeout(1500)
      await enterSpace(win, SPACE_NAMES)
      // 恢复出来的布局是「作品标签在前」,栅格面板不在场 → 走启动器(＋)把栅格视图开出来再拍。
      const gridTab = win.locator('.dv-tab', { hasText: /Creations|造物/ }).first() // 作品开在新标签页里,栅格那一页还在,点回去即可
      if (await gridTab.count().catch(() => 0)) await gridTab.click().catch(() => {})
      if (!(await win.locator('[data-artificial-card]:visible').count())) {
        await win.locator('.newtab-card', { hasText: /Creations|造物/ }).first().click({ timeout: 3000 }).catch(async () => {
          await win.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+T').catch(() => {})
          await win.locator('.newtab-card', { hasText: /Creations|造物/ }).first().click({ timeout: 5000 }).catch(() => {})
        })
      }
      await win.waitForSelector('[data-artificial-card]', { timeout: 15_000 }).catch(() => {})
      await shoot(app, win, 'grid-en-dark')
    }
  } catch (e) {
    check('端到端流程跑完', false, (e && e.stack) || String(e))
  } finally {
    await app.close().catch(() => {})
  }

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过;夹具:${home}`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
