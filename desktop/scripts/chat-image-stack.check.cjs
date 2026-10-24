/**
 * 真 Electron:多图叠成一摞(components/ImageStack.tsx,借鉴 Comma §2.5)。npx electron-vite build && npm run check:imagestack
 * 钉:5 张叠、3 张平铺;只露 3 张、右边露边;悬停才出翻页、两头禁用;往后翻时翻过的那张往左飞再落进左边那摞;
 *     点开看图器从当前那张开始、关闭后这摞翻到看到的那张;减少动态效果时不飞;左右滑翻页且不误开看图;深色药丸跟 token。
 * SHOTS=<目录> 时另存亮 / 暗 / 翻到中间 / 窄栏截图(DESIGN §8 自查用)。
 * 没覆盖:真触屏手势 —— Playwright 的 Electron 驱动给不出 pointerType=touch,滑动用合成的 PointerEvent 代替。
 */
const fs = require('fs')
const path = require('path')
const assert = require('node:assert/strict')
const zlib = require('zlib')
const { launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

let count = 0
function check(name, ok, detail) { assert.ok(ok, `${name}: ${JSON.stringify(detail)}`); console.log(`PASS ${name}`); count++ }

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
const img = (name, rgb) => ({ name, mimeType: 'image/png', data: png(640, 420, rgb).toString('base64'), size: 30000 })
const FIVE = [img('a.png', [200, 120, 110]), img('b.png', [120, 170, 130]), img('c.png', [110, 140, 200]), img('d.png', [210, 190, 110]), img('e.png', [160, 120, 190])]
const THREE = [img('x.png', [150, 150, 150]), img('y.png', [180, 160, 140]), img('z.png', [140, 170, 180])]

const SID = 'image-stack'
const T = Date.UTC(2026, 9, 24, 9)
const messages = [
  { id: 'u1', role: 'user', content: '这五张截图帮我对一下', timestamp: T, attachments: FIVE },
  { id: 'a1', role: 'model', content: '好的。', timestamp: T + 1000 },
  { id: 'u2', role: 'user', content: '再看这三张', timestamp: T + 2000, attachments: THREE },
  { id: 'a2', role: 'model', content: '看过了。', timestamp: T + 3000 },
]
const SESSION = { id: SID, title: '叠图', summary: '', model_id: 'm1', archived: false, agent_config: null, projectless: true, created_at: '2026-10-24 09:00:00', updated_at: '2026-10-24 09:10:00' }

async function main() {
  const ctx = await launch({ tag: 'image-stack', fixtures: { agents: [], sessions: [SESSION] }, messages })
  const shots = process.env.SHOTS
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const { win, app } = ctx
  try {
    await boot(app, win, { space: 'tangu', width: 1400, height: 950 }); await enterSpace(win, 'tangu')
    await win.locator(`.t2s-srow[data-sel-id="${SID}"]`).first().click()
    await win.locator('#tocmsg-u1 .img-stack').waitFor()
    await win.evaluate(() => document.fonts.ready)
    const shot = async (name) => {
      if (!shots) return
      await win.waitForTimeout(400)
      const b = await win.locator('#tocmsg-u1').boundingBox()
      await win.screenshot({ path: path.join(shots, `${name}.png`), clip: { x: b.x - 40, y: b.y - 16, width: b.width + 56, height: b.height + 32 } })
    }
    // 每张卡:名字、可见与否、几何、层级;front = 最上面那张
    const state = () => win.evaluate(() => {
      const st = document.querySelector('#tocmsg-u1 .img-stack')
      const sr = st.getBoundingClientRect()
      const cards = [...st.querySelectorAll('.img-stack-card')].map((c) => {
        const r = c.getBoundingClientRect(); const cs = getComputedStyle(c)
        return { name: c.querySelector('img').alt, op: +cs.opacity, z: +cs.zIndex, l: Math.round(r.left - sr.left), r: Math.round(r.right - sr.left), w: Math.round(r.width), hidden: c.hasAttribute('aria-hidden'), anims: c.getAnimations().length }
      })
      const nav = (d) => { const b = st.querySelector(`.img-stack-nav[data-dir="${d}"]`); return { dis: b.disabled, op: +getComputedStyle(b).opacity } }
      const front = cards.reduce((a, c) => (c.z > a.z ? c : a))
      return { front: front.name, frontIdx: +st.dataset.front, cards, visible: cards.filter((c) => c.op > 0.01).length, pill: st.querySelector('.img-stack-count')?.textContent, prev: nav('prev'), next: nav('next'), w: Math.round(sr.width) }
    })
    const settle = () => win.waitForTimeout(450)
    const stack = win.locator('#tocmsg-u1 .img-stack')

    // ── 阈值 ──
    let s = await state()
    check('5 张叠成一摞,5 张图都在 DOM 里(看图器按 DOM 收图)', s.cards.length === 5 && s.pill === '5 张', s)
    check('只露 3 张:最上面 a + 右边露边两张', s.visible === 3 && s.front === 'a.png' && s.cards.filter((c) => !c.hidden).length === 1, s.cards)
    const [c0, c1, c2] = s.cards
    check('右边两层各多露 ~7px、不旋转(宽度按缩放比)', Math.abs(c1.r - c0.r - 7) <= 1 && Math.abs(c2.r - c0.r - 14) <= 1 && c1.w < c0.w && c2.w < c1.w, { c0, c1, c2 })
    const flat = await win.evaluate(() => ({ stack: !!document.querySelector('#tocmsg-u2 .img-stack'), tiles: document.querySelectorAll('#tocmsg-u2 .t2-user-atts-row .att-tile--img img').length }))
    check('3 张照旧平铺', !flat.stack && flat.tiles === 3, flat)
    await shot('stack-light')

    // ── 翻页 ──
    check('没悬停时不出翻页', s.prev.op === 0 && s.next.op === 0, s)
    await stack.hover()
    await win.waitForTimeout(200)
    s = await state()
    check('悬停出「下一张」;在第一张时「上一张」禁用且不显示', s.next.op === 1 && !s.next.dis && s.prev.dis && s.prev.op === 0, s)
    // 页面里点、逐帧量:飞行期间 a 的左缘最远到哪、是不是一直压在最上面
    const flight = await win.evaluate(() => new Promise((done) => {
      const st = document.querySelector('#tocmsg-u1 .img-stack')
      const card = st.querySelector('.img-stack-card')
      const left = () => card.getBoundingClientRect().left - st.getBoundingClientRect().left
      const t0 = performance.now(); let minL = Infinity, anims = 0, zTop = false
      st.querySelector('.img-stack-nav[data-dir="next"]').click()
      const tick = () => {
        const t = performance.now() - t0
        minL = Math.min(minL, left()); anims = Math.max(anims, card.getAnimations().length)
        if (t < 100 && +getComputedStyle(card).zIndex === 20) zTop = true
        if (t < 360) requestAnimationFrame(tick); else done({ minL: Math.round(minL), anims, zTop })
      }
      requestAnimationFrame(tick)
    }))
    check('往后翻:翻过的那张在飞(WAAPI)、先压在最上面、往左甩出这一摞的左缘', flight.anims > 0 && flight.zTop && flight.minL < -60, flight)
    await settle()
    s = await state()
    check('落定:b 到最上面,a 在左边露边 ~7px', s.front === 'b.png' && s.frontIdx === 1 && Math.abs((s.cards[1].l - s.cards[0].l) - 7) <= 1 && s.cards[0].op === 1 && s.visible === 4, s.cards)
    check('翻过一页后「上一张」可用', !s.prev.dis && s.prev.op === 1, s.prev)
    // 翻过去马上翻回来(还在飞):甩出动画要停掉,a 回到最上面不弹走(Codex P2)
    // 每下单独一个任务(真点击就是这样;同一段同步代码里连点两下,React 18 还没把第一下落进 DOM)
    const tap = (dir) => win.evaluate((dir) => document.querySelector(`#tocmsg-u1 .img-stack-nav[data-dir="${dir}"]`).click(), dir)
    await tap('prev'); await settle()
    await tap('next')
    await win.waitForTimeout(60)
    await tap('prev')
    await settle()
    s = await state()
    check('翻过去 60ms 内翻回:a 停在最上面、没有残留的甩出动画', s.front === 'a.png' && s.cards[0].anims === 0 && s.cards[0].l === 14, s.cards)
    await tap('next')
    await settle()
    await shot('stack-paged')
    for (let i = 0; i < 3; i++) { await stack.locator('.img-stack-nav[data-dir="next"]').click(); await win.waitForTimeout(80) } // 连点:前一张还在飞
    await settle()
    s = await state()
    check('翻到最后一张就停、「下一张」禁用(不循环)', s.front === 'e.png' && s.next.dis && s.visible === 3, s)
    await stack.locator('.img-stack-nav[data-dir="prev"]').click()
    await settle()
    s = await state()
    check('「上一张」翻回 d', s.front === 'd.png', s)

    // ── 看图器 ──
    await stack.locator('.img-stack-card:not([aria-hidden]) img').click()
    await win.locator('.iv').waitFor()
    await win.waitForTimeout(400)
    const iv = () => win.evaluate(() => ({ name: document.querySelector('.iv-title b')?.textContent, count: document.querySelector('.iv-title span')?.textContent }))
    let v = await iv()
    check('点开进看图器,从当前那张开始(对话里共 8 张)', v.name === 'd.png' && v.count === '4 / 8', v)
    await win.keyboard.press('ArrowLeft'); await win.keyboard.press('ArrowLeft')
    v = await iv()
    check('看图器里 ← 翻到 b', v.name === 'b.png' && v.count === '2 / 8', v)
    await win.keyboard.press('Escape')
    await win.waitForFunction(() => !document.querySelector('.iv'), null, { timeout: 3000 })
    await settle()
    s = await state()
    check('关掉看图器,这摞翻到刚看的 b', s.front === 'b.png' && (await win.evaluate(() => document.activeElement?.getAttribute('alt'))) === 'b.png', s.front)

    // ── 手机:左右滑(合成 touch PointerEvent)──
    const swipe = (dx) => win.evaluate((dx) => {
      const el = document.querySelector('#tocmsg-u1 .img-stack-card:not([aria-hidden]) img')
      const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2
      const ev = (type, cx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: y }))
      ev('pointerdown', x); ev('pointerup', x + dx)
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x + dx, clientY: y }))
    }, dx)
    await win.mouse.move(5, 5)
    await swipe(-60); await settle()
    s = await state()
    check('左滑 = 下一张,滑完那下 click 不开看图', s.front === 'c.png' && !(await win.locator('.iv').count()), s.front)
    await swipe(60); await settle()
    check('右滑 = 上一张', (await state()).front === 'b.png', null)
    await swipe(12)
    await win.locator('.iv').waitFor()
    check('滑不够 32px = 点按:不翻、照常开看图', (await state()).front === 'b.png', null)
    await win.keyboard.press('Escape')
    await win.waitForFunction(() => !document.querySelector('.iv'), null, { timeout: 3000 })

    // ── 减少动态效果 ──
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await stack.hover()
    await stack.locator('.img-stack-nav[data-dir="next"]').click()
    s = await state()
    check('减少动态效果:不飞、不过渡,直接落定', s.front === 'c.png' && s.cards.every((c) => c.anims === 0), s.cards)
    await win.emulateMedia({ reducedMotion: 'no-preference' })

    // ── 深色:药丸 / 翻页钮跟 token ──
    const pill = () => win.evaluate(() => { const p = document.querySelector('#tocmsg-u1 .img-stack-count'); const cs = getComputedStyle(p); return { bg: cs.backgroundColor, fg: cs.color } })
    const light = await pill()
    await win.evaluate(() => document.documentElement.classList.add('dark'))
    await win.waitForTimeout(200)
    const dark = await pill()
    check('深色下药丸底色 / 字色跟着变(token,不是写死的黑底白字)', light.bg !== dark.bg && light.fg !== dark.fg, { light, dark })
    await stack.hover()
    await shot('stack-dark')
    await win.evaluate(() => document.documentElement.classList.remove('dark'))
    await win.mouse.move(5, 5)

    // ── 窄栏:卡片跟 --att-tile 缩到 96px 那档 ──
    // 照 check:messageactions:直接把聊天 View 压到 420px,触发 chat2.css 的 520px 容器断点
    await win.evaluate(() => { document.querySelector('.t2-chat-view').style.width = '420px' })
    await win.waitForTimeout(600)
    const narrow = await win.evaluate(() => ({
      tile: getComputedStyle(document.querySelector('#tocmsg-u1 .t2-user-atts')).getPropertyValue('--att-tile').trim(),
      w: Math.round(document.querySelector('#tocmsg-u1 .img-stack-card:not([aria-hidden])').offsetWidth),
    }))
    check('窄栏(--att-tile 96px 那档):最上面那张跟着缩到 96 × 1.8 ≈ 173px', narrow.tile === '96px' && Math.abs(narrow.w - 173) <= 1, narrow)
    await shot('stack-narrow')

    console.log(`\n${count} checks passed`)
  } finally { await ctx.close() }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
