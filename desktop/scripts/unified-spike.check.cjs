// v4 统一实例 spike 三关仪器(spec §9 step 1,2026-08-13)。
// 验:① 回灌 = 同实例事务(不重挂、组合中押后、静默后应用);② calloutPlugin 整只带入
// (折叠/露源码契约不变)+ 单实例新规则「光标离开收回源码态」;③ PM 原生键位 = Notion 语义
// (Enter 分段、Shift+Enter 硬换行),并量化 §3.4 换行编码的往返证据。
//
// 仪器工程注意(2026-08-13 实测踩坑):
//  · headless mac Chromium 里 `End` 键不保证移动光标 —— 一律用「点击文字右缘」定位到行尾;
//  · 并行会话写 frontend/src 会让 vite 全量重载 harness,把跑到一半的组打成假红(e2e-editor.cjs
//    头注点名的失败模式)—— 每组独立开页 + 页面令牌检测重载,重载即整组重试(最多 2 次);
//  · callout 内容行用 `>` 空行分隔(标准 md 段落)。软换行连体的单段落 callout 是已知 §residual:
//    折叠只藏「第 2+ 个子元素」,单段落无从藏起(见 U4f)。
//
// 用法:node scripts/e2e-editor.cjs --check=unified-spike(自起 vite);或先 npm run web 再直跑本文件。
const fs = require('fs'), os = require('os'), path = require('path')
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
const PM = '.unified-spike .ProseMirror'
const SEED = [
  '# 演示标题', '',
  '第一段甲。', '',
  '第二段乙。', '',
  '> [!note]+ 折叠标题', '>', '> 内容一', '>', '> 内容二', '',
  '第三段丙。', '',
].join('\n')

const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 元素内文字范围上的一个点:start=左缘 / mid=中心 / end=右缘(兼作「光标到行尾」,End 键不可靠)。 */
const textPoint = (p, sel, where = 'mid') =>
  p.evaluate(([s, w]) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = document.createRange()
    r.selectNodeContents(el)
    const b = r.getBoundingClientRect()
    const x = w === 'start' ? b.left + 2 : w === 'end' ? b.right - 2 : b.left + b.width / 2
    return { x, y: b.top + b.height / 2 }
  }, [sel, where])
const clickAt = async (p, sel, where) => {
  const c = await textPoint(p, sel, where)
  await p.mouse.click(c.x, c.y)
  return c
}
const mdNow = (p) => p.evaluate(() => window.__unified.md)
const syntaxCount = (p) => p.evaluate(() => document.querySelectorAll('.unified-spike .callout-syntax').length)

