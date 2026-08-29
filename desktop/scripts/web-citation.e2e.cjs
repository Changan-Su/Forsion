/**
 * 网页引用整链 e2e:真 Electron × 真内置浏览器 <webview> × 可编剧假引擎(pdf/file-citation 的姊妹篇)。
 * 链路 = agent 回复里写普通 markdown 链接 `[一句页面原文](https://…)`(web_fetch 教它的形态)
 *      → 点击在 Agent Desk 里开内置浏览器 → **滚到那句话**(Chromium 原生 `#:~:text=`)。
 *
 * 断言盯这条链上会静默失效的几处:
 *   W1 链接被当成普通外链(主区新标签/系统浏览器)而不是进 Desk;或进了 Desk 却停在页首
 *   W2 同一页第二条引语:换 key = 重挂 webview = 整页重下;或就地跳的事件没人接 → 不动
 *   W3 引语在页面上找不到时必须**照常打开**(退化成普通链接),不能崩、不能不开
 *
 * 地基单独有桩:npm run check:textfrag(文本片段在 guest 里活不活,不依赖 app 构建)。
 * 需先 npm run build。用法:npm run e2e:webcite
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const NEEDLE = 'quicksilver phrase forty'        // 第 200 段(共 400)→ ~50%
const NEEDLE2 = 'zephyr marker two hundred sixty' // 第 260 段 → ~65%
const MISSING = 'this sentence is nowhere on the page at all'
const pageHtml = (title) => {
  const body = Array.from({ length: 400 }, (_, i) =>
    `<p>para ${i} — ${i === 200 ? NEEDLE : i === 260 ? NEEDLE2 : 'filler text lorem ipsum dolor sit amet'}</p>`).join('\n')
  return `<!doctype html><meta charset=utf-8><title>${title}</title><style>p{margin:24px 0;font:16px/1.6 sans-serif}</style>${body}`
}

const SESSION = {
  id: 's1', title: '网页引用会话', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
  created_at: '2026-08-28 09:00:00', updated_at: '2026-08-28 09:00:00',
}

/** Desk 里那个 <webview> guest 的滚动位置(0..1)、引语是否真落在**可见视口内**、
 *  以及一枚重挂探针的存活情况。
 *  ⚠️ 只断滚动比例是不够的:比例对 ≠ 那句话在屏幕上(页面结构一变比例就失去意义),
 *  所以直接量引语元素的 rect 落没落进 guest 视口 —— 这是「看起来对」那一半。 */
async function deskProbe(win, needle) {
  return win.evaluate(async (needleText) => {
    const wv = document.querySelector('.agent-desk webview')
    if (!wv) return { wv: false }
    try {
      const r = await wv.executeJavaScript(`(() => {
        const hit = [...document.querySelectorAll('p')].find((p) => p.textContent.includes(${JSON.stringify(needleText)}))
        const b = hit ? hit.getBoundingClientRect() : null
        // ::target-text 是高亮伪元素,getComputedStyle 读得到实际生效值(注入前是 rgba(0,0,0,0))
        const hl = hit ? getComputedStyle(hit, '::target-text') : null
        return {
          y: scrollY, h: document.documentElement.scrollHeight, vh: innerHeight, title: document.title,
          inView: !!(b && b.top >= 0 && b.bottom <= innerHeight),
          hlBg: hl ? hl.backgroundColor : null, hlFg: hl ? hl.color : null,
        }
      })()`)
      return {
        wv: true,
        pos: r.h > r.vh ? +(r.y / (r.h - r.vh)).toFixed(3) : 0,
        title: r.title,
        inView: r.inView,
        hlBg: r.hlBg,
        hlFg: r.hlFg,
        marked: wv.dataset.e2emark === '1',
        count: document.querySelectorAll('.agent-desk webview').length,
      }
    } catch { return { wv: true, pos: null, loading: true } }
  }, needle)
}

/** 等 guest 装完并稳定(位置连续两次一致)。 */
async function settle(win, needle, ms = 20_000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < ms) {
    const p = await deskProbe(win, needle).catch(() => null)
    if (p && p.wv && !p.loading && p.pos !== null) {
      if (last !== null && Math.abs(p.pos - last) < 0.002) return p
      last = p.pos
    }
    await win.waitForTimeout(500)
  }
  return (await deskProbe(win, needle).catch(() => ({ wv: false }))) || { wv: false }
}

