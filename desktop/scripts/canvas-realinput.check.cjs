// 画布「粘贴 / 拖入」的**真实输入**仪器(2026-08-20 深夜)。用法:node scripts/e2e-editor.cjs --check=canvas-realinput
//
// 为什么另起一层:check:canvas / check:blockops 里那几格是**合成事件** —— `new DragEvent(...)` 的
// dataTransfer 是脚本自己造的,`new ClipboardEvent('paste')` 也是。它们只验分流逻辑,验不到
// 「浏览器/OS 把 DataTransfer.files 填进来」的那一段(今天上午那条日志把这一格明写成 SKIP)。
// 这里改用 CDP 打真输入:
//   R1 真系统剪贴板 + 真 Cmd+V(Input.dispatchKeyEvent 带 commands:['paste'],走的是浏览器自己的
//      粘贴命令,clipboardData 由**剪贴板**填)→ 落一张卡
//   R2 剪贴板里放真 PNG → 同一条真 Cmd+V → `clipboardData.files` 由浏览器填 → 附件卡
//   R3 Input.dispatchDragEvent 带**磁盘上的真文件路径**拖到舞台空白 → 附件卡(files 由浏览器读盘填)
//   R4 同上但落点压在**卡片上**(用户实报那一半:卡片 DOM 住在 .ProseMirror 里)
//   R5 真 Cmd+C → 真 Cmd+V 的整卡往返:自定义 MIME(web custom data)到底出得去回得来吗
//      —— 合成事件那层复制粘贴共用同一个 DataTransfer,这条平凡成立,只有真剪贴板答得了
//   R6 真 Cmd+X:系统剪贴板里的纯文本保住块边界(node.textContent 是零分隔拼接)
//
// ⚠️ 仍未覆盖:真人按住鼠标从 Finder 拖过来(那需要 OS 级手势,只有 computer use 答得了)。
// 但从「dataTransfer 里的 File 是不是浏览器按真路径造的」这个角度,R3/R4 与真拖拽同一条内核路径。
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
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 1x1 PNG(真文件,给 R3/R4 拖;R2 用同一份字节进剪贴板)。 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const stubAttachments = (p) => p.evaluate(() => {
  const g = window
  g.__stub = { saved: [] }
  Object.assign(g.amadeus, {
    saveAttachment: (page, name) => { g.__stub.saved.push(name); return Promise.resolve({ base: name, pageRel: name }) },
    exclusiveAssets: () => Promise.resolve([]),
  })
})

/** 真编辑命令:走浏览器自己的 copy/cut/paste(载荷由**系统剪贴板**填,不是脚本造的)。 */
async function realEdit(cdp, cmd) {
  const k = { copy: ['c', 'KeyC', 67], cut: ['x', 'KeyX', 88], paste: ['v', 'KeyV', 86] }[cmd]
  const base = { key: k[0], code: k[1], windowsVirtualKeyCode: k[2], nativeVirtualKeyCode: k[2], modifiers: 4 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, commands: [cmd] })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
const realPaste = (cdp) => realEdit(cdp, 'paste')

