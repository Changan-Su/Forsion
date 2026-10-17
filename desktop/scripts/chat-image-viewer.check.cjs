/**
 * 真 Electron:看图(A2,components/ImageViewer.tsx)。npx electron-vite build && npm run check:imageviewer
 * SHOTS=<目录> 时另存 110% 缩放的截图(和方案页 round2.html §4 对照用)。
 * 没覆盖:触屏手势(双指缩放、左右滑、下拉关闭)—— Playwright 的 Electron 驱动给不出 pointerType=touch。
 */
const fs = require('fs')
const path = require('path')
const assert = require('node:assert/strict')
const zlib = require('zlib')
const { launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

let count = 0
function check(name, ok, detail) { assert.ok(ok, `${name}: ${JSON.stringify(detail)}`); console.log(`PASS ${name}`); count++ }

// 纯色 PNG,左上角一块深色(看得出放大 / 平移)
function png(w, h, [r, g, b]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x++) { const dark = x < w / 4 && y < h / 4; row[1 + x * 3] = dark ? 30 : r; row[2 + x * 3] = dark ? 30 : g; row[3 + x * 3] = dark ? 30 : b }
    rows.push(row)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}
const b64 = (buf) => buf.toString('base64')
const BIG = b64(png(1760, 1040, [70, 72, 80])) // Retina 截图大小:适应窗口时 < 100%
const MAIL = b64(png(720, 440, [236, 234, 230]))
const CHART = b64(png(760, 440, [120, 150, 125]))
const AGENT = b64(png(400, 300, [180, 140, 110]))

const SID = 'image-viewer'
const T = Date.UTC(2026, 9, 17, 9)
const messages = [
  { id: 'u1', role: 'user', content: '这几张截图帮我看看', timestamp: T, attachments: [
    { name: 'terminal.png', mimeType: 'image/png', data: BIG, size: 90000 },
    { name: 'mail.png', mimeType: 'image/png', data: MAIL, size: 20000 },
    { name: 'chart.png', mimeType: 'image/png', data: CHART, size: 20000 },
  ] },
  { id: 'a1', role: 'model', content: '我画了一张对比图。', timestamp: T + 1000, display_files: [{ name: 'agent.png', mime: 'image/png', dataUrl: `data:image/png;base64,${AGENT}` }] },
]
const SESSION = { id: SID, title: '看图', summary: '', model_id: 'm1', archived: false, agent_config: null, projectless: true, created_at: '2026-10-17 09:00:00', updated_at: '2026-10-17 09:10:00' }

