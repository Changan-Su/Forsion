/**
 * 滚动条**不占布局**契约(2026-08-13 起)。
 *
 * 背景:此前全局写了 `::-webkit-scrollbar{width:8px}` / `.am-app ::-webkit-scrollbar{width:11px}`。
 * Blink 只要匹配到任意一条滚动条伪元素规则就切成 custom scrollbar,而 custom scrollbar **恒占布局宽**,
 * 于是每个滚动区右边都硬留一条槽(用户实报「滚动条占体积」)。删干净 = 交还系统 overlay 滚动条:
 * 悬浮在内容上、不占位。本脚本就是防止哪天有人手一滑再写回去。
 *
 * ⚠️ 必须打**真 Electron**,不能用 playwright 的 chromium:后者恒用 overlay 滚动条,
 *    `offsetWidth - clientWidth` 恒等 0 —— 在那儿跑本脚本必然**全绿且是假绿**。2026-07-30 踩过。
 * ⚠️ gutter 要扣掉 border(offsetWidth-clientWidth 把左右边框也算进去了),否则带边框的容器全是假红。
 *
 *  0 前置:探针确实可滚(不可滚的容器本来就没滚动条,绿了也不算数)
 *  1 普通滚动容器不占位
 *  2 .am-app 内层容器不占位
 *  3 .am-app 自身即滚动容器时不占位
 *  4 内容铺满到容器右缘(= 滚动条悬浮在内容之上,不是被挤到一边)
 *  5 **真实 App 里**所有可滚元素都不占位 —— 扫全页,报出违例者的选择器(这条抓的是局部规则回潮)
 *
 * ⚠️ mac 上滚动条是否 overlay 由**系统设置**决定(设置→外观→显示滚动条;「自动」时插鼠标 = 经典滚动条)。
 *    本脚本红了先看这个:那是系统级选择,页面 CSS 覆盖不了。Win/Linux 由 electron/main.ts 里的
 *    enable-features=…OverlayScrollbar 负责。
 *
 * 需先 npm run build(量的是发布产物里的 base.css / amadeus/styles.css,不是源码)。
 * 用法:npm run check:scrollbar
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

/** 三个探针:普通 / .am-app 内层 / .am-app 自身即滚动容器。刻意给 2px 边框 —— 顺带钉住「gutter 要扣边框」。 */
const INJECT = `
  const base = 'position:fixed;top:120px;width:180px;height:140px;z-index:99999;background:#fff;border:2px solid #ccc;box-sizing:border-box;'
  const mk = (id, cls, left) => {
    const host = document.createElement('div')
    host.className = cls
    host.style.cssText = base + 'left:' + left + 'px;overflow:hidden;min-height:0;border:none;'
    const box = document.createElement('div')
    box.id = id
    // 边框写在**滚动元素自身**:顺带钉住「gutter 要扣边框」,写错了 1/2 就红
    box.style.cssText = 'width:100%;height:100%;overflow:auto;border:2px solid #ccc;box-sizing:border-box;'
    box.innerHTML = '<div id="' + id + '-fill" style="height:1400px;background:#eee"></div>'
    host.appendChild(box)
    document.body.appendChild(host)
  }
  mk('sbA', '', 20)
  mk('sbB', 'am-app', 220)
  const selfHost = document.createElement('div')
  selfHost.className = 'am-app'
  selfHost.id = 'sbC'
  selfHost.style.cssText = base + 'left:420px;overflow:auto;min-height:0;'
  selfHost.innerHTML = '<div id="sbC-fill" style="height:1400px;background:#eee"></div>'
  document.body.appendChild(selfHost)
`

/** 竖向滚动条占掉的布局宽度。offsetWidth-clientWidth 含左右边框,得扣掉。
 *  以源码文本注进页面(不能用 eval/new Function —— 打包版有 CSP)。 */
const GUTTER_SRC = `const gutter = (el) => {
  const s = getComputedStyle(el)
  const b = parseFloat(s.borderLeftWidth || '0') + parseFloat(s.borderRightWidth || '0')
  return Math.round(el.offsetWidth - el.clientWidth - b)
}`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-scrollbar-'))
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
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

  const probe = await win.evaluate(`(() => {
    ${GUTTER_SRC}
    const one = (id) => {
      const el = document.getElementById(id)
      const fill = document.getElementById(id + '-fill')
      return {
        gutter: gutter(el),
        scrollable: el.scrollHeight > el.clientHeight,
        // 内容右缘 vs 容器右缘:占位时内容会被挤窄
        contentGap: Math.round(el.getBoundingClientRect().right - fill.getBoundingClientRect().right),
      }
    }
    return { A: one('sbA'), B: one('sbB'), C: one('sbC') }
  })()`)

  const allScrollable = probe.A.scrollable && probe.B.scrollable && probe.C.scrollable
  check('0 前置:三个探针都真的可滚(否则后面全是空绿)', allScrollable, JSON.stringify({
    A: probe.A.scrollable, B: probe.B.scrollable, C: probe.C.scrollable,
  }))
  check('1 普通滚动容器不占位', probe.A.gutter === 0, `gutter=${probe.A.gutter}px`)
  check('2 .am-app 内层容器不占位', probe.B.gutter === 0, `gutter=${probe.B.gutter}px`)
  check('3 .am-app 自身即滚动容器时不占位', probe.C.gutter === 0, `gutter=${probe.C.gutter}px`)
  // 边框 2px:内容右缘应与容器右缘差整 2px(纯边框),多出来的就是滚动条槽
  check('4 内容铺到右缘(滚动条悬浮在内容上)', probe.A.contentGap === 2, `gap=${probe.A.contentGap}px(应=边框 2px)`)

  const offenders = await win.evaluate(`(() => {
    ${GUTTER_SRC}
    const sel = (el) => el.tagName.toLowerCase()
      + (el.id ? '#' + el.id : '')
      + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')
    return Array.from(document.querySelectorAll('*'))
      .filter((el) => {
        if (el.id && el.id.startsWith('sb')) return false // 探针自己已单独判
        const s = getComputedStyle(el)
        if (!/auto|scroll/.test(s.overflowY) || el.scrollHeight <= el.clientHeight) return false
        return gutter(el) > 0
      })
      .slice(0, 8)
      .map((el) => sel(el) + '(gutter=' + gutter(el) + ')')
  })()`)
  check('5 真实 App 里没有占位的滚动区', offenders.length === 0, offenders.join(' , ') || '扫描通过')

  await app.close()
  const bad = results.filter((r) => !r.ok)
  if (bad.length && process.platform === 'darwin') {
    console.log('\n提示:mac 上滚动条是否 overlay 由 AppleShowScrollBars 决定,页面 CSS 覆盖不了。')
    console.log('     2026-08-14 起 electron/main.ts 会往**本 app 自己的域**写 WhenScrolling 顶掉它 ——')
    console.log('     所以这里再红,先查那段有没有跑到(改过 main.ts 记得 npm run build,out/ 是旧的就白测)。')
    console.log('     唯一故意不顶的情况:全局显式设成「总是显示」(无障碍),那时本 app 会撤掉自己的覆盖。')
    console.log('     查:defaults read -g AppleShowScrollBars / defaults read com.github.Electron AppleShowScrollBars')
  }
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
