/**
 * 真 Electron:附件磁贴(B2)+ 长提问折叠(C2)。npx electron-vite build && npm run check:attachfold
 * SHOTS=<目录> 时另存几张 110% 缩放的截图(和方案页 round2.html 对照用)。
 * 方案页:docs/ToBeImproved/借鉴Claude设计系统方案_2026-10-17/round2.html
 */
const fs = require('fs')
const path = require('path')
const assert = require('node:assert/strict')
const zlib = require('zlib')
const { launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

let count = 0
function check(name, ok, detail) { assert.ok(ok, `${name}: ${JSON.stringify(detail)}`); console.log(`PASS ${name}`); count++ }

// 纯色 PNG(不依赖图片库):宽 w 高 h,一行一个 filter 字节
function png(w, h, [r, g, b]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}
const IMG = [png(320, 200, [40, 40, 44]), png(300, 200, [238, 236, 232]), png(320, 180, [120, 150, 125])].map((b) => b.toString('base64'))

const SID = 'attach-fold'
const T = Date.UTC(2026, 9, 17, 9)
const LOG = Array.from({ length: 36 }, (_, i) => `[2026-10-16 17:00:${String(i).padStart(2, '0')}] step ${i + 1} ok`)
const LONG = ['周报又没发出去，下面是日志：', ...LOG].join('\n') // 37 行
const XLSX = { name: '周报发送记录-2026年10月第三周-团队汇总版.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: 'UEsDBAo=', size: 18432 }
const messages = [
  { id: 'u1', role: 'user', content: LONG, timestamp: T, attachments: [
    { name: 'terminal.png', mimeType: 'image/png', data: IMG[0], size: 5000 },
    { name: 'mail.png', mimeType: 'image/png', data: IMG[1], size: 5000 },
    { name: 'chart.png', mimeType: 'image/png', data: IMG[2], size: 5000 },
    XLSX,
  ] },
  { id: 'a1', role: 'model', content: '看到了，是密码变量改了名字。', timestamp: T + 1000 },
  { id: 'u2', role: 'user', content: '好，改吧。', timestamp: T + 2000 },
  { id: 'u3', role: 'user', content: '', timestamp: T + 3000, attachments: [{ name: 'only.png', mimeType: 'image/png', data: IMG[2], size: 5000 }] },
  { id: 'a3', role: 'model', content: '收到截图。', timestamp: T + 4000 },
]
const SESSION = { id: SID, title: '附件与长提问', summary: '', model_id: 'm1', archived: false, agent_config: null, projectless: true, created_at: '2026-10-17 09:00:00', updated_at: '2026-10-17 09:10:00' }

async function main() {
  const ctx = await launch({ tag: 'attach-fold', fixtures: { agents: [], sessions: [SESSION] }, messages })
  const shots = process.env.SHOTS
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const { win } = ctx
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    await win.locator(`.t2s-srow[data-sel-id="${SID}"]`).first().click()
    await win.locator('#tocmsg-u1 .t2-user').waitFor()
    await win.evaluate(() => document.fonts.ready)
    const shot = async (name) => {
      if (!shots) return
      await win.evaluate(() => { document.documentElement.style.setProperty('--uiz', '1.1'); document.body.style.zoom = '1.1' })
      await win.waitForTimeout(300)
      await win.screenshot({ path: path.join(shots, `${name}.png`), scale: 'css' })
      await win.evaluate(() => { document.documentElement.style.removeProperty('--uiz'); document.body.style.zoom = '' })
    }

    // ── B2:已发消息的附件在气泡上方 ──
    const atts = await win.evaluate(() => {
      const w = document.querySelector('#tocmsg-u1')
      const a = w.querySelector('.t2-user-atts'), b = w.querySelector('.t2-user')
      const rows = [...a.querySelectorAll('.t2-user-atts-row')].map((r) => [...r.children].map((c) => c.className))
      const img = a.querySelector('.att-tile--img img').getBoundingClientRect()
      return {
        above: !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), rows,
        img: [Math.round(img.width), Math.round(img.height)],
        tail: a.querySelector('.att-tile-tail')?.textContent, sub: a.querySelector('.att-tile-sub')?.textContent,
        badge: a.querySelector('.att-tile-badge')?.dataset.kind, oldGrid: !!w.querySelector('.msg-attach-grid'),
        rightAligned: Math.abs(a.getBoundingClientRect().right - b.getBoundingClientRect().right) < 1,
      }
    })
    check('附件在气泡上方', atts.above && !atts.oldGrid, atts)
    check('图片一行在前、文件一行在后', atts.rows.length === 2 && atts.rows[0].length === 3 && atts.rows[0].every((c) => c.includes('att-tile--img')) && atts.rows[1][0].includes('att-tile--file'), atts.rows)
    check('消息里图片方块 120px', atts.img[0] === 120 && atts.img[1] === 120, atts.img)
    check('文件名中间省略、保住扩展名', atts.tail === '队汇总版.xlsx' && /^XLSX · 18\.0 KB$/.test(atts.sub) && atts.badge === 'sheet', atts)
    check('附件与气泡右对齐', atts.rightAligned, atts)
    const u3 = await win.evaluate(() => ({ bubble: !!document.querySelector('#tocmsg-u3 .t2-user'), atts: document.querySelectorAll('#tocmsg-u3 .att-tile').length }))
    check('只有附件没写字:不摆空气泡', !u3.bubble && u3.atts === 1, u3)

    // ── C2:长提问折叠 ──
    const fold = () => win.evaluate(() => {
      const f = document.querySelector('#tocmsg-u1 .t2-user-fold'), m = document.querySelector('#tocmsg-u1 .t2-user-more')
      return { folded: f.hasAttribute('data-folded'), h: Math.round(f.getBoundingClientRect().height), btn: m?.textContent, expanded: m?.getAttribute('aria-expanded') }
    })
    let f = await fold()
    check('长提问收起到 300px', f.folded && f.h <= 300 && f.h >= 290, f)
    check('「展开全文 · 共 37 行」', f.btn === '展开全文 · 共 37 行' && f.expanded === 'false', f)
    const short = await win.evaluate(() => ({ more: !!document.querySelector('#tocmsg-u2 .t2-user-more'), folded: !!document.querySelector('#tocmsg-u2 [data-folded]') }))
    check('短消息不折', !short.more && !short.folded, short)
    await win.locator('#tocmsg-u1').scrollIntoViewIfNeeded()
    await shot('fold-collapsed')
    await win.locator('#tocmsg-u1 .t2-user-fold-hit').click()
    f = await fold()
    check('点淡出那一截展开', !f.folded && f.h > 700 && f.btn === '收起' && f.expanded === 'true', f)
    await shot('fold-expanded')
    await win.locator('#tocmsg-u1 .t2-user-more').click()
    f = await fold()
    check('点「收起」回到折叠', f.folded && f.h <= 300, f)

    // ── B2:输入卡里的磁贴 ──
    await win.evaluate(({ imgs }) => {
      const ta = document.querySelector('.t2c-card .t2c-ta')
      const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes(imgs[0])], 'terminal.png', { type: 'image/png' }))
      dt.items.add(new File([bytes(imgs[1])], 'mail.png', { type: 'image/png' }))
      ta.focus()
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, { imgs: IMG })
    await win.locator('.t2c-tilerow .att-tile--img').nth(1).waitFor()
    const tiles = await win.evaluate(() => {
      const row = document.querySelector('.t2c-tilerow')
      const img = row.querySelector('.att-tile--img img').getBoundingClientRect()
      const x = getComputedStyle(row.querySelector('.att-tile-x'))
      return { n: row.querySelectorAll('.att-tile').length, img: [Math.round(img.width), Math.round(img.height)], xOpacity: x.opacity, oldChip: !!document.querySelector('.t2c-chiprow:not(.t2c-refrow) .attach-chip') }
    })
    check('输入卡里图片是 56px 方块、旧芯片不再出现', tiles.n === 2 && tiles.img[0] === 56 && tiles.img[1] === 56 && !tiles.oldChip, tiles)
    check('移除钮平时藏着', tiles.xOpacity === '0', tiles)
    await win.locator('.t2c-tilerow .att-tile').nth(1).hover()
    await win.waitForTimeout(250)
    const hov = await win.evaluate(() => getComputedStyle(document.querySelectorAll('.t2c-tilerow .att-tile')[1].querySelector('.att-tile-x')).opacity)
    check('悬停出移除钮', hov === '1', hov)
    await shot('composer-hover')
    await win.locator('.t2c-tilerow .att-tile').nth(1).locator('.att-tile-x').click()
    const mid = await win.evaluate(() => document.querySelectorAll('.t2c-tilerow .att-tile.is-leaving').length)
    await win.waitForTimeout(300)
    const after = await win.evaluate(() => [...document.querySelectorAll('.t2c-tilerow .att-tile img')].map((i) => i.alt))
    check('移除:先缩小淡出,再删掉的是点的那张', mid === 1 && after.length === 1 && after[0] === 'terminal.png', { mid, after })

    // 同名两张图删掉第一张:第二张不能接手它的淡出状态(按名字 + 下标给 key 时会,Codex P1)
    await win.evaluate(({ imgs }) => {
      const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes(imgs[1])], 'same.png', { type: 'image/png' }))
      dt.items.add(new File([bytes(imgs[2])], 'same.png', { type: 'image/png' }))
      document.querySelector('.t2c-card .t2c-ta').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, { imgs: IMG })
    await win.locator('.t2c-tilerow .att-tile').nth(2).waitFor()
    await win.locator('.t2c-tilerow .att-tile').nth(1).hover()
    await win.locator('.t2c-tilerow .att-tile').nth(1).locator('.att-tile-x').click()
    await win.waitForTimeout(300)
    const same = await win.evaluate(() => [...document.querySelectorAll('.t2c-tilerow .att-tile')].map((t) => ({ alt: t.querySelector('img')?.alt, leaving: t.classList.contains('is-leaving'), op: getComputedStyle(t).opacity })))
    check('同名图删掉第一张,第二张照常显示', same.length === 2 && same.every((t) => !t.leaving && t.op === '1') && same[1].alt === 'same.png', same)

    // ── C2:搜索跳到折叠的长提问时展开 ──
    await win.evaluate(() => document.querySelector('#tocmsg-u2').scrollIntoView())
    const jumped = await win.evaluate(async (sid) => {
      const store = window.__forsionStore
      if (!store?.getState?.().setJumpTarget) return 'no-store'
      store.getState().setJumpTarget(sid, 'u1')
      await new Promise((r) => setTimeout(r, 600))
      return document.querySelector('#tocmsg-u1 .t2-user-fold').hasAttribute('data-folded') ? 'folded' : 'open'
    }, SID)
    if (jumped === 'no-store') console.log('SKIP 搜索跳转展开(页面上拿不到 store)')
    else check('搜索跳到长提问时展开', jumped === 'open', jumped)

    console.log(`\n${count} checks passed`)
  } finally { await ctx.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
