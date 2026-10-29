// 插件视图基础样式 + 挂载失败卡的仪器(2026-10-29,插件开发体验 1B):样例插件 scripts/fixtures/plugin-base-sample 装进隔离 home,
// 明 / 暗各拍一张并量计算样式 —— 裸 <button> 与 .btn 同形(描边、内边距、字号、圆角、颜色)、.btn 不受影响、与基础层同权重的
// 插件规则照样赢、<input> / <select> 走主题、表格减线、标题按界面字号档、宿主零件那一层不吃基础样式;
// 右栏那个第一次 mount 就抛错的视图出失败卡(首行、不带栈),修好后点「重试」挂上,主区同插件的视图照常;英文下卡片跟着变。
// 跑法(先 npx electron-vite build):node <仓根>/.claude/hooks/devlock.cjs run --vehicle=e2e --what="plugin base shots" --eta=4 -- node scripts/plugin-base-shots.cjs
// 产物:$PBASE_OUT(缺省系统临时目录下 plugin-base-shots/)里的 png + results.json;有断言不过时退出码 1。
const fs = require('fs'), os = require('os'), path = require('path')
const { launch, boot, sleep } = require('./lib/uiux-electron.cjs')

const PLUG = path.join(__dirname, 'fixtures', 'plugin-base-sample')
const OUT = process.env.PBASE_OUT || path.join(os.tmpdir(), 'plugin-base-shots')
fs.mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail)) }

async function shot(app, win, name) {
  await sleep(150)
  const b64 = await app.evaluate(async ({ BrowserWindow }, u) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL() === u)
    return w ? (await w.capturePage()).toPNG().toString('base64') : null
  }, win.url())
  if (b64) fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(b64, 'base64'))
}
async function prefs(win, o) {
  await win.evaluate((p) => { localStorage.setItem('tangu_locale', p.lang); localStorage.setItem('forsion_theme_pref', p.mode); localStorage.setItem('forsion_default_space', 'pbase') }, o)
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('[data-pb="bare"]', { timeout: 30_000 })
  await sleep(1500)
}

// 页面里量:同一组属性在两个元素上比
const measure = () => {
  const q = (s) => document.querySelector(s)
  const cs = (el, props) => { if (!el) return null; const c = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, c[p]])) }
  const BTN = ['borderTopWidth', 'borderTopStyle', 'borderTopColor', 'paddingLeft', 'paddingTop', 'fontSize', 'borderTopLeftRadius', 'color', 'backgroundColor', 'height']
  // 宿主自己的 .btn(插件视图之外)当参照:插件视图里的 .btn 必须一模一样
  const ref = document.body.appendChild(Object.assign(document.createElement('button'), { className: 'btn', textContent: '.btn' }))
  const outside = cs(ref, BTN); ref.remove()
  // 宿主零件那一层里塞一颗裸按钮:不该吃基础样式(还是全局重置的无边框)
  const layer = q('[data-plugin-view-host] [data-pb="part"] [data-host-mount]')
  const probe = layer && layer.appendChild(Object.assign(document.createElement('button'), { textContent: 'x' }))
  const inPart = probe && getComputedStyle(probe).borderTopWidth; probe?.remove()
  const rootCs = getComputedStyle(document.documentElement)
  return {
    bare: cs(q('[data-pb="b1"]'), BTN), btn: cs(q('[data-pb="btn"]'), BTN), outside,
    disabled: cs(q('[data-pb="b3"]'), ['opacity']).opacity,
    tie: cs(q('[data-pb="tie"]'), ['backgroundColor', 'borderTopColor']),
    input: cs(q('[data-pb="in"]'), ['borderTopWidth', 'backgroundColor', 'borderTopLeftRadius']),
    select: cs(q('[data-pb="sel"]'), ['borderTopWidth', 'backgroundColor']),
    th: cs(q('[data-pb="table"] th'), ['fontWeight', 'color', 'paddingLeft', 'borderTopWidth', 'textAlign']),
    td: cs(q('[data-pb="table"] td'), ['borderTopWidth', 'paddingLeft']),
    h1: cs(q('[data-pb="bare"] h1'), ['fontSize', 'fontWeight']), h2: cs(q('[data-pb="bare"] h2'), ['fontSize']), h3: cs(q('[data-pb="bare"] h3'), ['fontSize']),
    tokens: { title: rootCs.getPropertyValue('--ui-font-title').trim(), heading: rootCs.getPropertyValue('--ui-font-heading').trim(), body: rootCs.getPropertyValue('--ui-font-body').trim() },
    hasLayer: !!layer, inPart,
  }
}
const same = (a, b) => a && b && Object.keys(a).every((k) => a[k] === b[k])
const diff = (a, b) => a && b ? Object.fromEntries(Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => [k, [a[k], b[k]]])) : { a, b }

