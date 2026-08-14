/**
 * 「进 Space 显示上次打开的东西」的端到端契约(真浏览器 + 真单列壳)。
 *
 * 病(用户实报):「桌面端、移动端,不管本地还是云端,进一个 space 都该显示上次打开的文件……
 * 特别是移动端进去每次都是 new 的页面」。两处根因:
 *  · 单列壳(移动/mini)的 saveCurrent/saveNamed/applyNamed 原本写死 no-op → 冷启动恒 buildDefault、
 *    切 Space 恒 resetLayout,每次都是新的一张。
 *  · 桌面 bootstrapEngine 的「固定启动 Space」策略原本无条件 clearLayout() → 每次冷启动推倒重建
 *    (那份 clear 是修「进 A 却看到 B 的布局」时的过头做法)。
 * 单元测试钉的是 store 的存取语义(lcl/engine/singleColumnStore.test.ts、spaceRegistry.test.ts);
 * 这支钉的是**接线**:壳真的在 buildDefault 之前问了一次存档,存档也真的在用之后写回去。
 *
 * 2026-08-13:「启动时进入」的**缺省**由 PRODUCT.defaultSpace 改成「上次退出时的 Space」(用户要求)。
 * D/E 于是显式写 forsion_default_space='tangu' 继续守固定 Space 那条路,F 守新缺省。
 *
 * 跑:npm run check:spacerestore   (需 npm run web 起着 5173)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of [
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium')
}

const SC_KEY = 'lcl_sc_layout_v1'
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })
  const ORIGIN = process.env.CAPSULE_ORIGIN || 'http://localhost:5173'
  // 与 check:capsule 同一套「未登录不跳登录页」的起手式。
  await ctx.addInitScript(() => {
    try { localStorage.setItem('forsion_token', 'space-restore-check'); localStorage.setItem('lcl.uiMode', 'mobile') } catch { /* ignore */ }
  })
  const page = await ctx.newPage()
  await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"check"}' }))
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))

  const boot = async () => {
    await page.goto(`${ORIGIN}/?ui=mobile`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.mb-shell', { timeout: 30000 })
    await page.waitForTimeout(2500) // 装配 + 200ms 存盘节流
  }
  const stored = () => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) || 'null') } catch { return null } }, SC_KEY)
  /** 打开标签 sheet,读回 [{title, active}]。 */
  const tabRows = async () => {
    await page.click('.mb-tabsbtn')
    await page.waitForSelector('.mb-tabrow', { timeout: 5000 })
    const rows = await page.$$eval('.mb-tabrow', (els) => els.map((e) => ({ title: e.textContent.trim(), active: e.classList.contains('on') })))
    await page.keyboard.press('Escape').catch(() => {})
    await page.click('.mb-sheet-scrim', { position: { x: 10, y: 10 } }).catch(() => {})
    await page.waitForTimeout(300)
    return rows
  }

  // A 首启:壳把当前布局写进存档(自动存盘接上了)
  await boot()
  const first = await stored()
  check('A 首启后写出了单列布局存档', !!first && Array.isArray(first.main) && first.main.length > 0, JSON.stringify(first && { v: first.v, main: first.main.map((r) => r.type), active: first.activeMainId }))

  // B 造一份两标签存档 → 重载 → 壳必须还原它,而不是 buildDefault 一张新的
  const type = first && first.main[0] && first.main[0].type
  await page.evaluate(({ k, t }) => {
    localStorage.setItem(k, JSON.stringify({
      v: 1,
      main: [
        { id: `${t}#1`, type: t, loc: 'main', params: {}, title: '存档甲' },
        { id: `${t}#2`, type: t, loc: 'main', params: {}, title: '存档乙' },
      ],
      left: [], right: [],
      activeMainId: `${t}#2`, leftActiveId: null, rightActiveId: null,
    }))
  }, { k: SC_KEY, t: type })
  await boot()
  const count = await page.textContent('.mb-tabcount').catch(() => null)
  check('B 重载后标签数 = 存档里的 2(不是 buildDefault 的 1)', count === '2', `.mb-tabcount=${count}`)
  const rows = await tabRows()
  check('B 激活项 = 存档里的那一个(不是第一个)', rows.length === 2 && rows[1].active && !rows[0].active, JSON.stringify(rows))

  // C 存档不可用(视图已下线)→ 回落 buildDefault,不能白屏
  await page.evaluate((k) => {
    localStorage.setItem(k, JSON.stringify({ v: 1, main: [{ id: 'ghost#1', type: 'ghost-view', loc: 'main', params: {}, title: '幽灵' }], left: [], right: [], activeMainId: 'ghost#1', leftActiveId: null, rightActiveId: null }))
  }, SC_KEY)
  await boot()
  const after = await stored()
  const cnt = await page.textContent('.mb-tabcount').catch(() => null)
  check('C 存档全是已下线视图 → 回落默认布局(有内容,不白屏)', !!after && after.main.length > 0 && after.main.every((r) => r.type !== 'ghost-view'), `count=${cnt} main=${JSON.stringify(after && after.main.map((r) => r.type))}`)

  // D 桌面壳(Dockview):冷启动的每-Space 布局交接。原来这里是无条件 clearLayout() —— 布局键每次
  //   冷启动都被抹掉,「上次退出那个 Space」的命名槽也从来没人补,于是重启必回干净默认。
  //   判据取「上次退出的 Space 有没有被归档」:那件事只有新代码会做,buildDefault 那条路做不出来。
  {
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
    await dctx.addInitScript(() => {
      try {
        localStorage.setItem('forsion_token', 'space-restore-check')
        localStorage.setItem('lcl.uiMode', 'desktop')
        localStorage.setItem('forsion_default_space', 'tangu') // D/E 钉的是**固定启动 Space**那条路(缺省已改成「上次退出」,见 F)
      } catch { /* ignore */ }
    })
    const dp = await dctx.newPage()
    await dp.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"check"}' }))
    dp.on('pageerror', (e) => console.log('  [pageerror]', e.message))
    const dboot = async () => {
      await dp.goto(`${ORIGIN}/?ui=desktop`, { waitUntil: 'domcontentloaded' })
      await dp.waitForSelector('.wb-dockview', { timeout: 30000 })
      await dp.waitForTimeout(2500)
    }
    const named = () => dp.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem('tangu2_named_layouts') || '{}')) } catch { return [] } })
    /** 往布局键里每个 panel 的 params 打一枚记号。panel params 是随 dockview JSON 原样往返的
     *  (`__type` 就靠它活着),所以「重启后记号还在」= 真的是上一程那份;被清掉重建的话
     *  buildDefault 造的新 panel 没有记号。panel **id** 认不出来 —— 默认布局的 id 是确定的,
     *  重建出来一模一样(实测 ["chat","workspace#1"] 两路相同)。 */
    const stamp = () => dp.evaluate(() => {
      const b = JSON.parse(localStorage.getItem('tangu2_layout_v4'))
      for (const p of Object.values(b.dockview.panels)) (p.params = p.params || {}).__probe = 'keepme'
      localStorage.setItem('tangu2_layout_v4', JSON.stringify(b))
      return Object.keys(b.dockview.panels).length
    })
    const stamped = () => dp.evaluate(() => {
      try {
        const ps = Object.values(JSON.parse(localStorage.getItem('tangu2_layout_v4')).dockview.panels)
        return `${ps.filter((p) => p.params && p.params.__probe === 'keepme').length}/${ps.length}`
      } catch { return 'n/a' }
    })
    await dboot() // 第一次:全新 context 里布局键本来是空的,没得可归档
    check('D 首启没有可归档的布局(基线)', !(await named()).includes('space:tangu'), `namedLayouts=${JSON.stringify(await named())}`)
    const marked = await stamp() // 给上一程的每个 panel 打记号(模拟「用户摆过的现场」)
    await dboot() // 第二次 = 一次真正的「重启」:布局键里是上一程的现场
    const after = await named()
    const survived = await stamped()
    const active = await dp.evaluate(() => localStorage.getItem('forsion_tangu_active_space'))
    check('D 冷启动仍定位在启动 Space', active === 'tangu', `active=${active}`)
    // 走的是 from===to 那条(启动 Space 恰是上次退出那个,最常见)。**只有新代码会归档** ——
    // 旧代码在这里是无条件 clearLayout(),归档这件事从来没人做。
    check('D 上次退出那个 Space 的布局被归档进自己的命名槽(不再是无条件 clearLayout)', after.includes('space:tangu'), `namedLayouts=${JSON.stringify(after)}`)
    // 归档过了但布局键还是被清掉重建的话,上面那条照样绿(Codex 评审指出的空通过口子)。
    check('D 重启后主区面板还是上一程那批(不是重建的)', survived === `${marked}/${marked}`, `带记号的 panel ${survived}(重启前 ${marked} 个)`)

    // E 上次退出的 Space **此刻尚未注册**(用户 L0 Space 异步装载 / 该 Space 已删):registerSpaces()
    //   会把活动 id 就地归一成产品默认,跑在启动策略之前。归档时若读归一后的值,上一程的布局就被
    //   写进**别人**的槽(Codex 评审抓的 High)。修法=用模块装载时的快照 BOOT_ACTIVE_SPACE_ID。
    await dp.evaluate(() => localStorage.setItem('forsion_tangu_active_space', 'ghost-space'))
    await dboot()
    const e = await named()
    check('E 上次退出在未注册的 Space:布局归档到它自己名下,不串到产品默认', e.includes('space:ghost-space'), `namedLayouts=${JSON.stringify(e)}`)
    await dctx.close()
  }

  // F 缺省(未设「启动时进入」)= 上次退出的那个 Space:布局键**原样**交给 tryRestoreLayout。
  //   2026-08-13 用户要求改的默认。旧缺省是 PRODUCT.defaultSpace='tangu' → 会把布局键换成 space:tangu
  //   的存档(全新 context 里没有 → clearLayout),上一程的记号一个不剩。独立 context:D/E 攒下的命名布局
  //   不能漏进来,否则「换掉了」也可能碰巧还有内容。
  {
    const fctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
    await fctx.addInitScript(() => {
      try {
        localStorage.setItem('forsion_token', 'space-restore-check')
        localStorage.setItem('lcl.uiMode', 'desktop')
        localStorage.removeItem('forsion_default_space') // 缺省
      } catch { /* ignore */ }
    })
    const fp = await fctx.newPage()
    await fp.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"check"}' }))
    fp.on('pageerror', (e) => console.log('  [pageerror]', e.message))
    const fboot = async () => {
      await fp.goto(`${ORIGIN}/?ui=desktop`, { waitUntil: 'domcontentloaded' })
      await fp.waitForSelector('.wb-dockview', { timeout: 30000 })
      await fp.waitForTimeout(2500)
    }
    await fboot()
    // 上次退出在一个此刻不注册的 Space(用户 L0 Space 异步装载 / 已删都长这样)+ 给现场打记号
    const fmarked = await fp.evaluate(() => {
      localStorage.setItem('forsion_tangu_active_space', 'ghost-space')
      const b = JSON.parse(localStorage.getItem('tangu2_layout_v4'))
      for (const p of Object.values(b.dockview.panels)) (p.params = p.params || {}).__probe = 'keepme'
      localStorage.setItem('tangu2_layout_v4', JSON.stringify(b))
      return Object.keys(b.dockview.panels).length
    })
    await fboot()
    const fsurvived = await fp.evaluate(() => {
      try {
        const ps = Object.values(JSON.parse(localStorage.getItem('tangu2_layout_v4')).dockview.panels)
        return `${ps.filter((p) => p.params && p.params.__probe === 'keepme').length}/${ps.length}`
      } catch { return 'n/a' }
    })
    const fnamed = await fp.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem('tangu2_named_layouts') || '{}')) } catch { return [] } })
    check('F 缺省启动设置:重启后还是上一程的现场(布局键没被换成产品默认那份)', fsurvived === `${fmarked}/${fmarked}`, `带记号的 panel ${fsurvived}(重启前 ${fmarked} 个)`)
    check('F 缺省启动设置下仍然归档(切走再切回来时槽里是新的)', fnamed.includes('space:ghost-space'), `namedLayouts=${JSON.stringify(fnamed)}`)
    await fctx.close()
  }

  await browser.close()
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
