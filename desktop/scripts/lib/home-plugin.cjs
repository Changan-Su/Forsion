/**
 * 主页台架的插件档(2026-10-18,主页插件化 B 第 3 步;照日历的 CALENDAR_PLUGIN_DIR)。
 * HOME_PLUGIN_DIR=<Forsion-Home 检出,先 npm run build> 时:把打好的插件(manifest.json + main.js)装进台架的隔离 home,
 * 渲染层起来后写 dev 的 `forsion.dev.coreTrial`(shared/corePlugins 的 canClaimHostView 认它)再 reload ——
 * 主页视图芯由插件接管,同一套检查对插件版跑。没设 = 内置档,这里全是空操作。
 *
 * ⚠️插件挂不上(main.js 抛错、缺接缝、没认领上)时宿主会**悄悄退回内置主页**,整套检查照样绿。
 * 所以插件档下每次进主页都要核一遍正文真的来自插件(pluginBody),对不上就是红的。
 */
const fs = require('fs')
const path = require('path')

const DIR = process.env.HOME_PLUGIN_DIR ? path.resolve(process.env.HOME_PLUGIN_DIR) : ''

/** 装进隔离 home 的 plugins/forsion-home(启动前调)。 */
function installHomePlugin(home) {
  if (!DIR) return
  for (const f of ['manifest.json', 'main.js']) {
    const src = path.join(DIR, f)
    if (!fs.existsSync(src)) throw new Error(`HOME_PLUGIN_DIR 里缺 ${f}(先在 Forsion-Home 跑 npm run build):${src}`)
    fs.mkdirSync(path.join(home, 'plugins', 'forsion-home'), { recursive: true })
    fs.copyFileSync(src, path.join(home, 'plugins', 'forsion-home', f))
  }
}

/** 渲染层第一次起来后调:写 coreTrial 并 reload(同一份 user-data-dir 里只做一次)。返回是否 reload 过。 */
async function claimHomeView(win) {
  if (!DIR) return false
  const had = await win.evaluate(() => localStorage.getItem('forsion.dev.coreTrial') === 'forsion-home')
  if (had) return false
  await win.evaluate(() => localStorage.setItem('forsion.dev.coreTrial', 'forsion-home'))
  await win.reload({ waitUntil: 'domcontentloaded' })
  return true
}

/** 此刻看得见的主页是谁画的:'plugin' / 'builtin' / null(没有主页)。插件版会先短暂露出内置那份(插件异步装载),所以等一会儿再判。
 *  want = 等它变成哪一份(停用插件后等它换回内置就传 'builtin')。 */
async function homeBody(win, timeout = 15_000, want = 'plugin') {
  const read = () => win.evaluate(() => {
    const root = [...document.querySelectorAll('.hp-root')].find((e) => e.getBoundingClientRect().width > 0)
    if (!root) return null
    return root.closest('[data-home-body="plugin"]') && document.querySelector('style[data-plugin="forsion-home"]') ? 'plugin' : 'builtin'
  })
  if (!DIR) return read()
  const until = Date.now() + timeout
  let body = await read()
  while (body !== want && Date.now() < until) { await win.waitForTimeout(250); body = await read() }
  return body
}

module.exports = { HOME_PLUGIN_DIR: DIR, installHomePlugin, claimHomeView, homeBody }
