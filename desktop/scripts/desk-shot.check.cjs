/**
 * Agent Desk 截屏(引擎 desk_screenshot 工具)的**真 Electron** 契约检查。
 * 纯函数单测只能钉「选哪块 DOM / 算多大矩形」;真正会静默错掉的是这几条,只有真机能验:
 *  ① window.tangu.captureRect 在打包后的 preload 里真存在(preload 漏挂 = 工具永远超时);
 *  ② getBoundingClientRect 的视口坐标 == capturePage 的 DIP 矩形 —— 抽样中心像素必须是
 *     我们铺进去的那块颜色。坐标系错一格就会截到隔壁(黑边/聊天区),而截图"有图"看着像成功;
 *  ③ body 端级 zoom ≠ 1 时同样成立(zoom×坐标是本仓的老坑,这条专门钉它,别再回头做反补偿);
 *  ④ 最长边压到 1024(不压一张 HiDPI 截图能顶几千 token);
 *  ⑤ 过小矩形被主进程挡掉(返回 null,不产出垃圾图)。
 *
 * 跑:npm run build && node scripts/desk-shot.check.cjs   (隔离 TANGU_HOME,不碰真实数据)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

// 铺一块已知纯色的假 Desk → 截它 → 把截图画回 canvas 抽样中心像素。
// 颜色随机不了(要断言),用一个绝不会与 UI 撞的值。
async function shoot(win, zoom) {
  return win.evaluate(async (z) => {
    const COLOR = { r: 18, g: 52, b: 86 } // #123456
    document.body.style.zoom = z === 1 ? '' : String(z)
    const host = document.createElement('div')
    host.setAttribute('data-desk-session', 'shotcheck')
    host.className = 'agent-desk open'
    // 绝对定位 + 固定 px:body 端级 zoom 会真的把它放大(fixed+% 反而两头抵消,量不出 zoom)
    host.style.cssText = 'position:absolute;left:40px;top:40px;width:420px;height:300px;z-index:99999;pointer-events:none'
    const body = document.createElement('div')
    body.className = 'agent-desk-body'
    body.style.cssText = `width:100%;height:100%;background:rgb(${COLOR.r},${COLOR.g},${COLOR.b})`
    host.appendChild(body)
    document.body.appendChild(host)
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const r = body.getBoundingClientRect()
      const rect = { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.floor(r.width), height: Math.floor(r.height) }
      const has = typeof window.tangu?.captureRect === 'function'
      if (!has) return { has, rect }
      const url = await window.tangu.captureRect(rect)
      const tiny = await window.tangu.captureRect({ x: 0, y: 0, width: 4, height: 4 })
      if (!url) return { has, url: null, rect, tiny }
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url })
      const c = document.createElement('canvas')
      c.width = img.width; c.height = img.height
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      const px = g.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data
      return { has, prefix: url.slice(0, 22), w: img.width, h: img.height, px: [px[0], px[1], px[2]], rect, tiny, want: COLOR }
    } finally {
      host.remove()
      document.body.style.zoom = ''
    }
  }, zoom)
}

const near = (px, want) => Math.abs(px[0] - want.r) <= 6 && Math.abs(px[1] - want.g) <= 6 && Math.abs(px[2] - want.b) <= 6

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-deskshot-'))
  let app
  try {
    app = await electron.launch({
      // ⚠️独立 userData:与开发者的 dev 实例共用目录会卡死在单实例锁(见 builtins.check.cjs)
      args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', ELECTRON_ENABLE_LOGGING: '1' },
    })
  } catch (e) {
    console.error('启动失败。若已有 dev 版 Electron 在跑,先 pkill -f "node_modules/electron/dist/Electron.app"(单实例锁)。')
    throw e
  }
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30_000 })

  const a = await shoot(win, 1)
  check('preload 暴露 window.tangu.captureRect', !!a.has)
  check('截图回 PNG data URL', a.prefix === 'data:image/png;base64,', a.prefix)
  check('中心像素 = 铺进去的颜色(rect 坐标系正确)', !!a.px && near(a.px, a.want), a.px && `got rgb(${a.px}) want rgb(18,52,86) rect=${JSON.stringify(a.rect)}`)
  check('最长边压到 1024 以内', !!a.w && Math.max(a.w, a.h) <= 1024, a.w && `${a.w}x${a.h}`)
  check('宽高比与请求矩形一致(没截歪)', !!a.w && Math.abs(a.w / a.h - a.rect.width / a.rect.height) < 0.05, a.w && `${(a.w / a.h).toFixed(3)} vs ${(a.rect.width / a.rect.height).toFixed(3)}`)
  check('过小矩形被挡(返回 null)', a.tiny === null, String(a.tiny).slice(0, 24))

  // ③ zoom≠1:本仓 body 端级 zoom 会把「rect 视口坐标」与「未缩放局部 px」拉开,
  //    截图走的是前者 —— 这条红了说明要么坐标系变了,要么有人加了反补偿。
  const z = await shoot(win, 1.25)
  check('zoom 确实生效(rect 是缩放后的视口坐标)', Math.abs(z.rect.width / a.rect.width - 1.25) < 0.02, `${a.rect.width} → ${z.rect.width}`)
  check('body zoom=1.25 下中心像素依旧正确', !!z.px && near(z.px, z.want), z.px && `got rgb(${z.px}) rect=${JSON.stringify(z.rect)}`)

  await app.close()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
