/**
 * 「Forsion 云端」个人中心（Extend 渲染半身画的账号 / 额度与积分 / 安全 / 用量记录 / 反馈 + 宿主的同步 / 连接）
 * × 真 Electron × 假云端（scripts/lib/fake-forsion-cloud.cjs，按 server 真实响应形状回数据）：预置已登录态，
 * 逐页打开、断言确实画出了内容且没有页面报错，并截图供人看（观感改动交付前自查真实截图，DESIGN §8）。
 *
 * 需先 npm run build（读 out/），且 node_modules/@forsion/extend 是带渲染半身页面的版本（≥ 0.5.0）。
 * 用法：node scripts/account-center.shot.cjs [--lang=en] [--out=<目录>]   截图默认落 $TMPDIR/forsion-account-center/
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { startFakeForsionCloud } = require('./lib/fake-forsion-cloud.cjs')

const ROOT = path.join(__dirname, '..')
const LANG = (process.argv.find((a) => a.startsWith('--lang=')) || '--lang=zh').slice(7) === 'en' ? 'en' : 'zh'
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || path.join(os.tmpdir(), 'forsion-account-center')
const EXPECT = LANG === 'en'
  ? ['Account', 'Quota & points', 'Backpack', 'Security', 'Usage', 'Feedback', 'Cloud sync', 'Connection']
  : ['账号', '额度与积分', '背包', '安全', '用量记录', '反馈', '云端同步', '连接']

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-account-center-'))
  const stub = await startStubEngine({ models: [{ id: 'm1', name: 'Stub', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off'] }] })
  const cloud = await startFakeForsionCloud({ scenario: 'both' })
  // JWT 形状:账号 id 取 payload 的 userId(shared/forsionAccount.ts)。给个不透明串的话账号 id 为空,云同步会把人当成没登录。
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: 'u1', username: 'demo_user' })}.e2e`
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud.url, token }))
  const logs = []
  const pageErrors = []
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, `--lang=${LANG === 'en' ? 'en-US' : 'zh-CN'}`, ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 90_000,
  })
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => logs.push(String(d)))
  try {
    const win = await app.firstWindow({ timeout: 120_000 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(1500)
    const skip = win.getByRole('button', { name: LANG === 'en' ? 'Skip onboarding' : '跳过引导', exact: true })
    if (await skip.count()) await skip.click()
    await win.evaluate(([n]) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'forsion', n } }), [Date.now()])
    let sp = null
    for (let i = 0; i < 80 && !sp; i++) {
      for (const w of app.windows()) if (w.url().includes('window=floating') && await w.locator('.settings-page').count().catch(() => 0)) sp = w
      if (!sp) await win.waitForTimeout(250)
    }
    if (!sp) throw new Error('设置浮窗没出来')
    sp.on('pageerror', (e) => pageErrors.push(String(e?.message || e)))
    await sp.setViewportSize({ width: 1100, height: 820 }).catch(() => {})
    // Extend 的渲染半身是异步装载的:等五个子页都注册上
    await sp.waitForFunction((n) => document.querySelectorAll('#settings-nav-subitems-forsion .settings-nav-subitem').length >= n, EXPECT.length, { timeout: 20_000 }).catch(() => {})
    const subs = await sp.$$eval('#settings-nav-subitems-forsion .settings-nav-subitem', (bs) => bs.map((b) => b.innerText.trim()))
    check(`「Forsion 云端」子页 = ${EXPECT.join(' / ')}`, subs.join('|') === EXPECT.join('|'), JSON.stringify(subs))
    for (const [i, label] of subs.entries()) {
      await sp.locator('#settings-nav-subitems-forsion .settings-nav-subitem').nth(i).click()
      await sp.waitForTimeout(1200)
      const body = await sp.evaluate(() => {
        const host = document.querySelector('[data-plugin-settings]')
        const b = document.querySelector('.settings-body')
        if (b) b.scrollTop = 0
        return { plugin: host?.getAttribute('data-plugin-settings') || null, pluginChildren: host?.childElementCount ?? 0, text: (b?.innerText || '').slice(0, 160).replace(/\s+/g, ' ') }
      })
      const isExtend = i < 6
      check(`${label}:画出了内容`, isExtend ? body.pluginChildren > 0 : body.text.length > 20, JSON.stringify(body))
      await sp.screenshot({ path: path.join(OUT, `${LANG}-${String(i + 1).padStart(2, '0')}-${label.replace(/[^\p{L}\p{N}]+/gu, '_')}.png`) })
    }
    // 页内跳转:账号页点「手机」那一行 → ctx.app.openSettings('forsion/fx:forsion-extend:security') → 窗口事件 →
    // 应用层 openSettings → openFloatingPanel 从设置浮窗自己身上重定向 —— 左栏当前项应变成「安全」
    await sp.locator('#settings-nav-subitems-forsion .settings-nav-subitem').first().click()
    await sp.waitForSelector('[data-plugin-settings="forsion-extend:account"] .fx-link-row', { timeout: 10_000 }).catch(() => {})
    await sp.locator('[data-plugin-settings="forsion-extend:account"] .fx-link-row').first().click().catch(() => {})
    const jumped = await sp.waitForFunction((want) => document.querySelector('#settings-nav-subitems-forsion .settings-nav-subitem.active')?.textContent?.trim() === want,
      EXPECT[3], { timeout: 8_000 }).then(() => true, () => false)
    const activeNow = await sp.$eval('#settings-nav-subitems-forsion .settings-nav-subitem.active', (b) => b.textContent.trim()).catch(() => null)
    check(`页内跳转:账号页点「手机」→ 左栏落到「${EXPECT[3]}」(ctx.app.openSettings 在设置浮窗里真走通)`, jumped, `active=${activeNow}`)

    // 头像菜单 → 设置中的同一背包页，走真实窗口路由。
    await win.locator('.ribbon-account:visible, .account-card:visible').first().click()
    await win.locator('.account-pop').waitFor()
    const backpackLabel = EXPECT[2]
    check('头像菜单包含背包', await win.getByRole('button', { name: backpackLabel, exact: true }).count() === 1)
    await win.screenshot({ path: path.join(OUT, `${LANG}-backpack-menu.png`) })
    await win.getByRole('button', { name: backpackLabel, exact: true }).click()
    await sp.waitForSelector('[data-fx-page="backpack"] .fx-backpack-grid')
    check('头像菜单背包入口关闭菜单并跳到背包页', await win.locator('.account-pop').count() === 0 && await sp.locator('[data-fx-page="backpack"]').count() === 1)
    check('真实云端背包:重置卡与自定义礼包叠放、卡券逐件占格', await sp.locator('button.fx-backpack-slot').count() === 4 && (await sp.locator('.fx-backpack-count').allTextContents()).join('|') === '×2|×2')
    check('查看物品前未拉卡密', !cloud.requests.some((r) => r.path.startsWith('/api/shop/inventory/')))
    await sp.locator('button.fx-backpack-slot').first().click()
    await sp.screenshot({ path: path.join(OUT, `${LANG}-backpack-light.png`) })
    await sp.locator('button.fx-backpack-slot').nth(1).click()
    await sp.getByRole('button', { name: LANG === 'en' ? 'Reveal key' : '查看卡密', exact: true }).click()
    await sp.locator('.fx-backpack-reveal code').waitFor()
    check('揭示卡密经真实 cloud:fetch 返回当前物品', await sp.locator('.fx-backpack-reveal code').textContent() === 'DEMO-VOUCHER-KEY')
    await sp.getByRole('button', { name: LANG === 'en' ? 'Cloud gift, quantity 2' : '云端礼包，数量 2', exact: true }).click()
    check('自定义物品按语言展示名称、说明与使用效果', (await sp.locator('.fx-backpack-effects').innerText()).includes('100') && await sp.getByRole('button', { name: LANG === 'en' ? 'Open gift' : '打开礼包', exact: true }).count() === 1)
    await sp.screenshot({ path: path.join(OUT, `${LANG}-item-use-light.png`) })
    await sp.getByRole('button', { name: LANG === 'en' ? 'Open gift' : '打开礼包', exact: true }).click()
    check('使用按钮先确认而不直接核销', !cloud.requests.some((r) => r.path.endsWith('/use') && r.path.includes('/inventory/')))
    await sp.getByRole('button', { name: LANG === 'en' ? 'Confirm use' : '确认使用', exact: true }).click()
    await sp.locator('.fx-backpack-used[role="status"]').waitFor()
    await sp.waitForFunction(() => [...document.querySelectorAll('.fx-backpack-count')].map((e) => e.textContent).join('|') === '×3|×1')
    check('使用通过真实 IPC 核销一件礼包、显示成功效果并刷新奖励重置卡', cloud.requests.filter((r) => r.path === '/api/shop/inventory/gift-1/use').length === 1 && (await sp.locator('.fx-backpack-used').innerText()).includes('100'))
    check('同一叠放格的下一件物品重新要求确认', await sp.getByRole('button', { name: LANG === 'en' ? 'Open gift' : '打开礼包', exact: true }).count() === 1 && await sp.getByRole('button', { name: LANG === 'en' ? 'Confirm use' : '确认使用', exact: true }).count() === 0)
    await sp.waitForTimeout(850)
    await sp.screenshot({ path: path.join(OUT, `${LANG}-item-used-light.png`) })
    await sp.evaluate(() => { document.documentElement.setAttribute('data-mode', 'dark'); document.documentElement.classList.add('dark') })
    await sp.waitForTimeout(350)
    await sp.screenshot({ path: path.join(OUT, `${LANG}-backpack-dark.png`) })
    await app.evaluate(({ BrowserWindow }, url) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)
      w?.setContentSize(640, 740)
    }, sp.url())
    await sp.setViewportSize({ width: 640, height: 740 })
    await sp.waitForTimeout(300)
    const geometry = await sp.evaluate(() => {
      const grid = document.querySelector('.fx-backpack-grid').getBoundingClientRect()
      const detail = document.querySelector('.fx-backpack-detail').getBoundingClientRect()
      const body = document.querySelector('.settings-body')
      const gridElement = document.querySelector('.fx-backpack-grid')
      return { width: innerWidth, below: detail.top >= grid.bottom, overflow: body.scrollWidth > body.clientWidth + 1,
        gridHeight: grid.height, gridScrolls: gridElement.scrollHeight > gridElement.clientHeight }
    })
    check('640px 窄窗口:详情在格子下方且无横向溢出', geometry.width === 640 && geometry.below && !geometry.overflow, JSON.stringify(geometry))
    check('窄窗口格子区限制高度并可滚动,详情可达', geometry.gridHeight <= 280 && geometry.gridScrolls)
    await sp.screenshot({ path: path.join(OUT, `${LANG}-backpack-narrow.png`) })

    const hits = cloud.requests.filter((r) => r.path.startsWith('/api/')).map((r) => `${r.method} ${r.path}${r.authed ? '' : ' (no token)'}`)
    // 公开端点本就不带 token:/features(功能开关)、/auth/region(首屏语言的 IP 区域探测,非中文系统才会打)
    const unauthed = cloud.requests.filter((r) => !r.authed && !['/api/features', '/api/auth/region'].includes(r.path)).map((r) => `${r.method} ${r.path}`)
    check('云端请求都带着 token(token 留主进程,经 cloud:fetch 盖上)', unauthed.length === 0, unauthed.length ? `没带 token:${[...new Set(unauthed)].join(', ')}` : [...new Set(hits)].join(', ').slice(0, 400))
    check('没有页面报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' / '))
  } catch (e) {
    for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(OUT, `${LANG}-failure-${i}.png`) }).catch(() => {})
    check('台架本身没炸', false, String(e?.stack || e).slice(0, 400))
  } finally {
    await app.close().catch(() => {})
    await cloud.close()
    stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  console.log(`\n截图 → ${OUT}`)
  process.exit(failed ? 1 : 0)
})()
