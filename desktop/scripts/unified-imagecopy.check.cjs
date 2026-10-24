// 网页 / 手机端复制笔记里的图片(2026-10-24):没有主进程时,Mod+C 与块菜单「复制图片」都要把真图片写进剪贴板,
// 同一项带着库内引用文字(Amadeus 自己粘贴拿回引用,不再导入一份)。harness 桥上没有 copyAttachment = 网页 / 手机那条路。
//
// 矩阵:`![](pic.png)` 图片节点 / `![[wiki.png]]` 嵌入图 × Mod+C / 右键「复制图片」;另一条对照:选中普通文字复制仍是纯文字。
// 图片地址经 __assets 指向 /__img/<ref>(page.route 回一张真 PNG),解析器认回 ref —— 与网页端 setAssetUrlBuilder 同形。
//
// 用法:node scripts/e2e-editor.cjs --check=unified-imagecopy
//      5173 被别的检出占着时:HARNESS_URL=http://localhost:<port>/harness.html
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
const ORIGIN = URL.split('/').slice(0, 3).join('/')
const PM = '.unified-body .ProseMirror'
// 纯色 PNG,缺省 80×60(太小的图会被宽度拖把手整个盖住,点不到图本身);文件名里的 w<N> 定宽,用来认出复制的是哪张
const png = (W = 80, H = 60) => {
  const zlib = require('zlib')
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return ~c >>> 0 }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((W * 3 + 1) * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw.set([200, 100, 88], y * (W * 3 + 1) + 1 + x * 3)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function open(ctx, seed) {
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  const net = { slowMs: 0 } // 开着时每次取图都晚到(只在复制那一拍开,首屏照常)
  await p.route(`${ORIGIN}/__img/**`, async (r) => {
    const name = decodeURIComponent(r.request().url().split('/__img/')[1])
    if (net.slowMs) await new Promise((res) => setTimeout(res, net.slowMs))
    r.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: png(+(/w(\d+)/.exec(name)?.[1] ?? 80)) })
  })
  await p.goto(`${URL}?upage`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForSelector(PM, { timeout: 120000 })
  await p.evaluate(() => {
    const base = `${location.origin}/__img/`
    window.__assets.setUrlBuilder((ref) => base + encodeURIComponent(ref), (url) => (url.startsWith(base) ? decodeURIComponent(url.slice(base.length)) : null))
  })
  await p.evaluate((seed) => window.__upage.switchFile('Pic.md', seed), seed)
  await p.waitForSelector(`${PM} img[src]`, { timeout: 20000 })
  await p.waitForFunction((s) => [...document.querySelectorAll(s + ' img[src]')].filter((i) => i.getAttribute('src')).some((i) => i.complete && i.naturalWidth > 0), PM, { timeout: 10000 })
  await p.evaluate(() => navigator.clipboard.writeText('-'))
  return { p, errs, net }
}