;(async () => {
  const ctx = await launch({ tag: 'pbase', overrideHome: true, beforeLaunch: ({ home }) => { fs.cpSync(PLUG, path.join(home, 'plugins', 'plugin-base-sample'), { recursive: true }) } })
  const { app, win } = ctx
  let failed = false
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 })
    for (const mode of ['light', 'dark']) {
      const tag = mode === 'dark' ? '-dark' : ''
      await prefs(win, { lang: 'zh', mode })
      await win.mouse.move(1500, 940)
      const m = await win.evaluate(measure)
      check(`button${tag}: bare <button> has the .btn shape (border, padding, size, radius, color, height)`, same(m.bare, m.btn), diff(m.bare, m.btn))
      check(`button${tag}: bare <button> draws a 1px outline, no fill`, m.bare?.borderTopWidth === '1px' && m.bare.borderTopStyle === 'solid' && m.bare.backgroundColor === 'rgba(0, 0, 0, 0)', m.bare)
      check(`button${tag}: .btn inside the view is exactly the host .btn`, same(m.btn, m.outside), diff(m.btn, m.outside))
      check(`button${tag}: disabled bare button dims`, m.disabled === '0.5', m.disabled)
      check(`button${tag}: plugin rule at the same weight wins (ctx.addStyle comes later)`, m.tie && m.tie.backgroundColor !== 'rgba(0, 0, 0, 0)' && m.tie.borderTopColor !== m.bare.borderTopColor, m.tie)
      check(`form${tag}: <input> / <select> on the theme (1px border, card fill)`, m.input?.borderTopWidth === '1px' && m.input.backgroundColor !== 'rgba(0, 0, 0, 0)' && m.select?.borderTopWidth === '1px', { input: m.input, select: m.select })
      check(`table${tag}: header muted, medium weight, no fill; cells padded with hairlines`, m.th?.fontWeight === '500' && m.th.paddingLeft === '10px' && m.th.textAlign === 'left' && m.td?.borderTopWidth === '1px', { th: m.th, td: m.td })
      check(`heading${tag}: h1 / h2 / h3 on the UI title / heading / body sizes`, m.h1?.fontSize === m.tokens.title && m.h1.fontWeight === '600' && m.h2?.fontSize === m.tokens.heading && m.h3?.fontSize === m.tokens.body, { h1: m.h1, h2: m.h2, h3: m.h3, tokens: m.tokens })
      check(`part${tag}: a bare button inside a host part's layer keeps the host reset`, m.hasLayer && m.inPart === '0px', { hasLayer: m.hasLayer, inPart: m.inPart })
      // 失败卡:右栏那个视图第一次 mount 就抛错
      const card = await win.evaluate(() => {
        const c = document.querySelector('[data-plugin-view-failed]')
        return c && { text: c.textContent, retry: c.querySelector('[data-action="plugin-view-retry"]')?.textContent, bare: !!document.querySelector('[data-pb="bare"]') }
      })
      check(`fail${tag}: failure card with the first line of the error and Retry`, card && /插件视图加载失败/.test(card.text) && /TypeError: Cannot read properties of undefined/.test(card.text) && !/main\.js:58/.test(card.text) && card.retry === '重试', card)
      check(`fail${tag}: the other view of the same plugin keeps running`, card?.bare)
      await shot(app, win, `base${tag}`)
      await win.evaluate(() => { window.__pbase.broken = false })
      await win.click('[data-action="plugin-view-retry"]'); await sleep(500)
      const after = await win.evaluate(() => ({ ok: !!document.querySelector('[data-pb="flaky-ok"]'), card: !!document.querySelector('[data-plugin-view-failed]') }))
      check(`retry${tag}: fixed view mounts after Retry, card gone`, after.ok && !after.card, after)
      await shot(app, win, `retried${tag}`)
    }
    await prefs(win, { lang: 'en', mode: 'light' })
    const en = await win.evaluate(() => { const c = document.querySelector('[data-plugin-view-failed]'); return c && { text: c.textContent, retry: c.querySelector('[data-action="plugin-view-retry"]')?.textContent } })
    check('fail-en: card in English', en && /Plugin view failed to load/.test(en.text) && en.retry === 'Retry', en)
    await shot(app, win, 'base-en')
  } catch (e) {
    console.error(e); failed = true
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1))
    await ctx.close()
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} passed · shots in ${OUT}`)
  process.exit(failed || bad.length ? 1 : 0)
})()
