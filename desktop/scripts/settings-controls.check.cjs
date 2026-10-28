/**
 * check:settingscontrols —— 设置页控件统一(10-25 走查续五 5.1–5.4)的真 Electron 台架。
 * 方案页:仓根 docs/ToBeImproved/走查续五_可优化点方案_2026-10-25/index.html(§2 的 5.1–5.4、§4 的细节)。
 *
 * 桩引擎(lib/stub-engine.cjs)+ 隔离 home;量的是 out/ 产物 —— 改了源码先 `npx electron-vite build`。
 *  5.1 收件箱 / 界面与会话 / 关于 / 外观 / 内置功能 / Hooks:页面上没有原生复选框,二态设置是 .settings-switch;外观页没有旧的 button.switch;
 *      点收件箱那颗开关 aria-checked 会翻。
 *  5.2 常规 › 基本、技能库工具栏:同一行的输入框 / 下拉 / 按钮一样高(34),刷新键 34 × 34。
 *  5.3 技能库:「这里还没有技能。」只出现一次;一个技能都没有时右栏是公共空态(还没有技能 + 添加技能 + 从其他 Agent 导入);
 *      导入子页标题 = 「从其他 Agent 导入」,左栏那一项一行放得下。
 *  5.4 Hooks:页头一张卡,协议说明用代码样式,「新建 Hook」左对齐、在卡里。
 * 截图(亮 / 暗、英文)落 SHOT_DIR(缺省系统临时目录 forsion-settingscontrols-shots),DESIGN §8:断言全绿 ≠ 看起来对,自己看。
 *
 * 用法:cd desktop && npx electron-vite build && npm run check:settingscontrols
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, sleep, shotDir, makeReporter } = require('./lib/uiux-electron.cjs')

const OUT = shotDir('settingscontrols')
const { check, note, summary } = makeReporter()

async function main() {
  const { app, win, close } = await launch({ tag: 'settingscontrols', overrideHome: true })
  const floating = () => app.windows().filter((x) => !x.isClosed() && x.url().includes('window=floating')).pop()
  const capture = async (name) => {
    const b64 = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed() && x.webContents.getURL().includes('window=floating')).sort((a, b) => b.id - a.id)[0]
      return w ? (await w.capturePage()).toPNG().toString('base64') : null
    })
    if (b64) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(b64, 'base64'))
  }
  /** 开设置浮窗到某一页(与方案页出图同一种开法),可选切明暗。 */
  const open = async (tab, mode = 'light') => {
    const old = floating(); if (old) { await old.close().catch(() => {}); await sleep(300) }
    await win.evaluate(([n, t]) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: t, n } }), [Date.now(), tab])
    let f = null
    for (let i = 0; i < 80 && !f; i++) { const w = floating(); if (w && await w.locator('.settings-page').count().catch(() => 0)) f = w; else await sleep(250) }
    if (!f) throw new Error(`设置浮窗没出来:${tab}`)
    await sleep(1100)
    await f.evaluate((m) => { const r = document.documentElement; r.dataset.mode = m; r.classList.toggle('dark', m === 'dark') }, mode)
    await sleep(250)
    return f
  }
  const checkboxes = (f) => f.locator('.settings-body input[type=checkbox]').count()
  const setLang = async (l) => {
    await win.evaluate((x) => localStorage.setItem('tangu_locale', x), l)
    await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 30_000 }); await sleep(1500)
  }

  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 })

    // ── 5.1 开关 ──
    let f = await open('general/g-inbox')
    check('5.1 收件箱:没有原生复选框', await checkboxes(f) === 0)
    // 收件箱这颗只量结构:inboxNotifyEnabled 不在主进程 SHELL_KEYS 里、也没人读(main 上就是死开关,另案),点了不会落盘
    check('5.1 收件箱:标题 + 说明 + 右侧开关', await f.locator('[data-setting-anchor="inbox-notify"] .settings-control-copy small').count() === 1
      && await f.locator('[data-setting-anchor="inbox-notify"] .settings-row-control .settings-switch').count() === 1)
    await capture('inbox-light')

    f = await open('advanced/a-ui')
    check('5.1 界面与会话:没有原生复选框', await checkboxes(f) === 0)
    check('5.1 界面与会话:Agent Desk 是开关行', await f.locator('.field .settings-control-row .settings-switch').count() >= 1)
    const deskSw = f.locator('.field .settings-control-row .settings-switch').first()
    const before = await deskSw.getAttribute('aria-checked').catch(() => null)
    await deskSw.click().catch((e) => note('Agent Desk 开关点击失败', String(e.message || e).split('\n')[0]))
    let after = before
    for (let i = 0; i < 20 && after === before; i++) { await sleep(150); after = await deskSw.getAttribute('aria-checked').catch(() => null) }
    check('5.1 界面与会话:点开关会落盘并翻过来', before !== null && after !== null && before !== after, `${before} → ${after}`)
    await deskSw.click().catch(() => {}); await sleep(400)
    await capture('aui-light')

    f = await open('about')
    check('5.1 关于:没有原生复选框', await checkboxes(f) === 0)

    for (const mode of ['light', 'dark']) {
      f = await open('theme', mode)
      if (mode === 'light') {
        check('5.1 外观:没有原生复选框', await checkboxes(f) === 0)
        check('5.1 外观:旧的 button.switch 全换成 .settings-switch', await f.locator('button.switch').count() === 0 && await f.locator('.settings-switch').count() >= 5,
          `switch=${await f.locator('button.switch').count()} settings-switch=${await f.locator('.settings-switch').count()}`)
      } else {
        // 暗色关态:轨道比卡面亮、旋钮比轨道亮(数值契约在 check:themecontrast,这里只钉「看得见」)
        const lum = await f.evaluate(() => {
          const sw = [...document.querySelectorAll('.settings-switch:not(.active)')].find((x) => x.getBoundingClientRect().height > 0)
          if (!sw) return null
          const rgb = (c) => { const v = (c.match(/[\d.]+/g) || []).map(Number); return /^color\(/.test(c) ? v.slice(0, 3).map((x) => x * 255) : v.slice(0, 3) }
          const y = (c) => { const [r, g, b] = rgb(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
          return { knob: y(getComputedStyle(sw.firstElementChild).backgroundColor), track: getComputedStyle(sw).backgroundColor }
        })
        check('5.1 外观 · 暗色:关着的开关旋钮是亮的(不再与卡面同色)', !!lum && lum.knob > 120, JSON.stringify(lum))
      }
      await f.evaluate(() => { const e = document.querySelector('.settings-switch'); let p = e?.parentElement; while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement; if (p && e) p.scrollTop += e.getBoundingClientRect().top - p.getBoundingClientRect().top - 160 })
      await sleep(300); await capture(`theme-${mode}`)
    }

    f = await open('amadeus-plugins/pl-forsion')
    await f.evaluate(() => document.querySelectorAll('details').forEach((d) => { if (/内置功能/.test(d.querySelector('summary')?.textContent || '')) d.open = true }))
    await sleep(600)
    check('5.1 插件 › 内置功能:卡片里没有原生复选框', await f.locator('.plugin-card input[type=checkbox]').count() === 0)
    check('5.1 插件 › 内置功能:卡片右边是开关', await f.locator('.plugin-card .settings-switch').count() >= 1, `n=${await f.locator('.plugin-card .settings-switch').count()}`)
    await f.evaluate(() => { const e = [...document.querySelectorAll('summary')].find((s) => /内置功能/.test(s.textContent || '')); e?.scrollIntoView({ block: 'start' }) })
    await sleep(300); await capture('plugins-builtin-light')

    // ── 5.2 同高 ──
    f = await open('general/g-basic')
    const rows = await f.evaluate(() => [...document.querySelectorAll('.settings-inline-row')].filter((r) => r.getBoundingClientRect().height > 0)
      .map((r) => [...r.children].filter((c) => c.matches('input, select, .btn')).map((c) => Math.round(c.getBoundingClientRect().height))))
    check('5.2 常规 › 基本:同一行输入框 / 按钮都是 34', rows.length > 0 && rows.every((r) => r.every((h) => h === 34)), JSON.stringify(rows))
    await capture('basic-light')

    // ── 5.3 技能 ──
    f = await open('skills/k-library')
    await f.locator('.gsk-toolbar').waitFor({ timeout: 10_000 }).catch(() => {})
    await sleep(800)
    const bar = await f.evaluate(() => [...document.querySelectorAll('.gsk-toolbar > *')].filter((c) => c.getBoundingClientRect().height > 0)
      .map((c) => ({ c: c.className.split(' ')[0], w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) })))
    check('5.2 技能库工具栏:四件都是 34 高', bar.length >= 3 && bar.every((b) => b.h === 34), JSON.stringify(bar))
    const refresh = bar.find((b) => b.c === 'icon-btn')
    check('5.2 技能库工具栏:刷新键 34 × 34', !!refresh && refresh.w === 34, JSON.stringify(refresh))
    const emptyLines = await f.evaluate(() => [...document.querySelectorAll('.gsk-library *')].filter((e) => !e.children.length && e.textContent.trim() === '这里还没有技能。').length)
    check('5.3 技能库:「这里还没有技能。」只说一次', emptyLines === 1, `n=${emptyLines}`)
    const empty = f.locator('[data-gsk-empty]')
    check('5.3 技能库:一个技能都没有 → 右栏公共空态', await empty.count() === 1 && (await empty.locator('.empty-state-title').textContent()) === '还没有技能')
    check('5.3 空态:「添加技能」+「从其他 Agent 导入」', await empty.locator('.empty-state-action').textContent().then((s) => s.trim()) === '添加技能'
      && await empty.locator('button', { hasText: '从其他 Agent 导入' }).count() === 1)
    check('5.3 空态:不再写「选择一项技能」', await f.locator('.gsk-placeholder').count() === 0)
    const nav = await f.evaluate(() => {
      const leaf = [...document.querySelectorAll('.settings-page *')].find((e) => !e.children.length && (e.textContent || '').trim() === '从其他 Agent 导入' && e.getBoundingClientRect().height > 0 && !e.closest('.settings-body'))
      if (!leaf) return null
      const range = document.createRange(); range.selectNodeContents(leaf)
      return { tag: leaf.tagName, cls: leaf.className, lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size }
    })
    check('5.3 左栏:「从其他 Agent 导入」一行', !!nav && nav.lines === 1, JSON.stringify(nav))
    await capture('skills-light')
    await f.evaluate(() => { const r = document.documentElement; r.dataset.mode = 'dark'; r.classList.add('dark') }); await sleep(250)
    await capture('skills-dark')
    // 空态的两颗按钮真能走:「添加技能」打开新建表单
    await empty.locator('.empty-state-action').click().catch(() => {}); await sleep(400)
    check('5.3 空态「添加技能」打开新建表单', await f.locator('.gsk-form').count() === 1)

    f = await open('skills/k-discovery')
    check('5.3 导入子页:标题 = 从其他 Agent 导入', (await f.locator('.settings-main-title').textContent().catch(() => '')).trim() === '从其他 Agent 导入')
    check('5.3 导入子页:副标题说清扫描什么', /扫描这台电脑上/.test(await f.locator('.settings-main-copy p').textContent().catch(() => '')))
    await capture('discovery-light')

    // ── 5.4 Hooks ──
    f = await open('hooks')
    await f.locator('.hooks-intro').waitFor({ timeout: 10_000 }).catch(() => {})
    check('5.4 Hooks:页头一张卡,卡头一句人话', await f.locator('.hooks-intro .settings-panel-head p').count() === 1)
    check('5.4 Hooks:协议说明里 stdin / exit 2 / decision 是代码样式', await f.locator('.hooks-intro code').count() === 3)
    const geo = await f.evaluate(() => {
      const card = document.querySelector('.hooks-intro'), btn = [...card.querySelectorAll('button')].find((b) => /新建 Hook/.test(b.textContent || ''))
      if (!btn) return null
      const c = card.getBoundingClientRect(), b = btn.getBoundingClientRect()
      return { inset: Math.round(b.left - c.left), w: Math.round(b.width), cw: Math.round(c.width), ghost: btn.classList.contains('ghost') }
    })
    check('5.4 Hooks:「新建 Hook」在卡里、左对齐、描边小按钮', !!geo && geo.ghost && geo.inset <= 20 && geo.w < geo.cw / 2, JSON.stringify(geo))
    check('5.4 Hooks:页面上没有原生复选框', await checkboxes(f) === 0)
    await capture('hooks-light')

    // 英文:文案成对、没有中文漏出
    await setLang('en')
    f = await open('hooks', 'dark')
    await f.locator('.hooks-intro').waitFor({ timeout: 10_000 }).catch(() => {})
    check('5.4 Hooks · 英文:New hook', await f.locator('.hooks-intro button', { hasText: 'New hook' }).count() === 1)
    await capture('hooks-dark-en')
    f = await open('skills/k-library')
    await f.locator('[data-gsk-empty]').waitFor({ timeout: 10_000 }).catch(() => {})
    check('5.3 技能库 · 英文:No skills yet / Import from other agents', (await f.locator('[data-gsk-empty] .empty-state-title').textContent().catch(() => '')) === 'No skills yet'
      && await f.locator('[data-gsk-empty] button', { hasText: 'Import from other agents' }).count() === 1)
    await capture('skills-en')
    f = await open('about')
    note('About(英文)截图', 'beta 开关行只在宿主有 setUpdateBeta 时出现')
    await capture('about-en')
    await setLang('zh')
  } finally {
    await close()
  }
  console.log(`截图:${OUT}`)
  process.exitCode = summary() ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
