/**
 * 开着一篇带图的笔记,把它拖进别的文件夹:图还显示得出、盘上的引用跟着改、接着打字存盘不把它改回去
 * (真 Electron × 真渲染层 × 真主进程 × 真资源协议 × 真磁盘;2026-10-10)。
 *
 * 为什么存在:挪单篇笔记只搬 .md,图片留在原文件夹。正文里的 `![](.amadeus/p.png)` 是页相对的,一个字不改就指向
 * 新文件夹下不存在的路径 —— 图当场裂;新文件夹恰好有同路径的文件时,显示的是**另一张图**。
 * 规则那半有单测(shared/amadeus/assets.test.ts 的「挪了位置之后的引用」、electron/amadeus/ipc.moveFileRefs.test.ts);
 * **这里钉的是整条链**:侧栏拖放 → pageStore.movePage → 主进程重写 → 编辑器换到新路径重新装载 → <img> 真去取图 →
 * 之后的存盘。尤其是最后一步:编辑器要是还拿着挪之前的正文,一存盘就把重写盖回去。
 *
 * 判图靠尺寸:原图 1×1,新文件夹里同路径的那张是 2×2 —— naturalWidth 是 1 才算取对了(0 = 裂,2 = 取成了另一张)。
 * 负对照(实跑过):构建产物里摘掉主进程 propagateRenames 对 rebaseFileRefs 的调用 → 3 / 4 / 5 红,第 4 条量到的宽度是 2
 *   (编辑器里显示的是目标夹那张)。
 *
 * ⚠️ 库是临时夹具(预置 amadeus-config 的 lastVault),不碰本机真实库。
 * ⚠️ 先 npm run build:量的是 out/ 里的产物,源码改了没构建就是白测。
 * ⚠️ 合成 DragEvent:HTML5 拖放没法用鼠标事件驱动(同 sidebar-drop.e2e.cjs)。
 *
 * 用法:npm run e2e:notemove
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** n×n 的纯色 PNG(尺寸就是这张图的身份)。 */
function png(n) {
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
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2 // 8 位 RGB
  const raw = Buffer.alloc(n * (1 + n * 3), 0x80)
  for (let y = 0; y < n; y++) raw[y * (1 + n * 3)] = 0 // 每行的滤波字节
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** 树里的一行(笔记行 / 文件夹行):真派发 dragstart,让应用自己记下「正在拖谁」。 */
const DRAG_START = ({ rowText }) => {
  const el = Array.from(document.querySelectorAll('.t2s-srow')).find((n) => (n.textContent || '').includes(rowText))
  if (!el) return { err: 'no row ' + rowText }
  window.__dt = new DataTransfer()
  el.dispatchEvent(new DragEvent('dragstart', { dataTransfer: window.__dt, bubbles: true, cancelable: true }))
  return { ok: true }
}
const DRAG_TO = ({ type, rowText }) => {
  const el = Array.from(document.querySelectorAll('.t2s-group')).find((n) => (n.textContent || '').includes(rowText))
  if (!el || !window.__dt) return { err: 'no folder ' + rowText }
  el.dispatchEvent(new DragEvent(type, { dataTransfer: window.__dt, bubbles: true, cancelable: true }))
  return { ok: true, lit: document.querySelectorAll('.amx-drop-into').length }
}
/** 编辑器里那张图:取完了没、取到的是几像素宽、地址指着库里的哪个路径。 */
const IMG = () => {
  const img = document.querySelector('.ProseMirror img')
  if (!img) return null
  let ref = img.getAttribute('src') || ''
  try { ref = decodeURIComponent(ref.replace('amadeus-asset://v/', '')) } catch { /* 原样 */ }
  return { done: img.complete, w: img.naturalWidth, ref }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-notemove-'))
  const userData = path.join(home, 'userdata')
  const vault = path.join(home, 'Vault')
  const BODY = '# 带图\n\n正文一行\n\n![](.amadeus/p.png)\n\n[doc](attachments/d.pdf)\n'
  const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), data) }
  put('来源夹/带图.md', BODY)
  put('来源夹/.amadeus/p.png', png(1))
  put('来源夹/attachments/d.pdf', '%PDF-1.4\n')
  put('目标夹/占位.md', '# 占位\n')
  put('目标夹/.amadeus/p.png', png(2)) // 新位置同路径的另一张图:不许显示成它
  const read = (rel) => fs.readFileSync(path.join(vault, rel), 'utf8')
  // 未打包时主进程把 userData 改成 `<--user-data-dir>-dev`,dev / 正式版还分用两个配置文件名:四份全种(同 sidebar-drop)。
  for (const dir of [userData, `${userData}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) {
      fs.writeFileSync(path.join(dir, f), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2), 'utf8')
    }
  }
  const shot = path.join(os.tmpdir(), `forsion-notemove-${process.pid}.png`)

  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
    })
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.locator('.rb-space[aria-label="笔记"], .rb-space[aria-label="Note"]').first().click({ timeout: 15_000 })
    await win.waitForSelector('.t2s-srow, .t2s-group', { timeout: 20_000 })
    await win.waitForTimeout(1500)

    const rows = () => win.evaluate(`Array.from(document.querySelectorAll('.t2s-srow, .t2s-group')).map((e) => (e.textContent || '').trim().slice(0, 16))`)
    // 文件夹默认可能是收起的:看不见「带图」就点开「来源夹」。
    if (!(await rows()).some((r) => r.includes('带图'))) {
      await win.locator('.t2s-folder-row', { hasText: '来源夹' }).first().click({ timeout: 10_000 })
      await win.waitForTimeout(600)
    }
    const seen = await rows()
    const fixtureOn = seen.some((r) => r.includes('带图')) && seen.some((r) => r.includes('目标夹'))
    check('0 夹具库装上了(树里看得见 带图 / 目标夹)', fixtureOn, JSON.stringify(seen.slice(0, 8)))
    if (!fixtureOn) throw new Error('夹具库没装上,拒绝继续(后面每一步都往库里写)')

    const imgSettled = async () => {
      for (let i = 0; i < 40; i++) {
        const v = await win.evaluate(IMG)
        if (v && v.done) return v
        await win.waitForTimeout(250)
      }
      return win.evaluate(IMG)
    }
    /** 把「带图」从 from 拖进 folder。树里看不见那一行(所在文件夹收着)就先点开 —— 拖不出去时这一步什么都不会发生。 */
    const dragInto = async (folder, from) => {
      if (!(await rows()).some((r) => r.includes('带图'))) {
        await win.locator('.t2s-folder-row', { hasText: from }).first().click({ timeout: 10_000 })
        await win.waitForTimeout(600)
      }
      const s = await win.evaluate(DRAG_START, { rowText: '带图' })
      if (s.err) throw new Error(`拖不起来:${s.err}(树里:${JSON.stringify(await rows())})`)
      await win.waitForTimeout(300) // 「正在拖谁」是 React 状态,等它提交
      const o = await win.evaluate(DRAG_TO, { type: 'dragover', rowText: folder })
      await win.waitForTimeout(300)
      const d = await win.evaluate(DRAG_TO, { type: 'drop', rowText: folder })
      await win.waitForTimeout(3500) // 落盘 → 全库重写 → 换路径 → 重新装载
      return { s, o, d }
    }

    // ── 1 打开笔记:挪之前图取得到 ───────────────────────────────────────────
    await win.locator('.t2s-srow', { hasText: '带图' }).first().click({ timeout: 10_000 })
    await win.waitForSelector('.ProseMirror img', { timeout: 20_000 })
    const before = await imgSettled()
    check('1 挪之前:图显示得出(1×1 那张)', before && before.w === 1, JSON.stringify(before))

    // ── 2 拖进「目标夹」──────────────────────────────────────────────────────
    const drag = await dragInto('目标夹', '来源夹')
    const moved = fs.existsSync(path.join(vault, '目标夹/带图.md')) && !fs.existsSync(path.join(vault, '来源夹/带图.md'))
    check('2 笔记挪进了目标夹(图片留在原处)', moved && fs.existsSync(path.join(vault, '来源夹/.amadeus/p.png')), JSON.stringify(drag))
    if (!moved) throw new Error('没挪成,后面的断言没有意义')
    const disk1 = read('目标夹/带图.md')
    check('3 盘上的图片 / 附件引用改成了从新位置指回去', disk1 === BODY.replace('](.amadeus/', '](../来源夹/.amadeus/').replace('](attachments/', '](../来源夹/attachments/'), JSON.stringify(disk1))
    const after = await imgSettled()
    check('4 ⚠️ 编辑器里的图还是原来那张(不是裂图,也不是目标夹里同路径的 2×2)', after && after.w === 1, JSON.stringify(after))

    // ── 3 接着打字存盘:不许把引用改回去 ─────────────────────────────────────
    await win.locator('.ProseMirror p', { hasText: '正文一行' }).first().click({ timeout: 10_000 })
    await win.keyboard.press('End')
    await win.keyboard.type('续写')
    await win.waitForTimeout(4000) // 存盘有防抖
    const disk2 = read('目标夹/带图.md')
    check('5 ⚠️ 打字存盘之后引用仍指着原来的文件(没被编辑器手里的旧正文盖回去)',
      disk2.includes('正文一行续写') && disk2.includes('![](../来源夹/.amadeus/p.png)') && disk2.includes('[doc](../来源夹/attachments/d.pdf)') && !disk2.includes('](.amadeus/'),
      JSON.stringify(disk2))
    check('5b 没在原路径复活出一篇', !fs.existsSync(path.join(vault, '来源夹/带图.md')), JSON.stringify(fs.readdirSync(path.join(vault, '来源夹'))))

    // ── 4 拖回去:写法回到原样 ────────────────────────────────────────────────
    await dragInto('来源夹', '目标夹')
    const backOk = fs.existsSync(path.join(vault, '来源夹/带图.md'))
    const disk3 = backOk ? read('来源夹/带图.md') : ''
    check('6 拖回原文件夹:引用回到原来的写法', disk3.includes('![](.amadeus/p.png)') && disk3.includes('[doc](attachments/d.pdf)') && disk3.includes('续写'), JSON.stringify(disk3))
    const back = await imgSettled()
    check('6b 图照样显示得出', back && back.w === 1, JSON.stringify(back))

    await win.screenshot({ path: shot })
    console.log(`\n截图:${shot}`)
  } finally {
    if (app) await app.close().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) { console.log('失败:', failed.map((f) => f.name).join(' / ')); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