/** 剪贴板里有什么:类型清单 + text/plain + PNG 宽度(真解得出来才算图片)。 */
const readClip = (p) => p.evaluate(async () => {
  const items = await navigator.clipboard.read()
  const it = items[0]
  const out = { types: [...it.types] }
  if (it.types.includes('text/plain')) out.text = await (await it.getType('text/plain')).text()
  if (it.types.includes('image/png')) out.w = (await createImageBitmap(await it.getType('image/png'))).width
  return out
})
const waitClip = async (p, pred) => {
  let c = null
  for (let i = 0; i < 30; i++) {
    c = await readClip(p)
    if (pred(c)) return c
    await p.waitForTimeout(100)
  }
  return c
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN })
  const cases = [
    { name: '图片节点 ![](pic.png)', seed: '前一段。\n\n![图](pic.png)\n\n后一段。\n', ref: '![图](pic.png)' },
    { name: '嵌入图 ![[wiki.png]]', seed: '前一段。\n\n![[wiki.png]]\n\n后一段。\n', ref: '![[wiki.png]]' },
  ]
  for (const c of cases) {
    for (const via of ['key', 'menu']) {
      const { p, errs } = await open(ctx, c.seed)
      const img = p.locator(`${PM} img[src^="${ORIGIN}/__img/"]`).first()
      await img.click()
      await p.waitForTimeout(200)
      if (via === 'key') {
        await p.keyboard.press('ControlOrMeta+C')
      } else {
        await img.click({ button: 'right' })
        const item = p.locator('.unified-block-menu [data-act="copyImage"]')
        const shown = await item.isVisible().catch(() => false)
        check(`${c.name} 右键块菜单出「复制图片」`, shown)
        if (shown) await item.click()
      }
      const clip = await waitClip(p, (x) => x.types.includes('image/png'))
      check(`${c.name} × ${via === 'key' ? 'Mod+C' : '右键复制图片'} → 剪贴板是 PNG + 引用文字`,
        clip.types.includes('image/png') && clip.w === 80 && clip.text === c.ref && errs.length === 0,
        JSON.stringify({ clip, errs: errs.map((m) => m.slice(0, 90)) }))
      await p.close()
    }
  }
  // 对照:选普通文字 Mod+C → 纯文字,菜单里也没有「复制图片」
  {
    const { p, errs } = await open(ctx, cases[0].seed)
    await p.locator(`${PM} > p`).first().click({ clickCount: 3 })
    await p.keyboard.press('ControlOrMeta+C')
    const clip = await waitClip(p, (x) => x.text && x.text !== '-')
    await p.locator(`${PM} > p`).first().click({ button: 'right' })
    const menu = await p.locator('.unified-block-menu [data-act="copyImage"]').count()
    check('对照:选文字复制 → 只有文字、菜单无「复制图片」', !clip.types.includes('image/png') && /前一段/.test(clip.text ?? '') && menu === 0 && errs.length === 0,
      JSON.stringify({ clip, menu, errs }))
    await p.close()
  }
  // 评审 P2:同一段两张嵌入图,点第二张 —— 剪贴板里的图必须是第二张(宽 120),不能是第一张配第二张的引用
  {
    const { p, errs } = await open(ctx, '前一段。\n\n![[a-w80.png]] ![[b-w120.png]]\n\n后一段。\n')
    await p.locator(`${PM} img[src*="b-w120"]`).click()
    await p.waitForTimeout(200)
    await p.keyboard.press('ControlOrMeta+C')
    await p.waitForTimeout(600)
    const clip = await readClip(p)
    const ok = clip.types.includes('image/png') ? clip.w === 120 && clip.text === '![[b-w120.png]]' : !clip.types.includes('image/png')
    check('同段两张嵌入图点第二张 → 若复制成图片,字节与引用都是第二张', ok && errs.length === 0, JSON.stringify({ clip, errs }))
    await p.close()
  }
  // 评审 P2:跨块选区(段落 + 图片)→ 不能被当成一张图复制
  {
    const { p, errs } = await open(ctx, '前一段。\n\n![[wiki.png]]\n\n后一段。\n')
    await p.evaluate((s) => {
      const v = document.querySelector(s)
      const r = document.createRange()
      r.setStart(v.querySelector('p').firstChild, 0)
      r.setEndAfter(v.querySelectorAll('p')[1])
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r)
    }, PM)
    await p.waitForTimeout(200)
    await p.keyboard.press('ControlOrMeta+C')
    await p.waitForTimeout(600)
    const clip = await readClip(p)
    check('跨块选区 Mod+C → 不变成单张图片', !clip.types.includes('image/png') && /前一段/.test(clip.text ?? ''), JSON.stringify({ clip, errs }))
    await p.close()
  }
  // 评审 P1:慢图还没取完,用户又复制了文字 —— 晚到的图不能把文字盖掉
  {
    const { p, errs, net } = await open(ctx, cases[0].seed)
    await p.locator(`${PM} img[src^="${ORIGIN}/__img/"]`).first().click()
    await p.waitForTimeout(200)
    net.slowMs = 1200
    await p.keyboard.press('ControlOrMeta+C')
    await p.waitForTimeout(100)
    await p.locator(`${PM} > p`).last().click({ clickCount: 3 })
    await p.keyboard.press('ControlOrMeta+C')
    await p.waitForTimeout(1800)
    net.slowMs = 0
    const clip = await readClip(p)
    check('慢图被后来的文字复制顶掉 → 剪贴板留文字', !clip.types.includes('image/png') && /后一段/.test(clip.text ?? ''), JSON.stringify({ clip, errs }))
    await p.close()
  }
  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} passed`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
