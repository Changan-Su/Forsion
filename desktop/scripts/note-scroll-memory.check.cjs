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
 * 换**标签**再换回来(2026-10-13 用户实报:「切换 tab 回来,文档内容又到顶上去了…不止是 md,pdf 等各种文件和
 * view 都有,看起来像是重新把这个文件打开了一遍」)。这条的根因不在笔记这一层:Dockview 把不显示的标签的 DOM
 * 摘下来,换回来时同一批节点重新入 DOM,里面每个滚动容器的位置都归零(视图没有重挂,所以按路径恢复的那套
 * 滚动记忆不会再跑)。修在 lcl/engine 的 keepScroll(逐容器记位置,标签换回来时写回),所以对所有 view 生效。
 *   5 甲滚到中段 → ⌘ 点乙开新标签 → 点回甲的标签:甲还在原位置,且是同一个 DOM 节点(没有重挂)
 *   6 再来一轮仍然回得去(换回来那一下不许把位置记成 0)
 *   7 PDF(内置阅读器)翻到后面几页 → 换到笔记标签 → 换回来:还在那一页
 *   8 乙的标签也各记各的
 *   9 ⌘ 点笔记里指向 PDF 的双链 → PDF 开在新标签页,笔记的标签还在(同日实报:「⌘ 点双链或者文件,应该开新标签」;
 *     指向笔记的双链本来就这样,指向文件的把修饰键丢了,就地把笔记的标签换成了 PDF)
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测(同 check:newtab)。
 * 跑:npm run check:notescroll
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { tinyPdf } = require('./lib/tiny-pdf.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const long = (title, n) => `# ${title}\n\n${title === '甲' ? '参见 [[丙文档.pdf]] 一文。\n\n' : ''}` + Array.from({ length: n }, (_, i) => `${title} 第 ${i + 1} 段。`).join('\n\n') + '\n'
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
  fs.writeFileSync(path.join(vault, '丙文档.pdf'), tinyPdf(Array.from({ length: 12 }, (_, i) => `Page ${i + 1} of the fixture`)))
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

    // ── 5-8 换标签再换回来 ─────────────────────────────────────────────────────────────
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    const tabNames = () => win.evaluate(`[...document.querySelectorAll('.wb-tab')].map((t) => t.querySelector('.wb-tab-name')?.textContent || '')`)
    const clickTab = async (name) => {
      await win.locator('.wb-tab', { hasText: name }).first().click()
      await win.waitForTimeout(900)
    }
    /** 给当前可见的正文容器打个记号:换回来还读得到 = 同一个 DOM 节点(视图没有重挂)。 */
    await win.evaluate(`(() => {
      const p = [...document.querySelectorAll('.amx-pane')].find((e) => e.getBoundingClientRect().width > 0 && e.scrollHeight > e.clientHeight + 4)
      if (p) p.__scrollProbe = 'A'
    })()`)
    await win.locator('.t2s-srow', { hasText: '乙长文' }).first().click({ modifiers: [mod] })
    await win.waitForTimeout(2200)
    const tabs2 = await tabNames()
    const atB2 = await paneOf('乙长文')
    await win.evaluate(scrollTo(450))
    await win.waitForTimeout(400)
    await clickTab('甲长文')
    const tabA = await paneOf('甲长文')
    const sameNode = await win.evaluate(`[...document.querySelectorAll('.amx-pane')].find((e) => e.getBoundingClientRect().width > 0)?.__scrollProbe === 'A'`)
    check('5 换标签再换回来:甲还在原位置,且是同一个 DOM 节点',
      tabs2.filter((n) => /长文/.test(n)).length === 2 && sameNode && Math.abs((tabA?.top ?? -1) - want) <= 40,
      JSON.stringify({ 标签: tabs2, 新标签里的乙: atB2?.top, 换回甲: tabA?.top, 期望: want, 同一节点: sameNode }) + '(修复前:换回恒 0)')

    await clickTab('乙长文')
    const tabB = await paneOf('乙长文')
    check('8 乙的标签各记各的', Math.abs((tabB?.top ?? -1) - 450) <= 40, JSON.stringify({ 换回乙: tabB?.top, 期望: 450 }))
    await clickTab('甲长文')
    const tabA2 = await paneOf('甲长文')
    check('6 再来一轮仍然回得去', Math.abs((tabA2?.top ?? -1) - want) <= 40, JSON.stringify({ 第二次换回: tabA2?.top, 期望: want }))

    // PDF:内置阅读器的滚动容器是 .pdfa-container(pdf.js 按滚动位置决定画哪几页,归零 = 回到第 1 页)。
    const PDF = `(() => {
      const c = [...document.querySelectorAll('.pdfa-container')].find((e) => e.getBoundingClientRect().width > 0)
      return c ? { top: Math.round(c.scrollTop), max: Math.round(c.scrollHeight - c.clientHeight), pages: c.querySelectorAll('.page').length } : null
    })()`
    // 9:此刻主区是 [甲, 乙] 两个标签、甲在前。回到页首,⌘ 点第一段里的 [[丙文档.pdf]]。
    await win.evaluate(scrollTo(0))
    await win.waitForTimeout(500)
    const before9 = await tabNames()
    await win.locator('.amx-pane .wikilink[data-wiki]', { hasText: '丙文档' }).first().click({ modifiers: [mod] })
    await win.waitForSelector('.pdfa-container .page', { timeout: 20_000 }).catch(() => {})
    await win.waitForTimeout(1500)
    const after9 = await tabNames()
    const named = (list, re) => list.filter((n) => re.test(n)).length
    check('9 ⌘ 点指向 PDF 的双链:开在新标签页,笔记的标签还在',
      named(before9, /丙文档/) === 0 && named(after9, /丙文档/) === 1 && named(after9, /甲长文/) === 1 && named(after9, /乙长文/) === 1,
      JSON.stringify({ 点之前: before9.filter(Boolean), 点之后: after9.filter(Boolean) }) + '(修复前:甲长文的标签被换成了 PDF)')
    const pdf0 = await win.evaluate(PDF)
    const pdfWant = Math.min(2400, Math.max(0, (pdf0?.max ?? 0) - 200))
    await win.evaluate(`(() => {
      const c = [...document.querySelectorAll('.pdfa-container')].find((e) => e.getBoundingClientRect().width > 0)
      if (c) c.scrollTop = ${pdfWant}
    })()`)
    await win.waitForTimeout(600)
    const pdf1 = await win.evaluate(PDF)
    await clickTab('甲长文')
    await clickTab('丙文档')
    await win.waitForTimeout(600)
    const pdf2 = await win.evaluate(PDF)
    check('7 PDF 翻到后面 → 换标签 → 换回来:还在那一页',
      !!pdf0 && pdf0.pages >= 12 && pdfWant > 800 && Math.abs((pdf2?.top ?? -1) - (pdf1?.top ?? -99999)) <= 40,
      JSON.stringify({ 打开时: pdf0, 滚到: pdf1?.top, 换回: pdf2?.top }) + '(修复前:换回恒 0)')
  } finally {
    await app.close().catch(() => {})
  }
  const ok = results.filter((r) => r.ok).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