/** 一组断言跑在独立页面上;组中途页面被 vite 重载(令牌消失)→ 丢弃本组结果重试。 */
async function group(browser, name, fn, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const p = await browser.newPage()
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${URL}?unified&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector(PM, { timeout: 20000 })
    await p.waitForTimeout(400)
    await p.evaluate(() => { window.__runToken = 'T' })
    const buf = []
    const check = (n, ok, detail) => buf.push([n, ok, detail])
    let err = null
    try {
      await fn(p, check)
    } catch (e) {
      err = e
    }
    const alive = await p.evaluate(() => window.__runToken === 'T').catch(() => false)
    await p.close()
    if (!alive && attempt < retries) {
      console.log(`[retry] 组「${name}」中途页面被重载(并行会话写 frontend/src 触发 vite),整组重试 #${attempt + 1}`)
      continue
    }
    if (err) throw err
    for (const [n, ok, detail] of buf) record(n, ok, detail)
    return
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

  // ── G1:结构 + 键位语义 + §3.4 编码证据 ──────────────────────────────────────
  await group(browser, 'G1 键位', async (p, check) => {
    const u1 = await p.evaluate((s) => {
      const root = document.querySelector(s)
      return {
        p: root.querySelectorAll(':scope > p').length,
        h1: root.querySelectorAll(':scope > h1').length,
        bq: root.querySelectorAll(':scope > blockquote').length,
        bqKids: root.querySelector(':scope > blockquote')?.children.length,
        mounts: window.__unified.mounts,
      }
    }, PM)
    check('U1 整篇一个实例挂载+解析(3 段/1 标题/1 callout×3 子段)', u1.p === 3 && u1.h1 === 1 && u1.bq === 1 && u1.bqKids === 3 && u1.mounts === 1, JSON.stringify(u1))

    // U2:Enter = 新段落(Notion 语义,PM 原生),落盘 = 标准空行分段。行尾定位用点击右缘。
    await clickAt(p, `${PM} > p:nth-of-type(1)`, 'end')
    await p.keyboard.press('Enter')
    await p.keyboard.type('新插入段')
    await p.waitForTimeout(400)
    const u2 = {
      p: await p.evaluate((s) => document.querySelector(s).querySelectorAll(':scope > p').length, PM),
      ok: (await mdNow(p)).includes('第一段甲。\n\n新插入段'),
    }
    check('U2 Enter=新段落且落盘为空行分段', u2.p === 4 && u2.ok, `p=${u2.p}`)

    // U3a:Shift+Enter = 段内硬换行(段数不变)
    await clickAt(p, `${PM} > p:nth-of-type(2)`, 'end')
    await p.keyboard.down('Shift')
    await p.keyboard.press('Enter')
    await p.keyboard.up('Shift')
    await p.keyboard.type('续行')
    await p.waitForTimeout(400)
    const md3 = await mdNow(p)
    const enc = (md3.match(/新插入段(\\\n|  \n|<br[^>]*>)续行/) || [])[1] || '(未匹配)'
    const u3p = await p.evaluate((s) => document.querySelector(s).querySelectorAll(':scope > p').length, PM)
    check('U3a Shift+Enter=段内硬换行(段数不变+可识别编码)', u3p === 4 && enc !== '(未匹配)', `编码=${JSON.stringify(enc)}`)

    // §3.4 编码证据:两种换行**都**原样往返 —— 硬换行(两空格/反斜杠)与裸 \n(Obsidian 宽松
    // 语义)各自保持,Milkdown 把软换行也建模为 break 节点并按原编码序列化(实测超预期,
    // spec §3.4 的「宽松换行约定」在编辑器管线里天然成立)。
    const rt1 = await p.evaluate(() => window.__unified.breakRoundTrip('换甲  \n换乙'))
    check('U3b 硬换行 serialize→parse 存活', !!rt1 && rt1.parasIn === 1 && rt1.breaksIn === 1 && rt1.parasOut === 1 && rt1.breaksOut === 1, JSON.stringify(rt1))
    const rt2 = await p.evaluate(() => window.__unified.breakRoundTrip('裸甲\n裸乙'))
    check('U3c 裸 \\n 软换行原样往返(1 段 1 break,编码保持)', !!rt2 && rt2.parasIn === 1 && rt2.breaksIn === 1 && rt2.out.includes('裸甲\n裸乙') && rt2.breaksOut === 1, JSON.stringify(rt2))
  })

  // ── G2:callout 整只带入 ─────────────────────────────────────────────────────
  await group(browser, 'G2 callout', async (p, check) => {
    const HEAD = `${PM} > blockquote > p:first-child`
    check('U4a 初始:语法字符隐藏中+token 为 [!note]+', (await syntaxCount(p)) > 0 && (await mdNow(p)).includes('[!note]+'))

    const hpt = await clickAt(p, HEAD)
    await p.waitForTimeout(400)
    const u4b = {
      md: (await mdNow(p)).includes('[!note]-'),
      hiddenKids: await p.evaluate((s) => {
        const bq = document.querySelector(s)
        return [...bq.children].slice(1).filter((k) => k.getBoundingClientRect().height === 0).length
      }, `${PM} > blockquote`),
    }
    check('U4b 单击标题=折叠(token 改 -,两条内容段高度归零)', u4b.md && u4b.hiddenKids === 2, `hiddenKids=${u4b.hiddenKids}`)

    // ⚠️ 同点连击必须隔开 >500ms:否则 Chromium 把第二击判成双击,PM 走 handleDoubleClick
    // (露源码,不折叠),U4c 就假红(2026-08-13 实测)。U4d 前同理防三击。
    await p.waitForTimeout(700)
    await p.mouse.click(hpt.x, hpt.y)
    await p.waitForTimeout(400)
    check('U4c 再击=展开(token 回 +)', (await mdNow(p)).includes('[!note]+'))

    await p.waitForTimeout(700)
    await p.mouse.dblclick(hpt.x, hpt.y)
    await p.waitForTimeout(400)
    check('U4d 双击=露源码(第一下顺带折叠,语法 spans 归零)', (await syntaxCount(p)) === 0 && (await mdNow(p)).includes('[!note]-'))

    await clickAt(p, `${PM} > p:nth-of-type(3)`)
    await p.waitForTimeout(300)
    check('U4e 【单实例新规则】光标离开 callout=收回源码态', (await syntaxCount(p)) > 0)

    // U4f 【已知 residual】软换行连体的 callout(`> 标题\n> 内容`,Obsidian 常见写法)解析为
    // 单段落 —— 折叠只藏「第 2+ 个子元素」,单段落无从藏。v4 折叠须支持段内 break 级隐藏,
    // 或读侧把 callout 内软换行拆段(softBreak.expand 的定向复用)。先钉住现状。
    const rt = await p.evaluate(() => window.__unified.breakRoundTrip('> [!info]- 标\n> 内容一\n> 内容二'))
    check('U4f 【已知 residual】软换行 callout=单段落(折叠无从藏)', !!rt && rt.parasIn === 1 && rt.breaksIn === 2, JSON.stringify(rt))
  })

  // ── G3:外部回灌 × 打字互斥 + 跨段选区 ───────────────────────────────────────
  await group(browser, 'G3 回灌', async (p, check) => {
    await p.evaluate((s) => document.querySelector(s).setAttribute('data-stamp', 'S1'), PM)
    await p.evaluate(() => window.__unified.reconcile('# 回灌标题\n\n回灌内容一。\n\n回灌内容二。\n'))
    await p.waitForTimeout(250)
    const u5 = await p.evaluate((s) => ({
      stamp: document.querySelector(s)?.getAttribute('data-stamp'),
      h1: document.querySelector(`${s} > h1`)?.textContent,
      mounts: window.__unified.mounts,
      reconciled: window.__unified.reconciled,
    }), PM)
    check('U5 空闲回灌=同实例事务(DOM 戳记还在,零重挂)', u5.stamp === 'S1' && u5.h1 === '回灌标题' && u5.mounts === 1 && u5.reconciled === 1, JSON.stringify(u5))

    // U6:组合中押后 → compositionend 后仍要过 700ms 静默窗(typingGuard.QUIET_MS)才应用。
    await p.evaluate(() => {
      document.dispatchEvent(new Event('compositionstart'))
      window.__rec = window.__unified.reconcile('# 组合期回灌\n\n组合甲。\n\n组合乙。\n')
    })
    await p.waitForTimeout(300)
    const during = await p.evaluate((s) => ({
      h1: document.querySelector(`${s} > h1`)?.textContent,
      pending: window.__unified.reconcilePending,
    }), PM)
    check('U6a 组合中回灌被押后(内容未变+pending)', during.h1 === '回灌标题' && during.pending === true, JSON.stringify(during))

    await p.evaluate(() => document.dispatchEvent(new Event('compositionend')))
    await p.waitForTimeout(1400)
    const after = await p.evaluate((s) => ({
      h1: document.querySelector(`${s} > h1`)?.textContent,
      pending: window.__unified.reconcilePending,
      stamp: document.querySelector(s)?.getAttribute('data-stamp'),
    }), PM)
    check('U6b 静默后应用(实例依旧没换)', after.h1 === '组合期回灌' && after.pending === false && after.stamp === 'S1', JSON.stringify(after))

    // U7:跨段落原生选区 —— 每块一实例做不到,统一实例的核心红利展示。
    await clickAt(p, `${PM} > p:nth-of-type(1)`, 'start')
    const e2 = await textPoint(p, `${PM} > p:nth-of-type(2)`, 'end')
    await p.keyboard.down('Shift')
    await p.mouse.click(e2.x, e2.y)
    await p.keyboard.up('Shift')
    const selTxt = await p.evaluate(() => String(window.getSelection()))
    check('U7 跨段落原生文本选区', selTxt.includes('组合甲。') && selTxt.includes('组合乙。'), JSON.stringify(selTxt.slice(0, 30)))
  })

  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} 通过`)
  process.exit(results.every(Boolean) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
