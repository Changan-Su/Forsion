/**
 * 「点新建笔记,就该跳到那篇笔记」的端到端契约(真 Electron)。
 *
 * 用户实报(2026-08-29):「新建笔记按钮,工作区列表里面是有新笔记出现,但是当前 view 没有跳到
 * 能够 new page。」根因:pageStore.createPageInFolder 收尾直调 `loadPage`,而 loadPage 装的是
 * **活动 scope** —— 活动 scope 只跟着编辑器面板走(amadeusViews effect ②)。站在新标签/主页/聊天上
 * 新建时它指着一个**后台**的编辑器 tab:笔记静默装进看不见的那份 store —— 当前 view 纹丝不动,
 * 而工作区列表照常刷出新笔记(refreshPages 是全局的),正是用户看到的「列表有、view 不跳」。
 * 修法:创建收尾发 `amadeus:navigate-note`,由宿主的 openNote 门面决定落点(与「新对话」同一课,
 * 见 check:newtab);标题聚焦请求随之从 per-scope 字段改成模块级按 path 认领的一次性信号。
 *
 * 判据(负对照实测:修复前 ①④⑤ 红、②③ 绿 —— ② 正是用户看到的那一半):
 *   1 站在空白新标签上点侧栏「新建笔记」→ **这个标签**变成编辑器并显示新笔记
 *   2 新笔记确实建出来了,且出现在工作区列表里(修复前这条也是绿的 —— 它正是用户看到的那一半)
 *   3 后台那个编辑器标签不许被顶掉(护栏,非本次症状:新笔记是 v4 素文件 → releasePage 清空
 *     activePage,认领用的 effect ③ 不触发;v3 老笔记走同一条链就会被改写,所以钉住它)
 *   4 光标落在标题栏(Notion 式先命名):跨面板导航后信号仍被认领到
 *   5 一个编辑器都没有时(全关掉)照旧成立:当前标签就地变成编辑器
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测(同 check:newtab)。
 * 跑:npm run check:newnote
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 只读 DOM:标签名单 / 可见编辑器认领的笔记 / 工作区列表里的行 / 标题栏是否拿着焦点。 */
const SNAP = `(() => {
  const vis = (e) => e.getBoundingClientRect().width > 0
  const tabs = [...document.querySelectorAll('.wb-tab')].map((t) => t.querySelector('.wb-tab-name')?.textContent || '')
  const title = document.querySelector('.amx-title-input, input.amx-title, .amx-note-title input')
  return {
    tabs,
    launcherVisible: [...document.querySelectorAll('.newtab')].filter(vis).length,
    // 可见编辑器现在拿的是哪篇:标题栏的值 + 顶栏面包屑兜底
    shownTitle: title ? title.value : null,
    treeRows: [...document.querySelectorAll('.t2s-srow-title')].map((e) => e.textContent || ''),
    titleFocused: !!title && document.activeElement === title,
  }
})()`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-newnote-'))
  const vault = path.join(home, 'vault')
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  fs.writeFileSync(path.join(vault, '欢迎.md'), '# 欢迎\n\n本篇不许被新建流顶掉。\n')
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    // 钉住 Amadeus Space(缺省是主页 Space,那儿既没侧栏也没编辑器)。
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'amadeus')`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForSelector('.am-app', { timeout: 40_000 })
    await win.waitForTimeout(2500)

    // 先在编辑器里打开「欢迎.md」—— 这就是那个会被顶掉的后台标签。
    if (!(await win.locator('.t2s-special', { hasText: '新建笔记' }).first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(800)
    }
    await win.locator('.t2s-srow', { hasText: '欢迎' }).first().click()
    await win.waitForTimeout(2000)
    const seeded = await win.evaluate(SNAP)

    // 站到一张空白新标签上。
    await win.click('.dv-new-tab')
    await win.waitForTimeout(1200)
    const blank = await win.evaluate(SNAP)
    if (!blank.launcherVisible) throw new Error(`前置失败:＋ 没开出空白启动器 ${JSON.stringify(blank)}`)

    await win.locator('.t2s-special', { hasText: '新建笔记' }).first().click()
    await win.waitForTimeout(2500)
    const after = await win.evaluate(SNAP)

    check(
      '1 站在空白新标签上新建 → 这个标签自己变成编辑器(不再是启动器)',
      after.launcherVisible === 0,
      JSON.stringify({ tabs: after.tabs, launcherVisible: after.launcherVisible, shownTitle: after.shownTitle })
        + '(修复前:launcherVisible=1 —— 当前 view 纹丝不动)',
    )
    check(
      '2 笔记确实建出来了,工作区列表里有它(用户看到的那一半,修复前也绿)',
      fs.existsSync(path.join(vault, 'untitled.md')) && after.treeRows.some((t) => t.includes('untitled')),
      `disk=${fs.existsSync(path.join(vault, 'untitled.md'))} tree=${JSON.stringify(after.treeRows)}`,
    )
    check(
      '3 后台的「欢迎」标签没被顶掉(护栏;v3 笔记走同一条链会被 effect③ 改写)',
      after.tabs.some((t) => t.includes('欢迎')),
      `建前 ${JSON.stringify(seeded.tabs)} → 建后 ${JSON.stringify(after.tabs)}`,
    )
    check(
      '4 光标落在标题栏(跨面板导航后聚焦信号仍被认领到)',
      after.titleFocused,
      `titleFocused=${after.titleFocused} shownTitle=${JSON.stringify(after.shownTitle)}`,
    )

    // ⑤ 一个编辑器都没有:全关掉,站在空白标签上再建一次。
    await win.evaluate(`(() => {
      const ws = window.__lclWorkspace || null
      return !!ws
    })()`)
    for (let i = 0; i < 8; i++) {
      const x = win.locator('.wb-tab .wb-tab-close').first()
      if (!(await x.count().catch(() => 0))) break
      await x.click().catch(() => {})
      await win.waitForTimeout(500)
    }
    await win.click('.dv-new-tab').catch(() => {})
    await win.waitForTimeout(1200)
    await win.locator('.t2s-special', { hasText: '新建笔记' }).first().click()
    await win.waitForTimeout(2500)
    const zero = await win.evaluate(SNAP)
    check(
      '5 一个编辑器都没有时也就地开(当前标签变编辑器)',
      zero.launcherVisible === 0 && fs.existsSync(path.join(vault, 'untitled-2.md')),
      JSON.stringify({ tabs: zero.tabs, launcherVisible: zero.launcherVisible }),
    )

    const bad = results.filter((r) => !r.ok)
    console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await app.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
