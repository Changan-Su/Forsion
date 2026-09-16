/**
 * 仪表盘标签的前进/后退、最近使用、树行高亮 —— 真 Electron × 真 bootstrapEngine 订阅 × 真磁盘。
 * 2026-09-16:view 早在 P3a 改注册成 'dashboard',而导航历史/最近使用那张参数表只认旧的
 * 'amadeus-dashboard'、树行高亮那张压根没有 → 箭头恒灰、最近使用里没有仪表盘、聚焦仪表盘时树上亮错行。
 * 这条只可能在真引擎里看见:check:nav 用的是 harness 假视图,不跑 installEngine 的订阅。
 * ⚠️ 光补表还不够(本仪器实测):仪表盘往 pageStore 里 loadPage,amadeusViews 的笔记历史订阅会再记一条
 *    amadeus:X.dashboard.md → 同一页两条,后退空按、复原后前进段被截、最近使用重复。N4/N5/N7/N6 钉的就是它。
 *
 *   N1 同一标签:笔记 → 树上点仪表盘,就地打开,树上亮的是仪表盘这行,后退可点
 *   N2 后退一下就回到笔记(没有死按键),前进可点
 *   N3 前进回到仪表盘视图 —— 不是把仪表盘文件塞进笔记编辑器
 *   N4 同类型就地跳:仪表盘 → 另一份仪表盘 → 后退回到前一份(dashPath 真换回去)
 *   N5 再后退一下回到笔记
 *   N7 连按两下前进回到最后一份,且到头(复原没截掉前进段)
 *   N6 新标签页的「最近使用」里仪表盘恰好一条、且是文件档
 *   KNOWN(不计分)既有竞态:编辑器 → 仪表盘就地切换时,编辑器卸载把同名 scope store 摘成孤儿,
 *         DashboardRouter 装进孤儿、自己换到新建的空 store 后不再重装 → 永久骨架屏。修好后这行会报「不复现」。
 *
 * 用法:npm run build && node scripts/dashboard-nav.e2e.cjs   (--shot 存截图到 /tmp/forsion-dashnav-*.png)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const SHOT = process.argv.includes('--shot')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-dashnav-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'Vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, 'Alpha-note.md'), '# Alpha\n\n正文。\n', 'utf8')
  fs.writeFileSync(path.join(vault, 'Dash-one.dashboard.md'), '---\ntitle: Dash-one\n---\n', 'utf8')
  fs.writeFileSync(path.join(vault, 'Dash-two.dashboard.md'), '---\ntitle: Dash-two\n---\n', 'utf8')
  // ⚠️ 四份配置全种:未打包时 userData 是 `<dir>-dev`,只种一份会打开本机真 dev 库(sidebar-drop 同款)。
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) {
      fs.writeFileSync(path.join(dir, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2), 'utf8')
    }
  }

  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
    })
    const win = await app.firstWindow()
    const logs = []
    win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
    const shot = async (name) => { if (SHOT) await win.screenshot({ path: `/tmp/forsion-dashnav-${name}.png` }).catch(() => {}) }

    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('.rb-space[title="Note"], .rb-space:has-text("Note")').first().click({ timeout: 15_000 })
    await win.waitForSelector('.t2s-srow:has-text("Dash-two")', { timeout: 20_000 })

    /** 主区此刻显示什么(读 DOM,不信 store 自证)。箭头取带箭头的第一个主区组。 */
    const state = () => win.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const inSide = (e) => !!e.closest('.t2s-side')
      const btns = [...document.querySelectorAll('.dv-nav-btn')]
      return {
        dash: [...document.querySelectorAll('.dash3-host, .dash2-host')].filter((e) => vis(e) && !inSide(e)).length,
        editor: [...document.querySelectorAll('.ProseMirror')].filter((e) => vis(e) && !inSide(e) && !e.closest('.dash3-host, .dash2-host')).length,
        tabs: [...document.querySelectorAll('.dv-tab')].map((e) => (e.textContent || '').trim()),
        active: [...document.querySelectorAll('.dv-tab.dv-active-tab')].filter(vis).map((e) => (e.textContent || '').trim()),
        row: [...document.querySelectorAll('.t2s-srow.active')].map((e) => (e.textContent || '').trim()),
        back: !!btns[0] && !btns[0].disabled,
        fwd: !!btns[1] && !btns[1].disabled,
      }
    })
    /** 轮询到 pred 成立(或超时),返回最后一次读到的状态。 */
    const until = async (pred, ms = 8000) => {
      const end = Date.now() + ms
      let s = await state()
      while (!pred(s) && Date.now() < end) { await win.waitForTimeout(150); s = await state() }
      return s
    }
    const arrow = async (i) => { await win.locator('.dv-nav-btn').nth(i).click({ timeout: 3000 }).catch(() => {}) }
    const openRow = async (name) => { await win.locator('.t2s-srow', { hasText: name }).first().click() }
    const onNote = (s) => s.editor >= 1 && s.dash === 0 && s.active.some((x) => x.includes('Alpha'))
    const onDash = (name) => (s) => s.dash >= 1 && s.editor === 0 && s.active.some((x) => x.includes(name))

    await openRow('Alpha-note')
    const s0 = await until(onNote, 15_000)
    check('N0 夹具:笔记 Alpha 在主区编辑器里', onNote(s0), JSON.stringify(s0))

    // ── N1 同一标签就地打开仪表盘 ─────────────────────────────────────────
    await openRow('Dash-one')
    const s1 = await until((s) => s.back && s.row.some((x) => x.includes('Dash-one')), 15_000)
    await shot('n1-dash')
    check('⚠️N1 树上点仪表盘 → 同一标签就地打开,树上亮仪表盘这行(修复前回落 activePage 亮成笔记)', s1.tabs.length === s0.tabs.length && s1.row.length === 1 && s1.row[0].includes('Dash-one'), JSON.stringify(s1))
    check('⚠️N1b 后退箭头可点(修复前仪表盘不记历史,恒灰)', s1.back, JSON.stringify({ back: s1.back }))
    const s1d = await until(onDash('Dash-one'), 5000)
    console.log(onDash('Dash-one')(s1d)
      ? 'NOTE   既有竞态已不复现:编辑器 → 仪表盘就地打开直接渲染出来了(可以把这行升级成正式断言)'
      : `KNOWN  既有竞态(不计分):编辑器 → 仪表盘就地打开卡骨架屏  | ${JSON.stringify(s1d)}`)

    // ── N2 后退一次回到笔记 ───────────────────────────────────────────────
    await arrow(0)
    const s2 = await until(onNote)
    check('N2 后退一下就回到笔记 Alpha,前进可点', onNote(s2) && s2.fwd, JSON.stringify(s2))

    // ── N3 前进回到仪表盘视图 ─────────────────────────────────────────────
    await arrow(1)
    const s3 = await until(onDash('Dash-one'))
    await shot('n3-forward')
    check('⚠️N3 前进回到仪表盘视图(不是笔记编辑器里的仪表盘文件),树行跟着亮', onDash('Dash-one')(s3) && s3.row.some((x) => x.includes('Dash-one')), JSON.stringify(s3))

    // ── N4 同类型就地跳:仪表盘 → 另一份仪表盘 → 后退 ─────────────────────
    await openRow('Dash-two')
    const s4a = await until(onDash('Dash-two'))
    check('N4a 仪表盘里点另一份仪表盘 → 同一标签换成 Dash-two', onDash('Dash-two')(s4a) && s4a.tabs.length === s0.tabs.length, JSON.stringify(s4a))
    await arrow(0)
    const s4 = await until((s) => onDash('Dash-one')(s) && s.row.some((x) => x.includes('Dash-one')))
    check('⚠️N4 后退回到 Dash-one(同类型复原真把 dashPath 换回去)', onDash('Dash-one')(s4) && s4.row.some((x) => x.includes('Dash-one')), JSON.stringify(s4))

    // ── N5 再后退一次回到笔记 ─────────────────────────────────────────────
    await arrow(0)
    const s5 = await until(onNote)
    check('N5 再后退一下回到笔记 Alpha(中间没有死按键)', onNote(s5), JSON.stringify(s5))

    // ── N7 复原不截前进段:连按两下前进 → Dash-one → Dash-two ───────────────
    await arrow(1)
    const s7a = await until(onDash('Dash-one'))
    await arrow(1)
    const s7 = await until((s) => onDash('Dash-two')(s) && !s.fwd)
    check('⚠️N7 连按两下前进 → Dash-one → Dash-two,且到头(复原没把前进段截掉、没有重复条目)', onDash('Dash-one')(s7a) && onDash('Dash-two')(s7) && !s7.fwd, JSON.stringify({ s7a, s7 }))

    // ── N6 最近使用 ──────────────────────────────────────────────────────
    await win.click('.dv-new-tab')
    await win.waitForSelector('.newtab', { timeout: 15_000 })
    await win.waitForTimeout(600)
    const labels = await win.$$eval('.newtab .newtab-card-label', (es) => es.map((e) => (e.textContent || '').trim()))
    await shot('n6-recents')
    // 文件档条目(按仪表盘视图重开)恰好一条;笔记订阅那份 `Dash-one.dashboard`(note 档)不许再出现。
    const one = labels.filter((x) => x.includes('Dash-one'))
    check('⚠️N6 新标签页「最近使用」里仪表盘恰好一条、且是文件档', one.length === 1 && one[0] === 'Dash-one.dashboard.md', JSON.stringify(labels))

    if (logs.length) console.log('LOGS\n' + logs.slice(0, 10).join('\n'))
  } finally {
    await app?.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} passed / ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
