/**
 * 前台窗口采样接缝 —— 真 Electron × 真主进程 IPC × 真子进程探针。
 *
 * 单测(electron/activeWindow.test.ts)验的是解析器与闸门逻辑;这里验台架看不见的那半:
 * IPC 通道真的接上了、preload 真的暴露了、**默认拒真的是默认**、开关拨了立刻生效、
 * 没在 manifest 里声明能力的插件真的连 ctx.system 都摸不到、调试面板真的画出来。
 *
 * 需先 npm run build。用法:npm run e2e:activewindow
 * 负对照:--nc=nocap(声明也不写进 manifest)—— 期望 T4a 变红。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = '/tmp'
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''

const results = []
function check(name, ok, detail) {
  // ⚠️ 必须 !!ok:`a && a.b === x` 遇 null 会短路成 null,按 ok===false 统计就漏项 → 假绿。
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
function skip(name, why) {
  results.push({ name, skipped: true })
  console.log(`SKIP  ${name}  | 未验:${why}`)
}

/** 两个探针插件:一个在 manifest 里声明了 activeWindow 能力,一个没声明。 */
const PROBE_MAIN = [
  'window.__awprobe = window.__awprobe || {}',
  'window.__awprobe[PLUGIN_TAG] = {',
  '  hasSystem: !!(ctx && ctx.system),',
  '  call: function () { return ctx.system ? ctx.system.activeWindow() : Promise.resolve("no-seam") },',
  '}',
].join('\n')

function writeProbe(pluginsDir, id, caps) {
  const dir = path.join(pluginsDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'main.js'), PROBE_MAIN.replace(/PLUGIN_TAG/g, JSON.stringify(id)))
  const manifest = { id, name: id, version: '1.0.0', minAppVersion: '0.0.1', description: 'e2e 用的接缝探针,不是产品插件' }
  // 负对照 nocap:把「声明了」的那个也去掉声明 —— T4a 若仍绿,说明能力闸根本没被测到。
  if (caps && NC !== 'nocap') manifest.capabilities = caps
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

/** 从 renderer 直接打接缝(preload → IPC → 主进程),这是产品路径,不是桩。 */
const probeSeam = (win) => win.evaluate(() => window.tangu && window.tangu.activeWindow ? window.tangu.activeWindow() : 'no-preload')
const setFlag = (win, on) => win.evaluate((v) => window.tangu.setConfig({ activeWindowEnabled: v }), on)
// 面板根挂了 data-view="active-window"(专为这条断言留的稳定钩子),别拿 dockview 的容器类猜。
const panelText = (win) => win.evaluate(() => {
  const el = document.querySelector('[data-view="active-window"]')
  return el ? el.textContent || '' : '(面板不在 DOM 里)'
})

/** 进设置某一页(store 没挂 window,只能走真 UI)。 */
async function openSettings(win) {
  // ribbon 按钮没有 id/data 属性(只有 title),热键 mod+, 是 addCommand 注册的,最稳。
  await win.keyboard.press('Meta+Comma').catch(() => {})
  await win.waitForTimeout(1200)
  return (await win.locator('.settings-main').first().count().catch(() => 0)) > 0
}
async function goTab(win, labels) {
  const nav = win.locator('.settings-nav')
  for (const l of labels) {
    const b = nav.getByRole('button', { name: l, exact: true }).first()
    if (await b.count().catch(() => 0)) {
      await b.scrollIntoViewIfNeeded().catch(() => {})
      await b.click().catch(() => {})
      await win.waitForTimeout(600)
      return true
    }
  }
  return false
}

