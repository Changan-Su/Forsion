/**
 * 「同一个标签里切走再切回,笔记停在原来那个位置」的端到端契约(真 Electron)。
 *
 * 用户实报(2026-09-05):「同一个tab窗口里面,切换之后没有上次打开的位置的记忆。」
 * 根因(2026-09-05 本脚本实测):滚动记忆(unified/viewMemory.ts 的 docScroll)本身在,坏在两处
 * **时序** —— 滚动容器 `.amx-pane` 是宿主壳的元素,换笔记时它不重建:
 *   ① React 把新笔记的 DOM 提交进同一个 pane → scrollTop 被内容换掉(归 0);随后才跑**旧**
 *      effect 的 cleanup,那句 `remember()` 于是把 0 写进**旧笔记**的槽位 —— 记忆当场抹掉;
 *      提交与 cleanup 之间浏览器补发的 scroll 事件同样落到旧路径上。
 *   ② 恢复只等了 2 帧:正文是异步装载的,那两帧里 pane 还没高度,`scrollTop = 700` 被夹回 0,
 *      之后再也没人补一刀。
 * 修法:cleanup 不再写(实时 scroll 监听已经逐笔记着);恢复前不记账(armed);恢复重试到
 * 真落位或 1.5s 到点为止,用户中途自己动了就立刻交还。
 *
 * 判据(负对照实测:修复前 ②③ 红 —— 切回去恒在页首):
 *   1 前置:笔记足够长,能滚动
 *   2 甲滚到中段 → 切到乙 → 切回甲:回到原位置(±40px)
 *   3 切回来之后那份记忆还在(再切一次仍然回得去)
 *   4 乙自己的位置独立记(不串到甲)
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测(同 check:newtab)。
 * 跑:npm run check:notescroll
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

const long = (title, n) => `# ${title}\n\n` + Array.from({ length: n }, (_, i) => `${title} 第 ${i + 1} 段。`).join('\n\n') + '\n'
/** 正文的滚动容器 = `.amx-pane`(宿主壳的元素,换笔记不重建 —— 本 bug 的舞台)。 */
const PANE = `(() => {
  const vis = (e) => e.getBoundingClientRect().width > 0
  const p = [...document.querySelectorAll('.amx-pane')].filter(vis).find((e) => e.scrollHeight > e.clientHeight + 4)
    ?? [...document.querySelectorAll('.amx-pane')].filter(vis)[0]
  if (!p) return null
  return { top: Math.round(p.scrollTop), max: Math.round(p.scrollHeight - p.clientHeight), title: document.querySelector('.amx-title-input, input.amx-title')?.value ?? null }
})()`
const scrollTo = (y) => `(() => {
  const vis = (e) => e.getBoundingClientRect().width > 0
  const p = [...document.querySelectorAll('.amx-pane')].filter(vis).find((e) => e.scrollHeight > e.clientHeight + 4)
  if (!p) return null
  p.scrollTop = ${y}
  return Math.round(p.scrollTop)
})()`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-scrollmem-'))
  const vault = path.join(home, 'vault')
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  fs.writeFileSync(path.join(vault, '甲长文.md'), long('甲', 120))
  fs.writeFileSync(path.join(vault, '乙长文.md'), long('乙', 120))
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
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
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'amadeus')`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForSelector('.am-app', { timeout: 40_000 })
    await win.waitForTimeout(2500)

    if (!(await win.locator('.t2s-srow', { hasText: '甲长文' }).first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(800)
    }
    /** 侧栏点一篇 = 在**同一个编辑器标签**里换笔记(这正是用户说的「同一个 tab 窗口」)。 */
    const openNote = async (name) => {
      await win.locator('.t2s-srow', { hasText: name }).first().click()
      await win.waitForTimeout(2200)
    }
    /** 快照 + **认领**:PANE 是按「可见且能滚」启发式挑容器,分屏/多面板时可能挑到隔壁那篇 ——
     *  不钉标题的话位置断言会在错的容器上恒绿(Codex 评审的假绿口)。 */
    const paneOf = async (expectTitle) => {
      const p = await win.evaluate(PANE)
      if (!p || p.title !== expectTitle) throw new Error(`量到的面板不是「${expectTitle}」:${JSON.stringify(p)}`)
      return p
    }

    await openNote('甲长文')
    const pane0 = await paneOf('甲长文')
    check('1 前置:笔记够长,正文容器能滚动', !!pane0 && pane0.max > 400, JSON.stringify(pane0))

    const want = 700
    await win.evaluate(scrollTo(want))
    await win.waitForTimeout(500)
    const scrolled = await paneOf('甲长文')

    await openNote('乙长文')
    const atB = await paneOf('乙长文')
    await win.evaluate(scrollTo(300))
    await win.waitForTimeout(500)

    await openNote('甲长文')
    await win.waitForTimeout(1200)
    const backA = await paneOf('甲长文')
    check('2 切走再切回:甲停在原来那个位置(±40px)',
      Math.abs((backA?.top ?? -1) - want) <= 40,
      JSON.stringify({ 滚到: scrolled?.top, 切回: backA?.top, 期望: want }) + '(修复前:切回恒 0)')

    await openNote('乙长文')
    await win.waitForTimeout(1200)
    const backB = await paneOf('乙长文')
    check('4 乙自己的位置独立记(不串到甲)',
      Math.abs((backB?.top ?? -1) - 300) <= 40,
      JSON.stringify({ 切回乙: backB?.top, 期望: 300, 乙首次: atB?.top }))

    await openNote('甲长文')
    await win.waitForTimeout(1200)
    const backA2 = await paneOf('甲长文')
    check('3 记忆不是一次性的:再切一轮仍然回得去',
      Math.abs((backA2?.top ?? -1) - want) <= 40,
      JSON.stringify({ 第二次切回: backA2?.top, 期望: want }))
  } finally {
    await app.close().catch(() => {})
  }
  const ok = results.filter((r) => r.ok).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
