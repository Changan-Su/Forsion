/**
 * Space 自绘图标(space.json 的 `iconFile`)—— 真 Electron × 真主进程读盘 × 真 IPC。
 * 钉四件事:① 插件 Space 自己目录里没放图 → 取插件包根的 icon.png;② 自己目录里的 SVG → 单色蒙版,
 * 颜色跟按钮的 currentColor(选中态也跟);③ 用户 Space 目录里的 PNG;④ 写坏的 iconFile → 回落 `icon` 词表图标。
 *
 * 需先 npm run build。用法:npm run check:spaceicon      负对照:… -- --nc(不放插件 icon.png → ① 必红)
 * 截图落 $SPACE_ICON_SHOTS(缺省系统临时目录),观感要人看。想看真图标的样子:
 * SPACE_ICON_SAMPLES=<插件目录>,<插件目录>… 会把各目录的 icon.png 再种成几个插件 Space 一起进截图(不参与断言)。
 * 验一个真插件适配上没有:SPACE_ICON_PLUGINS=<插件目录>,… 整个插件装进临时 home,它每个写了 iconFile 的 Space
 * 都必须画成图片 / 蒙版(退回词表图标 = 图没读到或不合规,红)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const NC = process.argv.includes('--nc')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-spaceicon-'))
const shots = process.env.SPACE_ICON_SHOTS || home
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 纯色方形 PNG(真能解码的那种:IHDR + IDAT + IEND,带 CRC)。 */
function png(side, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(side * 3).map((_, i) => [r, g, b][i % 3])])
  const raw = Buffer.concat(Array.from({ length: side }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.300 9.300l6.100-.700z"/></svg>'
const space = (id, zh, extra) => JSON.stringify({ id, name: { zh, en: id }, icon: 'video', layout: { main: [{ type: 'chat' }], left: [], right: [] }, ...extra })
const write = (rel, data) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }

// 插件 probe-plug:包根 icon.png(红),三个内嵌 Space
write('plugins/probe-plug/manifest.json', JSON.stringify({ id: 'probe-plug', name: 'Probe', version: '1.0.0', apiVersion: 1, main: 'main.js' }))
write('plugins/probe-plug/main.js', 'export function activate() {}\nexport function deactivate() {}\n')
if (!NC) write('plugins/probe-plug/icon.png', png(64, [220, 40, 40]))
write('plugins/probe-plug/spaces/plug-icon/space.json', space('plug-icon', '插件图标', { iconFile: 'icon.png' }))
write('plugins/probe-plug/spaces/own-svg/space.json', space('own-svg', '自绘线形', { iconFile: 'icon.svg' }))
write('plugins/probe-plug/spaces/own-svg/icon.svg', SVG)
write('plugins/probe-plug/spaces/bad-file/space.json', space('bad-file', '写坏了', { iconFile: '../icon.png' }))
// 用户 Space:自己目录里的 PNG(蓝)
write('spaces/user-png/space.json', space('user-png', '用户图片', { iconFile: 'mine.png' }))
write('spaces/user-png/mine.png', png(128, [40, 90, 220]))

for (const [i, dir] of (process.env.SPACE_ICON_SAMPLES || '').split(',').filter(Boolean).entries()) {
  write(`plugins/sample-${i}/manifest.json`, JSON.stringify({ id: `sample-${i}`, name: `Sample ${i}`, version: '1.0.0', apiVersion: 1, main: 'main.js' }))
  write(`plugins/sample-${i}/main.js`, 'export function activate() {}\nexport function deactivate() {}\n')
  write(`plugins/sample-${i}/icon.png`, fs.readFileSync(path.join(dir, 'icon.png')))
  write(`plugins/sample-${i}/spaces/sample-${i}/space.json`, space(`sample-${i}`, path.basename(dir), { iconFile: 'icon.png' }))
}

/** 真插件:整夹装进临时 home(目录名 = manifest id),记下它声明了 iconFile 的 Space。 */
const real = []
for (const dir of (process.env.SPACE_ICON_PLUGINS || '').split(',').filter(Boolean)) {
  const pid = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).id
  fs.cpSync(dir, path.join(home, 'plugins', pid), { recursive: true, filter: (src) => !/(^|[\\/])(\.git|node_modules)$/.test(src) })
  for (const slug of fs.existsSync(path.join(dir, 'spaces')) ? fs.readdirSync(path.join(dir, 'spaces')) : []) {
    const file = path.join(dir, 'spaces', slug, 'space.json')
    if (!fs.existsSync(file)) continue
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (spec.iconFile) real.push({ pid, id: spec.id, iconFile: spec.iconFile })
  }
}

/** 读一个 Space 在 ribbon 上的图标形态(「…」展开后每个 Space 都在条上)。 */
const PROBE = (id) => `(() => {
  const btn = document.querySelector('.rb-slot[data-id="space:${id}"] .rb-space')
  if (!btn) return null
  const img = btn.querySelector('img')
  const span = btn.querySelector('span[aria-hidden="true"]:not(.rb-badge)')
  const cs = span && getComputedStyle(span)
  return {
    img: img ? { src: img.src.slice(0, 22), natural: img.naturalWidth, complete: img.complete, w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height } : null,
    mask: cs ? { image: (cs.maskImage || cs.webkitMaskImage || '').slice(0, 30), bg: cs.backgroundColor, w: span.getBoundingClientRect().width } : null,
    lucide: btn.querySelector('svg.lucide')?.getAttribute('class') || null,
    color: getComputedStyle(btn).color,
    on: btn.classList.contains('on'),
  }
})()`

