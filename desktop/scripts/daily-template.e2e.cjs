/**
 * 「今天的日记」× templates/daily.md 的**真 Electron** 契约(2026-08-21)。
 *
 * 为什么必须真机:这条链横跨主进程(newPage/writeTextFile 落盘)、v4 绞杀者路由
 * (amadeusViews 读盘分类 → UnifiedPage 接管)、以及渲染层的模板插入 —— web harness 里
 * 三样全是桩,桩会撒谎。而失效方式恰恰是**这三者互相抢同一个文件**。
 *
 * 判据(2026-08-21 修复前实测:只有 D1 过 —— 日记建出来了、模板一个字没进去(D2/D3/D5 红),
 * 而且落盘是 v3(amadeus_page + 块标记,D4 红);S1 红 —— 「模板」项那时被 UNIFIED_HIDDEN_SLASH
 * 从 v4 菜单里整条藏掉):
 *   D1 点「今天」→ 库根出现 YYYY-MM-DD.md
 *   D2 templates/daily.md 的正文套上了
 *   D3 {{date}} 等变量被替换(文件里不许留 `{{`)
 *   D4 日记以**素文件**出生(无 amadeus_page / 无 `<!-- a n -->` 标记),且模板里的结构锚不漏进来 ——
 *      08-13 起新建笔记一律 v4 素文件,openOrCreate→newPage 曾是最后一条生 v3 的路径。
 *   D5 {{title}} 取目标笔记名(v4 没有 activePage)
 *   S1-S4 v4 笔记里走斜杠「模板」:菜单露出 → 选择器弹出 → 插回本篇 → 无哨兵残渣
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * 数据全在临时 TANGU_HOME 里,不碰 ~/.forsion-dev。
 * 跑:npm run e2e:daily   ｜   加 --headed 看着它跑
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  // `!!ok`:短路成 null 的断言按 `ok===false` 统计会被漏掉 → 真失败也报绿(见 plugin-seams 头注)。
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

function skip(name, why) {
  results.push({ name, ok: true, skipped: true })
  console.log(`SKIP  ${name}  | 未验:${why}`)
}

const pad = (n) => String(n).padStart(2, '0')
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const TEMPLATE = `# {{date}} 日志

## 今日待办

- [ ] 起床

<!-- a k1 -->

## 记录

写于 {{time}},笔记 {{title}}。
`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-daily-'))
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(path.join(vaultDir, 'templates'), { recursive: true })
  fs.writeFileSync(path.join(vaultDir, 'templates', 'daily.md'), TEMPLATE)
  fs.writeFileSync(path.join(vaultDir, '随手.md'), '# 随手\n\n一段。\n')
  // vaultRoot 启动即有值:落点 = <userData>-dev/amadeus-config.dev.json(isPackaged=false 走 .dev 那份)。
  const udDev = path.join(home, 'userdata-dev')
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(
    path.join(udDev, 'amadeus-config.dev.json'),
    JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }, null, 2),
  )

  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  try {
    const win = await app.firstWindow()
    // 渲染层的 warn/error 收着:这条链失败时基本都在控制台留了话(「没有活着的统一实例」等)。
    const logs = []
    win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`) })
    win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.waitForTimeout(1500)

    // ⚠️ vaultRoot 要等笔记面首次挂载才落地(只预置 amadeus-config.dev.json 不够),而「今天」
    //    这张卡的门是 `amadeusOn && !!vaultRoot` —— 不先开一次笔记面,它根本不出现。
    await win.click('.dv-new-tab')
    await win.waitForSelector('.newtab', { timeout: 15_000 })
    await win.waitForTimeout(600)
    await win.locator('.newtab-card', { hasText: /^新建笔记$|^New note$/ }).first().click()
    await win.waitForTimeout(2500)

    // 「今天」住在 ＋ 新标签页的启动器里(NewTabView 的动作卡)。
    await win.click('.dv-new-tab')
    await win.waitForSelector('.newtab', { timeout: 15_000 })
    await win.waitForTimeout(600)
    const card = win.locator('.newtab-card', { hasText: /^今天$|^Today$/ }).first()
    if (!(await card.count().catch(() => 0))) {
      const labels = await win.evaluate(
        () => [...document.querySelectorAll('.newtab-card-label')].map((e) => e.textContent),
      )
      throw new Error(`启动器里找不到「今天」卡片(vaultRoot 没落地?),现有:${JSON.stringify(labels)}`)
    }
    await card.click()
    // 建文件 + 路由分类 + UnifiedPage 挂载 + 插入 + 800ms 防抖落盘,给足余量。
    await win.waitForTimeout(4000)
    await win.screenshot({ path: '/tmp/forsion-daily.png' }).catch(() => {})

    const dailyPath = path.join(vaultDir, `${todayStr()}.md`)
    const exists = fs.existsSync(dailyPath)
    const raw = exists ? fs.readFileSync(dailyPath, 'utf8') : ''
    check('D1 点「今天」→ 库根出现当天日记文件', exists, dailyPath)
    check('D2 templates/daily.md 的正文套上了(待办勾选框往返不掉)',
      raw.includes('今日待办') && raw.includes('记录') && /^[-*] \[ \] 起床$/m.test(raw),
      JSON.stringify(raw).slice(0, 160))
    check('D3 {{date}}/{{time}} 变量已替换', raw.includes(todayStr()) && !raw.includes('{{'),
      `含今日=${raw.includes(todayStr())} 残留变量=${raw.includes('{{')}`)
    check('D4 日记以素文件出生(无 amadeus_page / 无块标记)',
      exists && !raw.includes('amadeus_page') && !/<!--\s*a\s+\S+\s*-->/.test(raw),
      JSON.stringify(raw.slice(0, 80)))

    check('D5 {{title}} 取的是目标笔记名(v4 没有 activePage,老写法在这里恒空)',
      raw.includes(`笔记 ${todayStr()}。`), JSON.stringify((/笔记 [^\n]*/.exec(raw) ?? [''])[0]))

    // ── S:斜杠「模板」在 v4 笔记上的整条链(菜单露出 → 选择器 → 插回本篇)
    const notePath = path.join(vaultDir, '随手.md')
    await win.locator('.t2s-srow', { hasText: '随手' }).first().click()
    await win.waitForSelector('.unified-body .ProseMirror', { timeout: 20_000 })
    await win.waitForTimeout(1200)
    await win.click('.unified-body .ProseMirror')
    await win.keyboard.press('Control+End')
    await win.keyboard.press('Enter')
    await win.keyboard.type('/')
    await win.waitForSelector('.slash-item', { timeout: 8000 })
    const tplItem = win.locator('.slash-item', { hasText: /^模板/ }).first()
    check('S1 v4 笔记的斜杠菜单里有「模板」项', !!(await tplItem.count().catch(() => 0)),
      JSON.stringify(await win.evaluate(() => [...document.querySelectorAll('.slash-item')].map((e) => e.textContent))).slice(0, 300))
    if (!(await tplItem.count().catch(() => 0))) {
      skip('S2 选中「模板」弹出模板选择器', '菜单里就没有这一项(S1 已红),没得点')
    } else {
      await tplItem.click()
      await win.waitForTimeout(900)
      const picked = await win.locator('.cmd-item').first().count().catch(() => 0)
      check('S2 选中「模板」弹出模板选择器(而不是把哨兵文本插进笔记)', !!picked,
        picked ? '' : '选择器没弹 —— 事件被宿主的 afterId 门丢掉了?')
      if (picked) {
        await win.locator('.cmd-item').first().click()
        await win.waitForTimeout(2000)
      }
    }
    const noteRaw = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : ''
    check('S3 模板正文插进了当前这篇(变量按本篇替换)',
      noteRaw.includes('今日待办') && noteRaw.includes(`笔记 随手。`),
      JSON.stringify(noteRaw).slice(0, 200))
    check('S4 笔记里没有哨兵残渣(NUL / __amadeus_template__)',
      !noteRaw.includes(String.fromCharCode(0)) && !noteRaw.includes('__amadeus_template__'))

    const bad = results.filter((r) => !r.ok)
    if (bad.length && logs.length) console.log('\n渲染层 warn/error:\n' + logs.slice(-25).join('\n'))
    console.log(bad.length ? `\n${bad.length} 项失败(截图 /tmp/forsion-daily.png)` : `\n${results.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await app.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
