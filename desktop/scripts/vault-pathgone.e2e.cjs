/**
 * 笔记库「改名 / 删除 / 文件改动」后的两个实报症状,真 Electron × 真主进程(VaultIndex / VaultWatcher)× 真磁盘。
 * 2026-09-16 用户实报(附截图:仪表盘标签 ybp 骨架屏不走、树里已无 ybp):
 *   ① 「明明是本地文件但是一直在加载」—— 树上改名/删除仪表盘后,标签的 leaf 参数还攥着旧路径,
 *      DashboardView 的装载 effect 不重跑 = 永久骨架屏;
 *   ② 「有些明明有图标的笔记,工作区不显示图标」—— watcher 的结构回调 `void index.build()` 后立刻广播,
 *      build 先 clear 再分片重读,渲染端拉 pageIcons() 撞上半截索引,残表整表覆盖。
 *
 *   P1 夹具:N 篇带 icon 的笔记,树上 emoji 一个不少
 *   P2 外部往库里写新文件(watcher add → 重建索引 → 广播 → 树刷新)后,emoji 仍一个不少
 *   P3 树上改名正开着的仪表盘:标签不停在骨架屏、跟到新名,磁盘上是新名
 *   P4 树上删除它(标签聚焦时 = 截图场景):标签关掉,主区没有卡住的骨架屏,文件没被建回来
 *   P5 经过改名/删除这几轮结构变化后,emoji 仍一个不少
 *
 * 用法:npm run build && npm run e2e:pathgone   (--shot 存截图到 /tmp/forsion-pathgone-*.png)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const N = 200 // 图标笔记数:少了 build 快到撞不上窗口,量是负对照实测给的
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pathgone-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'Vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, '1.md'), '# 1\n', 'utf8')
  for (let i = 0; i < N; i++) {
    fs.writeFileSync(path.join(vault, `图标笔记-${String(i).padStart(3, '0')}.md`), `---\nicon: 🌟\n---\n正文 ${i}\n`, 'utf8')
  }
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
    const shot = async (name) => { if (SHOT) await win.screenshot({ path: `/tmp/forsion-pathgone-${name}.png` }).catch(() => {}) }

    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('.rb-space[aria-label="Note"], .rb-space:has-text("Note")').first().click({ timeout: 15_000 })
    await win.waitForSelector('.t2s-srow', { timeout: 20_000 })

    const emojiCount = () => win.evaluate(() => document.querySelectorAll('.t2s-srow .amx-page-emoji').length)
    const waitEmoji = async (ms) => {
      const end = Date.now() + ms
      let n = await emojiCount()
      while (n < N && Date.now() < end) { await win.waitForTimeout(250); n = await emojiCount() }
      return n
    }
    /** 主区里看得见的骨架屏 + 所有标签名。 */
    const mainState = () => win.evaluate(() => ({
      skeletons: [...document.querySelectorAll('.sk')].filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('.t2s-side')).length,
      dash: [...document.querySelectorAll('.dash3-host, .dash2-host')].filter((e) => e.getBoundingClientRect().width > 0).length,
      tabs: [...document.querySelectorAll('.dv-tab')].map((e) => (e.textContent || '').trim()),
    }))

    // ── P1 ───────────────────────────────────────────────────────────────
    const n1 = await waitEmoji(20_000)
    check(`P1 夹具:${N} 篇带图标的笔记,树上 emoji 全在`, n1 === N, `emoji=${n1}`)

    // ── P2 外部新增文件 → watcher → 重建索引 → 树刷新 ───────────────────────
    fs.writeFileSync(path.join(vault, 'ZZ-外部新增.md'), '# 外部新增\n', 'utf8')
    await win.waitForSelector('.t2s-srow:has-text("ZZ-外部新增")', { timeout: 15_000 })
    await win.waitForTimeout(2000)
    const n2 = await emojiCount()
    check('P2 外部往库里写新文件、树刷新之后,emoji 一个不少', n2 === N, `emoji=${n2}/${N}`)
    await shot('p2-icons')

    // ── 建一个仪表盘并开着(真实用户路径,同 dash3-drag)─────────────────────
    await win.click('.dv-new-tab')
    await win.waitForSelector('.newtab', { timeout: 15_000 })
    await win.waitForTimeout(600)
    await win.locator('.newtab-card', { hasText: /^新建仪表盘$|^New dashboard$/ }).first().click()
    await win.waitForTimeout(800)
    const nameInput = win.locator('.dialog input').last()
    await nameInput.fill('ybp')
    await nameInput.press('Enter')
    await win.waitForSelector('.dash3-host, .dash2-host', { timeout: 15_000 })
    await win.waitForTimeout(1500)
    const s0 = await mainState()
    check('P3.0 仪表盘 ybp 打开', s0.dash >= 1 && s0.tabs.some((x) => x.includes('ybp')) && fs.existsSync(path.join(vault, 'ybp.dashboard.md')), JSON.stringify(s0))

    // ── P3 树上改名 ───────────────────────────────────────────────────────
    await win.locator('.t2s-srow', { hasText: 'ybp.dashboard.md' }).first().click({ button: 'right' })
    await win.locator('.ctx-menu button', { hasText: '重命名' }).first().click()
    const rename = win.locator('.t2s-rename')
    await rename.fill('ZZ改名.dashboard')
    await rename.press('Enter')
    await win.waitForTimeout(3000)
    const s3 = await mainState()
    await shot('p3-renamed')
    check('P3 改名后仪表盘仍在显示,主区没有卡住的骨架屏', s3.skeletons === 0 && s3.dash >= 1, JSON.stringify(s3))
    check('P3b 标签跟到新名', s3.tabs.some((x) => x.includes('ZZ改名')) && !s3.tabs.some((x) => x.includes('ybp')), JSON.stringify(s3.tabs))
    check('P3c 磁盘上是新名', fs.existsSync(path.join(vault, 'ZZ改名.dashboard.md')) && !fs.existsSync(path.join(vault, 'ybp.dashboard.md')))

    // ── P4 树上删除(仪表盘标签聚焦时)──────────────────────────────────────
    const tabName = s3.tabs.find((x) => x.includes('ZZ改名')) ? 'ZZ改名' : 'ybp'
    await win.locator('.dv-tab', { hasText: tabName }).first().click().catch(() => {})
    await win.waitForTimeout(500)
    const rowName = fs.existsSync(path.join(vault, 'ZZ改名.dashboard.md')) ? 'ZZ改名.dashboard.md' : 'ybp.dashboard.md'
    await win.locator('.t2s-srow', { hasText: rowName }).first().click({ button: 'right' })
    await win.locator('.ctx-menu button', { hasText: '删除' }).first().click()
    await win.waitForTimeout(3000)
    const s4 = await mainState()
    await shot('p4-deleted')
    check('P4 删除后标签关掉', !s4.tabs.some((x) => x.includes('ZZ改名') || x.includes('ybp')), JSON.stringify(s4.tabs))
    check('P4b 主区没有卡住的骨架屏', s4.skeletons === 0, JSON.stringify(s4))
    check('P4c 文件没被建回来', !fs.existsSync(path.join(vault, rowName)), rowName)

    // ── P5 几轮结构变化之后图标仍全 ───────────────────────────────────────
    await win.waitForTimeout(1500)
    const n5 = await emojiCount()
    check('P5 改名/删除引起的结构刷新之后,emoji 一个不少', n5 === N, `emoji=${n5}/${N}`)

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
