/**
 * Astryx 运行时主题样式不外溢(check:astryxscope):真 Electron + 桩引擎,隔离 HOME / 笔记库。
 *
 * 背景:Astryx 的 <Theme> 首次挂载往 <head> 注入两张运行时样式表(同一个作用域):
 *   style[data-astryx-theme-prose]  @layer reset        { @scope ([data-astryx-theme="forsion-lcl"]) to ([data-astryx-theme]) { :where(h1..h6 / p / small / code,pre / hr) {…} } }
 *   style[data-astryx-theme]        @layer astryx-theme { 同一 @scope { :scope { --color-* / --text-* / --font-family-* … } } }
 * 作用域根 = 任何带 data-astryx-theme 的元素。根 Theme 会把这个属性同步到 <html> → <html> 成了作用域根,
 * 打开过一次日历后,整窗(包裹层之外)的裸 h/p/small/code/pre/hr 都吃 Astryx 的字号 / 行高 / 颜色 / 字体,离开日历也不退。
 * 修法见 theme/astryxBridge.tsx:AstryxScope 把 <html> 上的属性摘掉(我们用的 Astryx 组件都不往 body 传送)。
 *
 * 断言(按状态逐个跑):
 *  A <html> 不带 data-astryx-theme;
 *  B 停用两张运行时样式表,包裹层(div[data-astryx-theme])外的元素逐个比全部计算样式(自定义属性 / 过渡 / 动画除外)与盒子:不变;
 *  C 负对照:往 body 挂一组裸 h1/h2/h6/p/small/code/pre/hr 探针,给 <html> 补上 / 摘掉属性 → 探针必须变(证明 B 的比对看得见外溢);
 *    同一组探针停用运行时样式表前后必须不变(B 的内容无关版,不依赖页面恰好有裸标签);
 *  D 日历(周视图+待办+右栏 / 下拉菜单 / 事件详情 / 月视图当日日程 / 深色)在 <html> 带与不带属性两种情况下逐元素全等 = 修法不改日历观感;
 *  E 包裹层内主题仍在:日历挂着时 prose 表在、包裹层上 --color-accent 有值(别拿「把样式表删了」当修法);
 *  F 注入者先卸:关掉主区日历(Astryx 原生注入时它是唯一登记了清理的 Theme),侧栏待办 / 日历设置还挂着 →
 *    两张表仍各一份、幸存包裹层逐元素 Astryx token 与字体不变;F0 负对照:停用运行时表,幸存者必变。
 * 两张表现由 theme/astryxBridge.tsx 在模块加载时常驻注入(日历分块空闲预热即加载),所以「启动后(未进过日历)」
 * 那行 NOTE 里 prose/comp 为 1 是预期 —— 表常驻但作用域根只有包裹层,靠 A/B 兜住不外溢。
 * 另覆盖会把属性写回去的路径:跨窗明暗 / 主题语言切换(设置浮窗 broadcastUi → syncFromWindow)、离开再回日历;
 * 设置浮窗是独立文档,不该有运行时样式。截图落 SHOT_DIR(DESIGN §8:几何全绿 ≠ 看起来对)。
 *
 * 量的是 out/ 产物 —— 改了源码先 `npx electron-vite build`。负对照实跑:把 astryxBridge.tsx 的修法回退、重建,A/B 必红。
 */
const fs = require('fs')
const path = require('path')
const { launch, boot, enterSpace, makeReporter, sleep, shotDir, captureWindow } = require('./lib/uiux-electron.cjs')

const { check, note, summary } = makeReporter()
const SHOTS = shotDir('astryx-scope')
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

// 裸标签齐全的正文:聊天(助手消息)与笔记各一份。
const PROSE_MD = [
  '## Release notes',
  '',
  'This paragraph is plain body text with `inline code` and a [link](https://example.com).',
  '',
  '- First bullet',
  '- Second bullet',
  '',
  '```js',
  'const answer = 42',
  '```',
  '',
  '---',
  '',
  '#### Small heading',
  '',
  '> A quoted paragraph.',
  '',
  'Closing paragraph.',
].join('\n')

