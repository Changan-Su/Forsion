/**
 * 真 Electron:生图多张与标注改图(1B 主图 + 缩略条、2B 看图器标注修改、1C 看图器「全部图片」多选一起改)。npx electron-vite build && npm run check:imagemarkup
 * 方案页:仓根 docs/ToBeImproved/生图多张与标注改图方案_2026-11-23/。SHOTS=<目录> 时另存 110% 缩放的截图(亮 / 暗)对照方案图。
 * 断言:只给带 source 的生图产出成组(截图照旧逐张);缩略条切主图;主图「标注修改」直接进标注态;圈 / 点 / Esc 删刚落下的 /
 *   ⌘Z ⇧⌘Z;标注态里 ← → 不切图、点空白不关、滚轮缩放;有标记时 Esc 先问;发送后假引擎收到「原图 + 标注副本」两件附件和编号清单;
 *   1C:G 进网格、多选、网格里逐张标注(收集模式,完成回网格)、一起发 → 「分别改下面 N 张图」+ 附件按图序(带标注的紧跟副本)、Esc 回单张;
 *   「用这张继续」进输入框附件;「再来 N 张」发出一句。
 * 没覆盖:触屏(单指画、双指缩放)—— Playwright 的 Electron 驱动给不出 pointerType=touch。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

const results = []
function check(name, ok, detail) { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + JSON.stringify(detail) : ''}`) }

// 带一块圆的渐变 PNG(看得出是哪张、放大后看得出平移)
function png(w, h, [r, g, b], [cx, cy]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = []
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3)
    for (let x = 0; x < w; x++) {
      const t = y / h, inC = Math.hypot(x - cx * w, y - cy * h) < w * 0.16
      row[1 + x * 3] = inC ? 250 : Math.round(r * (1 - t * 0.35)); row[2 + x * 3] = inC ? 214 : Math.round(g * (1 - t * 0.35)); row[3 + x * 3] = inC ? 150 : Math.round(b * (1 - t * 0.35))
    }
    rows.push(row)
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
}
const url = (buf) => `data:image/png;base64,${buf.toString('base64')}`
const GEN = [
  url(png(640, 640, [196, 170, 140], [0.5, 0.32])),
  url(png(640, 640, [150, 170, 196], [0.36, 0.5])),
  url(png(640, 640, [190, 150, 120], [0.62, 0.6])),
]
const SHOT = url(png(480, 300, [220, 220, 216], [0.2, 0.3]))

const SID = 'image-markup'
const T = Date.UTC(2026, 10, 23, 9)
const messages = [
  { id: 'u1', role: 'user', content: '画 3 张窗边打盹的橘猫，每张光线不一样。', timestamp: T },
  { id: 'a1', role: 'model', content: '三张窗边打盹的橘猫，分别是晨光、阴天和黄昏。', timestamp: T + 1000,
    display_files: GEN.map((dataUrl, i) => ({ name: `image-7a03-${i + 1}.png`, mime: 'image/png', dataUrl, source: 'generate_image' })) },
  { id: 'u2', role: 'user', content: '截两张图给我看看', timestamp: T + 2000 },
  { id: 'a2', role: 'model', content: '这是两张截图。', timestamp: T + 3000,
    display_files: [{ name: 'shot-1.png', mime: 'image/png', dataUrl: SHOT }, { name: 'shot-2.png', mime: 'image/png', dataUrl: SHOT }] },
]
const SESSION = { id: SID, title: '生图多张', summary: '', model_id: 'm1', archived: false, agent_config: null, projectless: true, created_at: '2026-11-23 09:00:00', updated_at: '2026-11-23 09:10:00' }

async function main() {
  const ctx = await launch({ tag: 'image-markup', fixtures: { agents: [], sessions: [SESSION] }, messages })
  const shots = process.env.SHOTS
  if (shots) fs.mkdirSync(shots, { recursive: true })
  const { win, app, stub } = ctx
  const zoom110 = async (on) => { await win.evaluate((on) => { document.body.style.zoom = on ? '1.1' : '' }, on); await win.waitForTimeout(350) }
  const shot = async (name) => { if (shots) { await win.waitForTimeout(350); await win.screenshot({ path: path.join(shots, `${name}.png`), scale: 'css' }) } }
  const lastRun = () => stub.seen.runs[stub.seen.runs.length - 1]
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    await win.locator(`.t2s-srow[data-sel-id="${SID}"]`).first().click()
    await win.locator('#tocmsg-a1 .inline-set-thumb img').nth(2).waitFor()
    await win.evaluate(() => document.fonts.ready)

    // ── 1B:成组只认生图产出
    const set = await win.evaluate(() => ({
      thumbs: document.querySelectorAll('#tocmsg-a1 .inline-set-thumb').length,
      count: document.querySelector('#tocmsg-a1 .inline-set-count')?.textContent,
      shotsGrouped: document.querySelectorAll('#tocmsg-a2 .inline-set').length,
      shotImgs: document.querySelectorAll('#tocmsg-a2 .inline-file-img').length,
      links: [...document.querySelectorAll('#tocmsg-a1 .inline-set-link')].map((b) => b.textContent),
    }))
    check('1B 三张生图 = 主图 + 3 格缩略条,1 / 3', set.thumbs === 3 && set.count === '1 / 3', set)
    check('1B 截图(没有 source)不成组,照旧两张缩略图', set.shotsGrouped === 0 && set.shotImgs === 2, set)
    check('1B 下面一行有「用这张继续」「再来 3 张」', set.links.some((t) => t.includes('用这张继续')) && set.links.some((t) => t.includes('再来 3 张')), set.links)
    await win.locator('#tocmsg-a1 .inline-set-thumb').nth(1).click()
    const picked = await win.evaluate(() => ({
      count: document.querySelector('#tocmsg-a1 .inline-set-count')?.textContent,
      on: [...document.querySelectorAll('#tocmsg-a1 .inline-set-thumb')].map((b) => b.classList.contains('is-on')),
      same: document.querySelector('#tocmsg-a1 .inline-set-main img')?.getAttribute('src') === document.querySelectorAll('#tocmsg-a1 .inline-set-thumb img')[1]?.getAttribute('src'),
      ring: getComputedStyle(document.querySelectorAll('#tocmsg-a1 .inline-set-thumb')[1]).boxShadow,
    }))
    check('1B 点第 2 格:主图换成它、2 / 3、这格描选中框', picked.count === '2 / 3' && picked.on.join() === 'false,true,false' && picked.same && /2px/.test(picked.ring), picked)
    if (shots) {
      await zoom110(true)
      await win.locator('#tocmsg-a1 .inline-set').evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await shot('1b-set-light')
      await win.evaluate(() => document.documentElement.classList.add('dark')); await shot('1b-set-dark'); await win.evaluate(() => document.documentElement.classList.remove('dark'))
      await zoom110(false)
    }

    // 点主图 = 看图器,列表按缩略图收(3 张生图 + 2 张截图),从第 2 张开
    await win.locator('#tocmsg-a1 .inline-set-main img').click()
    await win.locator('.iv').waitFor()
    await win.waitForTimeout(400)
    const iv = await win.evaluate(() => ({ count: document.querySelector('.iv-title span')?.textContent, acts: [...document.querySelectorAll('.iv-act')].map((b) => b.textContent) }))
    check('看图器从主图打开:2 / 5,顶栏有「标注修改」「用这张继续」', iv.count === '2 / 5' && iv.acts.join('|') === '标注修改|用这张继续', iv)
    await win.keyboard.press('ArrowRight'); await win.waitForTimeout(250)
    const shotIv = await win.evaluate(() => ({ count: document.querySelector('.iv-title span')?.textContent, acts: document.querySelectorAll('.iv-act').length }))
    await win.keyboard.press('ArrowRight'); await win.waitForTimeout(250)
    const shotIv2 = await win.evaluate(() => ({ count: document.querySelector('.iv-title span')?.textContent, acts: document.querySelectorAll('.iv-act').length }))
    check('截图也能标注修改(edit 跟会话走)', shotIv2.count === '4 / 5' && shotIv2.acts === 2, { shotIv, shotIv2 })
    await win.keyboard.press('Escape'); await win.waitForTimeout(600)

    // ── 2B:主图悬停「标注修改」直接进标注态
    await win.locator('#tocmsg-a1 .inline-set-main').hover()
    await win.locator('#tocmsg-a1 .inline-set-act').click()
    await win.locator('.imk').waitFor()
    await win.waitForTimeout(400)
    const head = await win.evaluate(() => ({
      title: document.querySelector('.imk-bar .iv-title span')?.textContent,
      ivBarHidden: getComputedStyle(document.querySelector('.iv > .iv-bar')).visibility,
      imkBarShown: getComputedStyle(document.querySelector('.imk-bar')).visibility,
      tools: [...document.querySelectorAll('.imk-tool[aria-pressed]')].map((b) => b.getAttribute('aria-pressed')),
    }))
    check('主图「标注修改」直接进标注态:标的是第 2 张,看图器顶栏藏起、标注顶栏看得见', head.title === 'image-7a03-2.png' && head.ivBarHidden === 'hidden' && head.imkBarShown === 'visible' && head.tools.join() === 'true,false,false', head)

    const wb = await win.locator('.imk-world').boundingBox()
    const at = (x, y) => [wb.x + wb.width * x, wb.y + wb.height * y]
    const notes = () => win.locator('.imk-notes .imk-note:not(.is-add)').count()
    // 圈
    let [x0, y0] = at(0.33, 0.18), [x1, y1] = at(0.66, 0.46)
    await win.mouse.move(x0, y0); await win.mouse.down(); await win.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await win.mouse.move(x1, y1, { steps: 4 }); await win.mouse.up()
    await win.waitForTimeout(150)
    const popFocused = await win.evaluate(() => document.activeElement === document.querySelector('.imk-pop input'))
    check('圈完当场弹一行输入且已聚焦', popFocused)
    // 输入法组字中的回车不算数
    await win.evaluate(() => { const i = document.querySelector('.imk-pop input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })) })
    check('组字中的回车不记', await win.locator('.imk-pop').count() === 1)
    await win.keyboard.type('换成红色的贝雷帽'); await win.keyboard.press('Enter'); await win.waitForTimeout(150)
    check('回车记下:清单 1 条,写着那句话', (await notes()) === 1 && (await win.locator('.imk-notes .imk-note-body > span').first().textContent()) === '换成红色的贝雷帽')
    // 点
    await win.locator('.imk-tool').nth(1).click()
    ;[x0, y0] = at(0.78, 0.74); await win.mouse.click(x0, y0); await win.waitForTimeout(120)
    await win.keyboard.type('换成透明玻璃杯，装冰美式'); await win.keyboard.press('Enter'); await win.waitForTimeout(150)
    check('点一下:清单 2 条', (await notes()) === 2)
    // 刚落下就 Esc = 当没落过
    ;[x0, y0] = at(0.2, 0.85); await win.mouse.click(x0, y0); await win.waitForTimeout(120)
    await win.keyboard.press('Escape'); await win.waitForTimeout(120)
    check('刚落下的那处 Esc 删掉,清单还是 2 条', (await notes()) === 2 && (await win.locator('.imk-confirm').count()) === 0)
    await win.keyboard.press('Meta+z'); await win.waitForTimeout(120)
    const afterUndo = await notes()
    await win.keyboard.press('Meta+Shift+z'); await win.waitForTimeout(120)
    check('⌘Z 撤销一处、⇧⌘Z 重做', afterUndo === 1 && (await notes()) === 2, { afterUndo })
    // 看图器那层让开:← → 不切图、点空白不关
    await win.keyboard.press('ArrowRight'); await win.waitForTimeout(150)
    const box = await win.locator('.imk-body').boundingBox()
    await win.mouse.click(box.x + 30, box.y + box.height - 40); await win.waitForTimeout(250)
    const still = await win.evaluate(() => ({ imk: !!document.querySelector('.imk'), iv: !!document.querySelector('.iv'), title: document.querySelector('.imk-bar .iv-title span')?.textContent, marks: document.querySelectorAll('.imk-notes .imk-note:not(.is-add)').length }))
    check('标注态:← 不切图、点空白不关看图器、也不落标记', still.imk && still.iv && still.title === 'image-7a03-2.png' && still.marks === 2, still)
    // 滚轮缩放
    await win.mouse.move(...at(0.5, 0.5)); await win.mouse.wheel(0, -300); await win.waitForTimeout(150)
    const tf = await win.locator('.imk-world').evaluate((e) => e.style.transform)
    check('滚轮以指针为中心放大', /scale\((1\.[1-9]|[2-6])/.test(tf), tf)
    const clip = await win.evaluate(() => { const f = document.querySelector('.imk-frame'), n = document.querySelector('.imk-notes'); const fr = f.getBoundingClientRect(), nr = n.getBoundingClientRect(); return { overflow: getComputedStyle(f).overflow, gap: Math.round(nr.left - fr.right) } })
    check('放大只在图框里:框裁切、右侧清单在框外', clip.overflow === 'hidden' && clip.gap > 0, clip)
    if (shots) { await zoom110(true); await shot('2b-zoomed-light'); await zoom110(false) }
    await win.mouse.wheel(0, 600); await win.waitForTimeout(150)
    // 有标记时 Esc 先问
    await win.keyboard.press('Escape'); await win.waitForTimeout(150)
    check('有标记时 Esc 先问「放弃这些标注？」', (await win.locator('.imk-confirm').count()) === 1)
    await win.locator('.imk-confirm .imk-ghost').click(); await win.waitForTimeout(100)
    check('「继续标」回到标注,标记都在', (await win.locator('.imk-confirm').count()) === 0 && (await notes()) === 2)
    const send = await win.locator('.imk-send').textContent()
    check('发送钮写着 2 处', /2/.test(send) && send.includes('处修改'), send)
    if (shots) { await zoom110(true); await shot('2b-markup-light'); await win.evaluate(() => document.documentElement.classList.add('dark')); await shot('2b-markup-dark'); await win.evaluate(() => document.documentElement.classList.remove('dark')); await zoom110(false) }

    // 发送:一句编号清单 + 原图 + 标注副本
    await win.locator('.imk-overall').fill('光线别动')
    const n0 = stub.seen.runs.length
    await win.locator('.imk-send').click()
    await win.locator('.iv').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
    await win.waitForTimeout(800)
    const run = stub.seen.runs.length > n0 ? lastRun() : null
    const lines = String(run?.message || '').split('\n')
    check('发出去的正文:附图 1 原图、附图 2 标注示意,逐处一行', lines[0] === '按标注改附图 1（附图 2 是标注示意，只用来看改哪里）：'
      && /^1 .*圈出的地方：换成红色的贝雷帽$/.test(lines[1] || '') && /^2 右下点的位置：换成透明玻璃杯，装冰美式$/.test(lines[2] || '') && lines.includes('另外：光线别动'), lines)
    check('附件两件:原图 PNG 在前、标注副本 JPEG 在后', run?.attachments?.length === 2 && run.attachments[0].name === 'image-7a03-2.png' && run.attachments[0].mimeType === 'image/png'
      && run.attachments[1].name === 'image-7a03-2-标注.jpg' && run.attachments[1].mimeType === 'image/jpeg', run?.attachments?.map((a) => [a.name, a.mimeType, a.dataLen]))
    check('发出去以后看图器关掉', (await win.locator('.iv').count()) === 0)

    // ── 1C:全部图片
    await win.locator('#tocmsg-a1 .inline-set-main img').click()
    await win.locator('.iv').waitFor(); await win.waitForTimeout(400)
    await win.keyboard.press('g'); await win.waitForTimeout(300)
    const g0 = await win.evaluate(() => ({ cells: document.querySelectorAll('.ivg-cell').length, checks: document.querySelectorAll('.ivg-check').length, title: document.querySelector('.ivg-bar .iv-title b')?.textContent, ivHidden: getComputedStyle(document.querySelector('.iv > .iv-bar')).visibility }))
    // 7 格 = 3 张生图 + 2 张截图 + 上面 2B 发出去那条用户消息里的两件附件(用户附件不带 edit,不能选)
    check('1C 按 G 进「全部图片」:对话流里 7 张、能改的 5 张有选择钮,看图器顶栏藏起', g0.cells === 7 && g0.checks === 5 && g0.title === '全部图片' && g0.ivHidden === 'hidden', g0)
    await win.locator('.ivg-cell').nth(0).hover(); await win.locator('.ivg-cell').nth(0).locator('.ivg-check').click()
    await win.locator('.ivg-cell').nth(2).locator('.ivg-check').click()
    check('1C 选两张:底下一条「已选 2 张」', (await win.locator('.ivg-picked').textContent().catch(() => '')) === '已选 2 张')
    if (shots) { await zoom110(true); await shot('1c-grid-light'); await zoom110(false) }
    await win.locator('.ivg-cell').nth(0).locator('.ivg-mark').click()
    await win.locator('.imk').waitFor(); await win.waitForTimeout(400)
    const cw = await win.locator('.imk-world').boundingBox()
    await win.locator('.imk-tool').nth(1).click()
    await win.mouse.click(cw.x + cw.width * 0.5, cw.y + cw.height * 0.3); await win.waitForTimeout(120)
    await win.keyboard.type('把这里换成一盆绿植'); await win.keyboard.press('Enter'); await win.waitForTimeout(120)
    const collectBtn = await win.locator('.imk-send').textContent()
    await win.locator('.imk-send').click(); await win.waitForTimeout(300)
    const g1 = await win.evaluate(() => ({ grid: !!document.querySelector('.ivg'), imk: !!document.querySelector('.imk'), mark: document.querySelectorAll('.ivg-mark')[0]?.textContent }))
    check('1C 网格里「标注」= 收集模式:按钮写「完成」,完成回网格、那格写「1 处」', collectBtn === '完成' && g1.grid && !g1.imk && g1.mark === '1 处', { collectBtn, g1 })
    check('1C 只标了一张、整体要求留空:发送不可点(另一张没有改法)', await win.locator('.ivg-dock .imk-send').isDisabled())
    await win.locator('.ivg-dock .imk-overall').fill('背景换成浅黄色')
    const n2 = stub.seen.runs.length
    await win.locator('.ivg-dock .imk-send').click()
    await win.locator('.iv').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
    await win.waitForTimeout(800)
    const run2 = stub.seen.runs.length > n2 ? lastRun() : null
    const l2 = String(run2?.message || '').split('\n')
    check('1C 一起发:「分别改下面 2 张图」,图 1 带标注副本、图 2 是附图 3', l2[0] === '分别改下面 2 张图，每张单独改一次、只拿它自己的原图（标注示意只用来看改哪里）：'
      && l2[1] === '图 1（image-7a03-1.png，附图 1；附图 2 是它的标注示意）：' && /^1 .*点的位置：把这里换成一盆绿植$/.test(l2[2] || '')
      && l2[3] === '另外：背景换成浅黄色' && l2[4] === '图 2（image-7a03-3.png，附图 3）：' && l2[5] === '背景换成浅黄色', l2)
    check('1C 附件三件、按图序:原图 1、原图 1 的标注副本、原图 3', (run2?.attachments || []).map((a) => a.name).join('|') === 'image-7a03-1.png|image-7a03-1-标注.jpg|image-7a03-3.png', run2?.attachments?.map((a) => a.name))
    // Esc 从网格回单张
    await win.locator('#tocmsg-a1 .inline-set-main img').click()
    await win.locator('.iv').waitFor(); await win.waitForTimeout(400)
    await win.keyboard.press('g'); await win.waitForTimeout(250); await win.keyboard.press('Escape'); await win.waitForTimeout(250)
    check('1C 网格里 Esc 回单张(看图器还开着)', (await win.locator('.ivg').count()) === 0 && (await win.locator('.iv').count()) === 1)
    await win.keyboard.press('Escape'); await win.waitForTimeout(600)

    // 用这张继续 / 再来 N 张
    await win.locator('#tocmsg-a1 .inline-set-link').first().click()
    await win.waitForTimeout(600)
    const tiles = await win.evaluate(() => [...document.querySelectorAll('.att-tile, [class*="att-tile"]')].map((e) => e.getAttribute('title') || e.textContent).filter(Boolean))
    check('「用这张继续」进输入框附件', tiles.some((t) => String(t).includes('image-7a03')), tiles)
    const n1 = stub.seen.runs.length
    await win.locator('#tocmsg-a1 .inline-set-link').nth(1).click()
    await win.waitForTimeout(1200)
    check('「再来 3 张」发出一句', stub.seen.runs.length > n1 && lastRun().message === '照 image-7a03-1.png 这组再来 3 张。', stub.seen.runs.length > n1 ? lastRun().message : null)

    // ── 窄窗(手机布局):缩略条换到下面横排;标注态图在上、清单和输入在底部抽屉
    // 主窗最小宽 880(electron/main.ts):用视口模拟窄屏,同 agent-picker.check
    await win.setViewportSize({ width: 430, height: 880 })
    await win.waitForTimeout(900)
    // 对话贴底:程序滚动会被拉回去,用真滚轮往上滚到这组露出来
    for (let i = 0; i < 30; i++) {
      const top = await win.locator('#tocmsg-a1 .inline-set').evaluate((el) => el.getBoundingClientRect().top)
      if (top > 60 && top < 400) break
      const sb = await win.locator('#tocmsg-a1').boundingBox()
      await win.mouse.move(sb.x + sb.width / 2, 420); await win.mouse.wheel(0, top < 60 ? -160 : 160); await win.waitForTimeout(120)
    }
    await win.waitForTimeout(300)
    const narrow = await win.evaluate(() => { const r = document.querySelector('#tocmsg-a1 .inline-set-row'); return { dir: r && getComputedStyle(r).flexDirection, w: Math.round(document.querySelector('#tocmsg-a1 .inline-set')?.getBoundingClientRect().width || 0) } })
    check('窄窗:缩略条换到主图下面', narrow.dir === 'column', narrow)
    await shot('narrow-1b')
    await win.locator('#tocmsg-a1 .inline-set-main').hover()
    await win.locator('#tocmsg-a1 .inline-set-act').click()
    await win.locator('.imk').waitFor(); await win.waitForTimeout(500)
    const nb = await win.locator('.imk-world').boundingBox()
    await win.mouse.click(nb.x + nb.width * 0.5, nb.y + nb.height * 0.5); await win.waitForTimeout(150)
    await win.keyboard.type('换成一只小鸟'); await win.keyboard.press('Enter'); await win.waitForTimeout(200)
    const sheet = await win.evaluate(() => ({ compact: !!document.querySelector('.imk.is-compact'), sheet: !!document.querySelector('.imk-sheet'), notes: document.querySelectorAll('.imk-sheet .imk-note:not(.is-add)').length, dock: !!document.querySelector('.imk-sheet .imk-dock'), side: !!document.querySelector('.imk-notes') }))
    check('窄窗标注态:抽屉在下、清单和输入在抽屉里、没有右侧清单', sheet.compact && sheet.sheet && sheet.notes === 1 && sheet.dock && !sheet.side, sheet)
    await shot('narrow-2b')
    await win.keyboard.press('Escape'); await win.waitForTimeout(150)
    await win.locator('.imk-confirm .imk-send').click().catch(() => {}); await win.waitForTimeout(200)
    await win.keyboard.press('Escape'); await win.waitForTimeout(500)
  } finally {
    await ctx.close()
  }
  const fail = results.filter((r) => !r.ok)
  console.log(`\n${results.length - fail.length}/${results.length} 通过${fail.length ? ';没过:' + fail.map((r) => r.name).join(' / ') : ''}`)
  process.exit(fail.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
