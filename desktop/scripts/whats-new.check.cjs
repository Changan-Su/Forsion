#!/usr/bin/env node
// What's new 弹窗的真机检查:隔离 home 起已构建的桌面端(先 npm run build),走两条入口并截图。
//   ① 设置(独立浮窗)→ 关于 →「What's new」→ 弹在主窗,官网文章加载出来;点一个历史版本切换正文。
//   ② 主进程广播「有新版本」→ 自动弹出;点「跳过这个版本」后同一版本再广播不再弹。
//   ③ 下载来源(10-19):底栏小字随状态变(从哪儿下 / 自动换源 / mac 点过下载安装包);设置 → 关于「下载来源」写进 config.json。
//      dev 构建跑不了真的检查 / 下载(unsupported),主进程那半由 electron/updater.test.ts 管,这里只验渲染层接线。
// 跑:node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="whats-new" --eta=3 -- node scripts/whats-new.check.cjs
// 截图写到 OUT(缺省 /tmp/whats-new-check)。需要能上 forsion.net(连不上时正文退回 CHANGELOG,第 ① 步会报出来)。
const fs = require('fs'); const os = require('os'); const path = require('path')
const DESK = path.resolve(__dirname, '..')
const electron = require('./lib/launch-electron.cjs')
const OUT = process.env.OUT || path.join(os.tmpdir(), 'whats-new-check'); fs.mkdirSync(OUT, { recursive: true })
const fails = []
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails.push(msg) }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-whatsnew-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', DESK], cwd: DESK,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1' },
  })
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1512, 950))
    await win.waitForSelector('#root', { timeout: 60_000 }); await win.waitForTimeout(2500)
    const skipOb = win.locator('text=跳过引导').first(); if (await skipOb.count().catch(() => 0)) await skipOb.click().catch(() => {})
    await win.waitForSelector('.dv-groupview', { timeout: 60_000 }); await win.waitForTimeout(1200)

    // ① 设置浮窗 → 关于 → What's new
    const before = new Set(app.windows())
    await win.click('.rb-btn[aria-label="设置"]'); await win.waitForTimeout(2500)
    const sw = app.windows().find((w) => !before.has(w))
    ok(!!sw, '设置开成独立浮窗')
    if (sw) {
      await sw.evaluate(() => { const el = [...document.querySelectorAll('button, a, li, div')].reverse().find((e) => e.textContent.trim() === '关于' && e.children.length < 3); el?.click() })
      await sw.waitForSelector('[data-testid="about-whats-new"]', { timeout: 10_000 })
      await sw.click('[data-testid="about-whats-new"]')
    }
    await win.waitForSelector('.wn-modal', { timeout: 10_000 })
    ok(sw ? (await sw.$('.wn-modal')) === null : true, '弹窗没有开在设置浮窗里')
    const loaded = await win.waitForSelector('.wn-article .amadeus-published', { timeout: 20_000 }).then(() => true).catch(() => false)
    ok(loaded, '官网文章加载出来(.amadeus-published)')
    const info = await win.evaluate(() => ({
      vers: [...document.querySelectorAll('.wn-ver .wn-ver-name')].map((e) => e.textContent),
      groups: [...document.querySelectorAll('.wn-group')].map((e) => e.textContent),
      title: document.querySelector('.wn-title')?.textContent,
      imgs: document.querySelectorAll('.wn-article img').length,
      offline: !!document.querySelector('.wn-note'),
    }))
    console.log('  ', JSON.stringify({ ...info, vers: `${info.vers.length} 个:${info.vers.slice(0, 4).join(' / ')} …` }))
    ok(info.vers.length > 10, '左栏列出历史版本')
    ok(!info.offline, '没有走离线回退')
    await win.waitForTimeout(2500) // 等 GIF 首帧
    await win.screenshot({ path: path.join(OUT, '1-manual-light.png') })
    // 点一个只在 CHANGELOG 里的老版本
    const old = await win.evaluate(() => { const b = [...document.querySelectorAll('.wn-ver')].find((e) => /^2\.10\./.test(e.textContent || '')); b?.click(); return b?.querySelector('.wn-ver-name')?.textContent })
    await win.waitForTimeout(600)
    const oldView = await win.evaluate(() => ({ title: document.querySelector('.wn-title')?.textContent, li: document.querySelectorAll('.wn-article li').length }))
    ok(!!old && oldView.li > 0, `切到历史版本 ${old} 显示更新日志条目(${oldView.li} 条)`)
    await win.screenshot({ path: path.join(OUT, '2-history-light.png') })
    await win.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'dark'; r.classList.add('dark') })
    await win.evaluate(() => (document.querySelector('.wn-ver') )?.click()); await win.waitForTimeout(1500)
    await win.screenshot({ path: path.join(OUT, '3-manual-dark.png') })
    await win.keyboard.press('Escape'); await win.waitForTimeout(400)
    ok(!(await win.$('.wn-modal')), 'Esc 关闭')
    await win.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'light'; r.classList.remove('dark') })

    // ② 主进程广播「有新版本」→ 自动弹出 → 跳过 → 再广播不弹
    const announce = (v) => app.evaluate(({ BrowserWindow }, ver) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('updater:status', { phase: 'available', version: ver, releaseNotes: '- 演示用的更新说明' }) }, v)
    await announce('9.9.9')
    const popped = await win.waitForSelector('.wn-modal', { timeout: 8000 }).then(() => true).catch(() => false)
    ok(popped, '检测到新版本自动弹出')
    if (popped) {
      const head = await win.evaluate(() => ({ head: document.querySelector('.wn-head b')?.textContent, top: document.querySelector('.wn-ver.on .wn-ver-name')?.textContent, foot: [...document.querySelectorAll('.wn-foot button')].map((b) => b.textContent.trim()) }))
      console.log('  ', JSON.stringify(head))
      ok(/9\.9\.9/.test(head.head || '') && /9\.9\.9/.test(head.top || ''), '标题与左栏首项是新版本')
      await win.screenshot({ path: path.join(OUT, '4-auto-available.png') })
      await win.locator('.wn-foot button', { hasText: '跳过这个版本' }).click(); await win.waitForTimeout(300)
      ok(!(await win.$('.wn-modal')), '「跳过这个版本」关闭弹窗')
      await announce('9.9.9'); await win.waitForTimeout(1200)
      ok(!(await win.$('.wn-modal')), '跳过的版本再广播不再弹')
    }

    // ③ 下载来源:底栏小字 + 设置里的「下载来源」
    const send = (st) => app.evaluate(({ BrowserWindow }, x) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('updater:status', x) }, st)
    const caption = () => win.evaluate(() => document.querySelector('.wn-foot .upd-src')?.textContent || '')
    await send({ phase: 'available', version: '9.9.8', releaseNotes: '- 演示', source: 'github', size: 447947415 })
    await win.waitForSelector('.wn-modal', { timeout: 8000 }); await win.waitForTimeout(400)
    ok((await caption()) === '从 GitHub 下载 · 427 MB', `有新版:小字写来源和大小(${await caption()})`)
    await send({ phase: 'downloading', version: '9.9.8', releaseNotes: '- 演示', percent: 7, source: 'github', fallbackFrom: 'website', transferred: 31 * 1048576, total: 447947415, canSwitch: true })
    await win.waitForTimeout(300)
    ok((await caption()) === '官网下不动，已改从 GitHub 重新下 · 31 MB / 427 MB换官网', `自动换源:小字 + 「换官网」(${await caption()})`)
    await win.screenshot({ path: path.join(OUT, '5-source-fallback.png') })
    await send({ phase: 'available', version: '9.9.8', releaseNotes: '- 演示', source: 'website', size: 509163663, opened: true })
    await win.waitForTimeout(300)
    const foot = await win.evaluate(() => [...document.querySelectorAll('.wn-foot button')].map((b) => b.textContent.trim()))
    ok((await caption()).startsWith('安装包在浏览器里下载') && !foot.includes('跳过这个版本') && foot.includes('关闭'), `mac 点过下载安装包:只剩说明和关闭(${foot.join(' / ')})`)
    await win.keyboard.press('Escape'); await win.waitForTimeout(300)
    const before3 = new Set(app.windows())
    await win.click('.rb-btn[aria-label="设置"]'); await win.waitForTimeout(2500)
    const sw3 = app.windows().find((w) => !before3.has(w)) || app.windows().find((w) => w !== win)
    if (sw3) {
      await sw3.evaluate(() => { const el = [...document.querySelectorAll('button, a, li, div')].reverse().find((e) => e.textContent.trim() === '关于' && e.children.length < 3); el?.click() })
      const row = await sw3.waitForSelector('[data-testid="about-update-source"]', { timeout: 10_000 }).then(() => true).catch(() => false)
      ok(row, '设置 → 关于有「下载来源」')
      if (row) {
        const active = await sw3.evaluate(() => document.querySelector('[data-testid="about-update-source"] .seg button.active')?.textContent)
        ok(active === '自动', `缺省是「自动」(${active})`)
        await sw3.click('[data-testid="about-update-source"] .seg button:has-text("GitHub")'); await sw3.waitForTimeout(800)
        const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
        ok(cfg?.updater?.source === 'github', `选 GitHub 写进 config.json(${JSON.stringify(cfg?.updater)})`)
        await sw3.evaluate(() => document.querySelector('[data-testid="about-update-source"]')?.scrollIntoView({ block: 'center' })); await sw3.waitForTimeout(300)
        await sw3.screenshot({ path: path.join(OUT, '6-settings-source.png') })
      }
    }
  } finally { await app.close() }
  console.log(fails.length ? `\n✗ ${fails.length} 项失败` : `\n✓ 全部通过;截图在 ${OUT}`)
  process.exitCode = fails.length ? 1 : 0
}
main().catch((e) => { console.error(e); process.exit(1) })
