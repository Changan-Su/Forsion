/**
 * 顶部 chrome 的**纵向堆栈**契约 —— tab 栏 / 主区纸卡 / ribbon 三条上边界的相对关系。
 *
 * 为什么必须打真 App:这套堆栈横跨 engine.css(tab 栏高、纸卡 gutter)、dockview 自己的布局、
 * mac 的交通灯避让(`[data-platform='mac'] .rb { padding-top: 30px }`,它**替换**而非叠加 .rb 的
 * 8px)。合成页面复刻不出来 —— 2026-07-30 我就是靠读 CSS 心算,把 ribbon 首按钮算成 38(实为 30)、
 * 又把用户说的「空白」认成聊天流内部 padding,改错地方交付了一轮。这支脚本是那次的产物。
 *
 *  A 主区纸卡上边界 ≈ ribbon 第一个按钮上边界(差 ≤4px)。这是「顶部对齐」的唯一硬判据。
 *  B tab 胶囊完整落在 tab 栏内,上下各留 ≥1px —— 压 tab 栏高度时最先崩的就是它。
 *  C 纸卡顶贴 tab 栏(gutter 0),左右仍留 8px:浮卡观感靠三边 + 圆角,不靠顶边。
 *  D 侧栏(图标 tab)组不吃纸卡 gutter —— 那条规则本就 :not(:has(.wb-tab--icon)),别被误改成全局。
 *
 * 改 --dv-tabs-and-actions-container-height / .dv-content-container padding / .rb padding 后必跑。
 * 需要先 npm run build。跑:node scripts/top-chrome.check.cjs
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

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-topchrome-'))
  let app
  try {
    app = await electron.launch({
      // ⚠️独立 userData:与开发者自己的 dev 实例共用目录会卡死在 requestSingleInstanceLock(无窗口无日志)。
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
  // 引导向导会整窗盖住工作区 → 点掉它,否则量到的是向导的盒子
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(2000)

  const g = await win.evaluate(() => {
    const groups = [...document.querySelectorAll('.dv-groupview')]
    const main = groups.find((x) => !x.querySelector('.wb-tab--icon'))
    const side = groups.find((x) => x.querySelector('.wb-tab--icon'))
    const box = (el) => (el ? el.getBoundingClientRect() : null)
    // ⚠️.dv-tab 内部也有一个 .dv-react-part(自定义 tab 渲染器)—— 直接 querySelector 会抓到它
    //   而不是内容区。必须用 > 直系选择器。踩过。
    const card = main.querySelector('.dv-content-container > .dv-react-part')
    const content = main.querySelector('.dv-content-container')
    const tabs = main.querySelector('.dv-tabs-and-actions-container')
    const pill = main.querySelector('.dv-tab')
    const cs = getComputedStyle(content)
    return {
      cardTop: +box(card).top.toFixed(1),
      cardLeft: +box(card).left.toFixed(1),
      contentLeft: +box(content).left.toFixed(1),
      padTop: cs.paddingTop, padLeft: cs.paddingLeft,
      tabsTop: +box(tabs).top.toFixed(1), tabsBottom: +box(tabs).bottom.toFixed(1),
      pillTop: +box(pill).top.toFixed(1), pillBottom: +box(pill).bottom.toFixed(1),
      rbBtnTop: +box(document.querySelector('.rb .rb-btn')).top.toFixed(1),
      sidePadTop: side ? getComputedStyle(side.querySelector('.dv-content-container')).paddingTop : 'n/a',
      // 各列视图容器的上边界(应当同线)+ 左侧栏第一个可见元素(它的内部留白最容易掉队)
      viewTops: [...document.querySelectorAll('.wb-view')].map((v) => +box(v).top.toFixed(1)),
      sideFirstTop: (() => {
        const v = document.querySelector('.wb-view--left')
        if (!v) return null
        const kid = [...(v.firstElementChild?.children || [])].find((c) => c.getBoundingClientRect().height > 0)
        return kid ? +box(kid).top.toFixed(1) : null
      })(),
    }
  })

  check('A 主区纸卡上边界与 ribbon 首按钮基本齐平(差 ≤4px)', Math.abs(g.cardTop - g.rbBtnTop) <= 4,
    `纸卡=${g.cardTop} ribbon=${g.rbBtnTop} 差=${(g.cardTop - g.rbBtnTop).toFixed(1)}`)
  check('B tab 胶囊完整落在 tab 栏内且上下各留 ≥1px',
    g.pillTop - g.tabsTop >= 1 && g.tabsBottom - g.pillBottom >= 1,
    `栏=${g.tabsTop}~${g.tabsBottom} 胶囊=${g.pillTop}~${g.pillBottom}`)
  check('C 纸卡顶贴 tab 栏(gutter 0)', parseFloat(g.padTop) === 0 && Math.abs(g.cardTop - g.tabsBottom) <= 0.5,
    `padTop=${g.padTop} 纸卡顶=${g.cardTop} 栏底=${g.tabsBottom}`)
  check('C 左右仍留 8px gutter(浮卡观感靠三边)', parseFloat(g.padLeft) === 8 && Math.abs(g.cardLeft - g.contentLeft - 8) <= 0.5,
    `padLeft=${g.padLeft} 实测=${(g.cardLeft - g.contentLeft).toFixed(1)}`)
  check('D 侧栏(图标 tab)组不吃纸卡 gutter', g.sidePadTop === '0px' || g.sidePadTop === 'n/a', `sidePadTop=${g.sidePadTop}`)
  check('E 各列视图容器上边界同线', new Set(g.viewTops).size === 1, `viewTops=${g.viewTops.join(',')}`)
  // 容器同线还不够 —— 用户看的是「第一个看得见的东西」。左侧栏内部留白(.t2s-vaultseg / .t2s-search)
  // 掉队时容器仍在 32,但首元素掉到 44,观感就是「侧栏比主区矮一截」。2026-07-30 用户实报过一次。
  check('F 左侧栏首元素不比主区纸卡低太多(≤6px)', g.sideFirstTop === null || g.sideFirstTop - g.cardTop <= 6,
    `侧栏首元素=${g.sideFirstTop} 纸卡=${g.cardTop} 差=${g.sideFirstTop === null ? 'n/a' : (g.sideFirstTop - g.cardTop).toFixed(1)}`)

  await app.close()
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
