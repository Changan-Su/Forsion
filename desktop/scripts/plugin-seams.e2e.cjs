/**
 * 插件宿主四条接缝(2026-08-15)的**真 Electron** 验证:registerSettingsView / registerEditorExtension
 * / loadData·saveData / app.watchFile。
 *
 * 为什么在 `e2e:latex` 之外还要这一条:那支跑的是 web harness —— 真 Chromium、真编辑器、真插件宿主,
 * 但**桥是打桩的**(`window.__ep.loadPlugin` 直接喂代码、`watchFile` 在宿主缺席时根本不存在、
 * `loadData` 走 fallback 分支)。于是「从磁盘发现插件」「设置面板在真插件管理器里」「落盘 + 重启保值」
 * 「禁用后 dispose」「watchFile 走真 VaultWatcher」这五件事**一次都没被验过**。桩会撒谎。
 *
 * 两个被测对象:
 *  ① 真插件 latex-suite(从仓里拷进临时家目录)—— 验「磁盘发现 + README 渲染 + 自绘面板真的画出来」;
 *  ② 探针插件 seamprobe(本文件里生成,~40 行)—— 直接验接缝语义,不依赖 latex-suite 的内部实现,
 *     也不依赖 i18n 文案。计数器挂 `window.__seamprobe`(不放闭包/DOM),这样能跨「禁用→启用」存活。
 *
 * ⚠️ 探针 id 只能 `[a-z0-9][a-z0-9-]*` —— 宿主的 SAFE_PLUGIN_ID 门禁会把 `_` 前缀的整个拒掉
 *    (落盘那侧 amadeus/ipc.ts 与列举那侧 main.ts 用同一条正则,两边必须一致)。
 *
 * 数据全在临时 TANGU_HOME 里,**不碰 ~/.forsion-dev**。
 * 需先 npm run build(跑的是 out/,所以对别人的 HMR 完全免疫)。
 *
 * 用法:npm run e2e:seams   ｜   加 --headed 看着它跑
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const LATEX_SRC = path.join(
  ROOT, '..', '..', 'Forsion-Instrumentality-Project', 'forsion-plugin-latex-suite',
)
const SHOT_DIR = '/tmp'

const results = []
function check(name, ok, detail) {
  // ⚠️ 必须 `!!ok`。断言写成 `a && a.b && a.b.c === x` 时,中途遇 null 会短路成 **null**,
  //    不是 false —— 下面按 `ok === false` 统计就把它漏掉:既不算过也不算败,
  //    而 exit code 只看 failed 数 → **一条真失败能让脚本报绿**。负对照跑出「10+1+1≠13」才看出来的。
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
/** 「未验」也是结论 —— 含糊的 PASS 一律不许出现。 */
function skip(name, why) {
  results.push({ name, skipped: true })
  console.log(`SKIP  ${name}  | 未验:${why}`)
}

/** 负对照开关(交付纪律:断言必须能红)。`--nc=noview` 不注册面板、`--nc=nosave` 存不进去。
 *  期望:noview → T2/T2b/T5* 全红;nosave → T3b/T7 红。全绿说明断言没测到东西。 */
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''

/** 探针插件:裸 setup 体(外置插件是 new Function('ctx', code) 求值的,没有 import)。 */
const PROBE_MAIN = `
const st = (window.__seamprobe = window.__seamprobe || { setups: 0, mounts: 0, disposes: 0, watch: 0 })
st.setups++
st.loaded = false
st.watchable = !!(ctx.app && ctx.app.watchFile)
st.vault = (ctx.app && ctx.app.vaultRoot && ctx.app.vaultRoot()) || ''

ctx.registerSettingsView({
  id: 'probe',
  title: 'Seam Probe',
  mount: function (el) {
    st.mounts++
    el.innerHTML = '<div class="seamprobe-view">probe mounted</div>'
    return function () { st.disposes++ }
  },
})

Promise.resolve(ctx.loadData()).then(function (d) {
  st.loaded = true
  st.data = d === undefined ? null : d
}, function (e) { st.loadErr = String(e) })

if (st.watchable) {
  ctx.app.watchFile('seamprobe.txt', function () { st.watch++ })
}

window.__seamprobeSave = function (v) { return Promise.resolve(ctx.saveData({ v: v })) }
`

