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
  ? ['Account', 'Quota & points', 'Security', 'Usage', 'Feedback', 'Cloud sync', 'Connection']
  : ['账号', '额度与积分', '安全', '用量记录', '反馈', '云端同步', '连接']

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
      const isExtend = i < 5
      check(`${label}:画出了内容`, isExtend ? body.pluginChildren > 0 : body.text.length > 20, JSON.stringify(body))
      await sp.screenshot({ path: path.join(OUT, `${LANG}-${String(i + 1).padStart(2, '0')}-${label.replace(/[^\p{L}\p{N}]+/gu, '_')}.png`) })
    }
    // 页内跳转:账号页点「手机」那一行 → ctx.app.openSettings('forsion/fx:forsion-extend:security') → 窗口事件 →
    // 应用层 openSettings → openFloatingPanel 从设置浮窗自己身上重定向 —— 左栏当前项应变成「安全」
    await sp.locator('#settings-nav-subitems-forsion .settings-nav-subitem').first().click()
    await sp.waitForSelector('[data-plugin-settings="forsion-extend:account"] .fx-link-row', { timeout: 10_000 }).catch(() => {})
    await sp.locator('[data-plugin-settings="forsion-extend:account"] .fx-link-row').first().click().catch(() => {})
    const jumped = await sp.waitForFunction((want) => document.querySelector('#settings-nav-subitems-forsion .settings-nav-subitem.active')?.textContent?.trim() === want,
      EXPECT[2], { timeout: 8_000 }).then(() => true, () => false)
    const activeNow = await sp.$eval('#settings-nav-subitems-forsion .settings-nav-subitem.active', (b) => b.textContent.trim()).catch(() => null)
    check(`页内跳转:账号页点「手机」→ 左栏落到「${EXPECT[2]}」(ctx.app.openSettings 在设置浮窗里真走通)`, jumped, `active=${activeNow}`)

    const hits = cloud.requests.filter((r) => r.path.startsWith('/api/')).map((r) => `${r.method} ${r.path}${r.authed ? '' : ' (no token)'}`)
    // 公开端点本就不带 token:/features(功能开关)、/auth/region(首屏语言的 IP 区域探测,非中文系统才会打)
    const unauthed = cloud.requests.filter((r) => !r.authed && !['/api/features', '/api/auth/region'].includes(r.path)).map((r) => `${r.method} ${r.path}`)
    check('云端请求都带着 token(token 留主进程,经 cloud:fetch 盖上)', unauthed.length === 0, unauthed.length ? `没带 token:${[...new Set(unauthed)].join(', ')}` : [...new Set(hits)].join(', ').slice(0, 400))
    check('没有页面报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' / '))
  } catch (e) {
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
