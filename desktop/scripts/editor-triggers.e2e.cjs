// Amadeus 编辑器「块级触发层」回归实测(slash 菜单 + #/-/1./>/[] 空格触发)。
// 这层 bug 纯靠肉眼/推演修了三轮都没修中,必须真浏览器驱动验证 —— 保留此脚本防复发。
//
// 用法:
//   1) desktop 仓:npm run web            (vite 起 http://localhost:5173,含 /harness.html)
//   2) 任意有 playwright-core 的目录:node <本文件路径>
//      chromium 路径默认取 ~/Library/Caches/ms-playwright 下最新版,可用 CHROMIUM_EXE 覆盖。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage()
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
  await page.waitForTimeout(400)

  const kinds = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.md-block')].map((b) => {
        const pm = b.querySelector('.ProseMirror')
        if (!pm) return null
        const el = pm.firstElementChild
        if (!el) return 'EMPTY'
        const t = el.tagName
        if (t === 'UL' || t === 'OL') {
          const li = el.querySelector('li')
          return t + (li && li.getAttribute('data-item-type') === 'task' ? ':task' : '')
        }
        return t
      })
    )
  // ⚠️ 剥掉结构源码 input：它是装饰，不是文档内容；断言问的是文档里有什么。
  // 它是装饰不是文档内容(不进选区、不进序列化)。断言问的是「文档里有什么」,不该看见它。
  const texts = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.md-block')].map((b) => {
        const pm = b.querySelector('.ProseMirror')
        if (!pm) return null
        const c = pm.cloneNode(true)
        c.querySelectorAll('.amx-struct-prefix').forEach((n) => n.remove())
        return c.textContent
      })
    )

  await page.locator('.md-block .ProseMirror').last().click()

  // T1: 空块 slash → 标题2
  await page.keyboard.type('/', { delay: 50 })
  await page.waitForTimeout(250)
  check('T1 slash 菜单打开', (await page.locator('.slash-menu').count()) === 1)
  await page.keyboard.type('h2', { delay: 60 })
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  let k = await kinds(), t = await texts()
  check('T1 空块 /h2 → H2', k[0] === 'H2', `kind=${k[0]}`)
  check('T1 无 "/" 残留', !(t[0] || '').includes('/'), `text=${JSON.stringify(t[0])}`)
  check('T1 整段 "/h2" 被消费(H2 无残留文本,非只删 "/")', (t[0] || '') === '', `text=${JSON.stringify(t[0])}`)
  check('T1 不新建多余块', k.length === 1, `blocks=${k.length}`)

  // T2: 标题重设级别(设级非叠加)
  await page.keyboard.type('Hello', { delay: 30 })
  await page.waitForTimeout(500)
  await page.keyboard.press('Meta+ArrowLeft')
  await page.keyboard.type('# ', { delay: 60 })
  await page.waitForTimeout(500)
  k = await kinds(); t = await texts()
  check('T2 h2 上 "# " → H1', k[0] === 'H1', `kind=${k[0]}`)
  check('T2 文本不带 #', t[0] === 'Hello', `text=${JSON.stringify(t[0])}`)
  await page.keyboard.press('Meta+ArrowLeft')
  await page.keyboard.type('### ', { delay: 60 })
  await page.waitForTimeout(500)
  k = await kinds(); t = await texts()
  check('T2 h1 上 "### " → H3', k[0] === 'H3', `kind=${k[0]}`)
  check('T2 文本仍是 Hello', t[0] === 'Hello', `text=${JSON.stringify(t[0])}`)

  // T2b: 标题行上 "- " → 列表(先降段落再转,Notion 语义)
  await page.keyboard.press('Meta+ArrowLeft')
  await page.keyboard.type('- ', { delay: 60 })
  await page.waitForTimeout(400)
  k = await kinds(); t = await texts()
  check('T2b h3 上 "- " → UL', k[0] === 'UL', `kind=${k[0]}`)
  check('T2b 文本仍是 Hello', (t[0] || '').trim() === 'Hello', `text=${JSON.stringify(t[0])}`)

  // T3-T6: 段落上四种前缀
  await page.keyboard.press('Meta+ArrowRight')
  await page.keyboard.press('Shift+Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type('- ', { delay: 60 })
  await page.waitForTimeout(400)
  await page.keyboard.type('item', { delay: 30 })
  await page.waitForTimeout(500)
  k = await kinds(); t = await texts()
  check('T3 "- " → UL', k[1] === 'UL', `kind=${k[1]}`)
  check('T3 文本干净', t[1] === 'item', `text=${JSON.stringify(t[1])}`)

  await page.keyboard.press('Shift+Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type('1. ', { delay: 60 })
  await page.waitForTimeout(400)
  await page.keyboard.type('one', { delay: 30 })
  await page.waitForTimeout(500)
  k = await kinds()
  check('T4 "1. " → OL', k[2] === 'OL', `kind=${k[2]}`)

  await page.keyboard.press('Shift+Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type('> ', { delay: 60 })
  await page.waitForTimeout(400)
  await page.keyboard.type('quote', { delay: 30 })
  await page.waitForTimeout(500)
  k = await kinds()
  check('T5 "> " → BLOCKQUOTE', k[3] === 'BLOCKQUOTE', `kind=${k[3]}`)

  await page.keyboard.press('Shift+Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type('[] ', { delay: 60 })
  await page.waitForTimeout(400)
  await page.keyboard.type('todo', { delay: 30 })
  await page.waitForTimeout(500)
  k = await kinds(); t = await texts()
  check('T6 "[] " → 待办', k[4] === 'UL:task', `kind=${k[4]}, text=${JSON.stringify(t[4])}`)

  // T7: 非空块快速 slash(120ms < 200ms debounce,压竞态;'/' 需行首或空格后)
  await page.keyboard.press('Shift+Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type('abc ', { delay: 10 })
  await page.keyboard.type('/', { delay: 10 })
  await page.waitForTimeout(120)
  await page.keyboard.type('h1', { delay: 10 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  k = await kinds(); t = await texts()
  check('T7 快速 /h1 → H1 且文本保住', k[5] === 'H1' && (t[5] || '').trim() === 'abc', `kind=${k[5]}, text=${JSON.stringify(t[5])}`)
  check('T7 无 "/" 残留', !(t[5] || '').includes('/'), `text=${JSON.stringify(t[5])}`)

  // T8: 嵌入类(数据库,无 bridge 创建必失败)也必须消费 '/'
  await page.keyboard.press('Meta+ArrowRight')
  await page.keyboard.press('Shift+Enter')
  await page.waitForTimeout(400)
  await page.keyboard.type('x /', { delay: 40 })
  await page.waitForTimeout(250)
  await page.locator('.slash-item').filter({ hasText: '数据库' }).filter({ hasNotText: '链接' }).first().click()
  await page.waitForTimeout(800)
  t = await texts()
  check('T8 选嵌入类后 "/" 被消费', (t[6] || '').trim() === 'x', `text=${JSON.stringify(t[6])}`)

  // ===== 新模型(AFFiNE 式):query 驻留文档 / 不吞字符 / 空格留字面 / 词中不触发 =====
  // 这些在旧的「菜单吸键」实现下必挂('/' 后的字符进不了文档,空格被当查询字符)。
  const lastIdx = async () => (await texts()).length - 1
  const freshBlock = async () => {
    await page.locator('.md-block .ProseMirror').last().click()
    await page.keyboard.press('Meta+ArrowRight')
    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(400)
    return lastIdx()
  }

  // T9【核心】'/' 后打字直接进正文(不吞字符),Esc 后字面完整保留(不丢字)
  let i9 = await freshBlock()
  await page.keyboard.type('/head', { delay: 40 })
  await page.waitForTimeout(250)
  check('T9 slash 菜单开着', (await page.locator('.slash-menu').count()) === 1)
  check('T9 "/head" 已在正文(query 驻留文档,不吞字符)', ((await texts())[i9] || '').includes('/head'), `text=${JSON.stringify((await texts())[i9])}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  check('T9 Esc 后菜单关', (await page.locator('.slash-menu').count()) === 0)
  check('T9 Esc 后 "/head" 字面保留(不丢字)', ((await texts())[i9] || '').includes('/head'), `text=${JSON.stringify((await texts())[i9])}`)
  await page.keyboard.type('x', { delay: 40 })
  await page.waitForTimeout(200)
  check('T9 Esc 后继续打字不重开菜单(slashDismissedFrom 闩锁)', (await page.locator('.slash-menu').count()) === 0)

  // T10 空格 → 菜单关、'/foo ' 留成字面文本(不触发任何块转换)
  let i10 = await freshBlock()
  await page.keyboard.type('/foo', { delay: 40 })
  await page.waitForTimeout(200)
  check('T10 /foo 菜单开', (await page.locator('.slash-menu').count()) === 1)
  await page.keyboard.type(' ', { delay: 40 })
  await page.waitForTimeout(200)
  check('T10 空格后菜单关', (await page.locator('.slash-menu').count()) === 0)
  check('T10 "/foo " 留成字面(含尾空格,未被吞)', /\/foo\s/.test((await texts())[i10] || ''), `text=${JSON.stringify((await texts())[i10])}`)
  check('T10 该块仍是段落 P(未误转换)', (await kinds())[i10] === 'P', `kind=${(await kinds())[i10]}`)

  // T11 词中的 '/'(TCP/IP)不触发菜单;字面完整
  let i11 = await freshBlock()
  await page.keyboard.type('TCP', { delay: 40 })
  await page.keyboard.type('/', { delay: 40 })
  await page.waitForTimeout(200)
  check('T11 词中 "TCP/" 不触发菜单', (await page.locator('.slash-menu').count()) === 0)
  await page.keyboard.type('IP', { delay: 40 })
  await page.waitForTimeout(150)
  check('T11 "TCP/IP" 字面完整', ((await texts())[i11] || '').includes('TCP/IP'), `text=${JSON.stringify((await texts())[i11])}`)

  // T12 代码块内 '/' 恒字面(不触发菜单)—— 代码里的路径/正则/注释常以 '/' 开头
  let i12 = await freshBlock()
  await page.keyboard.type('/code', { delay: 40 })
  await page.waitForTimeout(250)
  await page.locator('.slash-item').filter({ hasText: '代码块' }).first().click()
  await page.waitForTimeout(600)
  const isCode = await page.evaluate((idx) => !!document.querySelectorAll('.md-block')[idx]?.querySelector('pre'), i12)
  check('T12 已转为代码块', isCode)
  await page.keyboard.type('/usr', { delay: 40 })
  await page.waitForTimeout(250)
  check('T12 代码块内 "/" 不触发菜单(code_block 守卫)', (await page.locator('.slash-menu').count()) === 0)
  check('T12 "/usr" 确实落进代码块(非聚焦失败的假阴)', ((await texts())[i12] || '').includes('/usr'), `text=${JSON.stringify((await texts())[i12])}`)

  // T13 让位不清 Esc 闩锁(Codex 实现审查抓的真 bug 回归):
  //   '/' → Esc(闩锁记住这个 '/')→ 打 '[[' 让位给 wiki → 退格回 '/[' → 被 Esc 掉的同一个 '/' 不得重弹。
  //   旧实现把「让位(q=null)」和「触发真没了」共用清闩分支 → 退格后 slash 会重开(count===1)→ 本例挂。
  await freshBlock()
  await page.keyboard.type('/', { delay: 40 })
  await page.waitForTimeout(200)
  check('T13 "/" 菜单开', (await page.locator('.slash-menu').count()) === 1)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  await page.keyboard.type('[[', { delay: 40 }) // doc: '/[[' —— wiki 生效,slash 让位
  await page.waitForTimeout(200)
  check('T13 "[[" 让位时 slash 不叠开', (await page.locator('.slash-menu').count()) === 0)
  await page.keyboard.press('Backspace') // doc: '/[' —— wiki 失效
  await page.waitForTimeout(200)
  check('T13 让位撤销后被 Esc 的 "/" 不重弹(闩锁未被让位误清)', (await page.locator('.slash-menu').count()) === 0)

  // ─── F4:行内工具栏 + 自定义标记(下划线/文字色/背景色)往返 ───
  // 每项独立 page(干净起点),try 包裹:一项抛异常记 FAIL 但不中断后续。
  const freshPage = async (seed) => {
    const p = await browser.newPage()
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(seed ? `${URL}?seed=${encodeURIComponent(seed)}` : URL, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
    await p.waitForTimeout(400)
    return p
  }
  const mdOf = (p, i = 0) => p.evaluate((idx) => window.__harness.blocks[idx].content, i)
  const tryTest = async (name, fn) => {
    try {
      await fn()
    } catch (e) {
      check(`${name}(异常)`, false, String((e && e.message) || e).slice(0, 140))
    }
  }

  // T14: 选中文字 → 工具栏浮现;点加粗 → DOM <strong> + 序列化含 **world**
  await tryTest('T14', async () => {
    const p = await freshPage()
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.type('hello world', { delay: 20 })
    await p.waitForTimeout(200)
    for (let i = 0; i < 5; i++) await p.keyboard.press('Shift+ArrowLeft') // 选 "world"
    await p.waitForTimeout(300)
    check('T14 选区 → 工具栏浮现', (await p.locator('.inline-toolbar').count()) === 1)
    await p.locator('.inline-toolbar [data-act="bold"]').dispatchEvent('mousedown')
    await p.waitForTimeout(400)
    check('T14 加粗 → DOM <strong>', (await p.locator('.md-block .ProseMirror strong').count()) >= 1)
    const md = await mdOf(p)
    check('T14 序列化含 **world**', /\*\*world\*\*/.test(md), `md=${JSON.stringify(md)}`)
    await p.close()
  })

  // T14b: 行内工具栏的「转换为」按钮必须显示**当前**块类型(此前写死「正文」,标题/列表上也说正文)
  await tryTest('T14b', async () => {
    const p = await freshPage()
    const turnLabel = async (prefix, want) => {
      await p.locator('.md-block .ProseMirror').first().click()
      await p.keyboard.press('Meta+a')
      await p.keyboard.press('Backspace')
      if (prefix) await p.keyboard.type(prefix, { delay: 40 })
      await p.keyboard.type('hello world', { delay: 20 })
      await p.waitForTimeout(250)
      for (let i = 0; i < 5; i++) await p.keyboard.press('Shift+ArrowLeft')
      await p.waitForTimeout(300)
      const txt = (await p.locator('.inline-toolbar .itb-turn').textContent()) || ''
      check(`T14b ${want} 上工具栏显示「${want}」`, txt.includes(want), `label=${JSON.stringify(txt.trim())}`)
      await p.keyboard.press('Escape')
      await p.waitForTimeout(120)
    }
    await turnLabel('', '正文')
    await turnLabel('## ', '标题 2')
    await turnLabel('- ', '无序列表')
    await turnLabel('> ', '引用')
    await p.close()
  })

  // T14c:划选工具栏可改左/中/右，对齐标记可往返；Word 同款 Mod-L/E/R 快捷键。
  await tryTest('T14c', async () => {
    const p = await freshPage()
    const pm = p.locator('.md-block .ProseMirror').first()
    await pm.click()
    await p.keyboard.type('需要对齐的正文', { delay: 20 })
    for (let i = 0; i < 4; i++) await p.keyboard.press('Shift+ArrowLeft')
    await p.waitForTimeout(250)
    await p.locator('.inline-toolbar [data-act="alignCenter"]').dispatchEvent('mousedown')
    await p.waitForTimeout(400)
    const centerDom = await pm.locator('p[data-align="center"]').count()
    const centerMd = await mdOf(p)
    check('T14c 划选工具栏“居中”立即生效并落 Markdown 标记', centerDom === 1 && /data-amadeus-align="center"/.test(centerMd), `md=${JSON.stringify(centerMd)}`)
    await p.keyboard.press('Meta+r')
    await p.waitForTimeout(350)
    const rightDom = await pm.locator('p[data-align="right"]').count()
    const rightMd = await mdOf(p)
    check('T14c Word 快捷键 Mod-R 切右对齐', rightDom === 1 && /data-amadeus-align="right"/.test(rightMd), `md=${JSON.stringify(rightMd)}`)
    await p.close()

    const q = await freshPage(rightMd)
    check('T14c 关闭重开后右对齐仍在', (await q.locator('.md-block .ProseMirror p[data-align="right"]').count()) === 1)
    await q.locator('.md-block .ProseMirror').first().click()
    await q.keyboard.press('Meta+l')
    await q.waitForTimeout(350)
    const leftMd = await mdOf(q)
    check('T14c Mod-L 恢复左对齐并清除持久化标记', !/data-amadeus-align=/.test(leftMd), `md=${JSON.stringify(leftMd)}`)
    await q.close()
  })

  // T15: 下划线 mark 往返(apply → DOM <u> → 序列化 <u>abc</u>)—— remark 桥核心验证
  await tryTest('T15', async () => {
    const p = await freshPage()
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.type('abc', { delay: 20 })
    await p.waitForTimeout(150)
    for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowLeft')
    await p.waitForTimeout(300)
    await p.locator('.inline-toolbar [data-act="underline"]').dispatchEvent('mousedown')
    await p.waitForTimeout(400)
    check('T15 下划线 → DOM <u>', (await p.locator('.md-block .ProseMirror u').count()) >= 1)
    const md = await mdOf(p)
    check('T15 序列化含 <u>abc</u>', /<u>abc<\/u>/.test(md), `md=${JSON.stringify(md)}`)
    await p.close()
  })

  // T16: 文字色 → 序列化 <span style="color:...">red</span>
  await tryTest('T16', async () => {
    const p = await freshPage()
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.type('red', { delay: 20 })
    await p.waitForTimeout(150)
    for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowLeft')
    await p.waitForTimeout(300)
    await p.locator('.inline-toolbar .itb-color').dispatchEvent('mousedown') // 开颜色面板
    await p.waitForTimeout(250)
    await p.locator('.inline-toolbar .itb-swatch[data-fg="#c62222"]').dispatchEvent('mousedown') // AFFiNE v1 红(2026-08-13 第4振换正典)
    await p.waitForTimeout(400)
    const md = await mdOf(p)
    check('T16 文字色 → 序列化含 <span style="color', /<span style="color:[^"]+">red<\/span>/.test(md), `md=${JSON.stringify(md)}`)
    await p.close()
  })

  // T17: 加载既有 HTML 标记 → 解析成 DOM + 往返稳定(三种标记同种)
  await tryTest('T17', async () => {
    const seed = 'x<u>u</u> y<span style="color:#e03131">c</span> z<mark style="background:#fff3bf">b</mark>'
    const p = await freshPage(seed)
    await p.waitForTimeout(300)
    check('T17 <u> 解析为 DOM', (await p.locator('.md-block .ProseMirror u').count()) >= 1)
    check('T17 <span color> 解析为 DOM', (await p.locator('.md-block .ProseMirror span[style*="color"]').count()) >= 1)
    check('T17 <mark> 解析为 DOM', (await p.locator('.md-block .ProseMirror mark').count()) >= 1)
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.press('Home')
    await p.keyboard.type('!', { delay: 20 }) // 在最前插入(不落进任何 mark),触发一次重序列化(listener)
    await p.waitForTimeout(400)
    const md = await mdOf(p)
    check('T17 往返保留 <u>u</u>', /<u>u<\/u>/.test(md), `md=${JSON.stringify(md)}`)
    check('T17 往返保留 <span color>c', /<span style="color:[^"]*e03131[^"]*">c<\/span>/i.test(md), `md=${JSON.stringify(md)}`)
    check('T17 往返保留 <mark bg>b', /<mark style="background:[^"]*fff3bf[^"]*">b<\/mark>/i.test(md), `md=${JSON.stringify(md)}`)
    await p.close()
  })

  // T18: shift+点击任意块 → 整块选中(F1;?dnd 的真 PageView,含 BlockSelectionKeys 全局监听)
  await tryTest('T18', async () => {
    const p = await browser.newPage()
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${URL}?dnd`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.block-host', { timeout: 20000 })
    await p.waitForTimeout(500)
    const hosts = p.locator('.block-host')
    await hosts.nth(0).locator('.ProseMirror').click() // 聚焦第 1 块
    await p.waitForTimeout(150)
    await hosts.nth(1).locator('.ProseMirror').click({ modifiers: ['Shift'] }) // shift+点第 2 块正文
    await p.waitForTimeout(250)
    check('T18 shift+点击块 → 整块选中(data-selected)', (await hosts.nth(1).getAttribute('data-selected')) !== null)
    check('T18 编辑中的第 1 块不被误选', (await hosts.nth(0).getAttribute('data-selected')) === null)
    await p.close()
  })

  // T19: Codex 修复回归 —— M2 同型嵌套下划线扁平化(c 不丢标记)、M4 border-color 不误判为文字色
  await tryTest('T19', async () => {
    const p = await freshPage('x <u>a<u>b</u>c</u> and <span style="border-color:red">bc</span>')
    await p.waitForTimeout(300)
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.press('Home')
    await p.keyboard.type('!', { delay: 20 })
    await p.waitForTimeout(400)
    const md = await mdOf(p)
    check('T19 M2 同型嵌套下划线扁平化 <u>abc</u>(c 不丢标记)', /<u>abc<\/u>/.test(md), `md=${JSON.stringify(md)}`)
    check('T19 M4 border-color 未被误改成 color:(保字面)', /border-color:red/.test(md), `md=${JSON.stringify(md)}`)
    await p.close()
  })

  // T20: 块内 ↑↓ 逐视觉行移动(修:Chromium≥150 起 view.endOfTextblock('up'/'down') 在多行块中段
  //      误返回 true → ↑↓ 只跳块不移行;已改测光标 rect 对块逐行 rect,见 MarkdownBlock.atBlockEdge)。
  await tryTest('T20', async () => {
    const long =
      'The quick brown fox jumps over the lazy dog and then keeps running across the wide green field under the warm sun and never stops at all. The quick brown fox again.'
    const p = await freshPage(long)
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.press('End') // 落到末视觉行
    await p.waitForTimeout(80)
    const yTop = () =>
      p.evaluate(() => {
        const s = window.getSelection()
        if (!s || !s.rangeCount) return -1
        let r = s.getRangeAt(0).getBoundingClientRect()
        if (!r.height) { const rs = s.getRangeAt(0).getClientRects(); if (rs.length) r = rs[0] }
        return Math.round(r.top)
      })
    const y0 = await yTop()
    await p.keyboard.press('ArrowUp'); await p.waitForTimeout(80)
    const y1 = await yTop()
    check('T20 块内 ↑ 上移一视觉行(未跳块)', y0 > 0 && y1 > 0 && y1 < y0 - 3, `y0=${y0} y1=${y1}`)
    await p.keyboard.press('ArrowDown'); await p.waitForTimeout(80)
    const y2 = await yTop()
    check('T20 块内 ↓ 下移一视觉行', y2 > y1 + 3, `y1=${y1} y2=${y2}`)
    check('T20 仍是单块(未误增删块)', (await p.locator('.md-block').count()) === 1)
    await p.close()
  })

  // ---- 跨块方向键落点(真 PageView / BlockHost;经 window.__pageStore 注入布局)----
  const LONG = (t) =>
    `${t} this is a deliberately long block that wraps across several visual lines so we can test exactly where the caret lands when crossing between blocks with the arrow keys now indeed ok yes`
  const dndPage = async () => {
    const p = await browser.newPage()
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${URL}?dnd`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.block-host .ProseMirror', { timeout: 20000 })
    await p.waitForTimeout(500)
    return p
  }
  const caretIn = (p) =>
    p.evaluate(() => {
      const s = window.getSelection()
      const H = [...document.querySelectorAll('.block-host[data-block-id]')]
      if (!s || !s.rangeCount) return { id: 'none' }
      const n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement)
      const b = H.find((h) => n && h.contains(n))
      const bt = b ? b.getBoundingClientRect() : null
      let r = s.getRangeAt(0).getBoundingClientRect()
      if (!r.height) { const rs = s.getRangeAt(0).getClientRects(); if (rs.length) r = rs[0] }
      return { id: b ? b.getAttribute('data-block-id') : '?', caretX: Math.round(r.left), yInBlk: bt ? Math.round(r.top - bt.top) : -1, blkH: bt ? Math.round(bt.height) : -1 }
    })

  // T21: 单列跨块 ↑ 落在上一块的【末】视觉行(非首行)且保持水平列(用户实报:此前落到首行)。
  await tryTest('T21', async () => {
    const p = await dndPage()
    await p.evaluate((c) => {
      const ps = window.__pageStore, cur = ps.getState().manifest
      ps.setState({
        manifest: { ...cur, root: { type: 'stack', children: [{ type: 'row', id: 'r', columns: [{ id: 'c', width: 1, children: [{ ref: 'A' }, { ref: 'B' }] }] }] }, blocks: { A: { type: 'markdown' }, B: { type: 'markdown' } } },
        blocks: { A: { id: 'A', type: 'markdown', content: c.A }, B: { id: 'B', type: 'markdown', content: c.B } },
      })
    }, { A: LONG('AAA'), B: LONG('BBB') })
    await p.waitForTimeout(500)
    const bx = await p.evaluate(() => { const r = document.querySelector('.block-host[data-block-id="B"]').getBoundingClientRect(); return { x: Math.round(r.left + 130), y: Math.round(r.top + 6) } })
    await p.mouse.click(bx.x, bx.y)
    await p.waitForTimeout(120)
    const before = await caretIn(p)
    await p.keyboard.press('ArrowUp')
    await p.waitForTimeout(150)
    const after = await caretIn(p)
    check('T21 ↑ 跨到上一块 A', after.id === 'A', `from=${before.id} to=${after.id}`)
    check('T21 落 A 末视觉行(非首行)', after.yInBlk > after.blkH / 2, `yInBlk=${after.yInBlk} blkH=${after.blkH}`)
    check('T21 保持水平列', Math.abs(after.caretX - before.caretX) < 40, `before=${before.caretX} after=${after.caretX}`)
    await p.close()
  })

  // T22: 两栏行——右栏顶块按 ↑ 去上方【整行块】(不横跳到左栏);栏内 ↓ 在本栏内走。
  await tryTest('T22', async () => {
    const p = await dndPage()
    await p.evaluate((c) => {
      const ps = window.__pageStore, cur = ps.getState().manifest
      ps.setState({
        manifest: { ...cur, root: { type: 'stack', children: [
          { type: 'row', id: 'r0', columns: [{ id: 'c0', width: 1, children: [{ ref: 'TOP' }] }] },
          { type: 'row', id: 'r1', columns: [{ id: 'cL', width: 1, children: [{ ref: 'L1' }] }, { id: 'cR', width: 1, children: [{ ref: 'R1' }, { ref: 'R2' }] }] },
        ] }, blocks: { TOP: { type: 'markdown' }, L1: { type: 'markdown' }, R1: { type: 'markdown' }, R2: { type: 'markdown' } } },
        blocks: { TOP: { id: 'TOP', type: 'markdown', content: c.TOP }, L1: { id: 'L1', type: 'markdown', content: c.L1 }, R1: { id: 'R1', type: 'markdown', content: c.R1 }, R2: { id: 'R2', type: 'markdown', content: 'RIGHTTWO short' } },
      })
    }, { TOP: LONG('TOP'), L1: LONG('LEFT'), R1: LONG('RIGHT') })
    await p.waitForTimeout(500)
    const r1 = await p.evaluate(() => { const r = document.querySelector('.block-host[data-block-id="R1"]').getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + 6) } })
    await p.mouse.click(r1.x, r1.y)
    await p.waitForTimeout(120)
    check('T22 光标在右栏 R1', (await caretIn(p)).id === 'R1')
    await p.keyboard.press('ArrowUp')
    await p.waitForTimeout(150)
    check('T22 右栏顶 ↑ 到上方整行块 TOP(不横跳左栏 L1)', (await caretIn(p)).id === 'TOP', `to=${(await caretIn(p)).id}`)
    // 栏内:点 R1 末行 → ↓ 落到本栏下一块 R2(不跳别处)
    const r1b = await p.evaluate(() => { const r = document.querySelector('.block-host[data-block-id="R1"]').getBoundingClientRect(); return { x: Math.round(r.left + 40), y: Math.round(r.bottom - 6) } })
    await p.mouse.click(r1b.x, r1b.y)
    await p.waitForTimeout(120)
    await p.keyboard.press('ArrowDown')
    await p.waitForTimeout(150)
    check('T22 栏内 ↓ R1→R2(同栏)', (await caretIn(p)).id === 'R2', `to=${(await caretIn(p)).id}`)
    await p.close()
  })

  // T23: 有 padding 的块(代码块)首行 ↑ 能上移出块。回归 Codex 复审:selectNodeContents().getClientRects()
  //      把代码块**边框盒**(跨全部行)也算一条 rect,取 [0] 会误当首行 → 首行无法上移出块。
  await tryTest('T23', async () => {
    const p = await dndPage()
    await p.evaluate(() => {
      const ps = window.__pageStore, cur = ps.getState().manifest
      ps.setState({
        manifest: { ...cur, root: { type: 'stack', children: [{ type: 'row', id: 'r', columns: [{ id: 'c', width: 1, children: [{ ref: 'A' }, { ref: 'CODE' }] }] }] }, blocks: { A: { type: 'markdown' }, CODE: { type: 'markdown' } } },
        blocks: { A: { id: 'A', type: 'markdown', content: 'Alpha paragraph above the code block' }, CODE: { id: 'CODE', type: 'markdown', content: '```js\nconst a = 1\nconst b = 2\nconst c = 3\n```' } },
      })
    })
    await p.waitForTimeout(500)
    // 点代码块最上一条【左半区单行文本盒】(排除跨行的边框盒 + 右上角语言条/按钮)= 首个代码行
    const c1 = await p.evaluate(() => {
      const pm = document.querySelector('.block-host[data-block-id="CODE"] .ProseMirror')
      const pmR = pm.getBoundingClientRect()
      const rng = document.createRange(); rng.selectNodeContents(pm)
      const rects = [...rng.getClientRects()].filter((r) => r.height > 0 && r.height < 24 && r.width > 0 && r.left < pmR.left + pmR.width * 0.5)
      const first = rects.reduce((a, b) => (b.top < a.top ? b : a), rects[0])
      return { x: Math.round(first.left + 12), y: Math.round((first.top + first.bottom) / 2) }
    })
    await p.mouse.click(c1.x, c1.y)
    await p.waitForTimeout(120)
    check('T23 光标落代码块 CODE 首行', (await caretIn(p)).id === 'CODE')
    await p.keyboard.press('ArrowUp')
    await p.waitForTimeout(150)
    check('T23 代码块首行 ↑ 上移出块到 A(padding 块不卡)', (await caretIn(p)).id === 'A', `to=${(await caretIn(p)).id}`)
    await p.close()
  })

  // T24: 只读控件块(图片嵌入,无文本光标)方向键可穿过 —— 进入=选中整块+露只读源码,再按=移到下一块(option A)。
  await tryTest('T24', async () => {
    const p = await dndPage()
    await p.evaluate(() => {
      const ps = window.__pageStore, cur = ps.getState().manifest
      ps.setState({
        manifest: { ...cur, root: { type: 'stack', children: [{ type: 'row', id: 'r', columns: [{ id: 'c', width: 1, children: [{ ref: 'A' }, { ref: 'IMG' }, { ref: 'B' }] }] }] }, blocks: { A: { type: 'markdown' }, IMG: { type: 'markdown' }, B: { type: 'markdown' } } },
        blocks: { A: { id: 'A', type: 'markdown', content: 'Alpha before the image widget block' }, IMG: { id: 'IMG', type: 'markdown', content: '![[t.png|120]]' }, B: { id: 'B', type: 'markdown', content: 'Beta after the image widget block' } },
      })
    })
    await p.waitForTimeout(500)
    const ax = await p.evaluate(() => { const r = document.querySelector('.block-host[data-block-id="A"] .ProseMirror').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) } })
    await p.mouse.click(ax.x, ax.y)
    await p.waitForTimeout(120)
    await p.keyboard.press('ArrowDown')
    await p.waitForTimeout(220)
    const s1 = await p.evaluate(() => ({ imgSel: document.querySelector('.block-host[data-block-id="IMG"]').hasAttribute('data-selected'), src: [...document.querySelectorAll('.embed-src-readonly')].map((e) => e.textContent) }))
    check('T24 ↓ 进只读块 → 选中整块', s1.imgSel, `sel=${s1.imgSel}`)
    check('T24 选中露只读源码行', s1.src.some((t) => t.includes('t.png')), `src=${JSON.stringify(s1.src)}`)
    const chrome = await p.evaluate(() => {
      const el = document.querySelector('.embed-src-readonly')
      if (!el) return null
      const cs = getComputedStyle(el)
      const wrap = getComputedStyle(el.closest('.block-host').querySelector('.embed-src-line'))
      return { border: cs.borderTopStyle, bg: cs.backgroundColor, wrapBg: wrap.backgroundColor }
    })
    const bare = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'
    check('T24 源码行无虚线框/无高亮底(用户 07-26)', !!chrome && chrome.border === 'none' && bare(chrome.bg) && bare(chrome.wrapBg), JSON.stringify(chrome))
    await p.keyboard.press('ArrowDown')
    await p.waitForTimeout(220)
    const s2 = await p.evaluate(() => {
      const s = window.getSelection()
      const n = s && s.rangeCount ? (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement) : null
      const b = n && n.closest('.block-host[data-block-id]')
      const pm = b && b.querySelector('.ProseMirror')
      return { inB: !!(b && b.getAttribute('data-block-id') === 'B' && pm && pm.contains(n)), imgStillSel: document.querySelector('.block-host[data-block-id="IMG"]').hasAttribute('data-selected') }
    })
    check('T24 再按 ↓ 穿过控件到文本块 B', s2.inB && !s2.imgStillSel, JSON.stringify(s2))
    await p.close()
  })

  // T25: slash 菜单 / 行内工具栏的观感与交互(用户 2026-07-26 报的五条)
  await tryTest('T25', async () => {
    const p = await freshPage()
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.type('/', { delay: 30 })
    await p.waitForTimeout(350)

    // ① 圆角/投影跟宿主浮层同一套 token(此前写死 8px + 自定义阴影,和四周面板不是一个观感)。
    //    比计算值没意义(token 恰好也可能等于 8px),钉源码:这两条规则里不许再出现硬编码值。
    const css = require('fs').readFileSync(require('path').resolve(__dirname, '../frontend/src/amadeus/styles.css'), 'utf8')
    const ruleOf = (sel) => (css.split(sel + ' {')[1] || '').split('}')[0]
    const tokenized = (sel) => {
      const r = ruleOf(sel)
      return /border-radius:\s*var\(--radius-/.test(r) && /box-shadow:\s*var\(--shadow-/.test(r)
    }
    check('T25① slash 菜单 / 行内工具栏用宿主圆角+投影 token(不写死 px)',
      tokenized('.am-app .slash-menu') && tokenized('.am-app .inline-toolbar'),
      `slash=${tokenized('.am-app .slash-menu')} toolbar=${tokenized('.am-app .inline-toolbar')}`)

    // ② ↑↓ 换选项要跟着滚:一路按到最后一项,它必须在滚动容器可视区内
    const n = await p.locator('.slash-item').count()
    for (let i = 0; i < n + 2; i++) await p.keyboard.press('ArrowDown')
    await p.waitForTimeout(200)
    const vis = await p.evaluate(() => {
      const act = document.querySelector('.slash-item[data-active]')
      const box = document.querySelector('.slash-scroll')
      if (!act || !box) return null
      const a = act.getBoundingClientRect(), b = box.getBoundingClientRect()
      return { top: a.top - b.top, bot: b.bottom - a.bottom, scrolled: box.scrollTop }
    })
    check('T25② ↑↓ 走到末项时跟随滚动(选中项在可视区内)', !!vis && vis.top >= -1 && vis.bot >= -1, JSON.stringify(vis))

    // ③ 在菜单里滚动不该关掉菜单(菜单自己的 scroll 也走 window 捕获相位)
    await p.evaluate(() => {
      const box = document.querySelector('.slash-scroll')
      box.scrollTop = Math.max(0, box.scrollTop - 40)
      box.dispatchEvent(new Event('scroll', { bubbles: false }))
    })
    await p.waitForTimeout(200)
    check('T25③ 菜单内滚动不关菜单', (await p.locator('.slash-menu').count()) === 1)

    // ③b 外面滚动仍然要关(别把闸门开太大)
    await p.evaluate(() => document.querySelector('.md-block').dispatchEvent(new Event('scroll', { bubbles: false })))
    await p.waitForTimeout(200)
    check('T25③b 编辑区滚动仍然关菜单', (await p.locator('.slash-menu').count()) === 0)

    // ④ 工具栏:出现的**第一帧**就在选区上方,且动画结束后不再挪窝(此前 pop-in 的 transform 会
    //    覆盖摆位 120ms,先出现在选区右下再跳上去)
    const p2 = await freshPage()
    await p2.locator('.md-block .ProseMirror').first().click()
    await p2.keyboard.type('hello world', { delay: 20 })
    await p2.waitForTimeout(200)
    for (let i = 0; i < 5; i++) await p2.keyboard.press('Shift+ArrowLeft')
    // ⚠️这条 bug 是**瞬态**的(只在 pop-in 那 120ms 内),用 sleep 去赶中间态量不准(第一版假绿过)。
    // 改钉不变量:摆位不许来自 transform —— pop-in 动画也动 transform,会把它覆盖掉整整 120ms,
    // 于是工具栏先出现在选区右下、动画结束才跳到文字上方(用户实报)。稳态 transform 必须是 none。
    await p2.waitForTimeout(300)
    const geo = () => p2.evaluate(() => {
      const t = document.querySelector('.inline-toolbar')
      const sel = window.getSelection()
      const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null
      if (!t || !r) return null
      const b = t.getBoundingClientRect()
      return { tb: b.bottom, tl: b.left, tw: b.width, selTop: r.top, selMid: (r.left + r.right) / 2, tf: getComputedStyle(t).transform }
    })
    const g = await geo()
    check('T25④ 摆位不靠 transform(否则被 pop-in 覆盖 120ms:先右后上)', !!g && g.tf === 'none', g && `transform=${g.tf}`)
    check('T25④ 工具栏浮在选区上方', !!g && g.tb <= g.selTop + 1, JSON.stringify(g))
    check('T25④ 工具栏水平居中于选区', !!g && Math.abs(g.tl + g.tw / 2 - g.selMid) < 2, JSON.stringify(g))
    await p.close()
    await p2.close()
  })

  // ─── F5:2026-07-27 那批(切块 / 行样式 / 行首退格 / 单 \n 落盘 / 带 checkbox 复制 / H4-H6)───

  // T26:Shift+Enter = 切块。光标后有内容就切走,块尾才是新建空块。
  await tryTest('T26', async () => {
    const p = await freshPage()
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.type('abcdef', { delay: 30 })
    await p.waitForTimeout(400)
    for (let i = 0; i < 3; i++) { await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(60) }
    await p.keyboard.press('Shift+Enter')
    await p.waitForTimeout(700)
    const all = await p.evaluate(() => window.__harness.blocks.map((b) => b.content.trim()))
    check('T26 行中 Shift+Enter 把光标后内容切到新块', JSON.stringify(all) === '["abc","def"]', `blocks=${JSON.stringify(all)}`)
    await p.close()

    // 块尾:仍然是「新建空块」,不是切出个空壳
    const q = await freshPage()
    await q.locator('.md-block .ProseMirror').first().click()
    await q.keyboard.type('abc', { delay: 30 })
    await q.waitForTimeout(400)
    await q.keyboard.press('Shift+Enter')
    await q.waitForTimeout(700)
    const b2 = await q.evaluate(() => window.__harness.blocks.map((b) => b.content.trim()))
    check('T26 块尾 Shift+Enter 仍是新建空块', JSON.stringify(b2) === '["abc",""]', `blocks=${JSON.stringify(b2)}`)
    await q.close()

    // 尾随空格前按下:tail 只有一个空格 —— remark 会把它写成 `&#x20;`(非空),
    // 靠序列化结果判空会切出 `# &#x20;` 垃圾块(2026-07-27 实测踩到,故钉死)。
    const r = await freshPage()
    await r.locator('.md-block .ProseMirror').first().click()
    await r.keyboard.type('# abc ', { delay: 40 })
    await r.waitForTimeout(500)
    await r.keyboard.press('Meta+ArrowRight')
    await r.keyboard.press('Shift+Enter')
    await r.waitForTimeout(700)
    const b3 = await r.evaluate(() => window.__harness.blocks.map((b) => b.content))
    check('T26 尾随空格不产出 &#x20; 垃圾块', !b3.some((c) => c.includes('&#x20;')), `blocks=${JSON.stringify(b3)}`)
    await r.close()
  })

  // T27:待办上切行样式(此前 list_item 的 `paragraph block*` 把标题挡在门外、转正文是空操作)
  await tryTest('T27', async () => {
    const turn = async (to) => {
      const p = await freshPage('- [ ] hello world')
      await p.locator('.md-block .ProseMirror').first().click()
      await p.waitForTimeout(200)
      await p.keyboard.press('End')
      for (let i = 0; i < 5; i++) await p.keyboard.press('Shift+ArrowLeft')
      await p.waitForTimeout(400)
      await p.locator('.inline-toolbar .itb-turn').dispatchEvent('mousedown')
      await p.waitForTimeout(250)
      await p.locator('.itb-panel .itb-menu-item', { hasText: to }).first().dispatchEvent('mousedown')
      await p.waitForTimeout(700)
      const md = (await mdOf(p)).trim()
      await p.close()
      return md
    }
    const h1 = await turn('标题 1')
    const txt = await turn('正文')
    const todo = await turn('待办')
    check('T27 待办 → 标题 1', h1 === '# hello world', `md=${JSON.stringify(h1)}`)
    check('T27 待办 → 正文', txt === 'hello world', `md=${JSON.stringify(txt)}`)
    check('T27 待办 → 待办(幂等)', /^[-*] \[ \] hello world$/.test(todo), `md=${JSON.stringify(todo)}`)
  })

  // T28:尾随空格是结构渲染边界。第一次退格删掉它后必须立刻脱壳成字面 `- [ ]`，
  // 光标留在字面源码之后；再补空格则重新渲染为待办。
  await tryTest('T28', async () => {
    const p = await freshPage('- [ ] abc')
    await p.locator('.md-block .ProseMirror').first().click()
    await p.waitForTimeout(200) // 点完要给编辑器一拍落焦,否则 Home 打空(第一版就这么假红的)
    await p.keyboard.press('Home')
    await p.waitForTimeout(150)
    await p.keyboard.press('Backspace')
    await p.waitForTimeout(200)
    const literal = await p.evaluate(() => {
      const pm = document.querySelector('.md-block .ProseMirror')
      return {
        text: pm?.querySelector(':scope > p')?.textContent ?? null,
        lists: pm?.querySelectorAll(':scope > ul, :scope > ol').length ?? -1,
        source: pm?.querySelectorAll('.amx-struct-prefix').length ?? -1,
        offset: getSelection()?.anchorOffset ?? null,
        active: document.activeElement?.classList.contains('ProseMirror'),
      }
    })
    check(
      'T28 首块待办行首退格 → 立即还原字面源码并退出 input',
      literal.text === '- [ ]abc' && literal.lists === 0 && literal.source === 0
        && literal.offset === 5 && literal.active,
      JSON.stringify(literal),
    )
    await p.keyboard.type(' ')
    await p.waitForTimeout(500)
    check('T28 字面 `- [ ]` 补回边界空格 → 恢复待办渲染', /^[-*] \[ \] abc\s*$/.test(await mdOf(p)), `md=${JSON.stringify(await mdOf(p))}`)
    // 第二次往返仍须成立，不能被上一次提交闩锁卡死。
    await p.keyboard.press('Home')
    await p.keyboard.press('Backspace')
    await p.keyboard.type(' ')
    await p.waitForTimeout(250)
    const reenter = await p.evaluate(() => ({ active: document.activeElement?.classList.contains('ProseMirror'), sourceFocused: document.activeElement?.classList.contains('amx-struct-prefix') }))
    check('T28 原样退出后可再次进入并提交同一标记', reenter.active && !reenter.sourceFocused, JSON.stringify(reenter))
    await p.close()
  })

  // T29:块内换行落盘 = 单个 '\n'(Obsidian 语义),且往返闭合。
  await tryTest('T29', async () => {
    const p = await freshPage()
    await p.locator('.md-block .ProseMirror').first().click()
    for (const s of ['一', '二', '三']) { await p.keyboard.type(s, { delay: 30 }); await p.keyboard.press('Enter'); await p.waitForTimeout(150) }
    await p.waitForTimeout(700)
    const md = await mdOf(p)
    check('T29 三行落盘无空行(单 \\n 分行)', md.trim() === '一\n二\n三', `md=${JSON.stringify(md)}`)
    await p.close()

    const q = await freshPage(md)
    const back = await q.evaluate(() => document.querySelector('.md-block .ProseMirror').innerHTML)
    check('T29 读回仍是三行(解析侧拆段生效,否则塌成一个多行块)', (back.match(/<p>/g) || []).length === 3, `html=${back}`)
    check('T29 往返不变', (await mdOf(q)) === md, `md2=${JSON.stringify(await mdOf(q))}`)
    await q.close()

    // 中间的空行(敲两次回车)必须留住 —— 过滤空段会让它每次重开少一个
    const r = await freshPage('a\n<br />\nb')
    const h = await r.evaluate(() => document.querySelector('.md-block .ProseMirror').innerHTML)
    check('T29 块内空行往返保留', (h.match(/<p>/g) || []).length === 3, `html=${h}`)
    await r.close()
  })

  // T30:复制。整行待办要带 `- [ ]`(checkbox 是 CSS ::before,不在文档里);只选几个字仍是纯文本。
  await tryTest('T30', async () => {
    const ctx2 = await browser.newContext()
    // 本文件顶上的 `const URL` 遮住了全局的 URL 构造器,别用 new URL() —— 手拼源即可。
    await ctx2.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL.split('/').slice(0, 3).join('/') })
    const copy = async (seed, keys) => {
      const p = await ctx2.newPage()
      await p.goto(`${URL}?seed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
      await p.waitForTimeout(400)
      await p.locator('.md-block .ProseMirror').first().click()
      for (const k of keys) { await p.keyboard.press(k); await p.waitForTimeout(120) }
      await p.keyboard.press('Meta+c')
      await p.waitForTimeout(300)
      const t = await p.evaluate(() => navigator.clipboard.readText().catch(() => '(读不到)'))
      await p.close()
      return t
    }
    check('T30 整行待办复制带 checkbox', /^[-*] \[ \] 买牛奶$/.test((await copy('- [ ] 买牛奶', ['Home', 'Shift+End'])).trim()), `got=${JSON.stringify(await copy('- [ ] 买牛奶', ['Home', 'Shift+End']))}`)
    check('T30 只选几个字仍是纯文本(不带行前缀)', (await copy('- [ ] 买牛奶', ['End', 'Shift+ArrowLeft', 'Shift+ArrowLeft'])).trim() === '牛奶')
    check('T30 普通段落全选是纯文本', (await copy('普通一行', ['Meta+a'])).trim() === '普通一行')
    // 跨块选中(段落 + 待办):只看首块类型会退回纯文本、把后面那条的 `- [ ]` 丢掉(Codex 复审)
    const multi = await copy('普通行\n\n- [ ] 待办', ['Meta+a'])
    check('T30 段落+待办跨块复制不丢 checkbox', /\[ \] 待办/.test(multi), `got=${JSON.stringify(multi)}`)
    await ctx2.close()
  })

  // T31:H4-H6(此前 UI 只给到 H3)。顺带钉图标不许把数字漏进 textContent。
  await tryTest('T31', async () => {
    const p = await freshPage()
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.type('##### ', { delay: 40 })
    await p.keyboard.type('五级', { delay: 30 })
    await p.waitForTimeout(600)
    check('T31 "##### " → H5', (await p.locator('.md-block .ProseMirror h5').count()) === 1, `md=${JSON.stringify(await mdOf(p))}`)
    await p.close()

    const q = await freshPage()
    await q.locator('.md-block .ProseMirror').first().click()
    await q.keyboard.type('/', { delay: 40 })
    await q.waitForTimeout(400)
    const items = await q.locator('.slash-item').allTextContents()
    check('T31 斜杠菜单有标题 4/5/6', ['标题 4', '标题 5', '标题 6'].every((l) => items.some((t) => t.includes(l))), `items=${JSON.stringify(items.slice(0, 8))}`)
    check('T31 图标不把数字漏进文本(选择器不被污染)', !items.some((t) => /^\d/.test(t)), `items=${JSON.stringify(items.slice(0, 8))}`)
    await q.close()
  })

  // T32:源码↔可视 切换的光标接力,块内落点靠「光标前文本」锚回来(见 amadeus/lib/modeCursor)。
  // 纯映射由 modeCursor.test.ts 钉;这里钉的是最后一公里 —— 锚点在 ProseMirror 文档里的换算。
  await tryTest('T32', async () => {
    // 光标落点看不见 → 打一个 '|' 当探针,看它插在哪。
    const type = async (seed, anchor) => {
      const p = await browser.newPage()
      await p.goto(`${URL}?seed=${encodeURIComponent(seed)}&anchor=${encodeURIComponent(anchor)}`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
      await p.waitForTimeout(700)
      await p.keyboard.type('|', { delay: 30 })
      await p.waitForTimeout(500)
      const t = await p.evaluate(() => document.querySelector('.md-block .ProseMirror').textContent)
      await p.close()
      return t
    }
    check('T32 锚点命中 → 光标落在锚点之后', (await type('一二三四五', '一二三')) === '一二三|四五', `got=${JSON.stringify(await type('一二三四五', '一二三'))}`)
    check('T32 锚点找不到 → 停在块首(绝不乱跳)', (await type('一二三四五', '不存在')) === '|一二三四五')
  })

  // T33:`<br…>` 变体不得以字面量出现在正文里(用户实报「云端笔记有时候莫名会出现 <br />」)。
  // Milkdown 的 preserve-empty-line 只认四种精确写法,`<BR>` / `<br  />` / 带属性 / 后面紧跟文本的
  // 一律留成 contenteditable=false 的原子 html 块 —— 云端笔记多由 AI 写,正是这些口味。
  await tryTest('T33', async () => {
    const render = async (seed) => {
      const p = await freshPage(seed)
      const r = await p.evaluate(() => {
        const pm = document.querySelector('.md-block .ProseMirror')
        return { text: pm.textContent, paras: (pm.innerHTML.match(/<p[ >]/g) || []).length }
      })
      await p.close()
      return r
    }
    for (const [label, seed] of [
      ['大写 BR', 'a<BR>b'],
      ['多空格', 'a<br  />b'],
      ['带属性', 'a<br class="x">b'],
      ['块级紧邻文本', 'a\n\n<br />\nx\n\nb'],
    ]) {
      const r = await render(seed)
      check(`T33 ${label}:不显示字面量 <br`, !/<br/i.test(r.text), `text=${JSON.stringify(r.text)}`)
    }
    check('T33 br 换成了真换行(a/b 成两段)', (await render('a<BR>b')).paras === 2, `paras=${(await render('a<BR>b')).paras}`)
    // 用户写的真 HTML 别乱解释:`<div>` 仍原样保留。
    const div = await render('a\n\n<div>x</div>\n\nb')
    check('T33 非 br 的 HTML 不动', div.text.includes('<div>x</div>'), `text=${JSON.stringify(div.text)}`)
  })

  // T34:`|` = 引用,`>` = 折叠(2026-07-29 换键位)。折叠落盘 = Obsidian 折叠 callout。
  await tryTest('T34', async () => {
    const typed = async (prefix, body) => {
      const p = await freshPage()
      await p.click('.md-block .ProseMirror')
      await p.keyboard.type(prefix, { delay: 40 })
      await p.waitForTimeout(300)
      await p.keyboard.type(body, { delay: 40 })
      await p.waitForTimeout(500)
      const md = (await mdOf(p)).trim()
      const cls = await p.evaluate(() => {
        const bq = document.querySelector('.md-block .ProseMirror blockquote')
        return bq ? bq.className : ''
      })
      await p.close()
      return { md, cls }
    }
    const q = await typed('| ', '引用内容')
    check('T34 `|` + 空格 = 普通引用(落盘仍是标准 `> `)', q.md === '> 引用内容', `md=${JSON.stringify(q.md)}`)
    check('T34 普通引用不被当成 callout', !/callout/.test(q.cls), `class=${JSON.stringify(q.cls)}`)
    const f = await typed('> ', '这是标题')
    // 令牌不带尾随空格(contenteditable 会吃掉行尾空格);`[` 也不许被转义成 `\[`,否则 Obsidian 不认。
    check('T34 `>` + 空格 = 折叠块(Obsidian 折叠 callout)', f.md === '> [!fold]-这是标题', `md=${JSON.stringify(f.md)}`)
    check('T34 折叠块渲染成 callout-fold', /callout-fold/.test(f.cls), `class=${JSON.stringify(f.cls)}`)
    // callout 往返:`[!x]` 不得被转义,且必须真的渲染成 callout(这条正则漏 `]` 时整个功能是死的)。
    const cq = await freshPage('> [!note]- 标题\n> 内容')
    const cqCls = await cq.evaluate(() => document.querySelector('.md-block .ProseMirror blockquote').className)
    await cq.click('.md-block .ProseMirror')
    await cq.keyboard.press('End')
    await cq.keyboard.type('Z', { delay: 40 })
    await cq.waitForTimeout(250)
    await cq.keyboard.press('Backspace')
    await cq.waitForTimeout(450)
    const cqMd = await mdOf(cq)
    await cq.close()
    check('T34 已有 callout 渲染成标注块', /callout-note/.test(cqCls), `class=${JSON.stringify(cqCls)}`)
    check('T34 callout 往返不被转义成 \\[!note]', !cqMd.includes('\\['), `md=${JSON.stringify(cqMd)}`)
    // 老笔记里的裸 `>` 语义不变 —— 变的只是键盘上敲 `>` 得到什么。
    const legacy = await freshPage('> 老引用')
    const legacyCls = await legacy.evaluate(() => {
      const bq = document.querySelector('.md-block .ProseMirror blockquote')
      return bq ? bq.className : 'NO-BLOCKQUOTE'
    })
    await legacy.close()
    check('T34 老笔记的裸 `>` 仍是普通引用', !/callout/.test(legacyCls), `class=${JSON.stringify(legacyCls)}`)
  })

  // ─── F6:2026-08-03 那批(标题源码行 / 行内链接 / 标题折叠)───

  // T35:标题保持渲染，只有当前编辑行显示 `# `；行首向左可逐字符编辑，增删井号实时切级。
  await tryTest('T35', async () => {
    const p = await freshPage('## 二级标题')
    const probe = () => p.evaluate(() => {
      const h = document.querySelector('.md-block .ProseMirror :is(h1,h2,h3,h4,h5,h6)')
      const hash = h && h.querySelector('.amx-struct-prefix')
      const body = document.querySelector('.md-block .ProseMirror')
      return {
        hash: hash ? hash.value : null,
        fs: h ? parseFloat(getComputedStyle(h).fontSize) : 0,
        base: body ? parseFloat(getComputedStyle(body).fontSize) : 0,
        tag: h ? h.tagName : null,
      }
    })
    // freshPage 会按编辑器契约自动聚焦首块；先主动离开，才能验证真正的“未编辑行”。
    await p.evaluate(() => document.activeElement?.blur())
    await p.waitForTimeout(300)
    const rendered = await probe()
    check('T35 标题未编辑时不显示井号', rendered.hash === null, `hash=${JSON.stringify(rendered.hash)}`)
    await p.locator('.md-block .ProseMirror h2').click()
    await p.waitForTimeout(180)
    const editing = await probe()
    check('T35 光标进入标题行 → 显示字面 "## "', editing.hash === '## ', `hash=${JSON.stringify(editing.hash)}`)
    await p.keyboard.press('Home')
    await p.keyboard.press('ArrowLeft')
    await p.waitForTimeout(180)
    const on = await probe()
    check('T35 第一下向左即越过唯一空格进入字面 "## "', on.hash === '## '
      && await p.evaluate(() => document.activeElement?.classList.contains('amx-struct-prefix') && document.activeElement.selectionStart === 2),
    `hash=${JSON.stringify(on.hash)}`)
    // ⚠️ 露源码时**必须仍是标题字号**。曾经降回正文,结果「敲 `# ` 触发已生效」与
    // 「触发压根没生效」在屏幕上一模一样(用户实报「输入 # 什么也没发生」)。
    check('T35 露源码时仍是标题字号(绝不降回正文)', on.fs > on.base + 2, JSON.stringify(on))
    check('T35 节点是 h2', on.tag === 'H2', `tag=${on.tag}`)
    // 井号是装饰而非文本:落盘必须还是 `## 二级标题`,不能变成 `## ## 二级标题`
    check('T35 井号不进文档(往返不变)', (await mdOf(p)).trim() === '## 二级标题', `md=${JSON.stringify(await mdOf(p))}`)
    await p.keyboard.press('Backspace')
    await p.waitForTimeout(180)
    const h1 = await probe()
    check('T35 逐字符删除井号实时从 H2 切为 H1', h1.hash === '# ' && h1.tag === 'H1'
      && await p.evaluate(() => document.activeElement?.selectionStart === 1), JSON.stringify(h1))
    await p.keyboard.type('#')
    await p.waitForTimeout(180)
    const h2 = await probe()
    check('T35 逐字符补回井号实时恢复 H2', h2.hash === '## ' && h2.tag === 'H2'
      && await p.evaluate(() => document.activeElement?.selectionStart === 2), JSON.stringify(h2))
    await p.evaluate(() => document.activeElement.blur())
    await p.waitForTimeout(300)
    const off = await probe()
    check('T35 失焦 → 井号收回,字号照旧是标题', off.hash === null && off.fs > off.base + 2, JSON.stringify(off))

    // 用户实报的那条:空块里敲 `# ` 必须**当场**变成 H1 字号(而不是「看着什么也没发生」)。
    const q = await freshPage()
    await q.locator('.md-block .ProseMirror').first().click()
    const body = await q.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.md-block .ProseMirror')).fontSize))
    await q.keyboard.type('# 标题', { delay: 40 })
    await q.waitForTimeout(500)
    const live = await q.evaluate(() => {
      const h = document.querySelector('.md-block .ProseMirror h1')
      return h ? { fs: parseFloat(getComputedStyle(h).fontSize), hash: h.querySelector('.amx-struct-prefix')?.value ?? null } : null
    })
    check('T35 敲 "# " 当场变 H1 字号(不能看着像没生效)', !!live && live.fs > body + 2, JSON.stringify({ ...live, body }))
    check('T35 空格触发后当前行显示字面 "# "', live?.hash === '# ', `hash=${JSON.stringify(live?.hash)}`)
    // v3 空块转标题时外层 PageView 会按节点类型换壳，编辑器可能随之丢焦点；先按真实用户动作点回标题。
    await q.locator('.md-block .ProseMirror h1').click()
    await q.waitForTimeout(180) // click → selectionchange 异步落定，不能让 Home/← 吃到上一枚选区
    await q.keyboard.press('Home')
    await q.keyboard.press('ArrowLeft')
    await q.waitForTimeout(180)
    const reopened = await q.evaluate(() => document.activeElement?.classList.contains('amx-struct-prefix') ? document.activeElement.value : null)
    check('T35 触发后的标题仍可从行首进入字面 "# "', reopened === '# ', `hash=${JSON.stringify(reopened)}`)
    check('T35 井号不进文档(落盘仍是 `# 标题`)', (await mdOf(q)).trim() === '# 标题', `md=${JSON.stringify(await mdOf(q))}`)
    await q.close()
    await p.close()
  })

  // T36:行内工具栏「链接」按钮。此前它调 toggleLinkCommand 不带 payload,link schema 的 href
  //      是必填 string → mark.create 直接抛,按钮点了完全没反应(用户实报)。
  await tryTest('T36', async () => {
    const p = await freshPage('点这里')
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.press('End')
    for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowLeft')
    await p.waitForTimeout(400)
    await p.locator('.inline-toolbar [data-act="link"]').dispatchEvent('mousedown')
    await p.waitForTimeout(300)
    check('T36 点链接按钮弹出地址输入框', (await p.locator('.dialog-input').count()) === 1)
    await p.locator('.dialog-input').fill('forsion.net/docs')
    await p.keyboard.press('Enter')
    await p.waitForTimeout(700)
    const md = (await mdOf(p)).trim()
    check('T36 裸域名自动补 https:// 并写成 markdown 链接', md === '[点这里](https://forsion.net/docs)', `md=${JSON.stringify(md)}`)
    check('T36 渲染成可点的 <a>', (await p.locator('.md-block .ProseMirror a[href="https://forsion.net/docs"]').count()) === 1)
    // 再点一次 = 取消链接(空输入等同取消,拿不到「确认了但留空」,故去链接走无弹窗路径)
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.press('End')
    for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowLeft')
    await p.waitForTimeout(400)
    await p.locator('.inline-toolbar [data-act="link"]').dispatchEvent('mousedown')
    await p.waitForTimeout(600)
    check('T36 已是链接时再点 = 去链接(不再弹框)', (await p.locator('.dialog-input').count()) === 0)
    check('T36 去链接后回到纯文本', (await mdOf(p)).trim() === '点这里', `md=${JSON.stringify(await mdOf(p))}`)
    await p.close()

    // javascript: 一律拒绝 —— 笔记会被分享页独立渲染,这是个真 XSS 面。
    const q = await freshPage('危险')
    await q.locator('.md-block .ProseMirror').first().click()
    await q.keyboard.press('End')
    for (let i = 0; i < 2; i++) await q.keyboard.press('Shift+ArrowLeft')
    await q.waitForTimeout(400)
    await q.locator('.inline-toolbar [data-act="link"]').dispatchEvent('mousedown')
    await q.waitForTimeout(300)
    await q.locator('.dialog-input').fill('javascript:alert(1)')
    await q.keyboard.press('Enter')
    await q.waitForTimeout(700)
    check('T36 javascript: 地址被拒(不落盘成链接)', (await mdOf(q)).trim() === '危险', `md=${JSON.stringify(await mdOf(q))}`)
    await q.close()
  })

  // T37:标题折叠(?fold harness:真 PageView,H1/正文/H2/正文/H1 各占一行)。
  //     折叠 UI 本来就有(PageView 的 .amx-hfold),本轮补的是**持久化 + 按笔记分桶**。
  await tryTest('T37', async () => {
    const p = await browser.newPage()
    p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p.goto(`${URL}?fold`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
    await p.waitForTimeout(700)
    const shown = () => p.evaluate(() => [...document.querySelectorAll('.md-block .ProseMirror')].map((e) => e.textContent.trim()))
    check('T37 只有「其下还有行」的标题行才有折叠箭头(H1/H2 各一,末尾 H1 无下文)',
      (await p.locator('.amx-hfold').count()) === 2, `arrows=${await p.locator('.amx-hfold').count()}`)
    check('T37 初始五块全在', (await shown()).length === 5, JSON.stringify(await shown()))

    await p.locator('.amx-hfold').first().click() // 折起第一个 H1
    await p.waitForTimeout(400)
    check('T37 折 H1 → 吃到下一个 H1 之前', JSON.stringify(await shown()) === '["一级标题","另一个一级标题"]', JSON.stringify(await shown()))
    check('T37 折起有 folded 态记号', (await p.locator('.amx-hfold.folded').count()) === 1)

    await p.locator('.amx-hfold').first().click() // 展开
    await p.waitForTimeout(400)
    check('T37 再点展开 → 五块全回来', (await shown()).length === 5, JSON.stringify(await shown()))

    await p.locator('.amx-hfold').nth(1).click() // 折起 H2
    await p.waitForTimeout(400)
    check('T37 折 H2 只吃它自己那段', JSON.stringify(await shown()) === '["一级标题","一级下的正文","二级标题","另一个一级标题"]', JSON.stringify(await shown()))

    // 折叠态落 localStorage 且**按笔记路径分桶**(块 id 是每份文件的小整数,不分桶必跨笔记串档)
    const persisted = await p.evaluate(() => localStorage.getItem('amadeus.heading.fold'))
    check('T37 折叠态按笔记分桶存 localStorage', persisted === '{"Harness.md":["f3"]}', `ls=${persisted}`)
    const contents = await p.evaluate(() => Object.values(window.__pageStore.getState().blocks).map((b) => b.content))
    check('T37 折叠不改笔记内容(绝不写进 .md)', !contents.join('|').includes('fold'), JSON.stringify(contents))

    // 重新载入 = 重开笔记:折叠必须还在(本轮要修的正是这条)
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.md-block .ProseMirror', { timeout: 20000 })
    await p.waitForTimeout(700)
    check('T37 重开后折叠仍在(记忆保存)', JSON.stringify(await shown()) === '["一级标题","一级下的正文","二级标题","另一个一级标题"]', JSON.stringify(await shown()))
    await p.close()
  })

  // T38:`[[` 补全的两面 —— 光标**路过**已写完的双链不弹(否则面板吃掉 ↑/↓ 把光标困死),
  //      但在里面**打字**改目标名时必须照常弹(否则改不了已有链接的目标,是 UX 回归)。
  await tryTest('T38', async () => {
    const p = await freshPage('看 [[某笔记]] 这里')
    await p.locator('.md-block .ProseMirror').first().click()
    await p.keyboard.press('Home')
    for (let i = 0; i < 4; i++) await p.keyboard.press('ArrowRight') // 光标移进 [[…]] 内部
    await p.waitForTimeout(400)
    check('T38 光标路过已闭合的双链 → 不弹补全', (await p.locator('.wiki-suggest').count()) === 0)
    await p.keyboard.type('X', { delay: 40 }) // 在链接里打字 = 正在改目标名
    await p.waitForTimeout(400)
    check('T38 在已有双链里打字 → 照常弹补全(别为了修陷阱把改目标名一起废掉)', (await p.locator('.wiki-suggest').count()) === 1)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(200)
    await p.close()

    // 新写一条链接:全程该弹
    const q = await freshPage()
    await q.locator('.md-block .ProseMirror').first().click()
    await q.keyboard.type('看 [[新笔', { delay: 40 })
    await q.waitForTimeout(400)
    check('T38 新写 `[[` 未闭合 → 照常弹', (await q.locator('.wiki-suggest').count()) === 1)
    await q.close()
  })

  // T39:块菜单定位 —— 点 ⠿ 手柄弹出的 .ctx-menu 必须贴着手柄,不许钉在视口左上角。
  //     (回归 2026-08-06:OverlayPortal 宿主在被动 effect 里才挂载,外层 useClampedMenu 的
  //      量测 layout effect 跑在菜单 DOM 存在之前 → 早退,-1,-1 哨兵坐标直接上屏。
  //      修法=菜单节点自己用 OverlayAt 量测;本仪器钉死「菜单坐标 ≈ 手柄坐标」。)
  await tryTest('T39', async () => {
    const p = await dndPage() // 真 PageView(含 BlockHost 手柄);默认 harness 模式不渲染 gutter
    await p.locator('.block-host').first().hover()
    const h = p.locator('.block-host .drag-handle').first()
    await h.click({ force: true })
    await p.waitForTimeout(250)
    check('T39 块菜单打开', (await p.locator('.ctx-menu').count()) === 1)
    const mb = await p.locator('.ctx-menu').boundingBox()
    const hb = await h.boundingBox()
    const near = !!mb && !!hb && mb.y >= hb.y - 8 && mb.y <= hb.y + 160 && Math.abs(mb.x - hb.x) <= 280
    check('T39 菜单贴手柄弹出(不在视口左上角)', near, `menu=${JSON.stringify(mb)} handle=${JSON.stringify(hb)}`)
    await p.close()
  })

  // T40:标题小节折叠 —— ① 边界必须认「块中间的标题」;② 折叠箭头不许压在 ⠿ 手柄上。
  //     (回归 2026-08-08:块只由 <!-- a id --> 切分、不按段落拆,`## 二`/`# 三` 常躺在块中间;
  //      headingLevel 只看首行 → 边界漏检 → 折一次吞到文末。箭头则写死 left:-46px 正压手柄,
  //      标题块从此拖不动。反向验过:把 bound 换回 level、把箭头挪回 -46px,这两条即刻转红。)
  await tryTest('T40', async () => {
    const p = await dndPage()
    await p.evaluate(() => {
      const ps = window.__pageStore, cur = ps.getState().manifest
      const row = (id, ref) => ({ type: 'row', id, columns: [{ id: 'c' + id, width: 1, children: [{ ref }] }] })
      ps.setState({
        manifest: {
          ...cur,
          root: { type: 'stack', children: [row('r1', 'A'), row('r2', 'B'), row('r3', 'C'), row('r4', 'D')] },
          blocks: { A: { type: 'markdown' }, B: { type: 'markdown' }, C: { type: 'markdown' }, D: { type: 'markdown' } },
        },
        blocks: {
          A: { id: 'A', type: 'markdown', content: '# 一' },
          B: { id: 'B', type: 'markdown', content: '正文A\n## 二\n正文B' }, // 子小节:该跟着折
          C: { id: 'C', type: 'markdown', content: '正文C' },
          D: { id: 'D', type: 'markdown', content: '正文D\n# 三\n正文E' }, // ⚠️边界标题在块中间
        },
      })
    })
    await p.waitForTimeout(400)
    const hosts = () => p.locator('.block-host[data-block-id]').count()
    check('T40 起始四块都在', (await hosts()) === 4)
    const wrap = p.locator('.amx-hfold-wrap').first()
    await wrap.hover()
    const arrow = p.locator('.amx-hfold').first()
    check('T40 标题行有折叠箭头', (await arrow.count()) === 1)
    // ② 几何:箭头与本行 ⠿ 手柄不许有交集
    const ab = await arrow.boundingBox()
    const hb = await p.locator('.block-host[data-block-id="A"] .drag-handle').boundingBox()
    const overlap = !!ab && !!hb && ab.x < hb.x + hb.width && hb.x < ab.x + ab.width && ab.y < hb.y + hb.height && hb.y < ab.y + ab.height
    check('T40 折叠箭头不压 ⠿ 手柄', !overlap, `arrow=${JSON.stringify(ab)} handle=${JSON.stringify(hb)}`)
    check('T40 有箭头的行让出 ＋ 槽位', !(await p.locator('.amx-hfold-wrap.has-fold .block-add').first().isVisible()))
    // ① 语义:折 `# 一` 吞掉 B(子小节)与 C(正文),停在块中间那个 `# 三` 之前
    await arrow.click({ force: true })
    await p.waitForTimeout(300)
    check('T40 折起后只剩标题行与 `# 三` 所在行', (await hosts()) === 2, `hosts=${await hosts()}`)
    check('T40 边界行(块内标题)没被吞', (await p.locator('.block-host[data-block-id="D"]').count()) === 1)
    check('T40 子小节被折起', (await p.locator('.block-host[data-block-id="B"]').count()) === 0)
    await p.close()
  })

  // T41:边界标题藏在**标题行自己那一块**里 → 这一行自己就跨了小节,行级折叠切不开它,不许给箭头。
  //     (评审 P1:第一版只让「后面的行」参与边界判定,`# 一\n正文\n# 二` 同块时照样一折到底;
  //      真实 vault 里已实测命中。反向验:去掉 rowMeta.self 这一闸即刻转红。)
  await tryTest('T41', async () => {
    const p = await dndPage()
    await p.evaluate(() => {
      const ps = window.__pageStore, cur = ps.getState().manifest
      const row = (id, ref) => ({ type: 'row', id, columns: [{ id: 'c' + id, width: 1, children: [{ ref }] }] })
      ps.setState({
        manifest: {
          ...cur,
          root: { type: 'stack', children: [row('r1', 'A'), row('r2', 'B')] },
          blocks: { A: { type: 'markdown' }, B: { type: 'markdown' } },
        },
        blocks: {
          A: { id: 'A', type: 'markdown', content: '# 一\n正文1\n# 二' }, // 同块两个标题
          B: { id: 'B', type: 'markdown', content: '这段属于「二」' },
        },
      })
    })
    await p.waitForTimeout(400)
    await p.locator('.amx-hfold-wrap').first().hover()
    check('T41 跨小节的行不给折叠箭头', (await p.locator('.amx-hfold').count()) === 0)
    check('T41 后续行照常显示', (await p.locator('.block-host[data-block-id="B"]').count()) === 1)
    await p.close()
  })

  // T42:Tab 缩进(2026-08-14 用户实报「普通笔记没做 Tab 缩进」:v3 块世界此前无任何 Tab 键位,
  //      段落里按 Tab 焦点直接被浏览器抛出编辑器)。阶梯与 v4 blockLayer 共用 blocks/markdown/tabIndent.ts。
  await tryTest('T42', async () => {
    // ① 列表项 Tab = 降为子级(DOM 出现嵌套 ul);Shift-Tab = 升回。
    const p = await freshPage('- 甲\n\n- 乙')
    await p.locator('.md-block .ProseMirror li').nth(1).click()
    await p.waitForTimeout(200)
    await p.keyboard.press('Tab')
    await p.waitForTimeout(500)
    check('T42 列表项 Tab → 子级(嵌套 ul)', (await p.locator('.md-block .ProseMirror ul ul').count()) === 1)
    const inEditor = () => p.evaluate(() => !!document.activeElement?.closest?.('.ProseMirror'))
    check('T42 Tab 后焦点仍在编辑器里', await inEditor())
    await p.keyboard.press('Shift+Tab')
    await p.waitForTimeout(500)
    check('T42 Shift-Tab → 升回同级', (await p.locator('.md-block .ProseMirror ul ul').count()) === 0)
    await p.close()

    // ② 段落 Tab = 整段缩进档(2026-08-14 用户拍板「纯缩进,不转列表」,Notion/AFFiNE 视觉):
    //    data-indent 逐档加、margin-left 真生效、落盘是行首字面制表符;Shift-Tab 逐档退。
    const r = await freshPage('孤段落')
    await r.locator('.md-block .ProseMirror').first().click()
    await r.waitForTimeout(200)
    await r.keyboard.press('Tab')
    await r.waitForTimeout(500)
    const ind1 = await r.evaluate(() => {
      const p = document.querySelector('.md-block .ProseMirror > p')
      return { di: p?.getAttribute('data-indent'), ml: p ? parseFloat(getComputedStyle(p).marginLeft) : -1 }
    })
    check('T42 段落 Tab → 缩进一档(data-indent=1 且 margin 生效)', ind1.di === '1' && ind1.ml > 0, JSON.stringify(ind1))
    check('T42 缩进后不产生列表', (await r.locator('.md-block .ProseMirror ul, .md-block .ProseMirror ol').count()) === 0)
    const rInEditor = await r.evaluate(() => !!document.activeElement?.closest?.('.ProseMirror'))
    check('T42 缩进后焦点仍在编辑器里(不逃逸)', rInEditor)
    await r.keyboard.press('Tab')
    await r.waitForTimeout(400)
    check('T42 再按 Tab → 第二档', (await r.locator('.md-block .ProseMirror > p[data-indent="2"]').count()) === 1)
    const rmd = await mdOf(r)
    check('T42 缩进落盘 = 行首两枚字面制表符', rmd.startsWith('\t\t孤段落'), `md=${JSON.stringify(rmd)}`)
    await r.keyboard.press('Shift+Tab')
    await r.keyboard.press('Shift+Tab')
    await r.waitForTimeout(500)
    const rmd0 = await mdOf(r)
    check('T42 Shift-Tab 逐档退回零(attr 摘除,落盘无制表符)',
      (await r.locator('.md-block .ProseMirror > p[data-indent]').count()) === 0 && !rmd0.includes('\t'), `md=${JSON.stringify(rmd0)}`)
    await r.keyboard.press('Shift+Tab') // 零档再退:吞键不动,焦点不逃逸
    await r.waitForTimeout(300)
    check('T42 零档 Shift-Tab 吞键(焦点仍在)', await r.evaluate(() => !!document.activeElement?.closest?.('.ProseMirror')))
    await r.close()

    // ③ 缩进段落经「落盘 → 重新载入」round-trip 不塌成代码块、档位还在(indentIo 编解码 + compiler 保尾)。
    const q = await freshPage('\t缩进种子段')
    await q.waitForTimeout(300)
    const qState = await q.evaluate(() => {
      const pm = document.querySelector('.md-block .ProseMirror')
      return {
        code: pm.querySelectorAll('pre, code').length,
        di: pm.querySelector(':scope > p')?.getAttribute('data-indent'),
        text: pm.textContent,
      }
    })
    check('T42 磁盘行首制表符载入 → 缩进段落而非代码块', qState.code === 0 && qState.di === '1' && qState.text.includes('缩进种子段'), JSON.stringify(qState))
    await q.close()

    // ④ 表格内 Tab = 跳下一格(gfm tableKeymap),绝不许被缩进层吞成哑键。
    const s = await freshPage('| a | b |\n| --- | --- |\n| 1 | 2 |')
    await s.locator('.md-block .ProseMirror th').first().click()
    await s.waitForTimeout(200)
    await s.keyboard.press('Tab')
    await s.waitForTimeout(200)
    await s.keyboard.type('X', { delay: 30 })
    await s.waitForTimeout(500)
    // gfm 跳格会**全选**目标格内容,输入即整格替换 → b 格变 X、a 格纹丝不动才是「跳成功」。
    const tmd = await mdOf(s)
    check('T42 表格 Tab 跳到下一格(b 格被替换成 X,a 格不动)', tmd.startsWith('| a | X |'), `md=${JSON.stringify(tmd)}`)
    await s.close()

    // ⑤ 代码块内 Tab = 插两空格(绝不转列表/跳走);多行选区 = 逐行缩进(整段替换会吃掉选中代码)。
    const c = await freshPage('```\ncode\n```')
    await c.locator('.md-block .ProseMirror pre').first().click()
    await c.waitForTimeout(200)
    await c.keyboard.press('Home')
    await c.keyboard.press('Tab')
    await c.waitForTimeout(500)
    const cmd = await mdOf(c)
    check('T42 代码块 Tab → 行首两空格', cmd.includes('  code'), `md=${JSON.stringify(cmd)}`)
    await c.close()
    // 真选区必须真跨行:无头端键盘导航(Cmd+箭头/Shift+End)不稳定,用 DOM Range 精确铺
    // (Cmd+A 的 AllSelection 父节点是 doc,阶梯刻意吞掉 —— 真实多行操作是 shift 选区)。
    const spanSelect = (p, fromSel, toSel) =>
      p.evaluate(([a, b]) => {
        const root = document.querySelector('.md-block .ProseMirror')
        const el1 = root.querySelector(a)
        const el2 = root.querySelector(b)
        const firstText = (n) => { while (n.firstChild) n = n.firstChild; return n }
        const lastText = (n) => { while (n.lastChild) n = n.lastChild; return n }
        const r = document.createRange()
        r.setStart(firstText(el1), 0)
        const lt = lastText(el2)
        r.setEnd(lt, lt.textContent ? lt.textContent.length : 0)
        const s = window.getSelection()
        s.removeAllRanges()
        s.addRange(r)
      }, [fromSel, toSel])
    const c2 = await freshPage('```\naa\nbb\n```')
    await c2.locator('.md-block .ProseMirror pre').first().click()
    await c2.waitForTimeout(200)
    await spanSelect(c2, 'pre', 'pre')
    await c2.waitForTimeout(200)
    await c2.keyboard.press('Tab')
    await c2.waitForTimeout(500)
    const cmd2 = await mdOf(c2)
    check('T42 代码块多行选区 Tab → 逐行缩进(不吃代码)', cmd2.includes('  aa') && cmd2.includes('  bb'), `md=${JSON.stringify(cmd2)}`)
    await c2.keyboard.press('Shift+Tab')
    await c2.waitForTimeout(500)
    const cmd3 = await mdOf(c2)
    check('T42 代码块多行 Shift-Tab → 逐行去缩进', cmd3.includes('aa') && cmd3.includes('bb') && !cmd3.includes('  aa'), `md=${JSON.stringify(cmd3)}`)
    await c2.close()

    // ⑥ 列表后面的段落 Tab:**不并入列表**(旧「成为前块子块」语义已废除)—— 列表结构原封不动,
    //    段落只是缩进;落盘后重载也不许被列表吸走(indentIo 实体形态防 md 懒延续)。
    const u = await freshPage('- 项目一\n\n后段')
    await u.locator('.md-block .ProseMirror > p').first().click()
    await u.waitForTimeout(200)
    await u.keyboard.press('Tab')
    await u.waitForTimeout(500)
    const uState = await u.evaluate(() => {
      const pm = document.querySelector('.md-block .ProseMirror')
      return {
        lis: pm.querySelectorAll('li').length,
        ps: pm.querySelectorAll(':scope > p').length,
        di: pm.querySelector(':scope > p')?.getAttribute('data-indent'),
      }
    })
    check('T42 列表后段落 Tab → 只缩进不并入(列表 1 项、段落还在顶层)', uState.lis === 1 && uState.ps === 1 && uState.di === '1', JSON.stringify(uState))
    const umd = await mdOf(u)
    check('T42 列表+缩进段落落盘形态(列表原样 + 行首制表符)', /[-*] 项目一/.test(umd) && /\n\t后段/.test(umd), `md=${JSON.stringify(umd)}`)
    await u.close()

    // ⑦ 多段选区 Tab:逐段各自缩进一档,不产生列表。
    const m2 = await freshPage('甲段\n\n乙段')
    await m2.locator('.md-block .ProseMirror > p').first().click()
    await m2.waitForTimeout(200)
    await spanSelect(m2, ':scope > p:first-of-type', ':scope > p:last-of-type')
    await m2.waitForTimeout(200)
    await m2.keyboard.press('Tab')
    await m2.waitForTimeout(500)
    const m2State = await m2.evaluate(() => {
      const pm = document.querySelector('.md-block .ProseMirror')
      return {
        indented: pm.querySelectorAll(':scope > p[data-indent="1"]').length,
        lis: pm.querySelectorAll('li').length,
      }
    })
    // 种子 '甲段\n\n乙段' 在 v3 里落成三段(中间空段);选区内三段全部 +1 档(空段的档位只活在
    // 会话内 —— 空段序列化走 <br/> 不带缩进,重载即丢,属 md 可表示性边界,不追求)。
    check('T42 多段选区 Tab → 逐段缩进、零列表', m2State.indented === 3 && m2State.lis === 0, JSON.stringify(m2State))
    await m2.close()
  })

  const fails = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - fails}/${results.length} passed, ${fails} failed`)
  await browser.close()
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e)
  process.exit(1)
})