async function launch(home, stubUrl) {
  const app = await electron.launch({
    args: ['--user-data-dir=' + path.join(home, 'userdata'), '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: Object.assign({}, process.env, { TANGU_HOME: home, TANGU_BACKEND_URL: stubUrl }),
  })
  const win = await app.firstWindow()
  await win.waitForSelector('#root', { timeout: 40000 })
  await win.waitForTimeout(2500)
  for (const label of ['跳过引导', 'Skip']) {
    const b = win.locator('text=' + label).first()
    if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
  }
  await win.waitForSelector('.dv-groupview', { timeout: 40000 })
  await win.waitForTimeout(1200)
  return { app: app, win: win }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  if (NC) console.log('⚠️ 负对照模式 --nc=' + NC + ':期望相关断言变红\n')

  const stub = await startStubEngine({ sessions: [], messages: [], models: [] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-aw-'))
  const pluginsDir = path.join(home, 'plugins')
  fs.mkdirSync(pluginsDir, { recursive: true })
  writeProbe(pluginsDir, 'awprobe-declared', ['activeWindow'])
  writeProbe(pluginsDir, 'awprobe-silent', null)

  let app = null
  let win = null
  let sample = null
  try {
    const r = await launch(home, stub.url)
    app = r.app
    win = r.win

    // ── T1 默认拒:全新 profile,谁都没碰过开关 ──────────────────────────
    const first = await probeSeam(win)
    check('T1a preload 暴露了 activeWindow(通道接上了)', first !== 'no-preload')
    check('T1b 默认关:接缝恒回 null(不是「有方法就有数据」)', first === null, 'got=' + JSON.stringify(first))
    const cfg0 = await win.evaluate(() => window.tangu.getConfig())
    check('T1c 配置默认 activeWindowEnabled 非 true', cfg0.activeWindowEnabled !== true, 'got=' + cfg0.activeWindowEnabled)

    // ── T2 拨开开关 → 立刻拿到真数据(不用重启)────────────────────────
    await setFlag(win, true)
    await win.waitForTimeout(400)
    sample = await probeSeam(win)
    const ok = sample && typeof sample === 'object'
    check('T2a 开关拨开后拿到样本(config:set 当场刷新开关镜像)', ok, 'got=' + JSON.stringify(sample))
    check('T2b app 名非空 —— 真的探到了前台应用', ok && typeof sample.app === 'string' && sample.app.length > 0, ok ? 'app=' + sample.app : '')
    check('T2c platform 与宿主一致', ok && sample.platform === process.platform, ok ? 'platform=' + sample.platform : '')
    check('T2d idleSeconds 是数字(消费方靠它丢挂机段)', ok && typeof sample.idleSeconds === 'number' && sample.idleSeconds >= 0, ok ? 'idle=' + (ok && sample.idleSeconds) : '')
    if (process.platform === 'darwin') {
      check('T2e darwin:有 bundleId、title 恒空(标题属 Screen Recording 权限)', ok && !!sample.bundleId && sample.title === '', ok ? 'bundle=' + sample.bundleId + ' title=' + JSON.stringify(sample.title) : '')
    } else {
      skip('T2e darwin 专属字段', '本机是 ' + process.platform)
    }

    // ── T3 关回去 → 立刻恒 null(开关是双向的,不是一次性解锁)──────────
    await setFlag(win, false)
    await win.waitForTimeout(400)
    check('T3 关回去后恒 null', (await probeSeam(win)) === null)

    // ── T4 ctx.system 的 manifest 能力闸(默认拒的第二道)──────────────
    await setFlag(win, true)
    await win.waitForTimeout(400)
    const cap = await win.evaluate(async () => {
      const p = window.__awprobe || {}
      const one = async (k) => {
        if (!p[k]) return { missing: true }
        const r = await p[k].call().catch((e) => 'threw:' + e)
        return { hasSystem: p[k].hasSystem, result: r && typeof r === 'object' ? 'sample' : r }
      }
      return { declared: await one('awprobe-declared'), silent: await one('awprobe-silent') }
    })
    if (cap.declared.missing || cap.silent.missing) {
      skip('T4 ctx.system 能力闸', '探针插件没被加载/启用(外置插件默认关?)')
    } else {
      check('T4a 声明了 capabilities 的插件拿到 ctx.system 并读到样本', cap.declared.hasSystem === true && cap.declared.result === 'sample', JSON.stringify(cap.declared))
      check('T4b 没声明的插件连 ctx.system 都没有', cap.silent.hasSystem === false, JSON.stringify(cap.silent))
    }

    // ── T5 走真 UI:关于页连点版本号 10 次解锁开发者选项 → 拨开关 → ⌘K 开面板 ──
    //    这一段刻意不走 setConfig 抄近路:开关和 ⌘K 入口的联动就住在 SettingsModal 里,
    //    抄近路等于把要验的那根线换成桩。先把上面直接改的配置关回去,从「没开」开始。
    await setFlag(win, false)
    await win.waitForTimeout(300)
    let uiToggled = false
    if (await openSettings(win)) {
      await goTab(win, ['关于', 'About'])
      const ver = win.locator('.settings-main .hint').filter({ hasText: /^(版本|Version)\s/ }).first()
      if (await ver.count().catch(() => 0)) {
        for (let i = 0; i < 10; i++) { await ver.click().catch(() => {}); await win.waitForTimeout(60) }
      }
      await win.waitForTimeout(400)
      if (await goTab(win, ['开发者选项', 'Developer options'])) {
        const row = win.locator('.settings-main .field').filter({ hasText: /前台窗口采样|Active window sampling/ }).first()
        const box = row.locator('input[type="checkbox"]').first()
        if (await box.count().catch(() => 0)) { await box.check().catch(() => {}); uiToggled = true }
      }
      await win.waitForTimeout(600)
    }
    check('T5a 开发者选项里的「前台窗口采样」开关拨得动', uiToggled)
    const cfgUi = await win.evaluate(() => window.tangu.getConfig())
    check('T5b 拨开关真的写进了主进程配置', cfgUi.activeWindowEnabled === true, 'got=' + cfgUi.activeWindowEnabled)

    // 关掉设置。⚠️按钮一律用精确文案:hasText 的正则会把别的「返回」也命中。
    await win.locator('.settings-nav button:text-is("返回应用"), .settings-nav button:text-is("Back to app")').first().click({ timeout: 5000 }).catch(() => {})
    await win.waitForTimeout(800)
    check('T5b2 设置面板已关闭(后面的面板断言不是隔着遮罩读的)', (await win.locator('.settings-main').count().catch(() => 1)) === 0)
    let opened = false
    await win.keyboard.press('Meta+k').catch(() => {})
    await win.waitForTimeout(800)
    const palette = win.locator('.cmd-input').first()
    if (await palette.count().catch(() => 0)) {
      await palette.fill('前台窗口').catch(() => {})
      await win.waitForTimeout(500)
      const item = win.locator('.cmd-item', { hasText: '前台窗口采样' }).first()
      if (await item.count().catch(() => 0)) { await item.click().catch(() => {}); opened = true }
    }
    await win.waitForTimeout(2800) // 面板首轮采样 + 一次轮询
    if (!opened) {
      skip('T5c 面板经命令面板打开', '命令面板里没有「前台窗口采样」这一条')
      skip('T5d 面板里出现真实 app 名', '面板没打开')
      skip('T6 关掉后面板的空态', '面板没打开')
    } else {
      const txt = await panelText(win)
      check('T5c 面板显示「接缝已开启」', /接缝已开启|Seam enabled/.test(txt))
      check('T5d 面板里出现了真实 app 名', !!(sample && sample.app && txt.includes(sample.app)), sample ? 'app=' + sample.app : '')
      await win.screenshot({ path: path.join(SHOT_DIR, 'active-window-panel.png') }).catch(() => {})

      // ── T6 面板对「关着」有明确空态(不是空白)────────────────────────
      await setFlag(win, false)
      await win.waitForTimeout(5000) // 面板 4s 轮询一次开关态
      const offText = await panelText(win)
      check('T6 关掉后面板显示「接缝未开启」+ 去开发者选项的指引',
        /接缝未开启|Seam disabled/.test(offText) && /开发者选项|Developer options/.test(offText))
      await win.screenshot({ path: path.join(SHOT_DIR, 'active-window-panel-off.png') }).catch(() => {})
    }
  } catch (e) {
    console.error('\n跑挂了:', e && e.message)
    if (win) await win.screenshot({ path: path.join(SHOT_DIR, 'active-window-crash.png') }).catch(() => {})
    results.push({ name: '脚本跑完', ok: false })
  } finally {
    if (app) await app.close().catch(() => {})
    if (stub && stub.close) await Promise.resolve(stub.close()).catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }

  const bad = results.filter((r) => r.ok === false).length
  const skipped = results.filter((r) => r.skipped).length
  console.log('\n' + (results.length - bad - skipped) + ' passed / ' + bad + ' failed / ' + skipped + ' 未验  (共 ' + results.length + ')')
  console.log('截图:/tmp/active-window-panel.png、/tmp/active-window-panel-off.png')
  process.exit(bad ? 1 : 0)
}

main()
