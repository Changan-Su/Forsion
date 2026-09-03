// 媒体时间锚 `#t=` × 网页嵌入 `![[https://…]]` 的分类链仪器(2026-08-28)。
// 用法:node scripts/e2e-editor.cjs --check=media-embed   (npm run check:mediaembed)
//
// 本仪器**量 currentTime,不量 src 字符串** —— 起播的失败形态是「静默停在 0 秒」,
// 断言 src 里有没有 `#t=95` 是彻底测不到它的(而且我们的实现根本不把时刻写进 src,
// 走的是 loadedmetadata → currentTime,正是为了让改锚点能重新 seek)。
// 台架跑在普通 Chromium 里没有 amadeus-asset:// 协议,所以先经 window.__assets.setUrlBuilder
// 把资源 URL 换成一段真的 data: 视频(见 harness.tsx 的注释)。
//
//   M1 `![[a.mp4]]`        → 播放器,起播 0
//   M2 `![[a.mp4#t=95]]`   → 播放器,**currentTime 真的落在 95**(不是量 src)
//   M3 `![[a.mp4#t=1:35]]` → 非法锚:仍是播放器 + 「锚点无效」提示,**绝不是「嵌入丢失」**
//   M4 `![[a.mp4#page=3]]` → 同 M3(错族锚点)
//   M5 `![[笔记#块]]`      → 块锚点保护:仍走跨笔记分支,没被媒体分支抢走
//   M6 `![[https://…]]`    → 网页嵌入卡(冻结态);非 http(s) → 拦截卡
//   M7 amadeus:media-goto  → 页内播放器认领并 seek,handled 置 true
//   M8 同名歧义            → **不认领**(handled 仍 false),宁可回落也不猜
//
// 2026-08-29 补两组(同一层的粘贴与尺寸,共用这套起停,不另起脚本):
//   P1-P5 粘贴一条 URL → 「粘贴为」菜单三选一(链接 / 书签卡 / 内嵌);**忽略菜单 = 裸 URL = 书签卡**,
//         视频链接不再自动变播放器(用户实报「粘贴视频链接直接就 embed 了」)
//   R1-R4 嵌入宽度 `![[…|320]]`:像图片一样拖右缘把手改宽,零位移不写盘,别的嵌入形态不挂把手
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').slice('--nc='.length)
// `--shot[=目录]`:出一张真截图。DESIGN.md §8 —— 观感类改动几何断言全绿 ≠ 看起来对。
const SHOT_ARG = process.argv.find((a) => a === '--shot' || a.startsWith('--shot='))
const SHOT = SHOT_ARG ? (SHOT_ARG.split('=')[1] || os.tmpdir()) : null
const results = []
const record = (name, ok, detail) => {
  results.push(!!ok) // !!:一条真失败(undefined/异常对象)不许被当成真值报绿
  console.log(`${!!ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

// 3 秒静音 h264 是二进制,台架里用一段最小 webm 反而更稳:这里用 Chromium 一定认的 wav 音频 +
// 一个真 <video> 拿不到时退化成 <audio> 的判据无关 —— 我们只需要「元数据可加载 + 可 seek」。
// 200 秒静音 wav(44 字节头 + 数据),够 seek 到 95。
function silentWavDataUrl(seconds) {
  const rate = 8000
  const n = rate * seconds
  const buf = Buffer.alloc(44 + n)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34)
  buf.write('data', 36); buf.writeUInt32LE(n, 40)
  buf.fill(128, 44) // 8-bit PCM 的静音是 0x80
  return 'data:audio/wav;base64,' + buf.toString('base64')
}

async function open(browser, seed) {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(400)
  return p
}

/** 把 amadeus-asset:// 换成真的 data: 媒体,并让 pageStore 认得这些"文件"。 */
async function installAssets(p, wav, files) {
  await p.evaluate(([url, list]) => {
    window.__assets.setUrlBuilder(() => url)
    window.__pageStore.setState({ files: list })
  }, [wav, files])
}

/** 元素中心点(拿不到返回 null,调用方据此把依赖它的断言逐条记红)。 */
async function rectOf(p, sel) {
  const h = await p.$(sel)
  if (!h) return null
  const r = await h.boundingBox()
  return r && { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
}

async function dragX(p, from, dx) {
  await p.mouse.move(from.cx, from.cy)
  await p.mouse.down()
  await p.mouse.move(from.cx + dx, from.cy, { steps: 6 })
  await p.mouse.up()
}

const vaultOf = (p) => p.evaluate(() => String(window.__upage.vault.get('Unified.md')))

/** 把光标放到第一段的**行尾**,并**核实真的到了**(不到就重来一次)。
 *  ⚠️ 点段落中心 + End 是不稳的:焦点还没就位时 End 走空,光标留在段首 —— 后面无论是回车切段
 *  还是直接粘贴,结果都错位,报出来是一片看不懂的红(实测反复)。两道保险:点段落**右缘**
 *  (块级元素右边一大片空白,必定落到行尾)+ 落点自检 + 重试一次。 */
async function caretToLineEnd(p) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const el = await p.$(`${PM} > p`)
    if (!el) return false
    const box = await el.boundingBox()
    await p.mouse.click(box.x + box.width - 3, box.y + box.height / 2)
    await p.waitForTimeout(180)
    await p.keyboard.press('End')
    await p.waitForTimeout(120)
    const ok = await p.evaluate((sel) => {
      const s = window.getSelection()
      const first = document.querySelector(`${sel} > p`)
      if (!s || !s.anchorNode || !first || !first.contains(s.anchorNode)) return false
      return s.anchorOffset === (s.anchorNode.textContent || '').length
    }, PM)
    if (ok) return true
  }
  record('(前置)光标落到首段行尾', false, '两次都没落到')
  return false
}

/** 把光标放进一个**新的空段落**(粘贴菜单只在空段里弹)。 */
async function caretInNewParagraph(p) {
  if (!(await caretToLineEnd(p))) return false
  await p.keyboard.press('Enter')
  await p.waitForTimeout(250)
  const ok = await p.evaluate((sel) => {
    const ps = document.querySelectorAll(`${sel} > p`)
    return ps.length === 2 && !ps[1].textContent
  }, PM)
  if (!ok) record('(前置)光标进到新空段落', false, '回车没切出空段')
  return ok
}

/** 合成 paste 事件:headless 里 Meta+V 不一定带得上剪贴板,而要验的正是 PM 的 handlePaste。 */
async function pasteText(p, text) {
  await p.evaluate(([sel, t]) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, [PM, text])
  await p.waitForTimeout(300)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--autoplay-policy=no-user-gesture-required'] })
  const wav = silentWavDataUrl(200)

  // ── M1–M5:分类链 ─────────────────────────────────────────────────────────
  {
    // ⚠️ 首段必须是普通文字:编辑器初始光标落在文档开头,而本层的契约是「光标进入该节点 →
    // 装饰整体让位露源码」—— 首段放嵌入的话它**根本不会渲染**,后面所有按序号取的断言全部错位。
    const seed = [
      '开篇', '', '![[a.m4a]]', '', '![[a.m4a#t=95]]', '', '![[a.m4a#t=1:35]]', '', '![[a.m4a#page=3]]',
    ].join('\n')
    const p = await open(browser, seed)
    await installAssets(p, wav, ['a.m4a'])
    await p.waitForTimeout(900)

    const players = await p.$$eval('.embed-media', (els) => els.length)
    record('M1-4 四种媒体形态都渲染成播放器(含两种非法锚)', players === 4, `players=${players}`)

    const lost = await p.$$eval('.embed-missing', (els) => els.length)
    record('M3/M4 非法锚**绝不**变成「嵌入丢失」', lost === 0, `embed-missing=${lost}`)


    const warns = await p.$$eval('.embed-media-warn', (els) => els.length)
    record('M3/M4 非法锚给出可见的「锚点无效」提示', warns === 2, `warn=${warns}`)

    const badges = await p.$$eval('.embed-media-at', (els) => els.map((e) => e.textContent.trim()))
    record('M2 合法锚显示时刻徽标 @01:35', badges.length === 1 && badges[0] === '@01:35', JSON.stringify(badges))

    // M2 的真断言:量 currentTime
    const t = await p.evaluate(async () => {
      const list = [...document.querySelectorAll('.embed-media')]
      const host = list[1] // 第二块 = `#t=95`(第一块是无锚的 `![[a.m4a]]`)
      const el = host?.querySelector('video,audio')
      if (!el) return { err: 'no media element' }
      for (let i = 0; i < 60 && el.readyState < 1; i++) await new Promise((r) => setTimeout(r, 100))
      await new Promise((r) => setTimeout(r, 300))
      return { ready: el.readyState, at: el.currentTime, dur: el.duration }
    })
    record('M2 起播真的落在 95 秒(量 currentTime,不量 src)', t.ready >= 1 && Math.abs(t.at - 95) < 1.5, JSON.stringify(t))

    // 第一块(无锚)必须还在 0
    const t0 = await p.evaluate(() => {
      const el = document.querySelectorAll('.embed-media')[0]?.querySelector('video,audio')
      return el ? el.currentTime : -1
    })
    record('M1 无锚的那块不许被误 seek', t0 >= 0 && t0 < 1, `t0=${t0}`)
    // 落盘往返:新语法在编辑器里走一圈,磁盘字面必须一字不变(remark 把 `[[` 转义掉 = 死链,
    // 本仓栽过;而嵌入块的源码平时是藏起来的,肉眼看不出已经坏了)。
    const stored = await p.evaluate(() => window.__upage.vault.get('Unified.md'))
    const kept = ['![[a.m4a]]', '![[a.m4a#t=95]]', '![[a.m4a#t=1:35]]', '![[a.m4a#page=3]]']
      .filter((x) => String(stored).includes(x))
    record('M9 落盘往返:四种媒体字面一字不变(remark 没把 `[[` 转义成死链)', kept.length === 4, JSON.stringify(kept))

    if (SHOT) {
      const f = path.join(SHOT, 'media-embed.png')
      await p.screenshot({ path: f, fullPage: true })
      console.log(`  截图 → ${f}`)
    }
    await p.close()
  }

  // ── M5:块锚点保护(单独一页,免得它合法的「嵌入丢失」污染 M3/M4 的计数)──────────
  {
    const p = await open(browser, '开篇\n\n![[某笔记#^blk]]\n\n![[C# 日记.md]]')
    await p.waitForTimeout(700)
    const media = await p.$$eval('.embed-media', (els) => els.length)
    record('M5 块锚点/文件名含 # 的都没被媒体分支抢走', media === 0, `media=${media}`)
    await p.close()
  }

  // ── M6:网页嵌入 ─────────────────────────────────────────────────────────
  {
    // ⚠️ 第三条特意带 `www.` **和查询串**:URL 被解析成链接节点后,裸写需要转义 `www\.` → mdast
    // 改用尖括号形态。少了查询串复现不出来(`![[https://www.example.com/a]]` 就是不会包尖括号,
    // 实测;别把这条种子"简化"掉,负对照会当场变哑)。
    // 于是盘上变成 `![[<https://www…>]]`:我们自己照渲(尖括号在 textContent 里是语法不是文本),
    // 但 **Obsidian 解析不了**,而且每次保存都在改字节。不带 `www.` 的地址照不到这条。
    const p = await open(browser, '开篇\n\n![[https://example.com/page]]\n\nhttps://example.com/plain\n\n![[https://www.example.com/watch?v=abc12345]]')
    await p.waitForTimeout(700)
    const web = await p.$$eval('.amx-web', (els) => els.length)
    record('M6 `![[https://…]]` 渲染成网页嵌入卡(不是「嵌入丢失」)', web === 2, `amx-web=${web}`)
    const frozen = await p.$$eval('.amx-web webview, .amx-web iframe', (els) => els.length)
    record('M6 **默认冻结**:未点唤醒时不许有任何活网页宿体', frozen === 0, `hosts=${frozen}`)
    // ⚠️ 落盘往返必须**先制造一次编辑**:只加载不改的话 vault 里躺的还是种子原文,
    // 序列化器根本没跑过 —— 断言看着绿,其实一个字节都没验(负对照实测:去掉修复照样绿)。
    await p.click(`${PM} > p`)
    await p.keyboard.press('End')
    await p.keyboard.type('。')
    await p.waitForTimeout(1600)
    const storedWeb = await p.evaluate(() => window.__upage.vault.get('Unified.md'))
    record('M9 落盘往返:`![[https://…]]` 与裸 URL 两种字面都原样保留',
      String(storedWeb).includes('![[https://example.com/page]]') && String(storedWeb).includes('\nhttps://example.com/plain'),
      JSON.stringify(String(storedWeb).slice(0, 90)))
    record('M9b 带 `www.` 的地址不许被包成 `![[<url>]]`(Obsidian 解析不了 + 每次保存都churn)',
      String(storedWeb).includes('![[https://www.example.com/watch?v=abc12345]]') && !String(storedWeb).includes('<https'),
      JSON.stringify(String(storedWeb).slice(-60)))
    const bm = await p.$$eval('.amx-bm', (els) => els.length)
    // 冻结态的网页嵌入内部就复用书签卡 → 一条裸 URL + 两个冻结嵌入 = 3 张
    record('M6 裸 URL 仍是书签卡(两种字面两种形态)', bm === 3, `amx-bm=${bm}`)
    // 桌面分支:台架里没有 window.tangu(→ 走降级书签卡,上面已断言)。桩一个再重开,
    // 断言「冻结态有唤醒按钮、且此时仍无活网页宿体;点了唤醒才挂 webview」。
    // ⚠️ 普通 Chromium 里 <webview> 只是个未知标签(不会真加载)—— 这条测的是**挂载路径对不对**,
    // 真页面能不能跑必须去真 Electron 点(见 docs 的三端矩阵)。
    const q = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
    await q.addInitScript(() => { window.tangu = { openExternal: () => {} } })
    await q.goto(`${URL}?upage&upane&useed=${encodeURIComponent('开篇\n\n![[https://example.com/page]]')}`, { waitUntil: 'domcontentloaded' })
    await q.waitForSelector(PM, { timeout: 20000 })
    await q.waitForTimeout(700)
    const frozenBtn = await q.$$eval('.amx-web-frozen .embed-media-btn', (els) => els.map((e) => e.textContent.trim()))
    record('M6b 桌面端默认冻结:有「唤醒网页」按钮,且此刻没有活宿体',
      frozenBtn.some((x) => x.includes('唤醒')) && (await q.$$('.amx-web webview')).length === 0, JSON.stringify(frozenBtn))
    await q.click('.amx-web-frozen .embed-media-btn')
    await q.waitForTimeout(400)
    const live = await q.$$eval('.amx-web-live webview', (els) => els.length)
    record('M6c 点唤醒后才挂 <webview>(且是 webview 不是 iframe)', live === 1, `webview=${live}`)
    const ifr = await q.$$eval('.amx-web iframe', (els) => els.length)
    record('M6c 任意网页**绝不**用 iframe 承载(sandbox 静默削能力)', ifr === 0, `iframe=${ifr}`)
    await q.close()

    if (SHOT) {
      const f = path.join(SHOT, 'web-embed.png')
      await p.screenshot({ path: f, fullPage: true })
      console.log(`  截图 → ${f}`)
    }
    await p.close()
  }

  // ── M7/M8:media-goto 认领 ────────────────────────────────────────────────
  {
    const p = await open(browser, '开篇\n\n![[a.m4a]]')
    await installAssets(p, wav, NC === 'ambiguous' ? ['a.m4a'] : ['dir1/a.m4a', 'dir2/a.m4a'])
    await p.waitForTimeout(900)
    const amb = await p.evaluate(() => {
      const ev = new CustomEvent('amadeus:media-goto', { detail: { path: 'dir1/a.m4a', at: 42, handled: false } })
      window.dispatchEvent(ev)
      return ev.detail.handled
    })
    record('M8 同名歧义时**不认领**(宁可回落也不猜)', amb === false, `handled=${amb}`)
    await p.close()

    const q = await open(browser, '开篇\n\n![[a.m4a]]')
    await installAssets(q, wav, ['dir1/a.m4a'])
    await q.waitForTimeout(900)
    const got = await q.evaluate(async () => {
      const el = document.querySelector('.embed-media video, .embed-media audio')
      for (let i = 0; i < 60 && el.readyState < 1; i++) await new Promise((r) => setTimeout(r, 100))
      const ev = new CustomEvent('amadeus:media-goto', { detail: { path: 'dir1/a.m4a', at: 42, handled: false } })
      window.dispatchEvent(ev)
      await new Promise((r) => setTimeout(r, 300))
      return { handled: ev.detail.handled, at: el.currentTime }
    })
    record('M7 唯一命中时认领并就地 seek(handled=true)', got.handled === true && Math.abs(got.at - 42) < 1.5, JSON.stringify(got))
    await q.close()
  }

  // ── P1–P5:粘贴链接 → 「粘贴为」菜单 ───────────────────────────────────────
  const YT = 'https://www.youtube.com/watch?v=abc12345'
  {
    const p = await open(browser, '开篇')
    await caretInNewParagraph(p)
    await pasteText(p, YT)
    const items = await p.$$eval('.paste-as-item .paste-as-name', (els) => els.map((e) => e.textContent.trim()))
    record('P1 粘一条视频链接 → 先弹「粘贴为」三选一,不替用户猜', items.length === 3, JSON.stringify(items))
    const frames0 = await p.$$eval('iframe', (els) => els.length)
    record('P1 ⚠️ 此刻**没有**任何播放器(旧行为是当场 embed)', frames0 === 0, `iframe=${frames0}`)
    if (SHOT) {
      const f = path.join(SHOT, 'paste-as-menu.png')
      await p.screenshot({ path: f })
      console.log(`  截图 → ${f}`)
    }

    // 「内嵌」= 第三项
    const btns = await p.$$('.paste-as-item')
    if (btns.length === 3) await btns[2].click()
    await p.waitForTimeout(1600) // UnifiedPage 落盘防抖
    const md = await vaultOf(p)
    const frames = await p.$$eval('.amx-bm-video iframe', (els) => els.length)
    record('P2 选「内嵌」→ 落盘 `![[url]]` 且出现播放器', md.includes(`![[${YT}]]`) && frames === 1, `iframe=${frames} md=${JSON.stringify(md.slice(-70))}`)
    await p.close()
  }
  {
    const p = await open(browser, '开篇')
    await caretInNewParagraph(p)
    await pasteText(p, YT)
    const btns = await p.$$('.paste-as-item')
    if (btns.length) await btns[0].click()
    await p.waitForTimeout(1600)
    const md = await vaultOf(p)
    const cards = await p.$$eval('.amx-bm', (els) => els.length)
    // ⚠️ 链接文字**不能**是 URL 原文:那样整段仍是一条裸 URL,classifyEmbed 照样升级成书签卡
    //(它按 textContent 判,看不见 link mark),「链接」与「书签」就成了同一个东西。
    record('P3 选「链接」→ 行内链接(文字=主机名),不再是卡片',
      md.includes(`[youtube.com](${YT})`) && cards === 0, `cards=${cards} md=${JSON.stringify(md.slice(-70))}`)
    await p.close()
  }
  {
    const p = await open(browser, '开篇')
    await caretInNewParagraph(p)
    await pasteText(p, YT)
    await p.keyboard.press('Escape')
    // ⚠️ 光标还在这一段里 = 装饰让位、只露源码,这是本层的交互契约不是 bug。
    // 「忽略菜单」的观感要点开别处才看得到 —— 台架也得照做,不然量到的是 bm=0 的假红。
    await p.click(`${PM} > p`)
    await p.waitForTimeout(1600)
    const md = await vaultOf(p)
    const st = await p.evaluate(() => ({ menu: !!document.querySelector('.paste-as-menu'), bm: document.querySelectorAll('.amx-bm').length, ifr: document.querySelectorAll('iframe').length }))
    record('P4 忽略菜单(Esc)→ 维持裸 URL = 书签卡,零 churn(且仍不是播放器)',
      !st.menu && st.bm === 1 && st.ifr === 0 && md.includes(`\n${YT}`), `${JSON.stringify(st)} md=${JSON.stringify(md)}`)
    await p.close()
  }
  {
    const p = await open(browser, '开篇')
    await caretToLineEnd(p) // 同一道前置自检:落点错了粘出来是 `<url>开篇`,报出来看不懂
    await pasteText(p, YT) // 段落非空 → 正常粘贴,不该打断
    const st = await p.evaluate((sel) => ({ menu: !!document.querySelector('.paste-as-menu'), text: document.querySelector(sel).innerText }), PM)
    record('P5 段落非空时粘贴不弹菜单(别打断正常的行内粘贴)',
      !st.menu && st.text.includes(`开篇${YT}`), JSON.stringify(st).slice(0, 140))
    await p.close()
  }

  {
    const p = await open(browser, '开篇')
    if (await caretInNewParagraph(p)) {
      // 浏览器「复制图片」的剪贴板常常**同时**带一个 image File 和一条来源 URL。
      // URL 分支若排在图片之前,粘出来的是链接卡而不是图片(Codex 2026-08-29)。
      await p.evaluate(([sel, t]) => {
        const dt = new DataTransfer()
        dt.setData('text/plain', t)
        dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' }))
        document.querySelector(sel).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      }, [PM, YT])
      await p.waitForTimeout(500)
      const menu = await p.$$eval('.paste-as-menu', (els) => els.length)
      record('P6 ⚠️ 剪贴板同时带图片时图片优先(URL 分支不许吞掉复制的图片)', menu === 0, `menu=${menu}`)
    }
    await p.close()
  }
  {
    const p = await open(browser, '开篇\n\n![[https://x.test/?q=a|b]]')
    await p.waitForTimeout(700)
    const href = await p.$eval('.amx-web .amx-bm', (e) => e.getAttribute('href')).catch(() => null)
    record('P7 ⚠️ URL 里的 `|` 不许被当分隔符截断(截断后「转为书签卡」会永久丢半条)',
      href === 'https://x.test/?q=a|b', `href=${href}`)
    await p.close()
  }

  {
    // 菜单摆位:必须锚**光标**(URL 末尾),不是段首 —— 长地址时锚段首会让菜单离手很远。
    const p = await open(browser, '开篇')
    if (await caretInNewParagraph(p)) {
      await pasteText(p, YT)
      const g = await p.evaluate((sel) => {
        const para = document.querySelectorAll(`${sel} > p`)[1]
        const t = para?.firstChild
        if (!t) return null
        const r = document.createRange()
        r.setStart(t, t.textContent.length)
        r.setEnd(t, t.textContent.length)
        const menu = document.querySelector('.paste-as-menu')
        if (!menu) return null
        return { caret: r.getBoundingClientRect().left, menu: menu.getBoundingClientRect().left, paraLeft: para.getBoundingClientRect().left }
      }, PM)
      record('P8 菜单锚在光标处(不是段首)',
        !!g && Math.abs(g.menu - g.caret) < 28 && g.menu - g.paraLeft > 100, JSON.stringify(g))
    }
    await p.close()
  }
  {
    // 方向键选择:↓ 进选择态 → 再 ↓↓ 到「内嵌」→ ↵ 确认。
    const p = await open(browser, '开篇')
    if (await caretInNewParagraph(p)) {
      await pasteText(p, YT)
      const before = await p.$$eval('.paste-as-item[data-active]', (els) => els.length)
      record('P9 未按方向键时**不高亮任何项**(菜单是不请自来的,别抢默认动作)', before === 0, `active=${before}`)
      await p.keyboard.press('ArrowDown')
      await p.waitForTimeout(120)
      const first = await p.$eval('.paste-as-item[data-active] .paste-as-name', (e) => e.textContent.trim()).catch(() => null)
      record('P9 首次 ↓ 落到第一项', first === '链接', `active=${first}`)
      await p.keyboard.press('ArrowDown')
      await p.keyboard.press('ArrowDown')
      await p.waitForTimeout(120)
      const third = await p.$eval('.paste-as-item[data-active] .paste-as-name', (e) => e.textContent.trim()).catch(() => null)
      if (SHOT) {
        const f = path.join(SHOT, 'paste-as-keyboard.png')
        await p.screenshot({ path: f })
        console.log(`  截图 → ${f}`)
      }
      await p.keyboard.press('Enter')
      await p.waitForTimeout(1600)
      const md = await vaultOf(p)
      record('P9 ↓↓↓ 到「内嵌」再 ↵ → 落盘 `![[url]]`',
        third === '内嵌' && md.includes(`![[${YT}]]`), `third=${third} md=${JSON.stringify(md.slice(-46))}`)
    }
    await p.close()
  }
  {
    // ⚠️ 没按过方向键时,回车**一个键都不许拦** —— 「粘完直接敲回车」是肌肉记忆。
    const p = await open(browser, '开篇')
    if (await caretInNewParagraph(p)) {
      await pasteText(p, YT)
      const n0 = await p.$$eval(`${PM} > p`, (els) => els.length)
      await p.keyboard.press('Enter')
      await p.waitForTimeout(300)
      const st = await p.evaluate((sel) => ({
        menu: !!document.querySelector('.paste-as-menu'),
        n: document.querySelectorAll(`${sel} > p`).length,
      }), PM)
      record('P10 ⚠️ 没选过就按 ↵:菜单关掉,但回车照常换行(不许被吞)',
        !st.menu && st.n === n0 + 1, `${JSON.stringify(st)} n0=${n0}`)
    }
    await p.close()
  }

  // ── B1–B3:书签卡封面(2026-08-29 用户实报「书签卡怎么没有封面」)────────────────
  {
    // 三档封面一次看全:og 配图 / 只有 apple-touch-icon(方形 logo) / 站点什么都不发。
    // ⚠️ 台架里 `amadeus.fetchLinkMeta` 本来不存在 —— 用 addInitScript 先占住 window.amadeus,
    // harness 的 `Object.assign(g.amadeus ?? …)` 是**合并**进来,所以这个桩活得下来。
    const wide = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="315"><rect width="600" height="315" fill="#4f8cff"/></svg>')
    const sq = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" rx="34" fill="#0b84ff"/></svg>')
    const q = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 760 } })
    await q.addInitScript(([w, i]) => {
      window.amadeus = {
        fetchLinkMeta: async (u) => {
          if (u.includes('photo.test')) return { title: '有配图', description: 'og', image: w, imageKind: 'photo', siteName: 'photo.test' }
          if (u.includes('icon.test')) return { title: '只有图标', description: 'icon', image: i, imageKind: 'icon', siteName: 'icon.test' }
          return null
        },
      }
    }, [wide, sq])
    const seed = ['开篇', '', 'https://photo.test/a', '', 'https://icon.test/a', '', 'https://nometa.test/a'].join('\n')
    await q.goto(`${URL}?upage&upane&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await q.waitForSelector(PM, { timeout: 20000 })
    await q.waitForTimeout(1200)
    const kinds = await q.$$eval('.amx-bm-thumb', (els) => els.map((e) => (e.className.match(/amx-bm-thumb-(gen|icon)/) || [, 'photo'])[1]))
    record('B1 ⚠️ 封面位永远在:三种站点三档封面(照片 / 图标 / 生成),没有「没封面」这一档',
      kinds.length === 3 && kinds[0] === 'photo' && kinds[1] === 'icon' && kinds[2] === 'gen', JSON.stringify(kinds))
    // 改坏时要看到**完整**的红点清单,不是第一处异常就把整支脚本崩掉(同 image-select 的 skipRest)。
    const gen = await q.$eval('.amx-bm-thumb-gen', (e) => {
      const L = e.querySelector('.amx-bm-gen-letter')
      return {
        bg: e.style.backgroundImage.slice(0, 15),
        letter: L?.textContent ?? null,
        // ⚠️ 首字母必须绝对定位:祖先 <a> 的下划线是**画穿后代**的,子元素 text-decoration:none 关不掉。
        pos: L ? getComputedStyle(L).position : null,
      }
    }).catch(() => ({ bg: null, letter: null, pos: null }))
    record('B2 生成封面 = 主机名渐变 + 首字母,且首字母不被链接下划线穿过',
      gen.bg === 'linear-gradient' && gen.letter === 'N' && gen.pos === 'absolute', JSON.stringify(gen))
    // 封面在**左**(用户 2026-08-29 指定):量几何,不量 DOM 顺序 —— flex 的 order 也能换位置。
    const side = await q.$eval('.amx-bm', (e) => ({
      cover: e.querySelector('.amx-bm-thumb').getBoundingClientRect().left,
      text: e.querySelector('.amx-bm-main').getBoundingClientRect().left,
      cardL: e.getBoundingClientRect().left,
    }))
    record('B4 封面在左:封面左沿贴卡片左沿,且在正文左边',
      side.cover < side.text && Math.abs(side.cover - side.cardL) < 2, JSON.stringify(side))
    const icon = await q.$eval('.amx-bm-thumb-icon img', (e) => ({ fit: getComputedStyle(e).objectFit, w: e.getBoundingClientRect().width, host: e.parentElement.getBoundingClientRect().width }))
    record('B3 apple-touch-icon 是方形 logo:contain 居中垫在渐变上,不许拉满变形',
      icon.fit === 'contain' && icon.w < icon.host * 0.8, JSON.stringify(icon))
    if (SHOT) {
      const f = path.join(SHOT, 'bookmark-covers.png')
      await q.screenshot({ path: f })
      console.log(`  截图 → ${f}`)
    }
    await q.close()
  }

  // ── R1–R4:嵌入宽度把手 ───────────────────────────────────────────────────
  {
    const p = await open(browser, '开篇\n\n![[https://example.com/page|320]]\n\n![[报告.md|2024]]')
    await p.waitForTimeout(700)
    const w = await p.$eval('.unified-embed', (e) => e.getBoundingClientRect().width)
    record('R1 `|320` 真的把嵌入收窄到 320px', Math.abs(w - 320) < 2, `w=${w}`)
    const handles = await p.$$eval('.unified-embed > .amx-img-resize', (els) => els.length)
    // ⚠️ 第二块是 `![[报告.md|2024]]` —— 那个 `|2024` 是跨笔记别名,不许被当宽度吃掉,也不挂把手。
    record('R2 只有网页/媒体嵌入挂把手(跨笔记别名不挂)', handles === 1, `handles=${handles}`)
    const h = await rectOf(p, '.unified-embed > .amx-img-resize')
    if (!h) {
      record('R3 拖 +80px → 落盘 |400', false, '把手拿不到')
    } else {
      await dragX(p, h, 80)
      await p.waitForTimeout(1600)
      const md = await vaultOf(p)
      record('R3 拖 +80px → 落盘 `|400`,别的段不动',
        md.includes('![[https://example.com/page|400]]') && md.includes('![[报告.md|2024]]'), JSON.stringify(md.slice(0, 90)))
    }
    await p.close()
  }
  {
    const p = await open(browser, '开篇\n\n![[https://example.com/page]]')
    await p.waitForTimeout(700)
    const before = await vaultOf(p)
    const h = await rectOf(p, '.unified-embed > .amx-img-resize')
    if (!h) {
      record('R4 只在把手上点一下 → 不写盘', false, '把手拿不到')
    } else {
      await p.mouse.move(h.cx, h.cy)
      await p.mouse.down()
      await p.mouse.up()
      await p.waitForTimeout(1400)
      const after = await vaultOf(p)
      record('R4 只在把手上点一下 → **不写盘**(不平白给 md 添 `|宽度` + 一步撤销)',
        after === before && !after.includes('|'), JSON.stringify(after.slice(0, 80)))
    }
    if (SHOT) {
      const f = path.join(SHOT, 'embed-resize.png')
      await p.screenshot({ path: f, fullPage: true })
      console.log(`  截图 → ${f}`)
    }
    await p.close()
  }

  await browser.close()
  const bad = results.filter((r) => !r).length
  console.log(`\n${results.length - bad}/${results.length} 通过`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