function writeProbe(pluginsDir) {
  const dir = path.join(pluginsDir, 'seamprobe')
  fs.mkdirSync(dir, { recursive: true })
  let code = PROBE_MAIN
  if (NC === 'noview') code = code.replace('ctx.registerSettingsView({', 'void 0 && ({')
  if (NC === 'nosave') code = code.replace('ctx.saveData({ v: v })', 'Promise.resolve()')
  if (NC) console.log(`⚠️ 负对照模式 --nc=${NC}:期望相关断言变红\n`)
  fs.writeFileSync(path.join(dir, 'main.js'), code)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: 'seamprobe', name: 'Seam Probe', version: '1.0.0', minAppVersion: '0.0.1',
    description: 'e2e 用的接缝探针,不是产品插件',
  }, null, 2))
}

/** 进设置 → 插件栏。store 没挂 window,只能走真 UI。 */
async function openPluginsTab(win) {
  await win.keyboard.press('Meta+Comma')          // addCommand('open-settings', hotkey mod+,)
  await win.waitForTimeout(900)
  if (!(await win.locator('.settings-main').first().count().catch(() => 0))) {
    await win.locator('#rb-settings, [data-ribbon-id="rb-settings"]').first().click({ timeout: 4000 }).catch(() => {})
    await win.waitForTimeout(900)
  }
  const nav = win.locator('.settings-nav')
  for (const label of ['插件', 'Plugins']) {
    const b = nav.getByRole('button', { name: label, exact: true }).first()
    if (await b.count().catch(() => 0)) {
      await b.scrollIntoViewIfNeeded().catch(() => {})
      await b.click().catch(() => {})
      break
    }
  }
  await win.locator('.settings-sub--amadeus-plugins').first().waitFor({ timeout: 5000 }).catch(() => {})
  await win.waitForTimeout(900)
}

/** 点开某张插件卡的详情页。 */
async function openDetail(win, name) {
  const card = win.locator('.plugin-card--link', { hasText: name }).first()
  if (!(await card.count().catch(() => 0))) return false
  await card.click()
  await win.waitForTimeout(700)
  return true
}

/** 详情页的启用勾选框(唯一一个 checkbox)。 */
async function setEnabled(win, want) {
  const cb = win.locator('input[type="checkbox"]').first()
  if (!(await cb.count().catch(() => 0))) return false
  if ((await cb.isChecked().catch(() => null)) !== want) {
    await cb.click()
    await win.waitForTimeout(1400)   // 装载/卸载 + 落盘
  }
  return true
}

const probeState = (win) => win.evaluate(() => window.__seamprobe || null)