/** 页内工具:装一次(boot 之后页面不再 reload)。 */
const HELPER = `window.__axs = (() => {
  const SKIP = /^(--|transition|animation|will-change)/
  const WRAP = 'div[data-astryx-theme]'
  const html = document.documentElement
  const shown = (el) => el.getClientRects().length > 0 || getComputedStyle(el).display === 'contents'
  const outside = () => [html, document.body, ...document.body.querySelectorAll('*')].filter((el) => !el.closest(WRAP) && !el.closest('[data-axs-probe]') && shown(el))
  const calendar = () => {
    const roots = [...document.querySelectorAll('.amx-cal, .amx-todo, .amx-calside, .amx-calcfg, [popover], [role="dialog"], .amx-cal-cardwrap, .amx-cal-agenda')]
    return [...new Set(roots.flatMap((x) => [x, ...x.querySelectorAll('*')]))].filter(shown)
  }
  const snap = (els) => els.map((el) => {
    const cs = getComputedStyle(el)
    const o = {}
    for (let i = 0; i < cs.length; i++) { const p = cs[i]; if (!SKIP.test(p)) o[p] = cs.getPropertyValue(p) }
    const r = el.getBoundingClientRect()
    o.rect = [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10).join(',')
    return o
  })
  // F 专用:只取 Astryx token(运行时 token 表定义的那批)+ 解析后的字体 —— 关掉主区日历会改掉右栏小月历的本周高亮,
  // 全量比会把这种正常的状态变化也算进去;token 只随运行时表在不在而变。
  const TOKEN = /^--(color|font-family|text|radius)-/
  const snapTokens = (els) => els.map((el) => {
    const cs = getComputedStyle(el)
    const o = { 'font-family': cs.fontFamily }
    for (let i = 0; i < cs.length; i++) { const p = cs[i]; if (TOKEN.test(p)) o[p] = cs.getPropertyValue(p) }
    return o
  })
  const label = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '')
  const diff = (els, a, b, noise) => {
    const agg = new Map()
    let n = 0
    els.forEach((el, i) => {
      const ks = Object.keys(a[i]).filter((k) => a[i][k] !== b[i][k] && !noise[i].has(k))
      if (!ks.length) return
      n++
      for (const k of ks) { const key = label(el) + ' ' + k + ': ' + a[i][k] + ' → ' + b[i][k]; agg.set(key, (agg.get(key) || 0) + 1) }
    })
    return { n, top: [...agg].sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, c]) => c + '× ' + k) }
  }
  /** 改动 → 快照 → 复原。noise = 两次零改动快照之间就不同的键(光标 / 动画 / 时间戳),不计;back = 复原后仍不同的元素数。 */
  const measure = (els, apply, take = snap) => {
    const a1 = take(els), a2 = take(els)
    const noise = els.map((_, i) => new Set(Object.keys(a1[i]).filter((k) => a1[i][k] !== a2[i][k])))
    const undo = apply()
    const b = take(els)
    undo()
    const c = take(els)
    const d = diff(els, a1, b, noise)
    return { total: els.length, noisy: noise.filter((s) => s.size).length, changed: d.n, top: d.top, back: diff(els, a1, c, noise).n }
  }
  const themeName = () => document.querySelector('style[data-astryx-theme-prose]')?.getAttribute('data-astryx-theme-prose') || 'forsion-lcl'
  const sheetsOff = () => {
    const ss = [...document.querySelectorAll('style[data-astryx-theme-prose], style[data-astryx-theme]')]
    ss.forEach((s) => { s.sheet.disabled = true })
    return () => ss.forEach((s) => { s.sheet.disabled = false })
  }
  const flipAttr = () => {
    const had = html.getAttribute('data-astryx-theme')
    if (had !== null) html.removeAttribute('data-astryx-theme')
    else html.setAttribute('data-astryx-theme', themeName())
    return () => { if (had !== null) html.setAttribute('data-astryx-theme', had); else html.removeAttribute('data-astryx-theme') }
  }
  const survivors = (sel = '.amx-todo, .amx-calside') => [...document.querySelectorAll(WRAP)].filter((w) => w.querySelector(sel)).flatMap((w) => [...w.querySelectorAll('*')]).filter(shown)
  let held = null
  const withProbe = (fn) => {
    const box = document.body.appendChild(document.createElement('div'))
    box.setAttribute('data-axs-probe', '')
    box.style.cssText = 'position:fixed;left:0;top:0;width:480px;visibility:hidden;pointer-events:none'
    box.innerHTML = '<h1>Heading one</h1><h2>Heading two</h2><h6>Heading six</h6><p>Body <small>small</small> <code>code</code></p><pre>pre block</pre><hr>'
    try { return fn([box, ...box.querySelectorAll('*')]) } finally { box.remove() }
  }
  return {
    state: () => ({
      attr: html.getAttribute('data-astryx-theme'),
      prose: document.querySelectorAll('style[data-astryx-theme-prose]').length,
      comp: document.querySelectorAll('style[data-astryx-theme]').length,
      wraps: document.querySelectorAll(WRAP).length,
      accent: (() => { const w = document.querySelector(WRAP); return w ? getComputedStyle(w).getPropertyValue('--color-accent').trim() : null })(),
      mode: html.dataset.mode, lang: html.dataset.theme,
    }),
    tags: () => { const o = {}; for (const el of outside()) { const t = el.tagName.toLowerCase(); if (/^(h[1-6]|p|small|code|pre|hr)$/.test(t)) o[t] = (o[t] || 0) + 1 } return o },
    outsideSheets: () => measure(outside(), sheetsOff),
    outsideAttr: () => measure(outside(), flipAttr),
    probeSheets: () => withProbe((els) => measure(els, sheetsOff)),
    probeAttr: () => withProbe((els) => measure(els, flipAttr)),
    // F:侧栏幸存者(待办 / 日历设置两个包裹层)。hold 记下元素与快照,heldDiff 在关掉主区日历后对同一批元素重比。
    survivorSheets: () => measure(survivors(), sheetsOff, snapTokens),
    hold: (sel) => { const els = survivors(sel); const a = snapTokens(els), a2 = snapTokens(els); held = { els, a, noise: els.map((_, i) => new Set(Object.keys(a[i]).filter((k) => a[i][k] !== a2[i][k]))) }; return els.length },
    heldDiff: () => { const { els, a, noise } = held; const d = diff(els, a, snapTokens(els), noise); return { total: els.length, gone: els.filter((el) => !el.isConnected).length, noisy: noise.filter((x) => x.size).length, changed: d.n, top: d.top, back: 0 } },
    calendarAttr: () => { const els = calendar(); return { ...measure(els, flipAttr), outsideWrap: els.filter((el) => !el.closest(WRAP)).map(label).slice(0, 8), outsideWrapN: els.filter((el) => !el.closest(WRAP)).length } },
  }
})(); true`

