/**
 * 笔记里指向文件的双链:点了开在旁边的分屏、右键出这份文件的菜单、光标进嵌入那一行露出源码
 * (真 Electron × 真渲染层 × 真主进程 × 真磁盘;2026-10-13 用户定的三件)。
 *
 * 规则那半各有浏览器台架(check:openbeside / check:linkmenu / check:embedsource),**这里钉的是整条链**:
 * 双链部件 → pageStore.openWikiLink → amadeus:open-* 事件 → amadeusNav → Dockview 真布局;以及只有真宿主才有的
 * 菜单项(用系统程序打开 / 在文件管理器中显示)。
 *
 *   1 点图片双链:开在应用里、就地打开,不分屏(用户原话「图片不算」)
 *   2 点 PDF 双链:PDF 开在右边的分屏,笔记还在左边
 *   3 再点另一份 PDF:复用那个分屏(多一个标签),不再劈一栏。⚠️ 这一步是本检查抓到的真问题:PDF 一开,活动栏就是它了;
 *     双链部件又不落焦点,不把笔记这一栏设回活动栏的话,第二份会开进笔记自己这一栏(浏览器台架量不到,它总在活动栏里点)
 *   4 右键 PDF 双链:出文件菜单(不是文字编辑菜单),贴着指针,宿主项齐全
 *   5 菜单里「在分屏中打开」对笔记双链也管用(笔记默认点击是就地打开)
 *   6 光标走进文件嵌入那一行:源码露在嵌入上方,嵌入照样渲染;走开就收起
 *
 * 负对照(实跑过):构建产物里把 amadeusLinkMenu 的 activatePaneOf 掏空 → 第 3 条红(丁文档开进了甲笔记那一栏)。
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。
 * ⚠️ 库是临时夹具,不碰本机真实库。菜单里会拉起系统程序 / 访达的两项只看在不在,不点。
 * ⚠️ 别往夹具里加指向 .docx 之类「应用里开不了」的文件的双链去点:那些交给系统默认程序,会在本机真弹出别的应用。
 * 跑:npm run e2e:filelink(界面缩放用 UI_ZOOM=1.1 指定,用户的 dev 是 110%)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const electron = require('./lib/launch-electron.cjs')
const { tinyPdf } = require('./lib/tiny-pdf.cjs')

const ROOT = path.join(__dirname, '..')
const ZOOM = Number(process.env.UI_ZOOM || 1)
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 2×2 的纯色 PNG。 */
function png() {
  const crc = (buf) => {
    let c = ~0
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(2 * 7, 0x80)
  raw[0] = 0; raw[7] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** 主区的版面:每个看得见的标签组里有哪些标签、组的左右边、里面是笔记还是 PDF 阅读器(笔记里嵌着的 PDF 不算)。
 *  组按出现顺序编号(打在 DOM 上,前后两次快照对得上)。 */
const LAYOUT = `(() => {
  let n = Number(document.body.dataset.e2eGid || 0)
  const out = []
  for (const g of document.querySelectorAll('.dv-groupview')) {
    const r = g.getBoundingClientRect()
    const tabs = [...g.querySelectorAll('.wb-tab:not(.wb-tab--left) .wb-tab-name')].map((t) => t.textContent || '').filter(Boolean)
    if (r.width < 4 || !tabs.length) continue
    if (!g.dataset.e2eGid) g.dataset.e2eGid = String(++n)
    out.push({ id: g.dataset.e2eGid, left: Math.round(r.left), right: Math.round(r.right), tabs,
      note: !!g.querySelector('.unified-body'), pdf: [...g.querySelectorAll('.pdfa-container')].some((c) => !c.closest('.unified-embed')) })
  }
  document.body.dataset.e2eGid = String(n)
  return out
})()`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-filelink-'))
  const vault = path.join(home, 'vault')
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  fs.writeFileSync(path.join(vault, '甲笔记.md'), '# 甲\n\n参见 [[丙文档.pdf]] 与 [[丁文档.pdf]],配图 [[戊图.png]],另见 [[乙笔记]]。\n\n嵌入之前\n\n![[丙文档.pdf]]\n\n嵌入之后\n')
  fs.writeFileSync(path.join(vault, '乙笔记.md'), '# 乙\n\n乙的正文。\n')
  fs.writeFileSync(path.join(vault, '丙文档.pdf'), tinyPdf(['Page one of C', 'Page two of C']))
  fs.writeFileSync(path.join(vault, '丁文档.pdf'), tinyPdf(['Page one of D']))
  fs.writeFileSync(path.join(vault, '戊图.png'), png())
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))
  const shot = (tag) => path.join(os.tmpdir(), `forsion-filelink-${tag}-z${ZOOM}.png`)

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
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'amadeus'); ${ZOOM === 1 ? `localStorage.removeItem('forsion_ui_zoom')` : `localStorage.setItem('forsion_ui_zoom', '${ZOOM}')`}`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForSelector('.am-app', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    if (!(await win.locator('.t2s-srow', { hasText: '甲笔记' }).first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(800)
    }
    const openFromTree = async (name) => {
      await win.locator('.t2s-srow', { hasText: name }).first().click()
      await win.waitForSelector('.amx-pane .wikilink[data-wiki]', { timeout: 20_000 })
      await win.waitForTimeout(1200)
    }
    const layout = () => win.evaluate(LAYOUT)
    const link = (text) => win.locator('.amx-pane .wikilink[data-wiki]', { hasText: text }).first()
    const zoomNow = await win.evaluate(`Number(getComputedStyle(document.documentElement).zoom) || 1`)

    await openFromTree('甲笔记')
    const l0 = await layout()
    const noteG = l0.find((g) => g.note)
    check(`0 夹具装上了:一栏,里面是甲笔记(界面缩放 ${zoomNow})`, l0.length === 1 && !!noteG && Math.abs(zoomNow - ZOOM) < 0.01, JSON.stringify(l0))
    if (!noteG) throw new Error('笔记没打开,后面的断言没有意义')

    // ── 1 图片双链:应用里就地打开 ───────────────────────────────────────────
    await link('戊图').click()
    await win.waitForTimeout(1800)
    const l1 = await layout()
    check('1 点图片双链:开在应用里,还是一栏(图片不分屏)', l1.length === 1 && l1[0].id === noteG.id && l1[0].tabs.some((t) => t.includes('戊图')), JSON.stringify(l1))
    await openFromTree('甲笔记')

    // ── 2 PDF 双链:开在右边的分屏 ───────────────────────────────────────────
    await link('丙文档').click()
    await win.waitForSelector('.pdfa-container .page', { timeout: 20_000 }).catch(() => {})
    await win.waitForTimeout(1500)
    const l2 = await layout()
    const n2 = l2.find((g) => g.id === noteG.id)
    const p2 = l2.find((g) => g.pdf)
    check('2 点 PDF 双链:PDF 开在右边的分屏,笔记还在左边',
      l2.length === 2 && !!n2 && n2.note && n2.tabs.some((t) => t.includes('甲笔记')) && !!p2 && p2.id !== noteG.id && p2.left >= n2.right - 4 && p2.tabs.some((t) => t.includes('丙文档')),
      JSON.stringify(l2))
    await win.screenshot({ path: shot('split') })

    // ── 3 另一份 PDF:复用那个分屏 ───────────────────────────────────────────
    await link('丁文档').click()
    await win.waitForTimeout(2500)
    const l3 = await layout()
    const p3 = l3.find((g) => g.id === p2?.id)
    const n3 = l3.find((g) => g.id === noteG.id)
    check('3 ⚠️ 再点另一份 PDF:复用旁边那一栏(两个标签),不开进笔记自己这一栏,也不再劈一栏',
      l3.length === 2 && !!p3 && p3.tabs.some((t) => t.includes('丙文档')) && p3.tabs.some((t) => t.includes('丁文档')) && !!n3 && n3.note && n3.tabs.length === 1,
      JSON.stringify(l3))

    // ── 4 右键:文件菜单 ─────────────────────────────────────────────────────
    const box = await link('丙文档').boundingBox()
    await link('丙文档').click({ button: 'right' })
    await win.waitForSelector('.amx-link-menu', { timeout: 5000 }).catch(() => {})
    await win.waitForTimeout(300)
    const menu = await win.evaluate(`(() => {
      const m = document.querySelector('.amx-link-menu')
      if (!m) return null
      const r = m.getBoundingClientRect()
      return { acts: [...m.querySelectorAll('button[data-act]')].map((b) => b.dataset.act), labels: [...m.querySelectorAll('button')].map((b) => (b.textContent || '').trim()), left: Math.round(r.left), top: Math.round(r.top) }
    })()`)
    const cx = box ? box.x + box.width / 2 : -999
    const cy = box ? box.y + box.height / 2 : -999
    check('4 右键 PDF 双链:出文件菜单,宿主项齐全',
      !!menu && ['newtab', 'split', 'system', 'reveal', 'copypath', 'edit'].every((a) => menu.acts.includes(a)), JSON.stringify(menu))
    check('4b 菜单贴着指针(缩放下不偏)', !!menu && Math.abs(menu.left - cx) <= 14 && Math.abs(menu.top - cy) <= 14, JSON.stringify({ 指针: [Math.round(cx), Math.round(cy)], 菜单: menu && [menu.left, menu.top], 缩放: zoomNow }))
    await win.screenshot({ path: shot('menu') })
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    check('4c 按键收起', (await win.locator('.amx-link-menu').count()) === 0)

    // ── 5 笔记双链:菜单里显式分屏 ───────────────────────────────────────────
    await link('乙笔记').click({ button: 'right' })
    await win.waitForSelector('.amx-link-menu', { timeout: 5000 }).catch(() => {})
    const noteActs = await win.evaluate(`[...document.querySelectorAll('.amx-link-menu button[data-act]')].map((b) => b.dataset.act)`)
    await win.locator('.amx-link-menu button[data-act="split"]').click().catch(() => {})
    await win.waitForTimeout(2500)
    const l5 = await layout()
    const p5 = l5.find((g) => g.id === p2?.id)
    check('5 笔记双链「在分屏中打开」:乙开在旁边那一栏,甲还在原地(笔记没有「用系统程序打开」)',
      l5.length === 2 && !!p5 && p5.tabs.some((t) => t.includes('乙笔记')) && l5.some((g) => g.id === noteG.id && g.tabs.some((t) => t.includes('甲笔记'))) && !noteActs.includes('system'),
      JSON.stringify({ 版面: l5, 菜单项: noteActs }))

    // ── 6 光标走进嵌入那一行 ─────────────────────────────────────────────────
    const noteSel = `[data-e2e-gid="${noteG.id}"] .unified-body`
    /** src = 这一段里嵌入体之外、看得见的文字(源码露没露就看它)。 */
    const SRC = `(() => {
      const host = document.querySelector('${noteSel} .unified-embed-soft')
      if (!host) return null
      const vis = (e) => e.getBoundingClientRect().height > 2 && getComputedStyle(e).display !== 'none'
      const emb = host.querySelector(':scope > .unified-embed')
      const src = [...host.childNodes].filter((n) => n.nodeType === 3 || (n.nodeType === 1 && n !== emb && vis(n))).map((n) => n.textContent || '').join('')
      const sel = getSelection()
      const caret = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null
      return { revealed: host.classList.contains('unified-embed-src'), src, embed: !!emb && vis(emb),
        srcAbove: !!emb && !!caret && caret.height > 0 && caret.bottom <= emb.getBoundingClientRect().top + 2, caretInHost: !!sel?.anchorNode && host.contains(sel.anchorNode) }
    })()`
    await win.locator(`${noteSel} .ProseMirror p`, { hasText: '嵌入之前' }).first().click()
    await win.keyboard.press('End')
    const idle = await win.evaluate(SRC)
    await win.keyboard.press('ArrowDown')
    await win.waitForTimeout(500)
    const on = await win.evaluate(SRC)
    check('6 光标走进文件嵌入那一行:源码露在嵌入上方,嵌入照样渲染',
      !!idle && !idle.revealed && !idle.src.includes('![[') && idle.embed && !!on && on.revealed && on.src.includes('![[丙文档.pdf]]') && on.embed && on.srcAbove && on.caretInHost,
      JSON.stringify({ 走进之前: idle, 走进之后: on }))
    await win.screenshot({ path: shot('source') })
    await win.keyboard.press('ArrowDown')
    await win.waitForTimeout(500)
    const off = await win.evaluate(SRC)
    const at = await win.evaluate(`getSelection()?.anchorNode?.parentElement?.closest('p')?.textContent || ''`)
    check('6b 再往下:越过嵌入落到下一段,源码收起', !!off && !off.revealed && !off.src.includes('![[') && off.embed && at.includes('嵌入之后'), JSON.stringify({ off, 光标所在段: at }))

    console.log(`\n截图:${shot('split')} / ${shot('menu')} / ${shot('source')}`)
  } finally {
    await app.close().catch(() => {})
  }
  const ok = results.filter((r) => r.ok).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
