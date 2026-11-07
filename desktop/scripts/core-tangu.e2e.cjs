/**
 * 打包形态冒烟(界面热更新 4b;施工图 docs/ToBeImproved/Tangu界面热更新落地计划_2026-10-23.md §1.3、§6 P3–P5)——
 * 真 Electron × 真宿主 × 运行时加载的 Tangu 界面包(TANGU_UI=bundle,读仓里 tangu-agent/ui/main.js)× 假引擎。
 *
 *  K1 界面包被求值(渲染层日志 [core-tangu] bundled UI … evaluated),Tangu 的 CSS 以 <style data-forsion-core> 插在宿主样式之后;
 *  K2 Tangu Space 能用:假引擎的会话出现在会话侧栏(Tangu 视图),点开后对话输入框在 —— 宿主连上引擎写进 useApp 的状态,
 *     Tangu 这边读得到 = 只有一个 useApp(两份 store 时会话列表是空的);
 *  K3 没有 pageerror / Invalid hook call(两份 React 会在这里炸)。
 *  另记:从启动到会话行出现的耗时、包求值耗时;对话区截图(P4 观感对比用,和 --static 那次比)。
 *
 * 负对照(必须实跑):
 *  --nc=dup     故意让包里自带一份 React(共享模块被打进包里)→ K2 / K3 必须红;
 *  --nc=broken  界面包截掉一半(求值即抛)→ 这个窗口记标记、重载走编进宿主的那份:K2 仍绿,K1 记到失败日志。
 * 对照:--static 不开 TANGU_UI,走编进宿主的那份(dev 的路),K1 不适用、K2/K3 照样要绿。
 *
 * 需先:../tangu-agent 的 npm run build(engineRoot 认它的 dist)+ 本目录 npm run build(含 build-tangu-ui)。
 * 用法:npm run e2e:coretangu [-- --static | --nc=dup | --nc=broken]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const UI = path.join(ROOT, '..', 'tangu-agent', 'ui', 'main.js')
const STATIC = process.argv.includes('--static')
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
const SHOT = path.join(os.tmpdir(), `forsion-core-tangu-${STATIC ? 'static' : NC || 'bundle'}.png`)
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

const SESSION = {
  id: 'core-s1', title: '界面包冒烟', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/core-tangu', project_name: 'core-tangu',
  created_at: '2026-11-04 09:00:00', updated_at: '2026-11-04 09:00:00',
}

/** --nc=dup:同一套插件和选项,只是不把 react 当共享包 = 包里自带第二份 React(P3:共享模块被打进包里)。 */
async function buildDuplicateReactBundle() {
  const { build } = require('esbuild')
  const m = await import(path.join(__dirname, 'build-tangu-ui.mjs'))
  const cfg = require('./tangu-boundary.check.cjs').readConfig()
  const root = fs.realpathSync(path.join(ROOT, '..'))
  const r = await build(m.buildOptions({ plugin: m.tanguUiPlugin({ root, classify: m.classifier(cfg), entry: path.join(root, m.ENTRY), shared: m.SHARED_PACKAGES.filter((p) => p !== 'react') }), outfile: UI }))
  if (!Object.keys(r.metafile.inputs).some((k) => /node_modules\/react\/cjs\//.test(k))) throw new Error('[nc=dup] React 没进包,负对照失效')
  return r.outputFiles[0].text
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) throw new Error('缺 out/ 产物 —— 先跑 npm run build')
  if (!fs.existsSync(path.join(ROOT, '..', 'tangu-agent', 'dist', 'standalone', 'main.js'))) throw new Error('缺 ../tangu-agent/dist —— 先在 tangu-agent 跑 npm run build')
  if (!STATIC && !fs.existsSync(UI)) throw new Error('缺 ../tangu-agent/ui/main.js —— 先跑 node scripts/build-tangu-ui.mjs')
  const original = fs.existsSync(UI) ? fs.readFileSync(UI) : null
  if (NC === 'dup') fs.writeFileSync(UI, await buildDuplicateReactBundle())
  if (NC === 'broken') fs.writeFileSync(UI, original.subarray(0, Math.floor(original.length / 2)))

  const stub = await startStubEngine({ sessions: [SESSION], messages: [], models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-core-tangu-'))
  const logs = [], errors = []
  const t0 = Date.now()
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_BROWSER_CDP: 'off', TANGU_HARNESS_QUIET: '1', ...(STATIC ? { TANGU_UI: '' } : { TANGU_UI: 'bundle' }) },
  })
  try {
    const win = await app.firstWindow({ timeout: 60_000 })
    win.on('console', (m) => logs.push(m.text()))
    win.on('pageerror', (e) => errors.push(String(e?.stack || e)))
    await win.setViewportSize({ width: 1600, height: 900 })
    await win.waitForSelector('#root', { timeout: 60_000 })
    check('K0 点掉首启引导', await skipOnboarding(win, 30_000))
    await win.waitForSelector('.dv-groupview', { timeout: 60_000 }).catch(async (e) => {
      await win.screenshot({ path: SHOT }).catch(() => {})
      const state = await win.evaluate(() => ({ nav: performance.getEntriesByType('navigation')[0]?.type, flag: (() => { try { return sessionStorage.getItem('forsion.coreTangu.static') } catch (e) { return 'ERR ' + e } })(), coreTangu: document.documentElement.dataset.coreTangu || null, root: document.getElementById('root')?.innerHTML.length ?? 0, groups: document.querySelectorAll('.dv-groupview').length })).catch(() => null)
      throw new Error(`主区没出来:${JSON.stringify(state)};日志 ${JSON.stringify(logs.filter((l) => /core-tangu|error/i.test(l)).slice(0, 5))};截图 ${SHOT}(${e.message.split('\n')[0]})`)
    })
    await win.waitForTimeout(1000)
    await win.evaluate((names) => {
      const button = [...document.querySelectorAll('button.rb-space')].find((item) => names.some((n) => (item.getAttribute('aria-label') || item.getAttribute('title') || item.textContent || '').includes(n)))
      button?.click()
    }, ['Agent', 'Tangu'])
    await win.waitForTimeout(1500)
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) { await win.click('.dv-edge-left').catch(() => {}); await win.waitForTimeout(700) }
    const row = win.locator('.t2s-srow', { hasText: SESSION.title }).first()
    const rowSeen = await row.waitFor({ timeout: 15_000 }).then(() => true, () => false)
    const tRow = Date.now() - t0
    if (rowSeen) { await row.click(); await win.waitForTimeout(900) }
    const composer = await win.locator('.t2c-ta').first().count().catch(() => 0)
    const probe = await win.evaluate(() => {
      const el = document.querySelector('style[data-forsion-core="tangu"]')
      const sheets = [...document.querySelectorAll('link[rel="stylesheet"], style')]
      let flag = null
      try { flag = sessionStorage.getItem('forsion.coreTangu.static') } catch { /* ignore */ }
      return { style: el ? { bytes: el.textContent.length, afterHost: sheets.indexOf(el) > 0 } : null, loaded: document.documentElement.dataset.coreTangu || null, ms: document.documentElement.dataset.coreTanguMs || null, flag }
    })
    const { style } = probe
    await win.screenshot({ path: SHOT })
    // P4 观感:Agent 页也截一张(Space 名就叫 Agents)
    await win.evaluate(() => [...document.querySelectorAll('button.rb-space')].find((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim() === 'Agents')?.click())
    await win.waitForTimeout(2000)
    await win.screenshot({ path: SHOT.replace('.png', '-agents.png') })
    // 坏包那条:第一次加载求值失败 → 记标记 → 重载走编进宿主的那份;重载前的日志不一定抓得到,看重载后留下的标记
    if (STATIC) check('K1 编进宿主的那份(--static):没有求值界面包', !probe.loaded && !style, JSON.stringify(probe))
    else if (NC === 'broken') check('K1 坏掉的界面包:这个窗口记了标记、退回编进宿主的那份', probe.flag === '1' && !probe.loaded && !style, JSON.stringify(probe))
    else check('K1 界面包被求值、CSS 插在宿主样式之后', /^bundled /.test(probe.loaded || '') && style?.afterHost && style.bytes > 1000, JSON.stringify(probe))
    check('K2 Tangu Space 能用:会话行出现、点开有输入框(只有一个 useApp)', rowSeen && composer > 0, `会话行=${rowSeen} 输入框=${composer} 截图 ${SHOT}`)
    const hook = errors.concat(logs).find((l) => /Invalid hook call|more than one copy of React|\[tangu\] render crash/i.test(l))
    check('K3 没有 pageerror / 渲染崩溃 / 两份 React', errors.length === 0 && !hook, (hook || errors[0] || '').slice(0, 300))
    console.log(`耗时:启动 → 会话行 ${tRow} ms${probe.ms ? `;包求值 ${probe.ms} ms` : ''}`)
    // 和 --static 那次的截图逐像素比(先跑过 --static 才有;只报数,不判:截图里有时间等会变的东西)
    for (const suffix of ['', '-agents']) {
      const mine = SHOT.replace('.png', `${suffix}.png`), base = path.join(os.tmpdir(), `forsion-core-tangu-static${suffix}.png`)
      if (STATIC || NC || !fs.existsSync(base)) continue
      const { PNG } = require('pngjs')
      const [a, b] = [mine, base].map((f) => PNG.sync.read(fs.readFileSync(f)))
      let diff = 0
      if (a.width === b.width && a.height === b.height) for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) diff++
      console.log(`P4 ${suffix || '对话 + 会话侧栏'} 与 --static 相差 ${a.width === b.width && a.height === b.height ? diff : '尺寸不同'} 像素(${a.width}×${a.height})`)
    }
  } finally {
    await app.close().catch(() => {})
    stub.close?.()
    if (NC && original) fs.writeFileSync(UI, original)
  }
  const failedN = results.filter((r) => !r.ok).length
  console.log(`\ncore-tangu${STATIC ? ' --static' : NC ? ` --nc=${NC}` : ''}: ${results.length - failedN}/${results.length} PASS`)
  process.exit(failedN ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
