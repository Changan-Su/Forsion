/**
 * PDF 引用条整链 e2e:真 Electron × 真组件 × 可编剧假引擎。
 * 链路 = agent 回复里写 `[[研究.pdf#page=3]]`(read_document 教它的形态)→ 气泡渲染成可点引用条
 * → 点击在 Agent Desk 里就地打开那一页。
 *
 * 断言盯的是这条链上会**静默失效**的三处:
 *   C1 纯聊天会话里 vault 还没水化 → files 恒空 → 引用条全判「未解析」(vault 懒引导,三振过的病)
 *   C2 linkTarget 砍掉 `#page=` → 引用条能点但永远停在第 1 页
 *   C3 同一份 PDF 连点第二条引用 → 必须原地跳页(amadeus:pdf-goto),不是 remount 重下
 *
 * 需先 npm run build。用法:npm run e2e:pdfcite
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先 pkill -f "node_modules/electron/dist/Electron.app"。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { tinyPdf } = require('./lib/tiny-pdf.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 's1', title: '引用会话', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
  created_at: '2026-08-27 09:00:00', updated_at: '2026-08-27 09:00:00',
}

/** 轮询等页码框变成期望值(最长 25s)。固定 sleep 会在上一份 300 页文档还没卸干净时假红 —— 08-27 假红一次。 */
async function waitPage(win, want, ms = 25_000) {
  const t0 = Date.now()
  let cur = '?'
  while (Date.now() - t0 < ms) {
    cur = await win.locator('.agent-desk .pdfa-pageinput').first().inputValue().catch(() => '?')
    if (cur === String(want)) return cur
    await win.waitForTimeout(400)
  }
  return cur
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pdfcite-'))
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(vaultDir, { recursive: true })
  // 300 页:①页数够多,跳页才是**看得出**的位移(3 页的夹具一屏全塞得下,pdf.js 恒报中间那页 = 假绿/假红)
  //          ②文档够大,pdf.js 装载有真实耗时,C5 的「阅读器还没就绪」窗口才真的存在
  // 放在子目录里:read_document 给的引用锚点是 **vault 相对路径**,e2e 得走这条真形态。
  // 另在别处放一份**同名**空 PDF:裸文件名引用必须判「未解析」,不许字典序猜一份打开(C4)。
  fs.mkdirSync(path.join(vaultDir, '资料'), { recursive: true })
  fs.mkdirSync(path.join(vaultDir, '旧档'), { recursive: true })
  fs.writeFileSync(path.join(vaultDir, '资料', '研究.pdf'), tinyPdf(Array.from({ length: 300 }, (_, i) => `PAGE ${i + 1} MARKER quicksilver phrase ${i + 1}`)))
  fs.writeFileSync(path.join(vaultDir, '旧档', '研究.pdf'), tinyPdf(['OLD COPY']))
  // 第二份真 PDF:C5 拿它把 Desk 的格子换掉,好让下一次点引用是**全新挂载**(重现加载中的竞态)
  fs.writeFileSync(path.join(vaultDir, '资料', '附录.pdf'), tinyPdf(['APPENDIX ONE', 'APPENDIX TWO']))
  // 库**外**的 PDF(用户的真实场景:书就在 ~/Downloads):引用锚点是绝对路径,只读打开
  const hostPdf = path.join(home, '下载', '库外的书.pdf')
  fs.mkdirSync(path.dirname(hostPdf), { recursive: true })
  fs.writeFileSync(hostPdf, tinyPdf(Array.from({ length: 20 }, (_, i) => `HOST PAGE ${i + 1}`)))
  fs.writeFileSync(path.join(vaultDir, '随手.md'), '# 随手\n\n一段。\n')
  const udDev = path.join(home, 'userdata-dev')
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(path.join(udDev, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }))

  const stub = await startStubEngine({
    sessions: [SESSION],
    // 引用写进**历史消息**而不是临场 run:reload 后照样水化得回来(C5 要靠这个重来一次冷启动)。
    messages: [{
      id: 'hm1', role: 'model', timestamp: 1787000000000,
      content: '书里讲了两处:方法在 [[资料/研究.pdf#page=8]],背景在 [[资料/研究.pdf#page=3]];'
        + '裸名引用 [[研究.pdf#page=5]] 库里有两份同名,不该乱猜;另见 [[资料/附录.pdf#page=2]];'
        + `库外那本在 [[${hostPdf}#page=12]];`
        + `模型有时会写丢一层括号:【[${hostPdf}#page=6]】,也得认;`
        + '带引语的 [[资料/研究.pdf#page=40&q=quicksilver phrase 40]] 要高亮那句话。',
    }],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
  })
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  try {
    const win = await app.firstWindow()
    if (process.env.PDFCITE_TRACE) win.on('console', (m) => { if (m.text().includes('[pdfdbg]')) console.log('  ', m.text()) })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.waitForTimeout(1200)
    // ⚠️ e2e 与用户 dev 实例共用 renderer 存储(dev 模式 userData 恒为 forsion-desktop-dev),
    // 「上次 Space」是谁最后用谁说了算 —— 用户停在主页/Amadeus,这里就会开在那儿,聊天侧栏根本不存在
    // (08-28 深夜三连红的真相,失败截图= 主页 Space)。确定性切到 Tangu 聊天 Space 再断言,幂等。
    const spaceBtn = win.locator('.rb-space[title="Tangu"]').first()
    if (await spaceBtn.count().catch(() => 0)) { await spaceBtn.click().catch(() => {}); await win.waitForTimeout(1000) }
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    await win.locator('.t2s-srow', { hasText: '引用会话' }).first().click().catch(() => {})
    await win.waitForTimeout(1200)

    await win.waitForSelector('.t2-content a.wikilink', { timeout: 30_000 })
    await win.waitForTimeout(800)

    // C1 引用条解析出来了(灰色未解析 = vault 没水化,这条链当场断)
    const chips = win.locator('.t2-content a.wikilink')
    const n = await chips.count().catch(() => 0)
    const labels = await chips.allInnerTexts().catch(() => [])
    check('C1 带路径的引用渲染成可点引用条,显示「文件名 p.N」(vault 已水化)',
      n === 6 && labels.join('|') === '研究.pdf p.8|研究.pdf p.3|附录.pdf p.2|库外的书.pdf p.12|库外的书.pdf p.6|研究.pdf p.40',
      `chips=${n} labels=${labels.join('|')}`)

    // C4 裸文件名 + 库里两份同名 → 判未解析(宁可灰,也不静默打开另一份)
    const gray = await win.locator('.t2-content .wikilink-unresolved').allInnerTexts().catch(() => [])
    check('C4 同名歧义的裸文件名引用判未解析,不字典序猜一份', gray.length === 1 && gray[0].includes('研究.pdf#page=5'),
      `gray=${JSON.stringify(gray)}`)

    // C2 点第一条 → Desk 里就地开在第 3 页
    await chips.first().click()
    await win.waitForSelector('.agent-desk.open .amx-pdfview', { timeout: 20_000 }).catch(() => {})
    const page1 = await waitPage(win, 8)
    check('C2 点引用条 → Desk 打开 PDF 且停在第 8 页(#page= 没被 linkTarget 吃掉)', page1 === '8', `pageinput=${page1}`)

    // C3 同一份 PDF 的第二条引用 → 原地跳到第 2 页(不 remount:pdfa-root 不重建)
    const before = await win.evaluate(() => document.querySelectorAll('.agent-desk .pdfa-root').length)
    await chips.nth(1).click()
    const page2 = await waitPage(win, 3)
    const after = await win.evaluate(() => document.querySelectorAll('.agent-desk .pdfa-root').length)
    check('C3 同一份 PDF 的第二条引用原地跳页(第 3 页,阅读器仍是同一个)', page2 === '3' && after === before && before === 1,
      `pageinput=${page2} roots=${before}→${after}`)

    // C5 阅读器**还在加载**时连点同一份 PDF 的两条引用:后点的那条不能被丢
    //(只发 amadeus:pdf-goto 的老写法会在监听器挂上前就把事件扔掉,停在前一条的页)。
    //  先点另一份 PDF 把格子换掉,下一次点 研究 才是全新挂载 = 真的有加载窗口。
    await chips.nth(2).click()
    await win.waitForTimeout(2500)
    await chips.first().click()  // 研究 第 8 页,全新挂载开始
    // 不等:两次点击之间只隔 playwright 自己的几十毫秒 —— 阅读器此时 eng.current 还是 null,
    // 事件式跳页会被当场丢掉(负对照就是靠这个窗口转红的)。
    await chips.nth(1).click()   // 研究 第 3 页 —— 最终必须是它
    const page3 = await waitPage(win, 3)
    check('C5 加载中连点两条引用,最终停在后点的那页(第 3 页)', page3 === '3', `pageinput=${page3}`)
    // C6 库外 PDF(绝对路径锚点):照样点得开,停在第 12 页,且是**只读**(没有批注工具栏)
    await chips.nth(3).click()
    const hostPage = await waitPage(win, 12)
    const toolbars = await win.locator('.agent-desk .pdfa-toolbar').count().catch(() => -1)
    check('C6 库外 PDF 按绝对路径只读打开,停在第 12 页(无批注工具栏)', hostPage === '12' && toolbars === 0,
      `pageinput=${hostPage} toolbars=${toolbars}`)

    // C7 单层方括号的引用(模型实测会这么写)也点得开 —— 走的是同一条通路,只是解析放宽
    await chips.nth(4).click()
    const loosePage = await waitPage(win, 6)
    check('C7 单括号形态 `【[/abs/x.pdf#page=6]】` 同样渲染成引用条并跳到第 6 页', loosePage === '6', `pageinput=${loosePage}`)

    // C8 带 `&q=` 的引用:跳到第 40 页**并把那句话高亮**(pdf.js find 的文本层高亮,一个字节都不写盘)
    await chips.nth(5).click()
    await win.waitForSelector('.agent-desk .pdfa-pageinput', { timeout: 30_000 }).catch(() => {})
    // pdf.js 的 find 要先把整份文档的文本抽出来(300 页夹具),不是几百毫秒的事 —— 等到出高亮为止
    await win.waitForSelector('.agent-desk .textLayer .highlight', { timeout: 30_000 }).catch(() => {})
    // 断言钉「高亮落在第 40 页且在视口里」,不钉页码框:pdf.js 把命中滚进视口后,
    // 当前页的判定按占屏面积走,命中若靠近页顶,指示器会报下一页 —— 那不是错。
    const q = await win.evaluate(() => {
      const root = document.querySelector('.agent-desk .pdfa-root')
      const marks = root ? [...root.querySelectorAll('.textLayer .highlight')] : []
      const first = marks[0]
      const host = root ? root.querySelector('.pdfa-container') : null
      const r = first && host ? first.getBoundingClientRect() : null
      const hr = host ? host.getBoundingClientRect() : null
      return {
        marks: marks.length,
        text: marks.map((m) => m.textContent || '').join(' ').trim().slice(0, 40),
        onPage: first ? Number(first.closest('.page')?.getAttribute('data-page-number')) : 0,
        inView: !!(r && hr && r.bottom > hr.top && r.top < hr.bottom),
        // v4:hlBand.ts 在 updatetextlayermatches/textlayerrendered 上把命中画进 .pdfa-citehl overlay
        // (multiply 混画布,与批注同观感)。台架(check:hlband)是自己调那个函数的,
        // 只有这里能证明**事件真的挂上了**——overlay 带子存在且矩形非空。
        band: (() => {
          const b = first ? first.closest('.page')?.querySelector('.pdfa-citehl-band') : null
          if (!b) return null
          const br = b.getBoundingClientRect()
          return [+br.width.toFixed(1), +br.height.toFixed(1)]
        })(),
        // 落地这一次必须放提醒动画(.is-pulse);滚动引发的重画不放 —— 那半边由 check:hlband 的
        // 「默认重画不放提醒动画」钉。这里紧跟落地取样,类还在。
        pulse: (() => {
          const b = first ? first.closest('.page')?.querySelector('.pdfa-citehl-band') : null
          return b ? getComputedStyle(b).animationName : null
        })(),
        // 文本层必须与画布同尺寸:pdf.js 的样式按 content-box 写,app 全局 reset 是 border-box,
        // `.page` 的 9px 边框会把内容盒吃掉 18px → 文本层比画布大 7%,高亮/选区/笔迹越往下越偏。
        // (台架 check:hlband 里也有同款断言,那边是模拟 reset;这条是真机。)
        layers: first ? (() => {
          const pg = first.closest('.page')
          const t = pg.querySelector('.textLayer').getBoundingClientRect(), c = pg.querySelector('canvas').getBoundingClientRect()
          return [+(t.width - c.width).toFixed(1), +(t.height - c.height).toFixed(1)]
        })() : null,
      }
    })
    check('C8 带引语的引用把第 40 页那句话临时高亮并滚进视口(文本层 .highlight,不写盘)',
      q.marks > 0 && q.onPage === 40 && q.inView && q.text.toLowerCase().includes('quicksilver'),
      `marks=${q.marks} onPage=${q.onPage} inView=${q.inView} text=${JSON.stringify(q.text)}`)
    check('C9 高亮带子画进 overlay 了(尺寸非空 = 事件挂上了)', !!q.band && q.band[0] > 1 && q.band[1] > 1, `band=${JSON.stringify(q.band)}`)
    check('C9b 落地这一次放了提醒动画(引用条点开后高亮自己闪一下)', q.pulse === 'pdfa-citepulse', `animation-name=${q.pulse}`)
    check('C10 文本层与画布同尺寸(.page 的 box-sizing 没被全局 reset 掰歪)',
      !!q.layers && Math.abs(q.layers[0]) <= 1 && Math.abs(q.layers[1]) <= 1, `文本层−画布=${JSON.stringify(q.layers)}`)
    // C11/C12 冷路径落地:先切到另一份 PDF,再点带引语那条(换文档 + 全新 find)—— 这正是用户
    // 实测报的两个症状所在:①落地那一秒整个界面卡死 ②命中没滚到视野中间。
    // ①的病根是 highlightAll 的 find **逐页**发 updatetextlayermatches(300 页 = 300 次),
    //   repaintBands 若不合帧就会在同一帧里跑 300 遍全量重画 —— 合帧前实测一个 1007ms 的长帧。
    // ②pdf.js 只把命中「弄进视野」,实测落在容器高度的 7.8% 处(贴顶),centerMatch 把它顶到正中。
    await chips.nth(4).click()
    await win.waitForTimeout(2000)
    await win.evaluate(() => {
      window.__fr = []
      const t0 = performance.now()
      let last = t0
      const tick = (t) => { window.__fr.push(+(t - last).toFixed(1)); last = t; if (t - t0 < 5200) requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    await chips.nth(5).click()
    await win.waitForTimeout(5600)
    const cold = await win.evaluate(() => {
      const root = document.querySelector('.agent-desk .pdfa-root')
      const host = root && root.querySelector('.pdfa-container')
      const hl = root && root.querySelector('.textLayer .highlight')
      const r = hl && hl.getBoundingClientRect(), hr = host && host.getBoundingClientRect()
      return {
        longs: window.__fr.filter((d) => d > 40),
        frames: window.__fr.length,
        ratio: r && hr ? +(((r.top + r.height / 2) - hr.top) / hr.height).toFixed(3) : null,
      }
    })
    check('C11 冷路径落地全程不掉帧(repaintBands 必须合帧;不合帧实测有 1007ms 长帧)',
      cold.longs.length === 0, `帧数=${cold.frames} >40ms=${JSON.stringify(cold.longs)}`)
    check('C12 命中滚到容器正中(pdf.js 自己只滚到 7.8% 处,贴着顶边)',
      cold.ratio !== null && Math.abs(cold.ratio - 0.5) < 0.12, `纵向比例=${cold.ratio}(0.5=正中)`)

    if (process.env.PDFCITE_SHOT) {
      await win.screenshot({ path: '/tmp/pdfcite-c8.png' })
      // 落地提醒动画:再点一次同一条引用重放,按相位连拍并裁到带子附近(整窗看不出相位差)
      await chips.nth(5).click()
      for (const [wait, tag] of [[120, 'a'], [260, 'b'], [460, 'c']]) {
        await win.waitForTimeout(wait)
        const clip = await win.evaluate(() => {
          const b = document.querySelector('.agent-desk .pdfa-citehl-band')
          if (!b) return null
          const r = b.getBoundingClientRect()
          return { x: Math.max(0, r.left - 24), y: Math.max(0, r.top - 30), width: Math.min(700, r.width + 60), height: 80 }
        })
        if (clip) await win.screenshot({ path: `/tmp/pdfcite-pulse-${tag}.png`, clip })
      }
    }

  } finally {
    await app.close().catch(() => {})
    try { await stub.close() } catch { /* 桩关闭失败不该盖掉断言结果 */ }
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
