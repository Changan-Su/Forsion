/**
 * 手机形态(390×844,pointer:coarse,body zoom 1.15)的真浏览器实测 —— 2026-08-13 那批移动端改动的仪器。
 * 分三段:
 *  A 单列壳顶栏 = 浮动胶囊(Obsidian 式):脱流、透明、条不吃指针、左右两组药丸、e2e 依赖的 DOM 顺序没变。
 *  B 锚定浮层不掉出屏幕(用户实报:模型菜单连子面板整块跑到左边界外)。**桌面开发机永远复现不出来**
 *    —— 窗口宽、body zoom 恒 1;只有在这个 390 宽 + zoom 1.15 的上下文里才现形。
 *  C 编辑器底栏胶囊/块面板的几何(静态复刻,真 CSS):最要命的是「居中不许用 transform」——
 *    组件用内联 transform 做贴键盘的 translateY,CSS 再写 translateX(-50%) 会被整个覆盖掉。
 *
 * 跑:npm run check:capsule   (需 npm run web 起着 5173)
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

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-capsule-'))  // 截图落临时目录,不污染仓库
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const ctx = await browser.newContext({ locale: 'zh-CN',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  })
  // ORIGIN 可覆盖:默认打 desktop 的 `npm run web`(5173);指向 tangu-web 的 dev(5273)即可验
  // 真正部署的那份 —— web 经别名整份复用 desktop/frontend/src + lcl,手机视口装 @mobile/mobileEntry。
  const ORIGIN = process.env.CAPSULE_ORIGIN || 'http://localhost:5173'
  // web 未登录会 location.replace 跳登录页 → 先塞假 token(同 mobile 的 e2e),并把 /auth/me 挡回来。
  await ctx.addInitScript(() => {
    try { localStorage.setItem('forsion_token', 'capsule-check'); localStorage.setItem('lcl.uiMode', 'mobile') } catch { /* ignore */ }
  })
  const page = await ctx.newPage({ locale: 'zh-CN' })
  await page.route('**/auth/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"username":"check"}' }))
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.goto(`${ORIGIN}/?ui=mobile`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.mb-shell', { timeout: 30000 })
  await page.waitForTimeout(2500)

  const g = await page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const r = (el) => (el ? el.getBoundingClientRect().toJSON() : null)
    const bar = q('.mb-topbar')
    const caps = [...document.querySelectorAll('.mb-topbar .mb-cap')]
    const view = q('.mb-main > .mb-view')
    const main = q('.mb-main')
    const cs = bar ? getComputedStyle(bar) : null
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      zoom: getComputedStyle(document.body).zoom,
      barPos: cs?.position,
      barBg: cs?.backgroundColor,
      barPE: cs?.pointerEvents,
      barBorder: cs?.borderBottomWidth,
      bar: r(bar),
      main: r(main),
      caps: caps.map((c) => ({ rect: r(c), radius: getComputedStyle(c).borderRadius, bg: getComputedStyle(c).backgroundColor, pe: getComputedStyle(c).pointerEvents })),
      capBtns: caps.map((c) => c.querySelectorAll('.mb-icon-btn').length),
      firstBtnIsLeftToggle: q('.mb-topbar .mb-icon-btn')?.getAttribute('aria-label') ?? null,
      viewPadTop: view ? getComputedStyle(view).paddingTop : null,
      viewData: view?.getAttribute('data-view') ?? null,
      mainIsolation: main ? getComputedStyle(main).isolation : null,
    }
  })
  console.log(JSON.stringify(g, null, 1))

  check('触屏模式生效(pointer:coarse + body zoom 1.15)', g.coarse && g.zoom === '1.15', `coarse=${g.coarse} zoom=${g.zoom}`)
  check('顶栏脱离文档流浮着(absolute)', g.barPos === 'absolute', g.barPos)
  check('顶栏自身透明、无下边框', /rgba\(0, 0, 0, 0\)|transparent/.test(g.barBg || '') && g.barBorder === '0px', `${g.barBg} border=${g.barBorder}`)
  check('顶栏条不吃指针(两胶囊之间的空白放给内容)', g.barPE === 'none', g.barPE)
  check('两组胶囊,各自吃指针 + 药丸圆角', g.caps.length === 2 && g.caps.every((c) => c.pe === 'auto' && parseFloat(c.radius) > 100), JSON.stringify(g.caps.map((c) => ({ r: c.radius, pe: c.pe }))))
  check('左胶囊在左、右胶囊在右,中间留白', g.caps.length === 2 && g.caps[0].rect.left < 30 && g.caps[1].rect.right > 340 && g.caps[1].rect.left - g.caps[0].rect.right > 150,
    g.caps.length === 2 ? `left=${g.caps[0].rect.left.toFixed(0)}..${g.caps[0].rect.right.toFixed(0)} right=${g.caps[1].rect.left.toFixed(0)}..${g.caps[1].rect.right.toFixed(0)}` : 'n/a')
  check('⚠️ e2e 契约:.mb-topbar 里第一个 .mb-icon-btn 仍是左抽屉钮', g.firstBtnIsLeftToggle === 'left panel', String(g.firstBtnIsLeftToggle))
  check('.mb-main 自成栈(宽屏时胶囊不会盖到右抽屉上)', g.mainIsolation === 'isolate', g.mainIsolation)
  check('顶栏不再占流高:main 从 0 起(内容可滚到胶囊底下)', Math.abs(g.main.top - g.bar.top) < 1, `main.top=${g.main.top} bar.top=${g.bar.top}`)
  // ── D. 内容顶满(2026-08-13):退订名单里的视图,.mb-view 不再让位,留白进「视图顶端那个元素」──
  const d = await page.evaluate(() => {
    // 从 CSSOM 里找规则原文 —— 无头浏览器里 env(safe-area-inset-*) 恒为 0,computed 值断言不出
    // 「有没有躲刘海」,只能查规则本身在不在(真机留 人工点验)。
    const rules = []
    for (const ss of document.styleSheets) {
      let list = null
      try { list = ss.cssRules } catch { continue } // 跨源样式表读不到,跳过
      const walk = (l) => { for (const r of l) { if (r.cssText) rules.push(r.cssText); if (r.cssRules) walk(r.cssRules) } }
      walk(list)
    }
    const has = (re) => rules.some((t) => re.test(t))
    const stream = document.querySelector('.t2-stream')
    return {
      shellInlinePadTop: document.querySelector('.mb-shell').style.paddingTop || '(无)',
      viewPadTop: getComputedStyle(document.querySelector('.mb-main > .mb-view')).paddingTop,
      streamPadTop: stream ? getComputedStyle(stream).paddingTop : '(没有 .t2-stream)',
      ruleTopbarEnv: has(/\.mb-topbar[^{]*\{[^}]*top:\s*env\(safe-area-inset-top\)/),
      ruleMbTopEnv: has(/--mb-top:\s*calc\([^)]*env\(safe-area-inset-top\)/),
      ruleDrawerEnv: has(/\.mb-drawer[^{]*\{[^}]*padding-top:\s*env\(safe-area-inset-top\)/),
      ruleBlanket: has(/\.mb-main\s*>\s*\.mb-view\s*\{\s*padding-top:\s*var\(--mb-top\)/),
      ruleOptOut: has(/\.mb-main\s*>\s*\.mb-view:is\([^)]*data-view="?chat"?/),
    }
  })
  check('D1 顶部安全区已从壳下放(.mb-shell 不再内联 padding-top)', d.shellInlinePadTop === '(无)', d.shellInlinePadTop)
  check('D2 --mb-top 含 env(safe-area-inset-top)(壳不留了 → 消费方自己躲刘海)', d.ruleMbTopEnv, String(d.ruleMbTopEnv))
  check('D3 浮动胶囊自己躲刘海(.mb-topbar top:env(...))', d.ruleTopbarEnv, String(d.ruleTopbarEnv))
  check('D4 抽屉/侧栏自己躲刘海(壳不再代劳)', d.ruleDrawerEnv, String(d.ruleDrawerEnv))
  check('D5 安全默认仍在(名单外的视图照旧整块让位,失败方向=多留白而非被盖住)', d.ruleBlanket, String(d.ruleBlanket))
  check('D6 chat 已退订默认让位', d.ruleOptOut && d.viewPadTop === '0px', `rule=${d.ruleOptOut} .mb-view padTop=${d.viewPadTop}`)
  check('D7 ⚠️ 留白落进滚动器内部(.t2-stream)→ 面顶满、字不被压', d.streamPadTop === '58px', `.t2-stream padTop=${d.streamPadTop}(headless 里 env=0,故应为 58)`)

  await page.screenshot({ path: path.join(OUT, 'mobile-capsule.png') })
  console.log('screenshot →', path.join(OUT, 'mobile-capsule.png'))

  // ── B. 锚定浮层不掉出屏幕 ───────────────────────────────────────────────────
  const VW = 390
  const M = 6 // 断言余量:夹取目标是 8px 边距,给 2px 的亚像素/圆角容差
  const inScreen = (r) => r && r.left >= M && r.right <= VW - M
  const rectOf = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s)
    return el ? el.getBoundingClientRect().toJSON() : null
  }, sel)

  // 模式药丸(盾牌):打开后与 224px 菜单等宽、同右缘,同时仍要落在 390px 屏内。
  // 「＋」现在也是 .t2c-pill；必须按语义类找模式胶囊，不能再拿第一个 pill 猜。
  const modePill = page.locator('.t2c-row .mode-pill-btn').first()
  if (await modePill.count()) {
    await modePill.click()
    await page.waitForTimeout(350)
    const r = await rectOf('.composer-menu--mode')
    const p = await rectOf('.mode-pill-btn')
    check('B1 模式胶囊与菜单等宽对齐且整块在屏内',
      inScreen(r) && p && Math.abs(p.width - r.width) < 1 && Math.abs(p.right - r.right) < 1,
      r && p ? `pill=${p.left.toFixed(1)}..${p.right.toFixed(1)} menu=${r.left.toFixed(1)}..${r.right.toFixed(1)} w=${r.width.toFixed(1)}` : '没打开')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  } else check('B1 找得到模式药丸', false, '选择器失效,断言落空了')

  // 模型药丸:菜单 right:0 + 固定 224px;药丸靠左时菜单左缘为负 —— 用户截图里的真身。
  // 模型药丸在未连后端的 dev 环境里是 disabled,而 React 的合成事件按**自己的 props** 判定 disabled
  // (SimpleEventPlugin.shouldPreventMouseEvent),从 DOM 上摘掉 disabled 属性也骗不过它 —— 没有后端
  // 就点不开。故这里如实跳过,不伪造通过。它与 B1 走的是同一个 useEdgeNudge + 同一族 .composer-menu
  // CSS,B1 绿即代表该代码路径在真手机尺寸下有效;渲染点有没有接上夹取另由 check:menuclamp 钉。
  const modelDisabled = await page.evaluate(() => !!document.querySelector('.model-pill-btn')?.disabled)
  const modelPill = page.locator('.model-pill-btn').first()
  if (modelDisabled) {
    console.log('SKIP  B2/B3 模型菜单与子面板  | 未连后端 → 药丸 disabled,React 不派发点击;覆盖由 B1 + check:menuclamp + menuAnchor.test 承担')
  } else if (await modelPill.count()) {
    await modelPill.click()
    await page.waitForTimeout(350)
    const menu = await rectOf('.composer-menu--model')
    check('B2 模型菜单整块在屏内', inScreen(menu), menu ? `${menu.left.toFixed(1)}..${menu.right.toFixed(1)}` : '没打开')
    await page.locator('.composer-menu--model .cm-model-row').click()
    await page.waitForTimeout(350)
    const sub = await rectOf('.cm-sub')
    check('B3 ⚠️ 子面板整块在屏内(截图里被切掉的就是它)', inScreen(sub), sub ? `${sub.left.toFixed(1)}..${sub.right.toFixed(1)} w=${sub.width.toFixed(1)}` : '没打开')
    await page.screenshot({ path: path.join(OUT, 'mobile-modelmenu.png') })
    console.log('screenshot →', path.join(OUT, 'mobile-modelmenu.png'))
    await page.keyboard.press('Escape')
  } else check('B2 找得到模型药丸', false, '选择器失效,断言落空了')

  // 工作区下拉(与其他选择菜单同为 224px;左对齐时仍须防止捅右边缘)
  const projPill = page.locator('.project-pill:not([disabled])').first()
  if (await projPill.count()) {
    await projPill.click()
    await page.waitForTimeout(350)
    const r = await rectOf('.project-menu')
    check('B4 工作区下拉整块在屏内', inScreen(r), r ? `${r.left.toFixed(1)}..${r.right.toFixed(1)}` : '没打开')
    await page.keyboard.press('Escape')
  }

  // ── C. 编辑器底栏胶囊 / 块面板几何(静态复刻,吃的是真 amadeus-host.css)──────────
  const c = await page.evaluate(() => {
    const host = document.createElement('div')
    host.className = 'am-app tangu-lovable'
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:420px;z-index:99999'
    // 内联 transform 模拟「贴键盘上移」——CSS 若用 translateX(-50%) 居中就会被这行覆盖掉。
    host.innerHTML =
      '<div class="amx-mbar" style="transform:translateY(-260px)">' +
      '<button>a</button><button>b</button><button>c</button><button>d</button><button>e</button><button>f</button></div>' +
      '<div class="amx-bpick" style="height:260px"><div class="amx-bpick-scroll">' +
      '<div class="amx-bpick-label">基础</div><div class="amx-bpick-grid">' +
      '<button class="amx-bpick-item"><span class="amx-bpick-icon">T</span><span class="amx-bpick-name">文本</span></button>' +
      '<button class="amx-bpick-item"><span class="amx-bpick-icon">H</span><span class="amx-bpick-name">标题 1</span></button>' +
      '<button class="amx-bpick-item"><span class="amx-bpick-icon">H</span><span class="amx-bpick-name">标题 2</span></button>' +
      '<button class="amx-bpick-item"><span class="amx-bpick-icon">H</span><span class="amx-bpick-name">标题 3</span></button>' +
      '</div></div></div>'
    document.body.appendChild(host)
    const bar = host.querySelector('.amx-mbar')
    const pick = host.querySelector('.amx-bpick')
    // ⚠️ 面板的入场动画是 `from { translateY(100%) }` —— 不快进就量到「还在屏幕外」那一帧,
    //    C3「胶囊坐在面板上沿」会变成恒真的废断言(第一版就踩了:pick.top 量到 844 = 视口底)。
    host.getAnimations({ subtree: true }).forEach((a) => a.finish())
    const items = [...host.querySelectorAll('.amx-bpick-item')]
    const br = bar.getBoundingClientRect(); const pr = pick.getBoundingClientRect()
    const out = {
      bar: br.toJSON(), pick: pr.toJSON(),
      barPos: getComputedStyle(bar).position,
      barRadius: getComputedStyle(bar).borderRadius,
      vw: window.innerWidth,
      cols: new Set(items.map((el) => Math.round(el.getBoundingClientRect().left))).size,
      row0: Math.round(items[0].getBoundingClientRect().top) === Math.round(items[1].getBoundingClientRect().top),
    }
    host.remove()
    return out
  })
  const barMid = c.bar.left + c.bar.width / 2
  check('C1 底栏是悬浮药丸(absolute + 999px 圆角)', c.barPos === 'absolute' && parseFloat(c.barRadius) > 100, `${c.barPos} r=${c.barRadius}`)
  check('C2 ⚠️ 内联 translateY 不破坏水平居中(居中若用 transform 就会被覆盖 → 胶囊跳到一边)', Math.abs(barMid - c.vw / 2) < 2, `mid=${barMid.toFixed(1)} vw/2=${c.vw / 2}`)
  check('C3 胶囊坐在块面板上沿(不被面板压住)', c.bar.bottom <= c.pick.top + 1, `bar.bottom=${c.bar.bottom.toFixed(1)} pick.top=${c.pick.top.toFixed(1)}`)
  check('C4 块面板贴底铺满整宽(占住键盘让出的地)', Math.abs(c.pick.left) < 1 && Math.abs(c.pick.width - c.vw) < 1, `${c.pick.left.toFixed(1)}..${c.pick.right.toFixed(1)}`)
  check('C5 块面板是**双列**(用户明确要的排布)', c.cols === 2 && c.row0, `列数=${c.cols} 首两项同排=${c.row0}`)

  // ── E. 2026-08-13 第二批:胶囊明暗反转 / 底栏并入面板 / 封面顶满 / 滚动收起 ────────────
  // E1-E4 走**静态复刻**:真正的 VaultSideSwitch 只在 Electron(window.amadeusSync)或移动壳
  // (window.amadeusVaultMode)下渲染,浏览器里恒 null —— 但要验的就是 CSS 本身,复刻 DOM 足够。
  // 抽屉内容首开前不挂载(容器恒在,inner 靠 warm 才渲染)→ 量底栏之前必须先真开一次。
  await page.click('.mb-topbar .mb-icon-btn')
  await page.waitForSelector('.mb-drawer-foot', { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(600)
  const e = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] }
    // ⚠️ token 取值必须**过一次真元素**再读 backgroundColor:getPropertyValue('--bg') 返回的是作者原样
    // 写的 `#2a292b`,拿正则抠数字会得到 [2,29,2] 这种垃圾(第一版就是这么假绿/假红的)。
    const probe = document.createElement('div')
    probe.style.cssText = 'position:absolute;left:-9999px'
    document.body.appendChild(probe)
    const tokenRgb = (name, prop) => { probe.style.cssText = `position:absolute;left:-9999px;${prop}:var(${name})`; return getComputedStyle(probe)[prop === 'color' ? 'color' : 'backgroundColor'] }
    const seg = document.createElement('div')
    seg.className = 't2s-vaultseg'
    seg.innerHTML = '<div class="t2s-vaultseg-thumb" data-side="local"></div><button class="on">本地</button><button>云端</button>'
    document.body.appendChild(seg)
    const thumb = seg.querySelector('.t2s-vaultseg-thumb')
    const onBtn = seg.querySelector('button.on')
    // ⚠️ 必须掐掉过渡:`.t2s-vaultseg button` 有 `transition: color .25s`,切完 .dark 立刻读 computed
    // 拿到的是**过渡途中的当前值**(还停在旧模式的颜色)—— 第一版就是这么误报 E4 的。
    seg.querySelectorAll('*').forEach((el) => { el.style.transition = 'none' })
    const root = document.documentElement
    const wasDark = root.classList.contains('dark')
    // 轨道与滑块都是半透明叠层 → 必须**手工合成**再比亮度,直接读 backgroundColor 拿到的是
    // rgba(...) 原值,和面板底色没法比(合成:C = fg·α + bg·(1-α))。
    const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] ?? 1] }
    const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]))
    const sample = () => {
      const bgC = parse(tokenRgb('--bg', 'background'))
      const trackC = over(parse(getComputedStyle(seg).backgroundColor), bgC)
      const thumbC = over(parse(getComputedStyle(thumb).backgroundColor), trackC)
      return {
        bg: lum(`rgb(${bgC})`), track: lum(`rgb(${trackC})`), thumb: lum(`rgb(${thumbC})`),
        trackRaw: getComputedStyle(seg).backgroundColor,
        onColor: getComputedStyle(onBtn).color,
        accentInk: tokenRgb('--accent-ink', 'color'),
      }
    }
    root.classList.add('dark')
    const dark = sample()
    root.classList.remove('dark')
    const light = sample()
    if (wasDark) root.classList.add('dark')
    seg.remove(); probe.remove()

    // E5-E7 抽屉底栏:开左抽屉才量得到。
    const drawer = document.querySelector('.mb-drawer--left')
    const foot = document.querySelector('.mb-drawer-foot')
    // 真 Space 条要 spaces.length>1 才渲染(浏览器里不一定有),没有就在底栏里复刻一个量 CSS。
    let onTab = document.querySelector('.mb-tab.on')
    let synth = null
    if (!onTab && foot) {
      synth = document.createElement('nav')
      synth.className = 'mb-spacebar'
      synth.innerHTML = '<button class="mb-tab on"><span class="mb-tab-label">x</span></button>'
      foot.appendChild(synth)
      onTab = synth.firstElementChild
    }
    const fade = foot ? getComputedStyle(foot, '::before') : null

    // E8 封面顶满:同样静态复刻 —— 造一份 .mb-view[data-view=amadeus-editor] > .amx-editor(±封面),
    // 直接读 CSS 算出来的 padding-top,不依赖仓库里恰好有一篇带封面的笔记。
    const main = document.querySelector('.mb-main')
    const mk = (withCover) => {
      const v = document.createElement('div')
      v.className = 'mb-view'
      v.setAttribute('data-view', 'amadeus-editor')
      v.innerHTML = `<div class="am-app amx-pane amx-editor">${withCover ? '<div class="amx-cover"></div>' : ''}<div class="amx-doc"></div></div>`
      main.appendChild(v)
      const pt = getComputedStyle(v.querySelector('.amx-editor')).paddingTop
      v.remove()
      return pt
    }
    return {
      dark, light,
      footBg: foot ? getComputedStyle(foot).backgroundColor : null,
      drawerBg: drawer ? getComputedStyle(drawer).backgroundColor : null,
      footBorderTop: foot ? getComputedStyle(foot).borderTopWidth : null,
      fadeImg: fade ? fade.backgroundImage : null,
      fadeBottom: fade ? fade.bottom : null,
      tabBg: onTab ? getComputedStyle(onTab).backgroundColor : null,
      tabRadius: onTab ? getComputedStyle(onTab).borderRadius : null,
      tabOn: onTab ? onTab.classList.contains('on') : false,
      tabSynth: !!synth,
      padWithCover: mk(true),
      padNoCover: mk(false),
      _cleanup: (synth && synth.remove(), 1),
    }
  })
  const isBlackWash = (c) => { const m = c.match(/[\d.]+/g).map(Number); return m[0] === 0 && m[1] === 0 && m[2] === 0 && (m[3] ?? 1) > 0 }
  check('E1 深色:轨道比面板深(凹),选中滑块比两者都浅', e.dark.track < e.dark.bg && e.dark.thumb > e.dark.bg + 8, `track=${e.dark.track.toFixed(0)} bg=${e.dark.bg.toFixed(0)} thumb=${e.dark.thumb.toFixed(0)}`)
  check('E2 浅色:反之 —— 轨道仍凹,选中滑块比两者都深', e.light.track < e.light.bg && e.light.thumb < e.light.bg - 8, `track=${e.light.track.toFixed(0)} bg=${e.light.bg.toFixed(0)} thumb=${e.light.thumb.toFixed(0)}`)
  check('E3 ⚠️ 轨道是**黑色**叠层(凹);用 --overlay-light 会在深色下提亮 = 把关系做反', isBlackWash(e.dark.trackRaw) && isBlackWash(e.light.trackRaw), `dark=${e.dark.trackRaw} light=${e.light.trackRaw}`)
  check('E4 选中态用**次强调色**(--accent-light 底 + --accent-ink 字),不是纯 accent 实底', e.dark.onColor === e.dark.accentInk && e.light.onColor === e.light.accentInk, `${e.dark.onColor} / ${e.light.onColor}`)
  check('E5 抽屉底栏与面板同底色(不再是 --bg-card 那块补丁)', !!e.footBg && e.footBg === e.drawerBg, `foot=${e.footBg} drawer=${e.drawerBg}`)
  // bottom:100% 会被解析成用值(= 底栏自身高度的 px),别拿字符串 '100%' 去比。
  check('E6 交界改渐隐(硬分割线已去 + ::before 渐变浮在底栏上沿之外)', e.footBorderTop === '0px' && /gradient/.test(e.fadeImg || '') && parseFloat(e.fadeBottom) > 20, `border=${e.footBorderTop} img=${(e.fadeImg || '').slice(0, 24)} bottom=${e.fadeBottom}`)
  check('E7 当前 Space 是胶囊(有底 + 圆角,同桌面 .rb-space.on)', e.tabOn && !/,\s*0\)$/.test(e.tabBg || '') && parseFloat(e.tabRadius) >= 8, `bg=${e.tabBg} r=${e.tabRadius}${e.tabSynth ? '(复刻)' : ''}`)
  check('E8 ⚠️ 有封面 → 让位归零(封面满铺到顶);无封面 → 仍让位(标题不被压)', e.padWithCover === '0px' && e.padNoCover === '58px', `有封面=${e.padWithCover} 无封面=${e.padNoCover}`)

  // E9-E12 滚动收起:往真滚动器里塞一根高杆,再驱动 scrollTop —— 走的是 .mb-main 上那个真捕获监听。
  // ⚠️ 先关抽屉:开着抽屉时 useChromeAutoHide 会无条件召回(anyDrawer 依赖),测出来必假绿。
  // E8b 切 Space 后**留在左面板**(用户拍板 2026-08-13:切完接着在面板里找东西,不该被甩回主区)。
  // 抽屉此刻还开着;真 Space 条要 spaces.length>1 才渲染,凑不齐就诚实 SKIP,不假绿。
  const tabsN = await page.$$eval('.mb-drawer-foot .mb-tab', (els) => els.length)
  if (tabsN > 1) {
    const idx = await page.$$eval('.mb-drawer-foot .mb-tab', (els) => els.findIndex((el) => !el.classList.contains('on')))
    await page.click(`.mb-drawer-foot .mb-tab >> nth=${idx < 0 ? 1 : idx}`)
    await page.waitForTimeout(900)
    const st = await page.evaluate(() => ({
      open: !!document.querySelector('.mb-drawer--left.open'),
      onIdx: [...document.querySelectorAll('.mb-drawer-foot .mb-tab')].findIndex((el) => el.classList.contains('on')),
    }))
    check('E8b 切 Space 后抽屉仍开着(布局重建会复位 leftVisible,得再开回来)', st.open, `open=${st.open} 选中第 ${st.onIdx} 个`)
  } else {
    results.push({ name: 'E8b', ok: true })
    console.log(`SKIP  E8b 切 Space 后留在左面板  | 本 origin 只注册了 ${tabsN} 个 Space,凑不出切换`)
  }

  // 点右边缘的 dim 收回。⚠️ 不能用 page.click('.mb-push-dim')(几何中心被抽屉盖着 → intercepted),
  // 也不能再点顶栏钮(顶栏住在被推开的 .mb-main 里,已经跟着滑到抽屉右边/屏外)。
  await page.mouse.click(370, 500)
  await page.waitForTimeout(700)
  const s = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const shell = document.querySelector('.mb-shell')
    const main = document.querySelector('.mb-main')
    let sc = [...main.querySelectorAll('*')].find((el) => {
      const cs = getComputedStyle(el)
      return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.clientHeight > 100
    })
    if (!sc) return { err: '主区没有可滚动容器' }
    const pole = document.createElement('div')
    pole.style.height = '3000px'
    sc.appendChild(pole)
    const at = (v) => { sc.scrollTop = v; sc.dispatchEvent(new Event('scroll')) }
    at(0); at(10) // 先认准滚动器(第一帧只重置基线)
    at(300); at(600)
    await sleep(80)
    const hidden = shell.getAttribute('data-chrome')
    const barTop = document.querySelector('.mb-topbar').getBoundingClientRect().top
    at(500); at(360) // 反向上滑
    await sleep(80)
    const back = shell.getAttribute('data-chrome')
    // 收起态下落焦到可编辑处 → 必须立刻召回(否则键盘弹出而工具条还在屏外,「+」拿不到)
    at(700); at(1200)
    await sleep(80)
    const beforeFocus = shell.getAttribute('data-chrome')
    const inp = document.createElement('input')
    main.appendChild(inp); inp.focus()
    await sleep(80)
    const afterFocus = shell.getAttribute('data-chrome')
    // 打字中不许收:焦点还在输入框上继续下滑
    at(1600); at(2000)
    await sleep(80)
    const whileTyping = shell.getAttribute('data-chrome')
    inp.remove(); pole.remove(); at(0)
    return { hidden, barTop, back, beforeFocus, afterFocus, whileTyping }
  })
  check('E9 下滑 → chrome 收起(壳打上 data-chrome=off)', s.hidden === 'off', `data-chrome=${s.hidden}${s.err ? ' | ' + s.err : ''}`)
  check('E10 收起后顶栏确实移出屏幕上沿', typeof s.barTop === 'number' && s.barTop < -20, `topbar.top=${typeof s.barTop === 'number' ? s.barTop.toFixed(1) : s.barTop}`)
  check('E11 上滑立刻召回', s.back !== 'off', `data-chrome=${s.back}`)
  check('E12 ⚠️ 收起态下一落焦到可编辑处立刻召回(否则键盘弹出而工具条还在屏外,「+」拿不到)', s.beforeFocus === 'off' && s.afterFocus !== 'off', `落焦前=${s.beforeFocus} 落焦后=${s.afterFocus}`)
  check('E13 ⚠️ 打字中不收(底栏是此刻唯一入口,收了=把工具抽走)', s.whileTyping !== 'off', `data-chrome=${s.whileTyping}`)

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
