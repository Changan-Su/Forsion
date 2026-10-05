// 「呼吸感」三个外观开关(frontend/src/theme/calm.ts + calm.css)的真 Electron 检查。量 out/,先 `npx electron-vite build`。
//   外围淡出 = Ribbon 图标 / 未选中的标签 / 左栏文字 / 对话右侧卡片平时退后,指针进来恢复
//   宽松正文 = 笔记与对话正文的行距、段距、笔记阅读宽度;界面字号与控件不动
//   舒缓过渡 = 切主视图的淡入、外围恢复的时长
// 钉四件事:缺省全开的数、指针进去真的恢复、在**设置浮窗**里关掉后主窗不重启就回到改动前的数(OFF 常量 = 10-05 改动前
// 在同一夹具上量到的值)、重载后仍然关着。另钉两处容易静默出事的:全宽笔记不被阅读宽度压住、画布里按缺省排版。
// 用法:node scripts/calm.check.cjs [--baseline] [--nc] [--light] [--lang=<设计语言 id>]
//   --baseline 只打印当前产物的度量(改 CSS 前后各跑一遍对数用),不断言
//   --nc       负对照:启动前把三个开关都存成关,「缺省开」那几组必须红 —— 此时退出码非 0 才算对
//   --light    浅色下跑一遍(淡出的数与恢复都一样要成立)
//   --lang=…   换一套设计语言跑(缺省 genesis-glass;出厂缺省语言是 lovable,两套都要绿)
// 截图落 SHOT_DIR(缺省系统临时目录),断言管数、观感自己看(DESIGN §8)。
const fs = require('fs')
const path = require('path')
const { sleep, shotDir, makeReporter, launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

const BASELINE = process.argv.includes('--baseline')
const NC = process.argv.includes('--nc')
const MODE = process.argv.includes('--light') ? 'light' : 'dark'
const LANG = (process.argv.find((a) => a.startsWith('--lang=')) || '').slice(7) || 'genesis-glass'
const W = 1512, H = 950

const NOTE = `这一版只做一件事：让第一次打开的人，三分钟之内写下第一条笔记。其它的想法先记在后面，不排进这一期。

## 为什么是这件事

上个月的反馈里，有一半的人卡在同一个地方：装好以后不知道从哪里开始。功能再多，第一步迈不出去也没有用。

- 打开就是一张空白的纸，光标已经在上面
- 不用先选模板，不用先建文件夹
- 写完自动存好，名字取第一行

## 接下来

先做一个可以点的原型，找五个没用过的人试。记下他们停顿的地方，不记他们说的话。停顿超过三秒的地方就是要改的地方。

下周三之前给出第一版，周五复盘。
`
const MESSAGES = [
  { id: 'm1', role: 'user', content: '帮我把这周的产品计划理一下，重点是什么？', created_at: '2026-10-01 10:00:00' },
  { id: 'm2', role: 'model', content: '## 这周的重点\n\n只有一件事：让第一次打开的人，三分钟之内写下第一条笔记。其它的想法先记下来，不排进这一期。\n\n上个月的反馈里，有一半的人卡在同一个地方：装好以后不知道从哪里开始。\n\n1. 打开就是一张空白的纸，光标已经在上面\n2. 不用先选模板，不用先建文件夹\n3. 写完自动存好，名字取第一行\n\n先做一个可以点的原型，找五个没用过的人试。\n\n## 之后\n\n下周三之前给出第一版，周五复盘。', created_at: '2026-10-01 10:00:30' },
]

// 关着时的数 = 2026-10-05 改动前在这份夹具上量到的(--baseline)。关掉任何一个开关都必须逐项回到这里。
const OFF = {
  note: { lh: 1.6, pGap: 4.5, hTop: 30.38, hBottom: 7.09, liGap: 4.5, width: 824 },
  chat: { lh: 1.72, pGap: 9.8, hBottom: 7, listAfter: 0, liGap: 0 },
  enter: '0.22s', reveal: '0.15s',
}
const ON = {
  note: { lh: 1.8, pGap: 10.5, hTop: 42.53, hBottom: 10.13, liGap: 4.5, width: 720 },
  chat: { lh: 1.8, pGap: 14, hBottom: 10.5, listAfter: 14, liGap: 4.2 },
  enter: '0.45s', reveal: '0.36s',
  ribbon: 0.42, tab: 0.45, side: 0.6, rail: 0.55,
}

const HELPERS = `
  const cs = (e) => getComputedStyle(e), r2 = (v) => Math.round(parseFloat(v) * 100) / 100
  const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const alpha = (s) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = s; cv.fillRect(0, 0, 1, 1); return Math.round(cv.getImageData(0, 0, 1, 1).data[3] / 2.55) / 100 }
  const textEl = (root) => { const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = tw.nextNode(); n; n = tw.nextNode()) if (n.nodeValue.trim()) return n.parentElement; return root }
  const gap = (a, b) => a && b ? r2(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom) : null
  const box = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height) + '/' + cs(e).fontSize : null }
`
// 正文排版:行距(倍数)、相邻两段的间隔、非首个二级标题的上下边距、列表项间隔、列表到下一块的间隔、一行的宽度
const BODY = (sel) => `(() => { ${HELPERS}
  const root = document.querySelector(${JSON.stringify(sel)}); if (!root) return null
  const ps = [...root.querySelectorAll(':scope > p')].filter((p) => p.textContent.trim())
  const pair = ps.find((p) => p.nextElementSibling && p.nextElementSibling.tagName === 'P')
  const h2 = root.querySelector(':scope > h2:not(:first-child)'), list = root.querySelector(':scope > ul, :scope > ol')
  const lis = list ? [...list.children] : [], fs = parseFloat(cs(ps[0]).fontSize)
  return { fs, lh: r2(parseFloat(cs(ps[0]).lineHeight) / fs), pGap: gap(pair, pair && pair.nextElementSibling),
    hTop: h2 ? r2(cs(h2).marginTop) : null, hBottom: h2 ? r2(cs(h2).marginBottom) : null,
    liGap: gap(lis[0], lis[1]), listAfter: list ? gap(list, list.nextElementSibling) : null, width: Math.round(ps[0].getBoundingClientRect().width) }
})()`
const NOTE_SEL = '.wb-view--main .milkdown .ProseMirror', CHAT_SEL = '.wb-view--main .t2-asst .t2-content'
// 外围:Ribbon 上非当前 / 当前 Space 的图标、左栏里未选中的图标页签、左栏未选中 / 选中行的字色透明度、对话右侧车道
const DIM = `(() => { ${HELPERS}
  const q = (s) => document.querySelector(s), op = (e) => e ? r2(cs(e).opacity) : null
  const row = q('.dv-groupview:has(.wb-tab--left) .t2s-srow:not(.active)'), cur = q('.dv-groupview:has(.wb-tab--left) .t2s-srow.active')
  return { ribbon: op(q('.rb .rb-space:not(.on) > svg')), ribbonOn: op(q('.rb .rb-space.on > svg')),
    tab: op(q('.dv-groupview:has(.wb-tab--left) .dv-tab:not(.dv-active-tab) .wb-tab')), tabOn: op(q('.dv-tab.dv-active-tab .wb-tab')),
    side: row ? alpha(cs(textEl(row)).color) : null, sideOn: cur ? alpha(cs(textEl(cur)).color) : null, rail: op(q('.t2-rail')),
    attrs: [document.documentElement.dataset.calmDim || '', document.documentElement.dataset.calmReading || '', document.documentElement.dataset.calmMotion || ''].join('|') }
})()`
// 左栏里每个元素的字色(归一成 r,g,b,a 四个整数):恢复态必须与关掉开关时逐个相同 —— 兜住「淡出规则顺手改了谁的颜色」
const LEFT_COLORS = `(() => { ${HELPERS}
  const px = (s) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = s; cv.fillRect(0, 0, 1, 1); return [...cv.getImageData(0, 0, 1, 1).data].join(',') }
  const v = document.querySelector('.wb-view--left'); return v ? [...v.querySelectorAll('*')].filter((e) => !e.closest('.__calm_probe')).map((e) => px(cs(e).color)) : null
})()`
// 插件面板最常见的写法:行不写颜色、靠继承;选中行只标 aria-selected / .active
const PLUGIN_ROWS = `(() => { ${HELPERS}
  const v = document.querySelector('.wb-view--left'); let p = v.querySelector('.__calm_probe')
  if (!p) { p = document.createElement('div'); p.className = '__calm_probe'; p.style.cssText = 'position:absolute;left:0;bottom:0;pointer-events:none'
    p.innerHTML = '<div data-k="plain">行</div><div data-k="sel" aria-selected="true">行</div><button data-k="btn" class="active">行</button><div data-k="multi" class="sel">行</div><div data-k="tok" style="color:var(--text-muted)">行</div>'; v.appendChild(p) }
  const o = {}; for (const e of p.children) o[e.dataset.k] = alpha(cs(e).color); return o
})()`
const MOTION = `(() => {
  const d = document.createElement('div'); d.className = 'wb-view wb-view-enter'; d.style.cssText = 'position:fixed;left:-9px;top:-9px;width:1px;height:1px'
  document.body.appendChild(d); const enter = getComputedStyle(d).animationDuration; d.remove()
  const pre = document.querySelector('.dockview-theme-lcl .dv-pre-actions-container')
  return { enter, reveal: pre ? getComputedStyle(pre).transitionDuration : null }
})()`
const CONTROLS = `(() => { ${HELPERS} return { ribbonBtn: box('.rb .rb-btn'), sideRow: box('.t2s-srow'), tab: box('.dv-tab'), toolbar: box('.amx-toolbar'), composer: box('.t2-composer, .composer-anchor') } })()`

const near = (a, b, tol = 0.26) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol
// 行距是倍数(开 1.8 / 关 1.6 或 1.72),容差必须远小于两者之差;其余是像素
const same = (got, want, keys, tol) => keys.every((k) => near(got?.[k], want[k], k === 'lh' ? 0.011 : tol))

async function main() {
  const { check, note, summary } = makeReporter()
  const out = shotDir('calm')
  const { app, win, home, close } = await launch({ tag: 'calm', messages: MESSAGES })
  const vault = path.join(home, 'vault')
  for (const f of ['课程', '项目', '读书笔记']) { fs.mkdirSync(path.join(vault, f), { recursive: true }); fs.writeFileSync(path.join(vault, f, 'README.md'), `# ${f}\n`, 'utf8') }
  for (const n of ['周报', '会议记录', '灵感']) fs.writeFileSync(path.join(vault, `${n}.md`), `# ${n}\n\n待整理。\n`, 'utf8')
  fs.writeFileSync(path.join(vault, '产品计划.md'), NOTE, 'utf8')
  try {
    await app.evaluate(({ nativeTheme }, m) => { nativeTheme.themeSource = m }, MODE)
    await boot(app, win, { space: 'tangu', width: W, height: H })
    await win.evaluate(({ m, nc, lang }) => {
      localStorage.setItem('forsion_theme_lang', lang); localStorage.setItem('forsion_theme_pref', m)
      localStorage.setItem('forsion_glass', 'off'); localStorage.setItem('tangu_locale', 'zh')
      for (const k of ['dim', 'reading', 'motion']) { if (nc) localStorage.setItem('forsion_calm_' + k, '0'); else localStorage.removeItem('forsion_calm_' + k) }
    }, { m: MODE, nc: NC, lang: LANG })
    await win.emulateMedia({ colorScheme: MODE })
    const reload = async () => { await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.rb .rb-space', { timeout: 30_000 }) }
    await reload(); await sleep(4000)
    win.setDefaultTimeout(8000)
    const park = async () => { await win.mouse.move(Math.round(W * 0.6), Math.round(H * 0.62)); await sleep(700) }
    const toNote = async () => { await enterSpace(win, 'amadeus'); await sleep(1200); await win.locator('.t2s-srow', { hasText: '产品计划' }).first().click(); await win.waitForSelector(`${NOTE_SEL} h2`); await sleep(1200); await park() }
    const toChat = async () => { await enterSpace(win, 'tangu'); await sleep(800); await win.locator('.t2s-srow', { hasText: 'Probe session one' }).first().click(); await win.waitForSelector(`${CHAT_SEL} h2`); await sleep(1500); await park() }
    const read = async () => ({ dim: await win.evaluate(DIM), motion: await win.evaluate(MOTION), controls: await win.evaluate(CONTROLS) })
    // 截主窗:设置浮窗开着时 getAllWindows()[0] 是浮窗,lib 的 captureWindow 会截到它
    const shot = async (name) => {
      const png = await app.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('window=')); return (await w.capturePage()).toPNG().toString('base64') })
      fs.writeFileSync(path.join(out, `${name}-${MODE}${LANG === 'genesis-glass' ? '' : '-' + LANG}.png`), Buffer.from(png, 'base64'))
    }

    await toNote()
    const n1 = { body: await win.evaluate(BODY(NOTE_SEL)), ...(await read()) }
    await shot('note-default')
    await toChat()
    const c1 = { body: await win.evaluate(BODY(CHAT_SEL)), ...(await read()) }
    await shot('chat-default')
    if (BASELINE) { console.log(JSON.stringify({ note: n1, chat: c1 }, null, 1)); return 0 }

    // A 缺省全开
    check('A1 没存过 = 全开:<html> 上没有关的标记', n1.dim.attrs === '||', n1.dim.attrs)
    check('A2 Ribbon:非当前 Space 的图标退后,当前的不动', near(n1.dim.ribbon, ON.ribbon, 0.011) && n1.dim.ribbonOn === 1, JSON.stringify(n1.dim))
    check('A3 左栏未选中的图标页签退后,选中的不动', near(n1.dim.tab, ON.tab, 0.011) && n1.dim.tabOn === 1, `${n1.dim.tab} / ${n1.dim.tabOn}`)
    check('A4 左栏文字退后(字色变淡,不是整块降透明度),选中行不动', near(n1.dim.side, ON.side, 0.021) && n1.dim.sideOn === 1, `${n1.dim.side} / ${n1.dim.sideOn}`)
    check('A5 对话右侧卡片(已完成、没有待处理)退后', near(c1.dim.rail, ON.rail, 0.011), String(c1.dim.rail))
    check('A6 笔记正文:行距 / 段距 / 标题上下 / 阅读宽度', same(n1.body, ON.note, ['lh', 'pGap', 'hTop', 'hBottom'], 0.3) && near(n1.body.width, ON.note.width, 1), JSON.stringify(n1.body))
    check('A7 笔记列表项间隔不跟着段距拉开', near(n1.body.liGap, OFF.note.liGap), String(n1.body.liGap))
    check('A8 对话正文:行距 / 段距 / 标题下 / 列表之后', same(c1.body, ON.chat, ['lh', 'pGap', 'hBottom', 'listAfter', 'liGap'], 0.3), JSON.stringify(c1.body))
    check('A9 过渡:切主视图淡入与外围恢复的时长', n1.motion.enter === ON.enter && n1.motion.reveal === ON.reveal, JSON.stringify(n1.motion))

    // B 指针进去恢复、离开再退后(真鼠标);回到笔记页量左栏
    const hover = async (sel) => { const b = await win.locator(sel).first().boundingBox(); await win.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 200)); await sleep(900) }
    await hover('.t2-rail .t2-tsum')
    check('B1 指针进对话右侧卡片 → 恢复', (await win.evaluate(DIM)).rail === 1)
    await toNote()
    await hover('.rb')
    const hb = await win.evaluate(DIM)
    check('B2 指针进 Ribbon → 图标恢复;左栏仍退后(各区各管各的)', hb.ribbon === 1 && near(hb.side, ON.side, 0.021), JSON.stringify(hb))
    await hover('.dv-groupview:has(.wb-tab--left) .dv-content-container')
    const hs = await win.evaluate(DIM)
    check('B3 指针进左栏 → 文字恢复;Ribbon 退回去', hs.side === 1 && near(hs.ribbon, ON.ribbon, 0.011), JSON.stringify(hs))
    await hover('.dv-groupview:has(.wb-tab--left) .dv-tabs-and-actions-container')
    check('B4 指针进左栏页签条 → 页签恢复', (await win.evaluate(DIM)).tab === 1)
    await hover('.dv-groupview:has(.wb-tab--left) .dv-content-container')
    const leftRestored = await win.evaluate(LEFT_COLORS)
    await park()
    const back = await win.evaluate(DIM)
    check('B5 指针回正文 → 外围各处退回去', near(back.ribbon, ON.ribbon, 0.011) && near(back.tab, ON.tab, 0.011) && near(back.side, ON.side, 0.021), JSON.stringify(back))

    const rows = await win.evaluate(PLUGIN_ROWS)
    check('B6 插件式的行:不写颜色、靠继承的也跟着淡;标了 aria-selected / .active / 多选 .sel 的保持全亮', near(rows.plain, ON.side, 0.021) && rows.sel === 1 && rows.btn === 1 && rows.multi === 1 && near(rows.tok, ON.side, 0.021), JSON.stringify(rows))

    // C 两处容易静默出事的:全宽笔记、画布
    const wide = await win.evaluate(`(() => { const pane = document.querySelector('.wb-view--main .amx-pane'); pane.setAttribute('data-page-wide', ''); const w = document.querySelector(${JSON.stringify(NOTE_SEL)} + ' > p').getBoundingClientRect().width; pane.removeAttribute('data-page-wide'); return Math.round(w) })()`)
    check('C1 全宽笔记不被阅读宽度压住', wide > 900, String(wide))
    const canvas = await win.evaluate(`(() => { const h = document.createElement('div'); h.className = 'am-app'; h.innerHTML = '<div class="unified-body amx-canvas"><div class="milkdown"><div class="ProseMirror"><p>一</p><p>二</p><ul><li><p>三</p></li></ul></div></div></div>'
      document.body.appendChild(h); const p = h.querySelectorAll('p')[1], c = getComputedStyle(p), r = { lh: Math.round(parseFloat(c.lineHeight) / parseFloat(c.fontSize) * 100) / 100, m: Math.round(parseFloat(c.marginTop) / parseFloat(c.fontSize) * 100) / 100 }; h.remove(); return r })()`)
    check('C2 画布里按缺省排版(卡片尺寸不跟着开关变)', canvas.lh === 1.6 && canvas.m === 0.3, JSON.stringify(canvas))

    // D 设置浮窗里逐个关 → 主窗不重启就跟上;每关一个,只有它管的那几项回到改动前
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'theme' } }))
    let fl = null
    for (let i = 0; i < 60 && !fl; i++) { fl = app.windows().find((w) => w.url().includes('window=floating')) || null; if (!fl) await sleep(250) }
    const flip = async (label) => { const sw = fl.locator(`button[role="switch"][aria-label="${label}"]`); await sw.scrollIntoViewIfNeeded(); await sw.click(); await sleep(900); return sw.getAttribute('aria-checked') }
    if (fl) await fl.locator('button[role="switch"][aria-label="舒缓过渡"]').waitFor({ timeout: 30_000 }).catch(() => {}) // 浮窗刚出来时外观页还没挂上
    check('D0 设置 → 外观里三个开关都在且开着', !!fl && (await fl.locator('button[role="switch"][aria-label="外围淡出"], button[role="switch"][aria-label="宽松正文"], button[role="switch"][aria-label="舒缓过渡"]').evaluateAll((els) => els.length === 3 && els.every((e) => e.getAttribute('aria-checked') === 'true'))))
    if (fl) await fl.screenshot({ path: path.join(out, `settings-${MODE}.png`) }).catch(() => {})

    const sw1 = await flip('宽松正文'); await park()
    const d1 = { body: await win.evaluate(BODY(NOTE_SEL)), ...(await read()) }
    check('D1 关「宽松正文」→ 笔记正文回到改动前;淡出与过渡不受影响', sw1 === 'false' && same(d1.body, OFF.note, ['lh', 'pGap', 'hTop', 'hBottom', 'liGap']) && near(d1.body.width, OFF.note.width, 1) && near(d1.dim.ribbon, ON.ribbon, 0.011) && d1.motion.enter === ON.enter, JSON.stringify({ b: d1.body, a: d1.dim.attrs }))
    check('D2 开和关之间,笔记页界面控件的高度与字号一样(且四样都量到了)', ['ribbonBtn', 'sideRow', 'tab', 'toolbar'].every((k) => n1.controls[k]) && JSON.stringify(d1.controls) === JSON.stringify(n1.controls), JSON.stringify(d1.controls))
    await shot('note-reading-off')
    const sw2 = await flip('舒缓过渡')
    const d2 = await win.evaluate(MOTION)
    check('D3 关「舒缓过渡」→ 两个时长回到改动前', sw2 === 'false' && d2.enter === OFF.enter && d2.reveal === OFF.reveal, JSON.stringify(d2))
    const sw3 = await flip('外围淡出'); await park()
    const d3 = await win.evaluate(DIM)
    check('D4 关「外围淡出」→ Ribbon / 页签 / 左栏都不退后', sw3 === 'false' && d3.ribbon === 1 && d3.tab === 1 && d3.side === 1 && d3.attrs === 'off|off|off', JSON.stringify(d3))
    await hover('.dv-groupview:has(.wb-tab--left) .dv-content-container') // 与取恢复态时同一个落点:悬停行自己的悬停色两边都有
    const leftOff = await win.evaluate(LEFT_COLORS)
    await park()
    const diff = leftRestored && leftOff && leftRestored.length === leftOff.length ? leftRestored.filter((c, i) => c !== leftOff[i]).length : -1
    check('D5 指针在左栏里时(恢复态),左栏每个元素的字色与关掉开关时逐个相同', diff === 0 && leftOff.length > 20, `${diff} / ${leftOff ? leftOff.length : 0} 个不同`)
    await shot('note-all-off')
    if (fl) await fl.close().catch(() => {})

    // E 关着的状态留得住:重载后第一眼就是关的(Ribbon 一出现就量,不等别的)
    await reload()
    const e1 = await win.evaluate(DIM)
    check('E1 重载后仍然关着,首帧就没有退后', e1.attrs === 'off|off|off' && e1.ribbon === 1, JSON.stringify(e1))
    await sleep(3000); await toChat()
    const e2 = { body: await win.evaluate(BODY(CHAT_SEL)), dim: await win.evaluate(DIM), controls: await win.evaluate(CONTROLS) }
    check('E2 全关时对话正文与右侧卡片回到改动前', same(e2.body, OFF.chat, ['lh', 'pGap', 'hBottom', 'listAfter', 'liGap']) && e2.dim.rail === 1, JSON.stringify(e2))
    check('E3 开和关之间,对话页界面控件(含输入区)的高度与字号一样', ['ribbonBtn', 'sideRow', 'tab', 'composer'].every((k) => c1.controls[k]) && JSON.stringify(e2.controls) === JSON.stringify(c1.controls), JSON.stringify(e2.controls))
    await shot('chat-all-off')
    note('截图', out)
    return summary()
  } finally {
    await close()
  }
}
main().then((failed) => { if (NC) { console.log(failed ? '负对照:如期变红' : '负对照没红 —— 断言是空的'); process.exit(failed ? 0 : 1) } process.exit(failed ? 1 : 0) }).catch((e) => { console.error(e); process.exit(2) })