async function launch(home, stubUrl) {
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl },
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 40_000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {              // 首启引导覆盖层
    const b = win.locator(`text=${label}`).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
  await win.waitForTimeout(1200)
  return { app, win }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-seams-'))
  const pluginsDir = path.join(home, 'plugins')
  fs.mkdirSync(pluginsDir, { recursive: true })
  writeProbe(pluginsDir)

  // 预置 Amadeus 配置,让 vaultRoot 启动即有值(T4 要知道往哪写被监听的文件)。
  // 落点 = <userData>/amadeus-config.dev.json,而 dev 态 userData = --user-data-dir 再加 `-dev`
  // 后缀(main.ts:54 干的);isPackaged=false 所以走 .dev 那个文件名。
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(vaultDir, { recursive: true })
  const udDev = path.join(home, 'userdata-dev')
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(path.join(udDev, 'amadeus-config.dev.json'),
    JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }, null, 2))

  // 真插件:只拷运行期需要的文件与包根身份图标,别把 node_modules / src 一起搬进来
  const latexDir = path.join(pluginsDir, 'latex-suite')
  fs.mkdirSync(latexDir, { recursive: true })
  let haveLatex = true
  for (const f of ['main.js', 'manifest.json', 'README.md', 'CHANGELOG.md', 'icon.png']) {
    const src = path.join(LATEX_SRC, f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(latexDir, f))
    else if (f !== 'CHANGELOG.md') haveLatex = false
  }

  let app, win
  try {
    ;({ app, win } = await launch(home, stub.url))
    await openPluginsTab(win)

    // ── T1 从磁盘发现插件(harness 是直接喂代码,这条它测不到)
    const probeCard = await win.locator('.plugin-card--link', { hasText: 'Seam Probe' }).first().count().catch(() => 0)
    check('T1a 探针插件被磁盘发现', !!probeCard)
    if (haveLatex) {
      const latexCard = win.locator('.plugin-card--link', { hasText: 'LaTeX' }).first()
      const lx = await latexCard.count().catch(() => 0)
      check('T1b latex-suite 被磁盘发现且未标「版本过低」', !!lx)
      const iconReady = await latexCard.locator('.plugin-logo__img').evaluate((img) => (
        img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0
      )).catch(() => false)
      check('T1c 插件卡读取包根 icon.png 并显示', iconReady)
      await win.screenshot({ path: path.join(SHOT_DIR, 'seams-plugin-icons.png') }).catch(() => {})
    } else {
      skip('T1b latex-suite 被磁盘发现', '插件源目录缺 main.js/manifest.json/icon.png')
      skip('T1c 插件卡显示 icon.png', '插件源目录不全')
    }

    // ── T2/T3 探针:settingsView 挂载 + loadData 首次为空 + saveData 落盘
    if (!(await openDetail(win, 'Seam Probe'))) throw new Error('打不开探针详情页')
    await setEnabled(win, true)
    let st = await probeState(win)
    check('T2 registerSettingsView 在真插件管理器里挂载', !!st && st.mounts >= 1,
      st ? `mounts=${st.mounts}` : 'window.__seamprobe 不存在')
    check('T2b 面板 DOM 真的进了详情页',
      !!(await win.locator('.seamprobe-view').first().count().catch(() => 0)))
    check('T3a loadData 走真 IPC 返回(首次应为空)', !!st && st.loaded === true && (st.data === null || st.data === undefined),
      st ? `loaded=${st.loaded} data=${JSON.stringify(st.data)}` : '-')

    const dataFile = path.join(home, 'plugins-data', 'seamprobe.json')
    await win.evaluate(() => window.__seamprobeSave('hello-seam'))
    await win.waitForTimeout(1200)
    const onDisk = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : ''
    check('T3b saveData 落到 <home>/plugins-data/<id>.json', onDisk.includes('hello-seam'),
      onDisk ? onDisk.replace(/\s+/g, ' ').slice(0, 80) : '文件不存在')

    // ── T4 watchFile 走真 VaultWatcher
    if (!st || !st.watchable) {
      skip('T4 watchFile 收到外部改动', 'ctx.app.watchFile 缺席(宿主桥没接上)')
    } else if (!st.vault) {
      // 实测(2026-08-18):预置 <userData>/amadeus-config.dev.json 的 lastVault **不够** ——
      // pageStore.vaultRoot 要等 Amadeus 笔记面**首次挂载**才填,而本脚本全程待在设置里。
      // vaultRoot 空 = VaultWatcher 也没在盯任何目录,这时候写文件断言必然假红。
      // 下一步:先把笔记 Space 打开(需要映射 Space/leaf 的导航),再回设置跑 T4。
      skip('T4 watchFile 收到外部改动',
        'vaultRoot 空 —— 要先打开笔记面才会有库;本脚本没进笔记面,VaultWatcher 没在盯目录')
    } else {
      const target = path.join(st.vault, 'seamprobe.txt')
      fs.mkdirSync(st.vault, { recursive: true })
      fs.writeFileSync(target, 'one\n')
      await win.waitForTimeout(1500)
      fs.appendFileSync(target, 'two\n')
      await win.waitForTimeout(2500)
      st = await probeState(win)
      check('T4 watchFile 收到外部改动', !!st && st.watch >= 1, st ? `watch=${st.watch}` : '-')
    }

    // ── T5 禁用要 dispose、重新启用要再挂载(且不重启应用)
    const before = await probeState(win)
    const viewsBefore = await win.locator('.seamprobe-view').count().catch(() => 0)
    await setEnabled(win, false)
    let after = await probeState(win)
    check('T5a 禁用后 settingsView 被 dispose',
      !!after && !!before && after.disposes > before.disposes,
      after ? `disposes=${before ? before.disposes : '?'}→${after.disposes}` : '-')
    // ⚠️ 必须带上「之前确实有」这一半 —— 只断言「现在没有」的话,面板从没挂上过也照样绿
    //    (--nc=noview 负对照就是这么放过去的,是负对照抓出来的同义反复)。
    const viewsAfter = await win.locator('.seamprobe-view').count().catch(() => 1)
    check('T5b 面板 DOM 先有后无', viewsBefore >= 1 && viewsAfter === 0,
      `禁用前=${viewsBefore} 禁用后=${viewsAfter}`)
    await setEnabled(win, true)
    after = await probeState(win)
    check('T5c 重新启用后重新挂载(未重启应用)',
      !!after && after.setups >= 2 && after.mounts >= 2, after ? `setups=${after.setups} mounts=${after.mounts}` : '-')

    // ── T6 latex-suite 的自绘面板在真应用里画得出来(codex 那轮只看到「像是出来了」)
    if (haveLatex) {
      // ⚠️ 必须用**精确文案**「返回列表」。写成 hasText:/返回|Back/ 会同时命中左上角的
      //    「返回应用」(那是关掉设置),`.first()` 按 DOM 序恰好取到它 —— 于是设置被关掉、
      //    插件页的 detail 状态还留在上一个插件上,后面找卡片必然找不到。截图才看出来的。
      for (const label of ['返回列表', 'Back to list']) {
        const b = win.locator(`button:text-is("${label}")`).first()
        if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
      }
      await win.waitForTimeout(900)
      const gotLatex = await openDetail(win, 'LaTeX')
      if (!gotLatex) await win.screenshot({ path: path.join(SHOT_DIR, 'seams-nolatex.png') }).catch(() => {})
      if (gotLatex) {
        await setEnabled(win, true)
        await win.waitForTimeout(1800)
        const mdNodes = await win.locator('.md-body h1, .md-body h2, .md-body code, .md-body li').count().catch(() => 0)
        check('T6a README 渲染成 DOM(不是裸文本)', mdNodes > 0, `节点数=${mdNodes}`)
        const cm = await win.locator('.cm-editor').count().catch(() => 0)
        check('T6b 自绘面板里是真代码编辑器(CodeMirror)', cm > 0, `.cm-editor=${cm}`)
      } else skip('T6 latex-suite 自绘面板', '详情页打不开')
    } else skip('T6 latex-suite 自绘面板', '插件源目录不全')

    // ── T7 重启应用后 loadData 读回刚存的值(真 IPC 完整往返)
    await app.close().catch(() => {})
    ;({ app, win } = await launch(home, stub.url))
    await win.waitForTimeout(1500)
    const st2 = await probeState(win)
    check('T7 重启后 loadData 读回上次 saveData 的值',
      !!st2 && st2.loaded === true && st2.data && st2.data.v === 'hello-seam',
      st2 ? JSON.stringify(st2.data) : 'window.__seamprobe 不存在')
  } catch (e) {
    console.error('\n跑挂了:', e && e.message ? e.message : e)
    if (win) await win.screenshot({ path: path.join(SHOT_DIR, 'seams-crash.png') }).catch(() => {})
    check('脚本跑完', false, String(e && e.message ? e.message : e))
  } finally {
    if (win) {
      const bad = results.some((r) => r.ok === false)
      if (bad) await win.screenshot({ path: path.join(SHOT_DIR, 'seams-fail.png') }).catch(() => {})
      const errs = await win.evaluate(() => (window.__e2eConsoleErrors || []).slice(0, 5)).catch(() => [])
      if (errs.length) console.log('\n控制台错误:', JSON.stringify(errs))
    }
    if (app) await app.close().catch(() => {})
    try { stub.close?.() } catch { /* 同步 close,没有 promise 可 catch */ }
    fs.rmSync(home, { recursive: true, force: true })
  }

  const pass = results.filter((r) => r.ok === true).length
  const fail = results.filter((r) => r.ok === false).length
  const sk = results.filter((r) => r.skipped).length
  console.log(`\n${pass} passed / ${fail} failed / ${sk} 未验  (共 ${results.length})`)
  if (fail) console.log('失败截图:/tmp/seams-fail.png')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
