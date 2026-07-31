/**
 * 滚动条自动隐现的**像素级**契约:静止透明 / 滚动中显形 / 停手后淡回去 / 只亮正在滚的那个。
 *
 * ⚠️ 为什么必须打真 Electron,不能用 playwright 的 chromium:
 *    无头 chromium 用 **overlay 滚动条**(不占布局、`::-webkit-scrollbar` 整套被忽略),
 *    实测 `offsetWidth - clientWidth === 0`、截图里一根滚动条都画不出来 —— 在那儿跑必然全红,
 *    而且是**假红**。真 Electron 里同一段 CSS 拿到 gutter=8 的经典滚动条。2026-07-30 踩过,别再搬回去。
 *
 * ⚠️ 为什么量像素而不是量 CSS:webkit 滚动条伪元素读不到 computed style
 *    (`getComputedStyle(el, '::-webkit-scrollbar-thumb')` 给的是元素自己的样式)。而
 *    「transition 作用不作用在滚动条伪元素上」「`[data-scrolling]::-webkit-scrollbar-thumb` 选不选得中」
 *    恰恰会**静默失效** —— 写错就是滚动条永远不出现,零报错。故:截图 → 回灌页面用 canvas 解码 → 读像素。
 *
 *  A 静止时滚动条那一列 ≈ 容器底色(看不见)
 *  B 滚动后显形
 *  C 停手 IDLE_MS 后淡回底色
 *  D 标记只打在正在滚的元素上 —— 滚 A 时 B 不许一起亮(打 <html> 就会全亮)
 *  E Amadeus 两条选择器(.am-app 自身滚 / 内层滚)都覆盖到
 *
 * 探针元素注进**真实运行的 App**,所以量的是发布产物里的 base.css / amadeus/styles.css /
 * main.tsx 里那次 installScrollFade() —— 不是复刻件。需先 npm run build。
 * 改 scrollFade.ts 或两处 ::-webkit-scrollbar-thumb 规则后必跑:node scripts/scroll-fade.check.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 四个探针:两个普通(验「只亮在滚的那个」)、一个 .am-app 内层、一个 .am-app 自身即滚动容器。
 *  底色写死白、thumb 色写死黑 —— 像素判定不受主题 token 漂移影响。 */
const INJECT = `
  const mk = (id, cls, left) => {
    const host = document.createElement('div')
    host.className = cls
    host.style.cssText = 'position:fixed;top:120px;left:' + left + 'px;width:180px;height:140px;z-index:99999;'
      + 'background:#fff;overflow:hidden;min-height:0;'
      + '--overlay-medium:#000;--overlay-strong:#000;--border-strong:#000;--text-muted:#000;'
    const box = document.createElement('div')
    box.id = id
    box.style.cssText = 'width:100%;height:100%;overflow:auto;background:#fff;'
      + '--overlay-medium:#000;--overlay-strong:#000;--border-strong:#000;--text-muted:#000;'
    box.innerHTML = '<div style="height:1400px"></div>'
    host.appendChild(box)
    document.body.appendChild(host)
    return box
  }
  mk('sbA', '', 20)
  mk('sbB', '', 220)
  mk('sbC', 'am-app', 420)
  // .am-app 自身就是滚动容器
  const selfHost = document.createElement('div')
  selfHost.className = 'am-app'
  selfHost.id = 'sbD'
  selfHost.style.cssText = 'position:fixed;top:120px;left:620px;width:180px;height:140px;z-index:99999;'
    + 'background:#fff;overflow:auto;min-height:0;'
    + '--overlay-medium:#000;--overlay-strong:#000;--border-strong:#000;--text-muted:#000;'
  selfHost.innerHTML = '<div style="height:1400px"></div>'
  document.body.appendChild(selfHost)
`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-scrollfade-'))
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
      cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
    })
  } catch (e) {
    console.error('启动失败。若已有 dev 版 Electron 在跑,先 pkill -f "node_modules/electron/dist/Electron.app"(单实例锁)。')
    throw e
  }
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 30_000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1500)
  await win.evaluate(INJECT)
  await win.waitForTimeout(400)

  const gutter = await win.evaluate(() => {
    const e = document.getElementById('sbA')
    return e.offsetWidth - e.clientWidth
  })
  check('0 前置:经典滚动条确实占位(否则后面全是假红)', gutter >= 6, `gutter=${gutter}px`)

  /** 截图 → 回灌页面用 canvas 解码 → 读某元素滚动条那一列的最深像素(0=黑,255=白)。 */
  const darkest = async (id) => {
    const b64 = (await win.screenshot()).toString('base64')
    return win.evaluate(async ({ b64, id }) => {
      const img = new Image()
      img.src = 'data:image/png;base64,' + b64
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const r = document.getElementById(id).getBoundingClientRect()
      const dpr = img.width / window.innerWidth
      // 滚动条落在容器右缘 8px 内;只扫上半段(刚滚一点点时 thumb 在那儿)
      const x0 = Math.round((r.right - 8) * dpr), x1 = Math.round((r.right - 1) * dpr)
      const y0 = Math.round((r.top + 4) * dpr), y1 = Math.round((r.top + 45) * dpr)
      const d = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data
      let min = 255
      for (let i = 0; i < d.length; i += 4) min = Math.min(min, (d[i] + d[i + 1] + d[i + 2]) / 3)
      return Math.round(min)
    }, { b64, id })
  }
  const scroll = (id) => win.evaluate((id) => { document.getElementById(id).scrollTop = 70 }, id)

  const idleA = await darkest('sbA')
  check('A 静止时滚动条不可见(≈底色)', idleA > 230, `最深像素=${idleA}(白=255)`)

  await scroll('sbA')
  await win.waitForTimeout(250) // 等 0.12s 淡入
  const movingA = await darkest('sbA')
  check('B 滚动后滚动条显形', movingA < 170, `最深像素=${movingA}`)

  const otherB = await darkest('sbB')
  check('D 只有正在滚的元素亮(旁边那个仍不可见)', otherB > 230, `sbB 最深像素=${otherB}`)

  await win.waitForTimeout(1600) // IDLE_MS 900 + 淡出 350
  const restA = await darkest('sbA')
  check('C 停止滚动后淡回不可见', restA > 230, `最深像素=${restA}`)

  await scroll('sbC')
  await win.waitForTimeout(250)
  check('E .am-app 内层容器滚动时显形', (await darkest('sbC')) < 170)
  await win.waitForTimeout(1600)

  await scroll('sbD')
  await win.waitForTimeout(250)
  check('E .am-app 自身即滚动容器时也显形(少写这条选择器会漏一半)', (await darkest('sbD')) < 170)

  await app.close()
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
