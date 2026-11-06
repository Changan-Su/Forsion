/** 动效收口台架(真 Electron,隔离 TANGU_HOME):装一个专门捣乱的磁盘主题,断言动效仍归宿主管。
 * 先 npm run build,再:node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what=check:motiontheme -- npm run check:motiontheme
 *
 * 钉住(theme/motionGuard.ts + styles/layers.css + base.css 的 @layer forsion-guard):
 *  1 层序:文档里第一个出现的层是 forsion-guard(Astryx 的 @layer reset 等都在它后面);
 *  2 主题写的动效 token 不生效 —— :root 上、写在 .shell 上的子孙同名变量、@property inherits:false 三种都拦住;
 *  3 主题注入的 <style> 里:token 声明没了、自己的关键帧与层名加了前缀;主题自己的动画照样能用;
 *  4 主题把 --droplet-duration 做成「就地调参」:不写进 :root 内联;
 *  5 系统「减少动态效果」压过主题的 `* { animation-duration: 3s !important }` 和塞进同名层的规则;
 *  6 设置 → 外观里这套主题下面提示「N 项动效已忽略」;
 * 负对照(必须真的变红,否则上面的断言在骗人):
 *  N1 把主题原文(不过收口)直接塞进页面 → .shell 上的 --menu-enter-duration 被盖成 2s、出现主题版 ui-menu-enter;
 *  N2 删掉护栏层、把里面的规则不分层地放回 base 的位置 → 减少动态效果下主题的 3s 赢。 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-motion-theme-'))
let fails = 0
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '  ' + JSON.stringify(detail)}`); if (!ok) fails++ }

const ID = 'motion-bad'
const BAD_CSS = `
[data-theme='${ID}'] { --radius-md: 13px; --droplet-duration: 1600ms; --menu-enter-duration: 2s; }
[data-theme='${ID}'] .shell, [data-theme='${ID}'] body { --menu-enter-duration: 2s !important; --collapse-duration: 0s; }
@property --menu-exit-duration { syntax: '<time>'; inherits: false; initial-value: 2s; }
@keyframes ui-menu-enter { from { opacity: 0.2; transform: translateX(200px); } }
@layer forsion-guard { *, *::before, *::after { animation-duration: 2s !important; } }
* { animation-duration: 3s !important; }
.mtc-probe { animation: mtc-spin 5s linear infinite; }
@keyframes mtc-spin { to { transform: rotate(1turn); } }
`

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, 'out/renderer/index.html')), '先 npm run build')
  const dir = path.join(home, 'themes', ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'theme.css'), BAD_CSS)
  fs.writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({
    id: ID, name: 'Motion bad', nameEn: 'Motion bad', description: '动效收口台架用', version: '0.0.1', author: 'harness', supportsDarkMode: true,
    preview: { bg: '#ffffff', fg: '#111111', accent: '#3355ff' },
    settings: [{ key: '--droplet-duration', label: '液滴时长', type: 'number', default: 1600, min: 0, max: 5000, unit: 'ms' }],
  }))
  const stub = await startStubEngine({ sessions: [], messages: [], agents: [], engines: [] })
  const userdata = path.join(home, 'userdata')
  for (const d of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' },
  })
  try {
    const main = await app.firstWindow()
    await main.waitForSelector('#root', { timeout: 40000 })
    await skipOnboarding(main)
    await main.evaluate((id) => { localStorage.setItem('forsion_theme_lang', id); localStorage.setItem('forsion_theme_pref', 'light') }, ID)
    await main.reload({ waitUntil: 'domcontentloaded' })
    await skipOnboarding(main)
    await main.waitForFunction((id) => document.documentElement.dataset.theme === id, ID, { timeout: 20000 })
    await main.locator('.shell').first().waitFor({ timeout: 20000 })

    const read = () => main.evaluate((id) => {
      const root = document.documentElement, app = document.querySelector('.shell')
      const deep = app.querySelector('*') || app
      const v = (el, k) => getComputedStyle(el).getPropertyValue(k).trim()
      let probe = document.querySelector('.mtc-probe')
      if (!probe) { probe = document.createElement('div'); probe.className = 'mtc-probe'; app.appendChild(probe) }
      const pcs = getComputedStyle(probe)
      // 文档里第一个出现的层名(@import / @media / @supports 里面也找)
      const firstLayer = (() => {
        const walk = (rules) => {
          for (const r of rules) {
            if (r instanceof CSSLayerStatementRule) return r.nameList[0]
            if (r instanceof CSSLayerBlockRule) return r.name || '(anonymous)'
            if (r instanceof CSSImportRule && r.styleSheet) { const x = walk(r.styleSheet.cssRules); if (x) return x }
            if ((r instanceof CSSMediaRule || r instanceof CSSSupportsRule)) { const x = walk(r.cssRules); if (x) return x }
          }
          return null
        }
        for (const s of document.styleSheets) { if (s.disabled) continue; try { const x = walk(s.cssRules); if (x) return x } catch { /* 跨源 */ } }
        return null
      })()
      const style = document.getElementById('forsion-theme-css-' + id)
      const themeKeyframes = (() => { try { return [...style.sheet.cssRules].filter((r) => r instanceof CSSKeyframesRule).map((r) => r.name) } catch { return null } })()
      return {
        firstLayer,
        rootDroplet: v(root, '--droplet-duration'), rootInline: root.style.getPropertyValue('--droplet-duration'),
        appMenuEnter: v(app, '--menu-enter-duration'), appCollapse: v(app, '--collapse-duration'), deepMenuExit: v(deep, '--menu-exit-duration'),
        radius: v(root, '--radius-md'),
        styleOn: !!style && !style.disabled,
        styleHasToken: !!style && /--droplet-duration|--menu-enter-duration|--collapse-duration|--menu-exit-duration/.test(style.textContent),
        themeKeyframes, themeLayer: !!style && /@layer t-motion-bad-forsion-guard/.test(style.textContent),
        probeName: pcs.animationName, probeDur: pcs.animationDuration,
      }
    }, ID)

    let r = await read()
    check('1 层序:第一个层是 forsion-guard', r.firstLayer === 'forsion-guard', r.firstLayer)
    check('2 :root 的 --droplet-duration 仍是 420ms,没有写进内联(就地调参也拦了)', r.rootDroplet === '420ms' && r.rootInline === '', r)
    check('2 .shell 上的子孙同名变量拦住:--menu-enter-duration 180ms、--collapse-duration 跟宿主', r.appMenuEnter === '180ms' && r.appCollapse !== '0s', r)
    check('2 @property inherits:false 拦住:深处的 --menu-exit-duration 仍是 80ms', r.deepMenuExit === '80ms', r)
    check('3 主题样式生效(圆角 13px)、但注入文本里没有动效 token', r.styleOn && r.radius === '13px' && !r.styleHasToken, r)
    check('3 主题的关键帧加了前缀、层名加了前缀', JSON.stringify(r.themeKeyframes) === JSON.stringify(['t-motion-bad-ui-menu-enter', 't-motion-bad-mtc-spin']) && r.themeLayer, r)
    // 时长是 2s:主题自己那层(改名后的 t-motion-bad-forsion-guard)的 !important 压过它不分层的 3s —— 主题内部的事,宿主不管
    check('3 主题自己的动画照样能用(改写过的名字,不在减少动态效果下)', r.probeName === 't-motion-bad-mtc-spin' && parseFloat(r.probeDur) >= 1, r)

    await main.emulateMedia({ reducedMotion: 'reduce' })
    r = await read()
    check('5 减少动态效果压过主题的 !important 与塞进同名层的规则', parseFloat(r.probeDur) < 0.01, r.probeDur)

    // 6 设置浮窗里的提示
    await main.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'theme' } }))
    let fl = null
    for (let i = 0; i < 60 && !fl; i++) { fl = app.windows().find((w) => w.url().includes('window=floating')) || null; if (!fl) await new Promise((res) => setTimeout(res, 250)) }
    const hint = fl ? await fl.locator('[data-theme-motion-ignored]').first().textContent({ timeout: 20000 }).catch(() => null) : null
    check('6 设置里提示「N 项动效已忽略」(4 项)', !!hint && hint.includes('4 项动效已忽略'), hint)

    // N2 删掉护栏层 → 主题的 3s 应该赢(在减少动态效果下)
    const n2 = await main.evaluate(() => {
      const moved = []
      for (const s of document.styleSheets) {
        let rules; try { rules = s.cssRules } catch { continue }
        for (let i = rules.length - 1; i >= 0; i--) {
          const r = rules[i]
          if (r instanceof CSSLayerBlockRule && r.name === 'forsion-guard') { moved.unshift(...[...r.cssRules].map((x) => x.cssText)); s.deleteRule(i) }
        }
      }
      const el = document.createElement('style'); el.textContent = moved.join('\n'); document.head.insertBefore(el, document.head.firstChild)
      return { moved: moved.length, dur: getComputedStyle(document.querySelector('.mtc-probe')).animationDuration }
    })
    check('N2 负对照:拿掉护栏层后,减少动态效果被主题压过(断言确实能红)', n2.moved > 0 && parseFloat(n2.dur) >= 1, n2)

    // N1 主题原文不过收口直接注入 → 子孙同名变量生效、出现主题版 ui-menu-enter
    const n1 = await main.evaluate((css) => {
      const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el)
      const out = { appMenuEnter: getComputedStyle(document.querySelector('.shell')).getPropertyValue('--menu-enter-duration').trim(), kf: [...el.sheet.cssRules].filter((r) => r instanceof CSSKeyframesRule).map((r) => r.name) }
      el.remove(); return out
    }, BAD_CSS)
    check('N1 负对照:不过收口时 .shell 上的 token 被盖成 2s、出现主题版 ui-menu-enter', n1.appMenuEnter === '2s' && n1.kf.includes('ui-menu-enter'), n1)
  } finally {
    await app.close().catch(() => {})
    await stub.close?.()
  }
  console.log(fails ? `\n${fails} 项没过` : '\n全部通过')
  process.exit(fails ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