/** 真拖文件:files 给**磁盘路径**,由浏览器自己造 File 对象填进 dataTransfer。 */
async function dragFile(cdp, file, x, y) {
  const data = { items: [], files: [file], dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amx-drag-'))
  const file = path.join(tmp, 'dragged.png')
  fs.writeFileSync(file, PNG)

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const p = await ctx.newPage({ locale: 'zh-CN' })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage&upane&useed=${encodeURIComponent('# 真输入画布\n\n主卡一段。\n')}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(400)
  await stubAttachments(p)
  const cdp = await ctx.newCDPSession(p)
  await p.click('.amx-modeseg button:nth-child(3)')
  await p.waitForTimeout(1000)

  const stage = await p.evaluate(() => {
    const r = document.querySelector('.amx-stage').getBoundingClientRect()
    return { left: r.left, top: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }
  })
  const blank = { x: Math.round(stage.right - 150), y: Math.round(stage.top + stage.h * 0.45) }

  // ── R1 真剪贴板文字 + 真 Cmd+V ────────────────────────────────────────────────
  await p.evaluate(() => navigator.clipboard.writeText('# 真粘贴标题\n\n真粘贴正文。'))
  await p.mouse.click(blank.x, blank.y)
  await realPaste(cdp)
  await p.waitForTimeout(500)
  const r1 = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.amx-ucard')]
    return { n: cards.length, h1: cards.filter((c) => !!c.querySelector('h1')).length, text: cards.map((c) => c.textContent).join('|') }
  })
  record('R1 真系统剪贴板 + 真 Cmd+V(浏览器 paste 命令)= 落一张卡,markdown 成真块',
    r1.n === 1 && r1.h1 === 1 && r1.text.includes('真粘贴正文'), JSON.stringify(r1))

  // ── R2 剪贴板里放真 PNG(clipboardData.files 由浏览器填)────────────────────────
  await p.evaluate(async (b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([u8], { type: 'image/png' }) })])
  }, PNG.toString('base64'))
  await p.mouse.click(blank.x, blank.y)
  await realPaste(cdp)
  await p.waitForTimeout(700)
  const r2 = await p.evaluate(() => ({
    n: document.querySelectorAll('.amx-ucard').length,
    saved: window.__stub.saved,
    texts: [...document.querySelectorAll('.amx-ucard')].map((c) => c.textContent),
  }))
  record('R2 剪贴板里的真图片 + 真 Cmd+V = 附件卡(clipboardData.files 由浏览器填)',
    r2.n === 2 && r2.saved.length === 1 && r2.texts.some((t) => t.includes('![[')), JSON.stringify(r2))

  // ── R3 真文件路径拖到舞台空白 ────────────────────────────────────────────────
  const blank2 = { x: Math.round(stage.left + stage.w * 0.62), y: Math.round(stage.bottom - 180) }
  await dragFile(cdp, file, blank2.x, blank2.y)
  await p.waitForTimeout(700)
  const r3 = await p.evaluate(() => ({
    n: document.querySelectorAll('.amx-ucard').length,
    saved: window.__stub.saved,
    texts: [...document.querySelectorAll('.amx-ucard')].map((c) => c.textContent),
  }))
  record('R3 真文件路径拖到舞台空白 = 附件卡(dataTransfer.files 由浏览器读盘填)',
    r3.n === 3 && r3.saved.includes('dragged.png') && r3.texts.some((t) => t.includes('![[dragged.png]]')), JSON.stringify(r3))

  // ── R4 同上,但落点压在卡片上(用户实报的那一半)──────────────────────────────
  const onCard = await p.evaluate(() => {
    const c = document.querySelector('.amx-ucard')
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })
  await dragFile(cdp, file, onCard.x, onCard.y)
  await p.waitForTimeout(700)
  const r4 = await p.evaluate(() => ({
    n: document.querySelectorAll('.amx-ucard').length,
    saved: window.__stub.saved.length,
    main: document.querySelector('.unified-body .ProseMirror')?.firstElementChild?.textContent ?? '',
  }))
  record('R4 真文件拖到**卡片上**照样落成新卡(不被让回 PM、不塞进主卡)',
    r4.n === 4 && r4.saved === 3, JSON.stringify(r4))

  // ── R5/R6 整卡复制粘贴走**真系统剪贴板**(自定义 MIME 到底能不能往返?)────────────
  // ⚠️ 合成事件那层(C71b)复制和粘贴共用同一个 DataTransfer 对象,自定义 MIME 平凡成立 ——
  //    真剪贴板才答得了「Chromium 的 web custom data 出得去回得来吗」。它要是回不来,整卡粘贴
  //    会静默退化成纯文本(而断言仍会在合成那层全绿)。
  // ⚠️ 首段带一个**行内代码**(里面装着 markdown 语法):它是「令牌路径」与「纯文本兜底」的分水岭 ——
  //    退化成文本时,剪贴板里的字面 `**x**` 会被重新解析成**加粗**,代码块就没了。只断言「两段」
  //    的话两条路都绿,断言等于白写。
  await p.evaluate(() => navigator.clipboard.writeText('`**x**` 甲段。\n\n乙段。'))
  await p.mouse.click(blank.x, blank.y)
  await realPaste(cdp)
  await p.waitForTimeout(500)
  const twoPara = await p.evaluate(() => {
    const c = [...document.querySelectorAll('.amx-ucard')].find((x) => (x.textContent ?? '').includes('乙段'))
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { ps: c.querySelectorAll('p').length, code: c.querySelectorAll('code').length, x: Math.round(r.left + 4), y: Math.round(r.top + 4), anchor: c.dataset.anchor }
  })
  await p.mouse.click(twoPara.x, twoPara.y) // 卡的 chrome 圈 = 选中(不落光标)
  await realEdit(cdp, 'copy')
  await p.waitForTimeout(200)
  await p.mouse.click(blank.x, blank.y)
  await realPaste(cdp)
  await p.waitForTimeout(500)
  const r5 = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.amx-ucard')].filter((c) => (c.textContent ?? '').includes('乙段'))
    return {
      n: cards.length,
      ps: cards.map((c) => c.querySelectorAll('p').length),
      code: cards.map((c) => c.querySelectorAll('code').length),
      strong: cards.map((c) => c.querySelectorAll('strong').length),
      anchors: cards.map((c) => c.dataset.anchor),
    }
  })
  record('R5 真剪贴板往返:复制卡 → 粘贴 = 整卡复现(自定义 MIME 令牌真能出得去回得来;行内代码没退化成加粗)',
    !!twoPara && twoPara.ps === 2 && r5.n === 2 && r5.ps.every((n) => n === 2)
      && r5.code.every((n) => n === 1) && r5.strong.every((n) => n === 0) && new Set(r5.anchors).size === 2,
    JSON.stringify({ src: twoPara, ...r5 }))

  // R6 真剪切:系统剪贴板里的纯文本必须**保住块边界**(textContent 会把「甲段。」「乙段。」粘成一坨)
  const cutAt = await p.evaluate(() => {
    const c = [...document.querySelectorAll('.amx-ucard')].find((x) => (x.textContent ?? '').includes('乙段'))
    const r = c.getBoundingClientRect()
    return { x: Math.round(r.left + 4), y: Math.round(r.top + 4) }
  })
  await p.mouse.click(cutAt.x, cutAt.y)
  await realEdit(cdp, 'cut')
  await p.waitForTimeout(400)
  const r6 = await p.evaluate(async () => ({
    clip: await navigator.clipboard.readText(),
    n: [...document.querySelectorAll('.amx-ucard')].filter((c) => (c.textContent ?? '').includes('乙段')).length,
  }))
  record('R6 真剪切:卡走了,系统剪贴板里的纯文本保住块边界(不是「甲段。乙段。」粘成一坨)',
    r6.clip.includes('甲段。\n\n乙段。') && r6.n === 1, JSON.stringify(r6))

  await browser.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  console.log('SKIP  真人从 Finder 按住鼠标拖(OS 级手势)—— 只有 computer use 答得了;这里验的是 files 由浏览器真填的那一段')
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
