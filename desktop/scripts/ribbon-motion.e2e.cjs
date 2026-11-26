/** Ribbon 开合零位移(2026-11-26,方案页 docs/ToBeImproved/胶囊收起与Ribbon过渡方案_2026-11-26/ribbon.html,用户选建议)。
 *  真 Electron(out/ 构建)+ 假引擎 + 隔离 home,不冻结、1× 逐帧(rAF)采样,点 Ribbon 顶上的折叠钮开 / 合各一次:
 *   · 条上每颗图标(折叠钮、主位、Space 区、最近使用、命令区)和账号头像:单帧位移 ≤ 0.5px、全程 ≤ 0.5px;
 *     原来展开行高 34、账号换两行卡、对齐居中 ↔ 靠左,上区往下推 17px、命令区往上顶 24px、收起那帧横移 43px;
 *   · 图标宽度不低于首帧的 95%(原来字一挂上 18px 图标被 flex 压成 1.7px 的小点);
 *   · 名字:展开后可见、收起后 visibility:hidden(台架不会点到看不见的字);
 *   · 条宽确实在补间(中间帧落在两端之间),会话栏(紧挨 Ribbon 的那一列)左缘与 Ribbon 右缘的差每帧记下来(报数,超过 2px 判红)。
 *  负对照:RBM_ROOT=<main 检出的 desktop>(要有 out/ 构建)跑,位移与最小宽度两条必须红。
 *  用法:npm run build && node scripts/ribbon-motion.e2e.cjs [--shots=<目录>] */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = process.env.RBM_ROOT || path.resolve(__dirname, '..')
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const SHOTS = arg('shots', '')
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const fails = []
let passed = 0
function check(name, ok, detail) { if (ok) { passed++; console.log('PASS ' + name) } else { fails.push(name); console.log('FAIL ' + name + ' ' + JSON.stringify(detail).slice(0, 700)) } }

/** 点折叠钮,页内按 rAF 采样 ms 毫秒:每颗图标中心与宽、条宽、会话栏左缘。 */
async function film(win, ms) {
  await win.evaluate((ms) => {
    const rb = document.querySelector('.rb')
    // 每颗图标每帧重新取(账号在开合时换整棵子树:头像 = 新节点;按「第几个」认,缺了记 null → 判红)
    const btnIcons = () => [...rb.querySelectorAll(':scope > :is(.rb-head, .rb-group) .rb-btn > :is(svg, .rb-more-n, .unitsw-ic)')].filter((e) => e.checkVisibility?.() !== false)
    const avatar = () => rb.querySelector(':scope > .rb-pinned .account-avatar')
    const n0 = btnIcons().length
    const pick = () => { const b = btnIcons(); return [...Array.from({ length: n0 }, (_, i) => b[i] || null), avatar()] }
    const els = pick()
    const name = (e) => (e?.closest('.rb-btn, .ribbon-account, .account-card')?.getAttribute('aria-label') || e?.closest('.rb-btn')?.className || 'avatar').slice(0, 24)
    const tog = rb.querySelector('.rb-toggle-ic')
    const side = () => {
      // 紧挨 Ribbon 右边的那一列:Ribbon 右缘再往右 2px 处、条中部那个点上的元素所在的分组
      const r = rb.getBoundingClientRect()
      // 从那个点往上找:左缘仍在 Ribbon 右边(不含 Ribbon 本身)的最外一层,就是那一列的外框
      let el = document.elementFromPoint(r.right + 2, r.top + r.height / 2), col = null
      while (el && el !== document.body) { if (el.contains(rb)) break; if (el.getBoundingClientRect().left >= r.right - 0.5) col = el; el = el.parentElement }
      return col ? col.getBoundingClientRect().left : null
    }
    const t0 = performance.now()
    const frame = () => ({
      t: Math.round(performance.now() - t0), rbw: rb.getBoundingClientRect().width, rbr: rb.getBoundingClientRect().right, side: side(),
      ic: pick().map((e) => { if (!e?.isConnected) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width] }),
      rot: tog ? parseFloat(getComputedStyle(tog).rotate) || 0 : null,
    })
    window.__rbFilm = { names: els.map(name), frames: [frame()] }
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    window.__rbDone = (async () => { while (performance.now() - t0 < ms) { await raf(); window.__rbFilm.frames.push(frame()) } })()
  }, ms)
  await win.locator('.rb .rb-toggle').click({ noWaitAfter: true })
  await win.evaluate(() => window.__rbDone)
  return win.evaluate(() => window.__rbFilm)
}