/** 观感自查用的截图(WEBCITE_SHOT=1)。⚠️ guest 是独立进程,文本片段那次滚动发生在合成器里,
 *  直接截会拿到**一片空白**的陈旧图面(不是渲染坏了,断言里的「引语在视口」是绿的)——
 *  先在 guest 里微动一像素逼它重画,再截。 */
async function shot(app, win, file) {
  await win.evaluate(async () => {
    const wv = document.querySelector('.agent-desk webview')
    if (wv) await wv.executeJavaScript('scrollBy(0,1); scrollBy(0,-1); 1')
  }).catch(() => {})
  await win.waitForTimeout(600)
  await win.screenshot({ path: file })
  // guest 的画面单独抓一张:整窗截图对 <webview> 时灵时不灵(独立进程,拿到的可能是陈旧图面)。
  // 走主进程直接 capturePage 那份 webContents,拿的是 guest 自己的合成结果,稳。
  const b64 = await app.evaluate(async ({ webContents }) => {
    const g = webContents.getAllWebContents().find((w) => w.getType() === 'webview')
    return g ? (await g.capturePage()).toPNG().toString('base64') : null
  }).catch(() => null)
  if (b64) fs.writeFileSync(file.replace(/\.png$/, '-guest.png'), Buffer.from(b64, 'base64'))
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    const u = req.url.split('?')[0]
    res.end(pageHtml(u.startsWith('/page3') ? 'PAGE-THREE' : u.startsWith('/page2') ? 'PAGE-TWO' : 'PAGE-ONE'))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-webcite-'))
  const stub = await startStubEngine({
    sessions: [SESSION],
    messages: [{
      id: 'hm1', role: 'model', timestamp: 1787100000000,
      content: `书里说 [${NEEDLE}](${base}/page.html) 是核心;`
        + `后文又提到 [${NEEDLE2}](${base}/page.html);`
        + `另一页的 [${MISSING}](${base}/page2.html) 找不到原句。`,
      // 造一条 web_fetch 工具调用 → 任务总结卡的「来源」区出现网页来源行(taskFacts 的 SOURCE_KIND)
      tool_calls: [{ id: 'tc1', function: { name: 'web_fetch', arguments: JSON.stringify({ url: `${base}/page3.html` }) } }],
      tool_results: [{ tool_call_id: 'tc1', content: 'ok' }],
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
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.waitForTimeout(1200)
    // ⚠️ e2e 与用户 dev 实例共用 renderer 存储(dev userData 恒为 forsion-desktop-dev),「上次 Space」
    // 是谁最后用谁说了算 → 必须确定性切到 Tangu 聊天 Space 再断言(见 file-citation.e2e 同款守卫)。
    const spaceBtn = win.locator('.rb-space[title="Tangu"]').first()
    if (await spaceBtn.count().catch(() => 0)) { await spaceBtn.click().catch(() => {}); await win.waitForTimeout(1000) }
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    await win.locator('.t2s-srow', { hasText: '网页引用会话' }).first().click().catch(() => {})
    await win.waitForTimeout(1200)

    const links = win.locator(`.t2-content a[href^="${base}"]`)
    const n = await links.count().catch(() => 0)
    check('W0 网页引用渲染成可点链接(不是灰链、也没被 wikilink 分支抢走)', n === 3, `links=${n}`)
    // ⚠️ 出厂配色是单色的(--accent-ink ≈ 正文色):只靠 `a { color }` 的链接在聊天里跟正文一个样,
    // 看不出可点 = 功能等于没有。跨配色成立的信号只有下划线(与 [[双链]] 引用条同一套观感)。
    const look = await win.evaluate((sel) => {
      const a = document.querySelector(sel)
      const body = a && a.closest('.t2-content')
      if (!a || !body) return null
      const cs = getComputedStyle(a)
      return { deco: cs.textDecorationLine, link: cs.color, text: getComputedStyle(body).color }
    }, `.t2-content a[href^="${base}"]`)
    check('W0b 引用链接看得出可点(单色配色下颜色与正文同色,只剩下划线这一个信号)',
      !!look && (look.deco.includes('underline') || look.link !== look.text),
      look ? `下划线=${look.deco} 链接色=${look.link} 正文色=${look.text}` : 'null')

    // W0c 全局兜底:`.t2-content` 之外的网页链接(收件箱/更新日志/市场 README/右栏记忆/设置…
    // 凡是走 <Markdown> 的地方)也必须看得出可点 —— 那条规则住 base.css,聊天那条(chat2.css)
    // 特异性更高、盖不住它。少了它,聊天之外每一处网页链接都是隐形的。
    const outside = await win.evaluate(() => {
      const a = document.createElement('a')
      a.className = 'citelink'
      a.href = 'https://example.com/'
      a.textContent = '探针'
      document.body.appendChild(a)
      const deco = getComputedStyle(a).textDecorationLine
      a.remove()
      return deco
    })
    check('W0c 聊天之外的 .citelink 也有下划线(全局兜底那条规则)', outside.includes('underline'), `下划线=${outside}`)

    if (n !== 3) {
      await win.screenshot({ path: '/tmp/webcite-fail.png' }).catch(() => {})
      throw new Error('链接没渲染出来,截图 /tmp/webcite-fail.png')
    }

    // W1 冷路径:点第一条 → Desk 开内置浏览器,落在引语上(~50%)而不是页首
    await links.nth(0).click()
    await win.waitForTimeout(1500)
    const deskOpen = await win.locator('.agent-desk.open').count().catch(() => 0)
    const p1 = await settle(win, NEEDLE)
    check('W1 点网页引用条 → 在 Agent Desk 里开内置浏览器,并滚到引语处(不是页首)',
      deskOpen === 1 && p1.wv && p1.title === 'PAGE-ONE' && p1.inView && Math.abs(p1.pos - 0.5) < 0.1,
      `desk=${deskOpen} pos=${p1.pos} 引语在视口=${p1.inView} title=${p1.title}`)

    // W1b 引语高亮换成本应用的琥珀(Chromium 默认是浅紫,与 PDF 引语带子/代码行高亮不是一套语汇)。
    // 底色与字色必须一起断:第三方页面正文可能是任何颜色,只改底色会在深色站点上变黄底白字。
    check('W1b 网页引语高亮 = 批注调色板的琥珀 #ffe14d + 近黑字(不是 Chromium 默认的浅紫)',
      p1.hlBg === 'rgb(255, 225, 77)' && p1.hlFg === 'rgb(17, 17, 17)', `底=${p1.hlBg} 字=${p1.hlFg}`)

    if (process.env.WEBCITE_SHOT) await shot(app, win, '/tmp/webcite-1-landed.png')

    // W2 同一页第二条引语:必须**就地跳**(复用同一个 webview,不重挂 = 不重下整页)
    await win.evaluate(() => { document.querySelector('.agent-desk webview').dataset.e2emark = '1' })
    await links.nth(1).click()
    await win.waitForTimeout(1500)
    const p2 = await settle(win, NEEDLE2)
    check('W2 同页第二条引语就地跳到新位置,且**没有重挂 webview**(换 key = 整页重下)',
      p2.marked === true && p2.count === 1 && p2.inView && Math.abs(p2.pos - 0.65) < 0.1,
      `复用=${p2.marked} webview数=${p2.count} pos=${p2.pos} 引语在视口=${p2.inView}`)
    // 就地跳是**同文档导航**,不触发 dom-ready → 注进去的琥珀必须还在(重注的时机若写成 did-navigate
    // 之类只在换文档时才有的事件,这条会红而 W1b 照绿)。
    check('W2b 就地跳之后琥珀高亮仍在(同文档导航不重注,样式得自己活着)',
      p2.hlBg === 'rgb(255, 225, 77)', `底=${p2.hlBg}`)

    if (process.env.WEBCITE_SHOT) await shot(app, win, '/tmp/webcite-2-second.png')

    // W3 负对照:引语在页面上不存在 → 页面照常打开、停在页首(退化成普通链接,不能崩/不开)
    await links.nth(2).click()
    await win.waitForTimeout(1500)
    const p3 = await settle(win, NEEDLE)
    check('W3 引语在页面上找不到时照常打开、停在页首(命中不了不许坏事)',
      p3.wv && p3.title === 'PAGE-TWO' && p3.pos === 0, `pos=${p3.pos} title=${p3.title}`)
    if (process.env.WEBCITE_SHOT) await shot(app, win, '/tmp/webcite-3-nomatch.png')

    // W5 任务总结卡的**网页来源行**必须走同一条路。早先它是 `<a target="_blank">` 直接转外链 →
    // 同一张卡里文件来源进 Desk、网页来源开新标签,用户实报「有时候 Desk 有时候新标签」。
    // ⚠️ 判据必须是**行为**(点开落到哪),不能改成「查 citelink 类」:调用方自带 className 时
    //    ChatWebLink 刻意**不叠** citelink(来源行自己管观感),那个类在这里本来就不该有。
    // ⚠️ 点击走 DOM 直接派发,不用 Playwright 的可点性检查:总结卡与 Desk 共用右侧车道,Desk 展开时
    //    卡被挤成 0 宽(元素在、点不着)。先收起 Desk 再点也行,但收起动画与容器查询(≥860px)之间
    //    有竞态 —— 直接派发把这个抖动源整个绕开,React 的 onClick 照常触发。
    const srcRow = win.locator(`.t2-tsum a[href^="${base}"]`).first()
    if (await srcRow.count().catch(() => 0)) {
      const rowCls = await srcRow.getAttribute('class').catch(() => '')
      check('W5b 来源行不吃 citelink 的下划线(调用方自带 className = 它自己管观感)',
        !!rowCls && !rowCls.includes('citelink'), `class=${rowCls}`)
      await srcRow.evaluate((a) => a.click())
      await win.waitForTimeout(1500)
      const p5 = await settle(win, NEEDLE)
      check('W5 任务总结卡的网页来源行也在 Desk 里开(不是新标签;同卡的文件来源本来就进 Desk)',
        p5.wv && p5.title === 'PAGE-THREE', `Desk 里是=${p5.title}`)
    } else {
      check('W5 任务总结卡的网页来源行也在 Desk 里开', false, '总结卡/来源行没渲染出来(窗口太窄?容器查询 860px)')
    }

    // W4 非聊天面的链接不许劫持 Desk。Markdown 组件不只聊天在用(更新日志/设置/市场/收件箱/右栏/
    // WsFileView… 共 14 处调用点),而 activeId 在别的标签页上照样有值 —— 少了「该会话的 Desk 真挂在
    // DOM 上」这道闸,那些面里的链接会被写进一块看不见的 Desk = 点了没反应。
    // 场景注入:摘掉 data-desk-session(= Desk 不在场),再点同一条引用条,必须退回原出口。
    await win.evaluate(() => {
      document.querySelectorAll('[data-desk-session]').forEach((el) => el.removeAttribute('data-desk-session'))
    })
    await links.nth(0).click()
    await win.waitForTimeout(2500)
    // 判据 = Desk **之外**多了一个 webview(退回出口开的主区浏览器标签)。少了闸的话点击会进 Desk,
    // 主区一个新标签都不会有 → 这条当场红。
    // ⚠️ 别改成断「Desk 里还是旧页」:退回出口开的是主区标签,它会抢走当前 tab → 聊天视图连同
    //    AgentDesk 一起卸载,`.agent-desk webview` 本来就查不到了(第一版这么写,假红一次)。
    const fb = await win.evaluate(() => ({
      outside: document.querySelectorAll('webview').length - document.querySelectorAll('.agent-desk webview').length,
    }))
    check('W4 Desk 不在场时(非聊天面同款条件)链接退回原出口,不写进看不见的 Desk',
      fb.outside > 0, `Desk 外的 webview=${fb.outside}`)



  } finally {
    try { await app.close() } catch { /* 关闭失败不该盖掉断言结果 */ }
    try { await stub.close() } catch { /* 同上(close 是同步的,不返回 promise) */ }
    srv.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  const ok = results.filter((r) => r.ok).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