/** 条上装不下时展开态也只露一窗:滚轮把目标 Space 挪进来再读(窗外的只是占位格,没有按钮)。 */
async function probe(win, id) {
  for (let i = 0; i < 40; i++) {
    const got = await win.evaluate(PROBE(id))
    if (got) return got
    await win.mouse.move(22, 300)
    await win.mouse.wheel(0, i < 20 ? 60 : -60)
    await win.waitForTimeout(450) // 停手 120ms 吸附 + 240ms 过渡走完才换窗口(之前窗外只有占位格)
  }
  return null
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    // Space 是异步装载的(spaces:list IPC → registerSpace);「…」展开后全部上条
    const more = win.locator('.rb-top .rb-more').first()
    await more.waitFor({ timeout: 15_000 }).catch(() => {})
    if (await more.count()) { await more.click(); await win.waitForTimeout(400) }
    await win.waitForSelector('.rb-slot[data-id="space:user-png"] .rb-space', { timeout: 15_000 }).catch(() => {})

    const plug = await probe(win, 'plug-icon')
    check('插件 Space 自己没放图 → 用插件包根的 icon.png', plug?.img?.src === 'data:image/png;base64,' && plug.img.natural === 64 && !plug.lucide, JSON.stringify(plug))
    check('图片图标与 lucide 同尺寸(18×18)', plug?.img?.w === 18 && plug?.img?.h === 18, JSON.stringify(plug?.img))

    const user = await probe(win, 'user-png')
    check('用户 Space 目录里的 PNG', user?.img?.natural === 128 && !user.lucide, JSON.stringify(user))

    const svg = await probe(win, 'own-svg')
    check('SVG → 单色蒙版,颜色 = 按钮的 currentColor', svg?.mask?.image.includes('data:image/svg+xml') && svg.mask.bg === svg.color && svg.mask.w === 18 && !svg.img, JSON.stringify(svg))

    const bad = await probe(win, 'bad-file')
    check('iconFile 带路径 → 不读盘,回落 icon 词表(video)', /lucide-video/.test(bad?.lucide || '') && !bad.img && !bad.mask, JSON.stringify(bad))

    for (const r of real) {
      const got = await probe(win, r.id)
      check(`真插件 ${r.pid}:Space「${r.id}」的 ${r.iconFile} 画出来了`, got && (got.img?.natural > 0 || got.mask?.image.includes('data:image/')) && !got.lucide, JSON.stringify(got))
    }

    // 截图前把最后种下的那批(插件图标 / 真图标样本)滚进窗口
    const last = (process.env.SPACE_ICON_SAMPLES || '').split(',').filter(Boolean).length - 1
    await probe(win, real.length ? real[real.length - 1].id : last >= 0 ? `sample-${last}` : 'plug-icon')
    await win.screenshot({ path: path.join(shots, 'space-icon-ribbon.png'), clip: { x: 0, y: 0, width: 260, height: 760 } })

    // 选中态:蒙版图标跟着按钮变色(图片图标做不到,这正是 SVG 走蒙版的理由)
    await probe(win, 'own-svg')
    await win.evaluate(`document.querySelector('.rb-slot[data-id="space:own-svg"] .rb-space')?.click()`)
    await win.waitForTimeout(600)
    // 切 Space 不收「…」;万一收了(该 Space 落回溢出区)再点开
    if (!(await win.evaluate(PROBE('own-svg'))) && await more.count()) { await more.click().catch(() => {}); await win.waitForTimeout(400) }
    const on = await probe(win, 'own-svg')
    check('选中后蒙版图标跟随选中色', on?.on && on.mask?.bg === on.color && on.color !== svg?.color, JSON.stringify({ before: svg?.color, after: on?.color, bg: on?.mask?.bg }))
    await win.screenshot({ path: path.join(shots, 'space-icon-ribbon-active.png'), clip: { x: 0, y: 0, width: 260, height: 760 } })

    // 插件更新只换了图(space.json 一字未动):图标要跟上,且不能把正在用的 Space 踢回 Tangu。
    // 触发口 = 插件启停同步用的 storage 事件(amadeusPlugins.ts),它会重跑 loadUserSpaces。
    if (!NC) {
      await probe(win, 'plug-icon')
      await win.evaluate(`document.querySelector('.rb-slot[data-id="space:plug-icon"] .rb-space')?.click()`)
      await win.waitForTimeout(600)
      write('plugins/probe-plug/icon.png', png(96, [40, 160, 80]))
      await win.evaluate(`window.dispatchEvent(new StorageEvent('storage', { key: 'amadeus.plugins.disabled' }))`)
      await win.waitForFunction(`document.querySelector('.rb-slot[data-id="space:plug-icon"] img')?.naturalWidth === 96`, null, { timeout: 8000 }).catch(() => {})
      const swapped = await probe(win, 'plug-icon')
      const active = await win.evaluate(`localStorage.getItem('forsion_tangu_active_space')`)
      check('只换图标 → 原地更新,不离开当前 Space', swapped?.img?.natural === 96 && swapped.on && active === 'plug-icon', JSON.stringify({ natural: swapped?.img?.natural, on: swapped?.on, active }))
    }
    console.log(`截图: ${shots}`)
  } finally {
    await app.close().catch(() => {})
    if (shots !== home) fs.rmSync(home, { recursive: true, force: true })
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  process.exit(bad.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