async function main() {
  const ctx = await launch({ tag: 'image-viewer', fixtures: { agents: [], sessions: [SESSION] }, messages })
  const shots = process.env.SHOTS
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const { win, app } = ctx
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    await win.locator(`.t2s-srow[data-sel-id="${SID}"]`).first().click()
    await win.locator('#tocmsg-a1 .inline-file-img').waitFor()
    await win.evaluate(() => document.fonts.ready)
    // 截图按用户的 110% 拍;切缩放后等看图重新量完舞台(ResizeObserver)再读数
    const zoom110 = async (on) => { await win.evaluate((on) => { document.body.style.zoom = on ? '1.1' : '' }, on); await win.waitForTimeout(300) }
    const shot = async (name) => { if (shots) { await win.waitForTimeout(350); await win.screenshot({ path: path.join(shots, `${name}.png`), scale: 'css' }) } }
    const state = () => win.evaluate(() => {
      const iv = document.querySelector('.iv')
      if (!iv) return null
      const main = iv.querySelector('.iv-img:not(.is-side)')
      const r = main?.getBoundingClientRect()
      return {
        name: iv.querySelector('.iv-title b')?.textContent, count: iv.querySelector('.iv-title span')?.textContent,
        pct: iv.querySelector('.iv-zoom')?.textContent, zoomed: !!iv.querySelector('.iv-stage.is-zoomed'),
        role: iv.getAttribute('role'), sides: iv.querySelectorAll('.iv-img.is-side').length,
        main: r && [Math.round(r.width), Math.round(r.height)], shadow: main && getComputedStyle(main).boxShadow,
        alt: [...iv.querySelectorAll('.iv-tools .iv-btn')].map((b) => b.title).filter((t) => /标签页|打开文件/.test(t)),
        focusIn: iv.contains(document.activeElement),
      }
    })
    const closed = () => win.waitForFunction(() => !document.querySelector('.iv'), null, { timeout: 3000 })

    // ── 打开:点用户消息里的第二张 ──
    check('输入卡里待发的磁贴不开看图', await win.evaluate(() => !document.querySelector('.t2c-tilerow [data-viewable]')), null)
    await win.locator('#tocmsg-u1 .att-tile--img img').nth(1).click()
    await win.locator('.iv').waitFor()
    await win.waitForTimeout(400)
    let s = await state()
    check('点缩略图打开看图(对话里四张图,这是第二张)', s && s.role === 'dialog' && s.name === 'mail.png' && s.count === '2 / 4' && s.focusIn, s)
    check('左右邻图都露出来', s.sides === 2, s)
    check('小图适应窗口 = 100%(不放大超过原图)', s.pct === '100%' && s.main[0] === 720, s)

    // 点一下主图不关(指针一按下就被舞台捕获,松手时的 target 恒是舞台 —— 早先按它判「点在空处」,点主图也关了,Codex P1)
    const mainBox = await win.locator('.iv-img:not(.is-side)').boundingBox()
    await win.mouse.click(mainBox.x + mainBox.width / 2, mainBox.y + mainBox.height / 2)
    await win.waitForTimeout(500)
    s = await state()
    check('单击主图不关', s && s.name === 'mail.png', s)
    const sideBox = await win.locator('.iv-img.is-side[data-dir="1"]').boundingBox()
    await win.mouse.click(sideBox.x + 20, sideBox.y + sideBox.height / 2)
    await win.waitForTimeout(300)
    s = await state()
    check('点右边露出的邻图切过去', s && s.count === '3 / 4' && s.name === 'chart.png', s)
    for (let i = 0; i < 8; i++) await win.keyboard.press('Tab')
    await win.keyboard.press('Shift+Tab')
    check('Tab / ⇧Tab 圈在看图层里', await win.evaluate(() => document.querySelector('.iv').contains(document.activeElement)), null)
    await win.keyboard.press('ArrowLeft')

    // ── 切换 ──
    await win.keyboard.press('ArrowLeft')
    s = await state()
    check('← 切到上一张;大图适应窗口时 < 100%', s.count === '1 / 4' && s.name === 'terminal.png' && parseInt(s.pct) < 100 && s.sides === 1, s)
    await win.keyboard.press('ArrowLeft')
    check('第一张再 ← 不动', (await state()).count === '1 / 4', null)
    for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowRight')
    s = await state()
    check('→ 一路到 Agent 发的图,顶栏多「在标签页打开」', s.count === '4 / 4' && s.name === 'agent.png' && s.alt.length === 1, s)
    await win.keyboard.press('ArrowLeft'); await win.keyboard.press('ArrowLeft'); await win.keyboard.press('ArrowLeft')
    if (shots) { await zoom110(true); await shot('viewer-open'); await zoom110(false) }

    // ── 缩放 ──
    const fitPct = parseInt((await state()).pct)
    await win.keyboard.press('+')
    s = await state()
    check('+ 放大一档(×1.25),进入放大态', s.zoomed && Math.abs(parseInt(s.pct) - Math.round(fitPct * 1.25)) <= 1 && s.sides === 0, { fitPct, s })
    await win.keyboard.press('0')
    s = await state()
    check('0 回到适应窗口', !s.zoomed && parseInt(s.pct) === fitPct, s)
    const stage = await win.locator('.iv-stage').boundingBox()
    await win.mouse.move(stage.x + stage.width * 0.3, stage.y + stage.height * 0.3)
    for (let i = 0; i < 4; i++) { await win.mouse.wheel(0, -120); await win.waitForTimeout(40) }
    s = await state()
    check('滚轮放大', s.zoomed && parseInt(s.pct) > fitPct, s)
    const before = await win.evaluate(() => document.querySelector('.iv-img:not(.is-side)').getBoundingClientRect().left)
    await win.mouse.down(); await win.mouse.move(stage.x + stage.width * 0.3 + 80, stage.y + stage.height * 0.3 + 10, { steps: 5 }); await win.mouse.up()
    const after = await win.evaluate(() => document.querySelector('.iv-img:not(.is-side)').getBoundingClientRect().left)
    check('放大后拖动平移', Math.abs(after - before - 80) <= 2 || after === 0, { before, after })
    if (shots) { await zoom110(true); await win.keyboard.press('0'); await win.keyboard.press('+'); await win.keyboard.press('+'); await win.keyboard.press('+'); await shot('viewer-zoomed'); await zoom110(false) }
    await win.mouse.dblclick(stage.x + stage.width / 2, stage.y + stage.height / 2)
    s = await state()
    check('双击回到适应窗口', !s.zoomed, s)
    await win.mouse.dblclick(stage.x + stage.width / 2, stage.y + stage.height / 2)
    s = await state()
    check('再双击到 100%', s.zoomed && s.pct === '100%', s)

    // ── 关闭 ──
    await win.keyboard.press('Escape')
    await closed()
    const focus = await win.evaluate(() => ({ viewable: document.activeElement?.hasAttribute('data-viewable'), alt: document.activeElement?.getAttribute('alt') }))
    check('Esc 关闭,焦点回到缩略图', focus.viewable && focus.alt === 'terminal.png', focus)
    await win.keyboard.press('Enter')
    await win.locator('.iv').waitFor()
    check('缩略图上按回车打开', (await state()).name === 'terminal.png', null)
    const back = await win.evaluate(() => {
      const probe = !window.dispatchEvent(new CustomEvent('forsion:mobile-back', { cancelable: true, detail: { probe: true } }))
      const still = !!document.querySelector('.iv')
      const taken = !window.dispatchEvent(new Event('forsion:mobile-back', { cancelable: true }))
      return { probe, still, taken }
    })
    await closed()
    check('手机返回:先答「我接」,真返回时关闭看图', back.probe && back.still && back.taken, back)
    await win.locator('#tocmsg-a1 .inline-file-img').click()
    await win.locator('.iv').waitFor()
    await win.waitForTimeout(300)
    check('Agent 回复里的图也就地打开(不再直接开标签页)', (await state()).name === 'agent.png', null)
    await win.mouse.click(stage.x + 30, stage.y + stage.height - 60)
    await closed()
    check('点空处关闭', true, null)

    // ── 深色 ──
    await win.evaluate(() => document.documentElement.classList.add('dark'))
    await win.locator('#tocmsg-u1 .att-tile--img img').first().click()
    await win.locator('.iv').waitFor()
    await win.waitForTimeout(400)
    s = await state()
    check('深色下图片不加阴影', s.shadow === 'none', s)
    if (shots) { await zoom110(true); await shot('viewer-dark'); await zoom110(false) }
    await win.keyboard.press('Escape'); await closed()
    await win.evaluate(() => document.documentElement.classList.remove('dark'))

    // ── 窄窗:顶栏只留名字、计数、更多、关闭 ──
    // 主窗最窄 880:靠界面缩放把舞台压到 600 CSS px 以下(手机壳本来就是 body zoom 1.15 + 窄屏)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 820))
    await win.evaluate(() => { document.body.style.zoom = '1.7' })
    await win.waitForTimeout(600)
    await win.locator('#tocmsg-u1 .att-tile--img img').first().click()
    await win.locator('.iv').waitFor()
    await win.waitForTimeout(400)
    const narrow = await win.evaluate(() => ({ compact: !!document.querySelector('.iv.is-compact'), zoomUi: !!document.querySelector('.iv-zoom'), arrows: document.querySelectorAll('.iv-arrow').length, more: !!document.querySelector('.iv-more') }))
    check('窄窗:收起缩放按钮和箭头,留「更多」', narrow.compact && !narrow.zoomUi && narrow.arrows === 0 && narrow.more, narrow)
    await win.locator('.iv-more .iv-btn').click()
    const items = await win.evaluate(() => [...document.querySelectorAll('.iv-menu button')].map((b) => b.textContent))
    check('「更多」里是复制、下载', items.length === 2 && items[0] === '复制图片' && items[1] === '下载', items)
    if (shots) await shot('viewer-compact')
    await win.keyboard.press('Escape')
    check('Esc 先关「更多」菜单', await win.evaluate(() => !!document.querySelector('.iv') && !document.querySelector('.iv-menu')), null)
    await win.keyboard.press('Escape'); await closed()

    console.log(`\n${count} checks passed`)
  } finally { await ctx.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
