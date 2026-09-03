/**
 * Homepage 磨砂像素回归。真 Electron,隔离 userData,不碰用户壁纸。
 * 受控后端使模型/模式/附件控件可操作,同时验证整个输入区的聚焦生命周期。
 * 高对比条纹置于真实 wallpaper 层,对比同一材质启用/禁用 backdrop-filter 的截图。
 * computedStyle 有 blur 不算通过:opacity 动画的 fill-mode 会隔断子孙的 backdrop 采样。
 * npm run build && npm run check:homepageglass [--shot]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT = process.argv.includes('--shot')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` | ${JSON.stringify(detail)}`}`)
}

async function pixelDifference(app, a, b) {
  return app.evaluate(({ nativeImage }, images) => {
    const [first, second] = images.map((base64) => nativeImage.createFromBuffer(Buffer.from(base64, 'base64')))
    const size = first.getSize()
    if (JSON.stringify(size) !== JSON.stringify(second.getSize())) throw new Error('Probe geometry moved between captures')
    const x = first.toBitmap(), y = second.toBitmap()
    let difference = 0
    for (let i = 0; i < x.length; i += 4) {
      difference += Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2])
    }
    return Number((difference / (x.length / 4 * 3)).toFixed(2))
  }, [a.toString('base64'), b.toString('base64')])
}

async function probe(win, app, selector, pseudo = '') {
  const target = win.locator(selector).first()
  await win.waitForTimeout(360) // 等上一个切换的 opacity transition 结束,不量过渡中间帧。
  const material = await target.evaluate((el, pseudo) => {
    const css = getComputedStyle(el, pseudo || null)
    const ancestors = []
    for (let p = el; p && !p.matches('.hp-root'); p = p.parentElement) {
      const s = getComputedStyle(p)
      ancestors.push({ class: p.className, opacity: s.opacity, filter: s.filter, animation: s.animationName, fill: s.animationFillMode })
    }
    return { backdrop: css.backdropFilter, background: css.backgroundColor, ancestors }
  }, pseudo)
  const a = await target.screenshot()
  const disable = await win.addStyleTag({ content: `${selector}${pseudo} { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }` })
  const b = await target.screenshot()
  await disable.evaluate((el) => el.remove())
  return { difference: await pixelDifference(app, a, b), ...material }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('先 npm run build')
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-home-glass-'))
  let app
  const stub = await startStubEngine({ models: [
    { id: 'focus-a', name: 'Focus A', provider: 'stub', source: 'direct', contextWindow: 128000 },
    { id: 'focus-b', name: 'Focus B', provider: 'stub', source: 'direct', contextWindow: 128000 },
  ] })
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${path.join(testHome, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: testHome, TANGU_BACKEND_URL: stub.url },
    })
    const win = await app.firstWindow()
    const pageErrors = []
    win.on('pageerror', (error) => pageErrors.push(error.message))
    await win.waitForSelector('#root')
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const button = win.getByText(label, { exact: true }).first()
      if (await button.count()) { await button.click(); break }
    }
    await win.waitForSelector('.dv-groupview')
    // TANGU_BACKEND_URL 只覆盖地址,不会把 managed 改成 external;还需配置测试凭证才会 connect。
    await win.evaluate((backendUrl) => window.tangu.setConfig({ mode: 'external', backendUrl, token: 'homepage-focus-fixture' }), stub.url)
    // 固定夹具只写临时 userData,同时覆盖二级收纳夹。
    await win.evaluate(() => {
      localStorage.setItem('forsion_tangu_active_space', 'home')
      localStorage.setItem('forsion_tangu_ribbon_order', JSON.stringify(['space:home', 'folder:glass', 'space:tangu', 'space:inbox']))
      localStorage.setItem('forsion_tangu_ribbon_v2', JSON.stringify({ bottomOrder: [], commandItems: [], commandIcons: {}, folders: [
        { id: 'folder:glass', name: '工作空间', zone: 'top', items: ['space:calendar', 'space:coding'] },
      ] }))
    })
    await win.reload()
    await win.waitForSelector('.hp-root', { timeout: 30000 })
    await win.waitForTimeout(1000)
    // 真点击 + 真焦点事件,受控后端让模型/附件按钮可用,不靠移除 disabled 伪造交互。
    await win.waitForSelector('.hp-composer .t2c-ta:not(:disabled)', { timeout: 15000 }).catch(async (err) => {
      await win.screenshot({ path: path.join(os.tmpdir(), 'forsion-homepage.focus-boot-failed.png') })
      throw err
    })
    const isFocused = () => win.locator('.hp-root').evaluate((el) => el.classList.contains('hp-composer-focused'))
    check('主页不会自动进入输入聚焦', !(await isFocused()))
    for (const control of ['model', 'mode', 'add']) {
      await win.click(`.hp-composer .${control}-pill-btn`)
      await win.waitForSelector(`.composer-menu--${control}`)
      check(`${control}按钮点击触发聚焦`, await isFocused())
      if (control === 'model') {
        await win.click('.cm-model-row')
        await win.locator('.cm-sub[data-pane="model"] button').filter({ hasText: 'Focus B' }).click()
        check('选择模型并关闭菜单后保持聚焦', await isFocused()
          && (await win.locator('.model-pill-btn').innerText()).includes('Focus B'))
      } else if (control === 'mode') {
        await win.locator('.composer-menu--mode > .menu-item').first().click()
        check('调整模式并关闭菜单后保持聚焦', await isFocused())
      }
      if (SHOT) {
        await win.waitForTimeout(450)
        await win.screenshot({ path: path.join(os.tmpdir(), `forsion-homepage.focus-${control}.png`) })
      }
      await win.locator('.hp-root').click({ position: { x: 8, y: 8 } })
      check(`${control}操作后点击空白退出聚焦`, !(await isFocused()))
    }
    await win.click('.hp-composer .t2c-ta')
    await win.evaluate(() => {
      const root = document.querySelector('.hp-root')
      window.__hpFocusDrops = 0
      window.__hpFocusObserver = new MutationObserver(() => {
        if (!root.classList.contains('hp-composer-focused')) window.__hpFocusDrops++
      })
      window.__hpFocusObserver.observe(root, { attributes: true, attributeFilter: ['class'] })
    })
    await win.click('.hp-composer .mode-pill-btn')
    await win.locator('.composer-menu--mode > .menu-item').first().click()
    const drops = await win.evaluate(() => {
      window.__hpFocusObserver.disconnect()
      return window.__hpFocusDrops
    })
    check('从输入框切换到模式菜单不闪退', await isFocused() && drops === 0, { drops })
    await win.click('.hp-composer .t2c-ta')
    await win.keyboard.press('Escape')
    check('文本区 Escape 仍可退出聚焦', !(await isFocused()))
    await win.locator('.hp-composer .model-pill-btn').focus()
    check('键盘焦点进入相关控件也触发聚焦', await isFocused())
    await win.locator('.hp-wallpaper-button').focus()
    check('键盘焦点移到输入区外退出聚焦', !(await isFocused()))
    // 不改被测祖先的 opacity/animation/transform,否则会把这次的回归直接掩掉。
    const fixture = await win.addStyleTag({ content: `
      .hp-wallpaper { background-image: repeating-linear-gradient(90deg, #173b52 0 12px, #e7bb7b 12px 24px) !important; filter: none !important; transition: none !important; }
      .hp-wallpaper-art, .hp-wallpaper-edge, .hp-wallpaper-tone, .hp-glow { display: none !important; }
    ` })
    await win.evaluate(() => { document.documentElement.dataset.glass = 'on' })
    for (const [name, selector, pseudo] of [
      ['输入框', '.hp-composer .t2c-card', ''],
      ['Space 收纳架', '.hp-spaces', ''],
    ]) {
      const p = await probe(win, app, selector, pseudo)
      check(`${name}真实采样壁纸`, p.difference > 4 && p.backdrop.includes('blur('), p)
    }
    // 负对照:只隔断输入区祖先的 backdrop,blur 声明仍在,像素差必须归零。
    const blocker = await win.addStyleTag({ content: '.hp-composer { opacity: 0.999 !important; }' })
    const negative = await probe(win, app, '.hp-composer .t2c-card')
    check('负对照能识别仅半透明、blur 空采样', negative.difference < 1, negative)
    await blocker.evaluate((el) => el.remove())
    const restored = await probe(win, app, '.hp-composer .t2c-card')
    check('输入框在透明度切换后仍能采样', restored.difference > 4, restored)
    // 关闭景深时仍须有本地磨砂,不能依靠整张 wallpaper 的 filter 冒充材质。
    await win.locator('.hp-composer .t2c-ta').dispatchEvent('pointerdown')
    const focused = await probe(win, app, '.hp-composer .t2c-card')
    check('输入模式保留清晰前景与局部磨砂', focused.difference > 4, focused)
    await win.locator('.hp-root').dispatchEvent('pointerdown')

    await win.locator('.hp-root').dispatchEvent('contextmenu')
    await win.waitForSelector('.hp-organizer-panel')
    await win.waitForTimeout(650)
    const organizer = await probe(win, app, '.hp-organizer-panel', '::before')
    check('Space 抽屉整面磨砂', organizer.difference > 4 && organizer.backdrop.includes('blur('), organizer)
    const organizerHeader = await win.locator('.hp-organizer-panel').evaluate((panel) => ({
      hasClock: !!panel.querySelector('.hp-organizer-clock'),
      startsWithHeader: panel.firstElementChild?.matches('.hp-organizer-head'),
      homeClock: document.querySelector('.hp-title .hp-clock')?.textContent,
    }))
    check('Space 收纳层不显示时钟且不留占位,主页时钟保留', !organizerHeader.hasClock
      && organizerHeader.startsWithHeader && /\d{2}:\d{2}/.test(organizerHeader.homeClock || ''), organizerHeader)
    const off = async (selector, pseudo = '') => {
      await win.evaluate(() => { document.documentElement.dataset.glass = 'off' })
      await win.waitForTimeout(360) // 图标有 background transition,验证最终实色而不是中间帧。
      const css = await win.locator(selector).first().evaluate((el, pseudo) => {
        const s = getComputedStyle(el, pseudo || null)
        return { backdrop: s.backdropFilter, background: s.backgroundColor }
      }, pseudo)
      await win.evaluate(() => { document.documentElement.dataset.glass = 'on' })
      return css
    }
    const drawerOff = await off('.hp-organizer-panel', '::before')
    const iconOff = await off('.hp-organizer-grid .hp-tile-icon')
    check('抽屉与图标遵循玻璃关闭降级', drawerOff.backdrop === 'none' && iconOff.backdrop === 'none'
      && [drawerOff, iconOff].every((s) => !s.background.includes(' / ') && !s.background.includes('rgba')), { drawerOff, iconOff })
    await win.click('.hp-organizer-head > button')
    await win.waitForTimeout(400)
    await win.click('.hp-spaces .hp-folder')
    await win.waitForSelector('.hp-folder-panel')
    await win.waitForTimeout(650)
    const folder = await probe(win, app, '.hp-folder-panel', '::before')
    check('二级收纳夹整面磨砂', folder.difference > 4 && folder.backdrop.includes('blur('), folder)
    const folderOff = await off('.hp-folder-panel', '::before')
    check('二级收纳夹遵循玻璃关闭降级', folderOff.backdrop === 'none', folderOff)
    // 只增加 DOM 几何夹具,不创建用户 Space。大收纳夹滚动时不能把磨砂底层一并滚走。
    const scroll = await win.evaluate(() => {
      const panel = document.querySelector('.hp-folder-panel')
      const grid = document.querySelector('.hp-folder-grid')
      const seed = grid.firstElementChild
      for (let i = 0; i < 40; i++) grid.appendChild(seed.cloneNode(true))
      const headY = panel.querySelector('header').getBoundingClientRect().top
      grid.scrollTop = grid.scrollHeight
      return { top: grid.scrollTop, panelOverflow: getComputedStyle(panel).overflowY,
        headerMoved: panel.querySelector('header').getBoundingClientRect().top - headY }
    })
    const scrolled = await probe(win, app, '.hp-folder-panel', '::before')
    check('收纳夹滚动时整面磨砂与标题保持在位', scroll.top > 0 && scroll.panelOverflow === 'hidden'
      && scroll.headerMoved === 0 && scrolled.difference > 4, { scroll, difference: scrolled.difference })
    await win.click('.hp-folder-head > button')
    await win.waitForTimeout(400)
    await win.evaluate(() => {
      document.documentElement.dataset.mode = 'dark'
      document.documentElement.classList.add('dark')
    })
    const dark = await probe(win, app, '.hp-composer .t2c-card')
    check('深色输入框仍有真实磨砂', dark.difference > 4, dark)
    await win.locator('.hp-root').dispatchEvent('contextmenu')
    await win.waitForSelector('.hp-organizer-panel')
    const darkDrawer = await probe(win, app, '.hp-organizer-panel', '::before')
    check('深色抽屉仍有真实磨砂', darkDrawer.difference > 4, darkDrawer)
    await win.click('.hp-organizer-head > button')
    await win.waitForTimeout(400)
    await win.emulateMedia({ reducedMotion: 'reduce' })
    const still = await probe(win, app, '.hp-composer .t2c-card')
    check('减少动画不会关掉局部磨砂', still.difference > 4, still)
    await win.emulateMedia({ reducedMotion: 'no-preference' })
    await fixture.evaluate((el) => el.remove())

    if (SHOT) {
      // 优先通过真正的壁纸设置选 Bing 照片;离线时明确标记为纹理夹具。
      await win.click('.hp-wallpaper-button')
      await win.click('.hp-wallpaper-sources button[data-source="bing"]')
      const bing = await win.waitForFunction(() => {
        const thumbs = [...document.querySelectorAll('.hp-wallpaper-grid img')]
        return thumbs.length > 0 && thumbs.every((img) => img.complete && img.naturalWidth > 0)
          && document.querySelector('.hp-wallpaper')?.style.backgroundImage.includes('bing.com')
      }, undefined, { timeout: 15000 }).then(() => true).catch(() => false)
      await win.click('.hp-wallpaper-head > button')
      if (!bing) {
        await win.addStyleTag({ content: `.hp-wallpaper { background-image:
          radial-gradient(ellipse at 74% 24%, #e9bc82 0 13%, transparent 40%),
          repeating-linear-gradient(125deg, transparent 0 70px, #31596555 72px 76px, transparent 78px 130px),
          linear-gradient(140deg, #183c51, #78918c 48%, #ddae76) !important; }` })
        await win.evaluate(() => { document.querySelector('.hp-root').dataset.wallpaper = 'true' })
      }
      console.log(`视觉背景: ${bing ? 'Bing 实际照片' : '离线纹理夹具'}`)
      for (const mode of ['light', 'dark']) {
        await win.evaluate((mode) => {
          document.documentElement.dataset.mode = mode
          document.documentElement.classList.toggle('dark', mode === 'dark')
        }, mode)
        await win.waitForTimeout(650)
        for (const state of ['home', 'organizer', 'folder']) {
          if (state === 'organizer') await win.locator('.hp-root').dispatchEvent('contextmenu')
          if (state === 'folder') await win.click('.hp-spaces .hp-folder')
          await win.waitForTimeout(650)
          const out = path.join(os.tmpdir(), `forsion-homepage.glass-${mode}-${state}.png`)
          await win.screenshot({ path: out })
          console.log(`截图 → ${out}`)
          if (state !== 'home') await win.click(state === 'organizer' ? '.hp-organizer-head > button' : '.hp-folder-head > button')
          await win.waitForTimeout(400)
        }
      }
    }
    check('交互过程中没有未捕获的渲染异常', pageErrors.length === 0, pageErrors)
  } finally {
    await app?.close().catch(() => {})
    stub.close()
    fs.rmSync(testHome, { recursive: true, force: true })
  }
  console.log(`${results.filter((r) => r.ok).length}/${results.length} 通过`)
  process.exitCode = results.some((r) => !r.ok) ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
