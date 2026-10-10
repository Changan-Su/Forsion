/**
 * 「插件开着、它带的 Space 却没出现」时宿主把原因摆出来 —— 真 Electron × 真主进程读盘 × 真插件宿主。
 * 起因(2026-10-10):一份用户插件的 main.js 有个函数没收口,把 registerView 包了进去;求值不报错、零注册,
 * 随包 Space 被跳过,而原因只进了渲染端控制台。
 *
 * 种两份插件:坏的(同款写法)和好的(负对照:徽标不许出现在它身上)。钉四件事:
 * ① 好的那个 Space 在功能条上、坏的不在;② 命令面板的「插件状态」打开插件设置页(同一条命令也是 agent 读宿主记录的入口);
 * ③ 坏插件的卡片挂「Space 未显示」、好的不挂;④ 详情面说清是哪个视图没注册、问题在插件自己的 main.js。
 *
 * 需先 npm run build。用法:npm run check:spacehidden      截图落 outputs/plugin-space-hidden/,观感要人看。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'outputs', 'plugin-space-hidden')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-spacehidden-'))
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const write = (rel, data) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data) }
const manifest = (id, name) => JSON.stringify({ id, name, version: '1.0.0', apiVersion: 1, main: 'main.js' })
const space = (id, zh, en, view) => JSON.stringify({ id, name: { zh, en }, icon: 'boxes', layout: { main: [{ type: view }], left: [], right: [] }, requires: { views: [view] } })

// 坏的:render 少一个收口的 },文件末尾多补了一个凑平 —— 语法合法、求值不抛错,registerView 落在没人调用的函数里。
write('plugins/cad-dir/manifest.json', manifest('cad-probe', 'CAD Probe'))
write('plugins/cad-dir/main.js', [
  'function render(el) {',
  "  const draw = () => { el.textContent = 'mesh' }",
  '  draw()',
  "ctx.registerView({ id: 'mesh', title: 'Mesh', mount(el) { render(el) } })",
  '}',
].join('\n'))
write('plugins/cad-dir/spaces/cad-mesh/space.json', space('cad-mesh', '网格工作台', 'Mesh workbench', 'plugin:cad-probe:mesh'))
// 好的(负对照)
write('plugins/good-dir/manifest.json', manifest('good-probe', 'Good Probe'))
write('plugins/good-dir/main.js', "ctx.registerView({ id: 'desk', title: 'Desk', mount(el) { el.textContent = 'desk' } })\n")
write('plugins/good-dir/spaces/good-desk/space.json', space('good-desk', '好桌面', 'Good desk', 'plugin:good-probe:desk'))

async function until(fn, ms = 20_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await fn().catch(() => null)
    if (got || Date.now() > deadline) return got
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  fs.mkdirSync(OUT, { recursive: true })
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
    const more = win.locator('.rb-top .rb-more').first()
    await more.waitFor({ timeout: 15_000 }).catch(() => {})
    if (await more.count()) { await more.click(); await win.waitForTimeout(400) }
    const onRibbon = (id) => win.locator(`.rb-slot[data-id="space:${id}"]`).count()
    check('好插件的 Space 在功能条上(负对照)', await until(() => onRibbon('good-desk')))
    check('坏插件的 Space 不在功能条上', (await onRibbon('cad-mesh')) === 0)
    await win.evaluate(() => document.querySelector('.rb-open-top .rb-more')?.click())

    // 命令面板 → 「插件状态」→ 设置窗口落在插件页
    await win.keyboard.press('Meta+k')
    await win.locator('.cmd-input:visible').fill('插件状态')
    await win.locator('.cmd-item', { hasText: '插件状态' }).first().click()
    const settings = await until(async () => {
      for (const w of app.windows()) {
        if (w.url().includes('window=floating') && !w.isClosed() && await w.locator('.settings-sub--amadeus-plugins').count()) return w
      }
      return null
    })
    check('命令面板的「插件状态」打开插件设置页', !!settings, settings ? '' : app.windows().map((w) => w.url().replace(/^.*[/\\]/, '')).join(' | '))
    if (!settings) { // 留一张现场:是窗口没开、开错了页,还是插件没列出来
      for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(OUT, `fail-window-${i}.png`) }).catch(() => {})
      return
    }

    // 插件页先落在「核心插件」分段,装的插件在「已安装插件」里
    await settings.locator(':text-is("已安装插件"):visible').first().click() // 同名的还有一份窄屏用的隐藏导航项
    const badge = settings.locator('[data-plugin-id="cad-probe"] [data-plugin-space-hidden]')
    const shown = await until(() => badge.count())
    check('坏插件的卡片挂「Space 未显示」', shown && (await badge.first().textContent()) === 'Space 未显示', shown ? await badge.first().textContent() : '没有徽标')
    check('徽标悬停带原因', /mesh/.test((await badge.first().getAttribute('title').catch(() => '')) || ''), await badge.first().getAttribute('title').catch(() => ''))
    check('好插件的卡片不挂', (await settings.locator('[data-plugin-id="good-probe"] [data-plugin-space-hidden]').count()) === 0)
    await settings.evaluate(() => document.fonts.ready)
    await settings.locator('[data-plugin-id="cad-probe"]').scrollIntoViewIfNeeded()
    await settings.screenshot({ path: path.join(OUT, 'list.png') })

    await settings.locator('[data-plugin-id="cad-probe"]').click()
    const list = settings.locator('[data-plugin-detail="cad-probe"] [data-plugin-space-hidden-list]')
    const text = (await until(() => list.count())) ? await list.innerText() : ''
    check('详情面点名 Space、没注册的视图、问题在插件自己的 main.js', /网格工作台/.test(text) && /视图 mesh 没有注册/.test(text) && /main\.js/.test(text), text.replace(/\s+/g, ' '))
    check('详情面不把完整视图类型 / 原始校验串当正文', !/plugin:cad-probe|引用了未注册/.test(text))
    await settings.screenshot({ path: path.join(OUT, 'detail.png') })
    console.log(`截图: ${OUT}`)
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().then(() => {
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed`)
  process.exit(bad.length || !results.length ? 1 : 0)
}).catch((e) => { console.error(e); process.exit(1) })