function judge(tag, f) {
  const { names, frames } = f
  let step = 0, stepAt = null, total = 0, totalAt = null, minW = Infinity, minAt = null
  let missing = 0
  names.forEach((n, k) => {
    missing += frames.filter((fr) => !fr.ic[k]).length
    const seq = frames.map((fr) => fr.ic[k]).filter(Boolean)
    for (let i = 1; i < seq.length; i++) {
      const d = Math.max(Math.abs(seq[i][0] - seq[i - 1][0]), Math.abs(seq[i][1] - seq[i - 1][1]))
      if (d > step) { step = d; stepAt = n }
    }
    const d = Math.max(Math.abs(seq.at(-1)[0] - seq[0][0]), Math.abs(seq.at(-1)[1] - seq[0][1]))
    if (d > total) { total = d; totalAt = n }
    for (const s of seq) if (s[2] / seq[0][2] < minW) { minW = s[2] / seq[0][2]; minAt = n } // 和自己首帧比(＋ 本来就是 16px)
  })
  check(`${tag}: 每帧都量到每颗图标(含换了节点的头像,缺 ${missing} 次)`, missing === 0, { missing })
  const rots = frames.map((fr) => fr.rot).filter((r) => r != null)
  check(`${tag}: 折叠钮转过中间角度(${rots.filter((r) => r > 5 && r < 175).length} 帧;开着外围淡出也不被吞成一跳)`, rots.filter((r) => r > 5 && r < 175).length >= 3, rots.map(Math.round))
  check(`${tag}: ${names.length} 颗图标单帧位移 ≤ 0.5px(最大 ${step.toFixed(1)},${stepAt || '-'})`, step <= 0.5, { step, stepAt })
  check(`${tag}: 全程位移 ≤ 0.5px(最大 ${total.toFixed(1)},${totalAt || '-'})`, total <= 0.5, { total, totalAt })
  check(`${tag}: 图标不被压扁(最小宽为首帧的 ${(minW * 100).toFixed(0)}%,${minAt})`, minW >= 0.95, { minW, minAt })
  const ws = frames.map((fr) => Math.round(fr.rbw))
  const lo = Math.min(ws[0], ws.at(-1)), hi = Math.max(ws[0], ws.at(-1))
  check(`${tag}: 条宽在补间(${ws[0]} → ${ws.at(-1)},中间帧 ${ws.filter((w) => w > lo && w < hi).length} 个)`, hi - lo > 40 && ws.filter((w) => w > lo && w < hi).length >= 3, ws)
  const gaps = frames.filter((fr) => fr.side != null).map((fr) => +(fr.side - fr.rbr).toFixed(1))
  const spread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : NaN
  console.log(`  会话栏左缘 − Ribbon 右缘(每帧): ${gaps.join(' ')}`)
  check(`${tag}: 会话栏与 Ribbon 同帧(差的波动 ${Number.isFinite(spread) ? spread.toFixed(1) : '量不到'}px)`, Number.isFinite(spread) && spread <= 2, gaps)
}

;(async () => {
  const stub = await startStubEngine({ models: [{ id: 'm1', name: 'Claude Sonnet 5.5', provider: 'stub', contextWindow: 200000 }], agents: [{ slug: 'arioso', name: 'Arioso', createdBy: 'user' }], engines: [], override: ({ path: p, method }) => p === '/agent/runs' && method === 'GET' ? { runs: [] } : undefined })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ribbon-motion-'))
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' } })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 860))
    await win.waitForSelector('#root')
    await skipOnboarding(win)
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.locator('.rb .rb-toggle').waitFor({ timeout: 40000 })
    await win.waitForTimeout(1500)
    // 从收起开始
    if (await win.locator('.rb.rb-expanded').count()) { await win.locator('.rb .rb-toggle').click(); await win.waitForTimeout(600) }
    const open = await film(win, 520)
    await win.waitForTimeout(300)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'ribbon-expanded.png') })
    const vis = await win.evaluate(() => [...document.querySelectorAll('.rb > :is(.rb-head, .rb-group) .rb-btn > .rb-label')].map((l) => getComputedStyle(l).visibility))
    check(`展开后名字可见(${vis.filter((v) => v === 'visible').length}/${vis.length})`, vis.length > 3 && vis.every((v) => v === 'visible'), vis)
    judge('展开', open)
    const close = await film(win, 520)
    await win.waitForTimeout(300)
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'ribbon-collapsed.png') })
    const hid = await win.evaluate(() => [...document.querySelectorAll('.rb > :is(.rb-head, .rb-group) .rb-btn > .rb-label')].map((l) => getComputedStyle(l).visibility))
    check(`收起后名字 visibility:hidden(${hid.filter((v) => v === 'hidden').length}/${hid.length})`, hid.length > 3 && hid.every((v) => v === 'hidden'), hid)
    judge('收起', close)
  } finally {
    await app?.close().catch(() => {})
    await stub.close?.()
    fs.rmSync(home, { recursive: true, force: true })
  }
  console.log(`\n${passed} passed, ${fails.length} failed`)
  if (fails.length) { console.log(fails.map((f) => ' - ' + f).join('\n')); process.exit(1) }
})().catch((e) => { console.error(e); process.exit(1) })