const fmt = (r) => `比了 ${r.total} 个元素,变了 ${r.changed} 个${r.noisy ? `(${r.noisy} 个自带抖动的键已剔除)` : ''}${r.back ? `,复原后仍有 ${r.back} 个不同` : ''}${r.top.length ? ` ‖ ${r.top.slice(0, 8).join(' ‖ ')}` : ''}`

async function main() {
  const today = new Date()
  const d0 = ymd(today)
  const dm1 = ymd(addDays(today, -1))
  const d1 = ymd(addDays(today, 1))
  const { app, win, home, close } = await launch({
    tag: 'astryx-scope',
    overrideHome: true,
    messages: [
      { id: 'axs-u', role: 'user', content: 'Show me the release notes.', timestamp: 1 },
      { id: 'axs-a', role: 'model', content: PROSE_MD, timestamp: 2 },
    ],
  })
  try {
    const vault = path.join(home, 'vault')
    fs.writeFileSync(path.join(vault, 'Prose sample.md'), `# Prose sample\n\n${PROSE_MD}\n`)
    const rows = [
      ['focus-a', '产品深度工作', `${d0}T09:00/${d0}T10:30`],
      ['all-day', '版本发布', d0],
      ['roadmap', '路线图工作坊', `${dm1}/${d1}`],
      ['lunch', '团队午餐', `${d0}T12:30/${d0}T13:30`],
      ['review', '周度复盘', `${d0}T15:00/${d0}T16:00`],
      ['wrap', '整理会议纪要', `${d0}T17:00/${d0}T17:30`],
      ['overdue', '补交上周总结', dm1],
    ].map(([id, name, date]) => ({ id, cells: { name, date } }))
    fs.writeFileSync(path.join(vault, 'calendar-demo.db'), `${JSON.stringify({
      version: 1, name: '产品日历',
      columns: [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }],
      rows,
    }, null, 2)}\n`)

    await boot(app, win, { space: 'tangu' })
    await win.evaluate(HELPER)
    const st = () => win.evaluate(() => window.__axs.state())
    note('启动后(未进过日历)', JSON.stringify(await st()))

    /** 一个状态跑 A + B(页面内容)+ 可选 C(探针)。 */
    const sweep = async (label, { probe = false } = {}) => {
      const s = await st()
      check(`A ${label}:<html> 不带 data-astryx-theme`, s.attr === null, JSON.stringify(s))
      note(`${label} 包裹层外的裸标签`, JSON.stringify(await win.evaluate(() => window.__axs.tags())))
      const flip = await win.evaluate(() => window.__axs.outsideAttr())
      note(`${label} 翻转 <html> 属性,包裹层外变化`, fmt(flip))
      const off = await win.evaluate(() => window.__axs.outsideSheets())
      check(`B ${label}:停用 Astryx 运行时样式表,包裹层外计算样式与盒子不变`, s.prose > 0 && off.total > 0 && off.back === 0 && off.changed === 0,
        s.prose > 0 ? fmt(off) : '运行时样式表不在(日历没挂过?)—— 前提不成立')
      if (probe) {
        const pa = await win.evaluate(() => window.__axs.probeAttr())
        check(`C ${label}:负对照 —— 裸标签探针随 <html> 属性翻转而变(比对看得见外溢)`, pa.changed > 0 && pa.back === 0, fmt(pa))
        const ps = await win.evaluate(() => window.__axs.probeSheets())
        check(`B' ${label}:裸标签探针停用运行时样式表前后不变`, ps.total > 0 && ps.changed === 0 && ps.back === 0, fmt(ps))
      }
    }
    /** 日历观感:<html> 带 / 不带属性逐元素全等。 */
    const calParity = async (label) => {
      const r = await win.evaluate(() => window.__axs.calendarAttr())
      check(`D 日历 ${label}:<html> 带 / 不带 data-astryx-theme 逐元素全等(包裹层外 ${r.outsideWrapN} 个)`, r.total > 0 && r.changed === 0 && r.back === 0,
        `${fmt(r)}${r.outsideWrapN ? ` ‖ 包裹层外:${r.outsideWrap.join(' ')}` : ''}`)
    }

    // ① 笔记先挂一次(vaultRoot / 全库扫描就绪,日历才有数据源),再进日历。
    check('进入笔记 Space', await enterSpace(win, 'amadeus'))
    await win.waitForSelector('.am-app', { timeout: 30_000 })
    await sleep(2200)
    check('进入日历 Space', await enterSpace(win, 'calendar'))
    await win.waitForSelector('.amx-cal-event[aria-label^="产品深度工作"]', { timeout: 30_000 })
    await sleep(1200)
    const calState = await st()
    check('E 日历挂着:prose 表已注入、包裹层上 --color-accent 有值(包裹层内主题仍在)', calState.prose > 0 && calState.wraps > 0 && !!calState.accent, JSON.stringify(calState))
    await sweep('日历·周视图', { probe: true })
    await calParity('周视图 + 待办 + 右栏')

    await win.locator('.amx-cal-modes').getByRole('button', { name: '周', exact: true }).click()
    await win.waitForFunction(() => document.querySelectorAll(':popover-open').length > 0, null, { timeout: 5000 })
    await calParity('视图下拉菜单打开')
    await win.keyboard.press('Escape')
    await win.waitForFunction(() => document.querySelectorAll(':popover-open').length === 0, null, { timeout: 5000 })

    await win.locator('.amx-cal-event[aria-label^="产品深度工作"]').first().click()
    await win.getByRole('dialog', { name: /编辑事件/ }).waitFor({ timeout: 5000 })
    await calParity('事件详情')
    await sweep('日历·事件详情')
    await win.keyboard.press('Escape')

    await win.keyboard.press('m')
    await win.waitForSelector('.amx-cal-mscroll', { timeout: 5000 })
    const more = win.locator('.amx-cal-more').first()
    if (await more.count()) {
      await more.click()
      await win.locator('.amx-cal-agenda[role="dialog"]').waitFor({ timeout: 5000 })
      await calParity('月视图 + 当日日程')
      await win.keyboard.press('Escape')
    } else {
      await calParity('月视图')
    }
    await win.keyboard.press('w')
    await win.waitForSelector('.amx-cal-tscroll', { timeout: 5000 })
    await captureWindow(app, path.join(SHOTS, 'calendar.png'))

    // ② 设置浮窗:独立文档,不该有运行时样式;顺便借它的 broadcastUi 走真跨窗通道切明暗 / 主题语言(syncFromWindow → AstryxScope 重跑)。
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'appearance', n: Date.now() } }))
    let settings = null
    for (let i = 0; i < 40 && !settings; i++) {
      await sleep(250)
      for (const w of app.windows()) if (w !== win && await w.locator('.settings-page').count().catch(() => 0)) settings = w
    }
    check('设置浮窗打开', !!settings)
    if (settings) {
      const ss = await settings.evaluate(() => ({ attr: document.documentElement.getAttribute('data-astryx-theme'), sheets: document.querySelectorAll('style[data-astryx-theme-prose], style[data-astryx-theme]').length }))
      check('设置浮窗(独立文档):没有 Astryx 运行时样式、<html> 不带属性', ss.attr === null && ss.sheets === 0, JSON.stringify(ss))
      const base = await st()
      // 载荷必须五轴齐全(shared/uiSync.ts 的 normalizeUiSync 缺一轴整条丢弃):skin / bg / glass 取主窗现值。
      const axes = await win.evaluate(() => { const d = document.documentElement.dataset; return { skin: d.skin, bg: d.bg || d.skin, glass: d.glass !== 'off' } })
      const broadcast = (patch) => settings.evaluate((p) => window.tangu.broadcastUi({ theme: p }), { ...axes, ...patch })
      const other = base.mode === 'dark' ? 'light' : 'dark'
      await broadcast({ lang: base.lang, modePref: other })
      await win.waitForFunction((m) => document.documentElement.dataset.mode === m, other, { timeout: 5000 }).catch(() => {})
      await sleep(600)
      const flipped = await st()
      check(`跨窗切明暗(${base.mode} → ${other})后日历仍挂着:<html> 不带属性`, flipped.mode === other && flipped.attr === null && flipped.prose > 0, JSON.stringify(flipped))
      await calParity(`${other} 模式周视图`)
      await captureWindow(app, path.join(SHOTS, `calendar-${other}.png`))
      const lang2 = base.lang === 'lovable' ? 'genesis-glass' : 'lovable'
      await broadcast({ lang: lang2, modePref: other })
      await win.waitForFunction((l) => document.documentElement.dataset.theme === l, lang2, { timeout: 5000 }).catch(() => {})
      await sleep(600)
      const relang = await st()
      check(`跨窗切主题语言(${base.lang} → ${lang2})后:<html> data-theme 是语言名、不带 data-astryx-theme`, relang.lang === lang2 && relang.attr === null, JSON.stringify(relang))
      await broadcast({ lang: base.lang, modePref: base.mode })
      await win.waitForFunction((b) => document.documentElement.dataset.theme === b.lang && document.documentElement.dataset.mode === b.mode, base, { timeout: 5000 }).catch(() => {})
      await sleep(600)
      const restored = await st()
      check('主题复原', restored.lang === base.lang && restored.mode === base.mode, JSON.stringify(restored))
      await settings.close().catch(() => {})
    }

    // ③ 离开日历:三个视图卸掉,运行时样式表随注入它的那个 Theme 一起被删(属性则会被旧版 AstryxScope 的清理微任务补回 <html>)。
    check('进入 Tangu', await enterSpace(win, 'tangu'))
    await sleep(800)
    const left = await st()
    note('离开日历后', JSON.stringify(left))
    check('A 离开日历后(Tangu):<html> 不带 data-astryx-theme', left.attr === null, JSON.stringify(left))
    const openChat = async () => {
      await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click({ timeout: 10_000 })
      await win.waitForFunction(() => [...document.querySelectorAll('pre')].some((p) => p.textContent.includes('const answer = 42')), null, { timeout: 15_000 })
      await sleep(800)
    }
    await openChat()
    await captureWindow(app, path.join(SHOTS, 'tangu-chat-alone.png'))

    // ④ 真实外溢场景:日历的视图跟别的内容同窗 —— 待办清单停在 Tangu / 笔记 Space 的右栏(用户能拖出来的布局)。
    //   在日历里改两个 Space 的命名布局槽(不在日历里改,切走时 saveNamed 会盖掉),右栏 stash = [todo-list],进去再展开右栏。
    check('进日历(准备布局)', await enterSpace(win, 'calendar'))
    await win.waitForSelector('.amx-cal-event', { timeout: 15_000 })
    const planted = await win.evaluate(() => {
      const KEY = 'tangu2_named_layouts'
      const m = JSON.parse(localStorage.getItem(KEY) || '{}')
      const ids = ['space:tangu', 'space:amadeus']
      if (!ids.every((k) => m[k] && m[k].sidebars)) return { ok: false, keys: Object.keys(m) }
      for (const k of ids) m[k].sidebars.right = { visible: false, stash: [{ type: 'todo-list', params: {} }] }
      localStorage.setItem(KEY, JSON.stringify(m))
      return { ok: true }
    })
    check('右栏布局已写入 Tangu / 笔记两个 Space 的命名槽', planted.ok, JSON.stringify(planted))
    const openTodoRight = async () => {
      if (!(await win.locator('.amx-todo').count())) await win.click('.dv-edge-right')
      await win.waitForSelector('.amx-todo', { timeout: 10_000 })
      await sleep(1200)
    }

    check('进入 Tangu(右栏待办)', await enterSpace(win, 'tangu'))
    await sleep(800)
    await openChat()
    await openTodoRight()
    await sweep('Tangu 对话 + 右栏待办', { probe: true })
    await captureWindow(app, path.join(SHOTS, 'tangu-chat-with-todo.png'))

    check('进入笔记(右栏待办)', await enterSpace(win, 'amadeus'))
    await sleep(800)
    if (!(await win.locator('.t2s-srow', { hasText: 'Prose sample' }).first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await sleep(800)
    }
    await win.locator('.t2s-srow', { hasText: 'Prose sample' }).first().click({ timeout: 10_000 })
    await win.waitForFunction(() => [...document.querySelectorAll('.am-app h4, .am-app pre')].length >= 2, null, { timeout: 15_000 })
    await openTodoRight()
    await sweep('笔记编辑器 + 右栏待办', { probe: true })
    await captureWindow(app, path.join(SHOTS, 'note-with-todo.png'))

    // ⑤ 回日历再离开:卸载 / 重挂路径不把属性写回去。
    check('再进日历', await enterSpace(win, 'calendar'))
    await win.waitForSelector('.amx-cal-event', { timeout: 15_000 })
    await sleep(600)
    check('A 再进日历:<html> 不带属性', (await st()).attr === null, JSON.stringify(await st()))
    check('再回 Tangu', await enterSpace(win, 'tangu'))
    await sleep(800)
    check('A 再回 Tangu:<html> 不带属性', (await st()).attr === null, JSON.stringify(await st()))

    // ⑥ 注入者先卸(放最后:关 tab 会改写日历 Space 的命名布局)。先去一个没有 Astryx 视图的 Space(收件箱)把所有 Theme 卸光,
    //   再进日历 = 从零挂载,Astryx 原生注入时首个挂载的是主区日历(它是唯一登记清理者)—— 从 Tangu(右栏停着待办)直接进,
    //   注入者会是别的视图,关主区就测不到(负对照实跑踩过)。
    check('去收件箱(卸光 Astryx 视图)', await enterSpace(win, 'inbox'))
    await sleep(800)
    note('收件箱(无 Astryx 视图)', JSON.stringify(await st()))
    check('再进日历(F)', await enterSpace(win, 'calendar'))
    await win.waitForSelector('.amx-cal-event', { timeout: 15_000 })
    await win.waitForSelector('.amx-todo .astryx-checkbox', { timeout: 10_000 })
    await sleep(800)
    const neg = await win.evaluate(() => window.__axs.survivorSheets())
    check('F0 负对照:停用运行时样式表,侧栏待办 / 日历设置的 token 与字体必变(比对看得见掉主题)', neg.changed > 0 && neg.back === 0, fmt(neg))
    // 注入者是三个视图里哪一个,取决于挂载序(Space 首次 build 时是主区日历,从命名布局还原时常是侧栏)—— 不去猜,
    // 三个轮流先卸:每一步都有别的视图还挂着,盯住它们的 token 与字体。
    const unmountStep = async (label, keepSel, wantWraps, act, waitGone) => {
      await win.evaluate((sel) => window.__axs.hold(sel), keepSel)
      const acted = await act()
      await win.waitForFunction(waitGone, null, { timeout: 5000 }).catch(() => {})
      await sleep(1000)
      const s = await st()
      const kept = await win.evaluate(() => window.__axs.heldDiff())
      check(`F ${label}:运行时 prose / token 表仍各一份,还剩 ${wantWraps} 个包裹层`, acted && s.prose === 1 && s.comp === 1 && s.wraps === wantWraps, JSON.stringify({ acted, ...s }))
      check(`F ${label}:还挂着的视图逐元素 Astryx token 与字体不变`, kept.total > 0 && kept.gone === 0 && kept.changed === 0,
        `${fmt(kept)}${kept.gone ? ` ‖ ${kept.gone} 个已脱离 DOM` : ''}`)
    }
    const leftToggle = () => win.evaluate(() => { const b = document.querySelector('.dv-edge-toggle:not(.dv-edge-right)'); if (b) b.click(); return !!b })
    await unmountStep('关掉主区日历', '.amx-todo, .amx-calside', 2, () => win.evaluate(() => {
      const btn = [...document.querySelectorAll('.dv-tab')].find((t) => t.textContent.trim() === '日历')?.querySelector('.wb-tab-close')
      if (btn) btn.click()
      return !!btn
    }), () => !document.querySelector('.amx-cal'))
    await captureWindow(app, path.join(SHOTS, 'calendar-main-closed.png'))
    await unmountStep('再收起左栏待办', '.amx-calside', 1, leftToggle, () => !document.querySelector('.amx-todo'))
    check('重新展开左栏待办', await leftToggle())
    await win.waitForSelector('.amx-todo .astryx-checkbox', { timeout: 10_000 })
    await sleep(800)
    await unmountStep('再收起右栏日历设置', '.amx-todo', 1, () => win.evaluate(() => { const b = document.querySelector('.dv-edge-right'); if (b) b.click(); return !!b }), () => !document.querySelector('.amx-calside'))
    await captureWindow(app, path.join(SHOTS, 'calendar-only-todo.png'))
    note('截图', SHOTS)
  } finally {
    await close()
  }
  process.exitCode = summary() ? 1 : 0
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
