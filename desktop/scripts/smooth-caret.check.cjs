/**
 * 丝滑光标「与原生光标重合」契约检查(真 Chromium 断言)。
 *
 * 为什么存在(两次翻车换来的):
 *  1) 覆盖层是挂在 body 下的 `position: fixed`,而 body 在多个端带 CSS zoom(uiZoom.ts:网页端 1.1 /
 *     触屏窄屏 1.15;singleColumn.css 的 .mini-shell 0.85)。CSS zoom 会把覆盖层自己的
 *     `translate(x,y)` 再乘一遍,而 `getBoundingClientRect()` 给的已是视口坐标 →
 *     偏移 =「离视口原点距离 ×(zoom-1)」。桌面 Electron 默认 zoom=1 看不出来,一到网页端就现原形。
 *  2) **caret 高度 ≠ 行高**。原生 caret 画的是行内盒(字体 content area,≈1.2em),不是行盒。
 *     textarea 分支原来拿 line-height 当高度 —— 聊天框 22.4px vs 真值 17px,长 32%,肉眼就是
 *     「光标比真的长一截」。第一版仪器只拿「collapsed range 矩形」当真值,而 textarea 分支根本
 *     不经过 range,于是仪器全绿、用户照报 bug。教训:真值要选**用户在看的那个东西**。
 *
 * 真值取法(headless Chromium **不渲染原生 caret**,像素法已验证不可行):
 *  - 编辑器有字:collapsed range 的矩形 = 原生 caret 几何。
 *  - 编辑器空行:临时往空段落塞一个字符,量它的 range 矩形,再还原。
 *  - 聊天框:与 textarea 完全同排版的 contenteditable 里同偏移的 range 矩形(caret 绘制规则一致),
 *    按「相对宿主左上角」比较。
 *
 * 直接 bundle 仓里真实的 smoothCaret.ts + 注入真实 base.css,故不会与源码漂移。
 * 改 smoothCaret.ts 的定位/尺寸计算后必跑:npm run check:caret
 * (需 playwright-core 自装的 chromium;CHROMIUM_EXE 可覆盖)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')
const esbuild = require('esbuild')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort()
  for (const d of dirs.reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const ROOT = path.resolve(__dirname, '..')
const BASE_CSS = fs.readFileSync(path.join(ROOT, 'frontend/src/styles/base.css'), 'utf8')
const SC_JS = esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'frontend/src/smoothCaret.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'SC',
  write: false,
}).outputFiles[0].text

/**
 * 复刻两个真实宿主的排版(字号/行高照抄产品值,改了要同步):
 *  - 笔记编辑器 `.am-app .milkdown .ProseMirror`:15px / 1.6(amadeus/styles.css)
 *  - 聊天输入框 `textarea.t2c-ta`:14px / 22.4px(真机量得)
 * `#truth` 是聊天框的真值参照:与 textarea 同排版的 contenteditable。
 */
const HTML = `<!doctype html><meta charset="utf-8"><style>${BASE_CSS}</style>
<style>
  html, body { margin: 0; background: #fff; color: #111; }
  .pad { padding: 40px 0 0 60px; }
  .milkdown .ProseMirror { width: 520px; font-size: 15px; line-height: 1.6; outline: none; }
  textarea.t2c-ta, #truth { display: block; width: 420px; font-family: system-ui; font-size: 14px;
    line-height: 22.4px; padding: 0; border: 0; outline: none; background: #fff;
    white-space: pre-wrap; overflow-wrap: break-word; box-sizing: border-box; }
  textarea.t2c-ta { margin-top: 30px; height: 70px; resize: none; }
  #truth { margin-top: 20px; }
</style>
<div class="pad"><div class="milkdown"><div class="ProseMirror" contenteditable="true"><p id="p1">Hello world, this is a fairly long line of text used to push the caret far from the viewport origin.</p><p id="p2">second line</p><p id="p3"><br></p></div></div>
<textarea class="t2c-ta" id="ta">chat input line one, long enough to wrap somewhere around here
line two</textarea>
<div id="truth" contenteditable="true">chat input line one, long enough to wrap somewhere around here
line two</div></div>`

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })
  await page.setContent(HTML)
  await page.addScriptTag({ content: SC_JS })
  await page.evaluate(() => {
    window.SC.installSmoothCaret()
    window.SC.setSmoothCaretEnabled(true) // 免 localStorage(about:blank 是不透明源,读写会抛)
  })
  check('文档处于聚焦态(update() 的前提)', await page.evaluate(() => document.hasFocus()))

  /** 编辑器:落 caret → 与 range 真值比。空段落走「临时塞字符」取真值。 */
  const editorCase = (pid, offset) =>
    page.evaluate(({ pid, offset }) => {
      const p = document.getElementById(pid)
      const empty = !p.firstChild || p.firstChild.nodeName === 'BR'
      const sel = getSelection()
      let truth
      if (empty) {
        const old = p.innerHTML
        p.textContent = 'x'
        const tr = document.createRange()
        tr.setStart(p.firstChild, 0)
        tr.collapse(true)
        const b = tr.getBoundingClientRect()
        truth = { left: b.left, top: b.top, height: b.height }
        p.innerHTML = old
      }
      const r = document.createRange()
      if (empty) r.setStart(p, 0)
      else r.setStart(p.firstChild, Math.min(offset, p.firstChild.length))
      r.collapse(true)
      sel.removeAllRanges()
      sel.addRange(r)
      document.querySelector('.ProseMirror').focus()
      document.dispatchEvent(new Event('selectionchange'))
      if (!empty) {
        const b = r.getBoundingClientRect()
        truth = { left: b.left, top: b.top, height: b.height }
      }
      return truth
    }, { pid, offset })

  /** 聊天框:textarea 落 caret;真值 = 同排版 contenteditable 同偏移的 range 矩形(相对各自宿主左上角)。 */
  const taCase = (at) =>
    page.evaluate((at) => {
      const ta = document.getElementById('ta')
      const ce = document.getElementById('truth')
      const r = document.createRange()
      r.setStart(ce.firstChild, at)
      r.collapse(true)
      const b = r.getBoundingClientRect()
      const cr = ce.getBoundingClientRect()
      ta.focus()
      ta.setSelectionRange(at, at)
      document.dispatchEvent(new Event('selectionchange'))
      return { relLeft: b.left - cr.left, relTop: b.top - cr.top, height: b.height }
    }, at)

  const drawn = (hostSel) =>
    page.evaluate((hostSel) => {
      const c = document.querySelector('.sc-caret')
      if (!c || getComputedStyle(c).display === 'none') return null
      const cr = c.getBoundingClientRect()
      const hr = document.querySelector(hostSel).getBoundingClientRect()
      return { left: cr.left, top: cr.top, height: cr.height, relLeft: cr.left - hr.left, relTop: cr.top - hr.top }
    }, hostSel)

  const CASES = [
    { label: '编辑器 行尾', host: '.ProseMirror', run: () => editorCase('p1', 97), rel: false },
    { label: '编辑器 次行中段', host: '.ProseMirror', run: () => editorCase('p2', 6), rel: false },
    { label: '编辑器 空行(<br>)', host: '.ProseMirror', run: () => editorCase('p3', 0), rel: false },
    { label: '聊天框 折行后', host: 'textarea.t2c-ta', run: () => taCase(45), rel: true },
    { label: '聊天框 第二行', host: 'textarea.t2c-ta', run: () => taCase(70), rel: true },
  ]

  for (const zoom of [1, 1.1]) { // 1=桌面 Electron 现场,1.1=网页端默认
    await page.evaluate((z) => { document.body.style.zoom = z === 1 ? '' : String(z) }, zoom)
    for (const c of CASES) {
      const truth = await c.run()
      await page.waitForTimeout(180) // 过 transform 90ms 过渡
      const got = await drawn(c.host)
      if (!got) { check(`zoom=${zoom} ${c.label}`, false, '覆盖层没画出来'); continue }
      const d = c.rel
        ? { x: got.relLeft - truth.relLeft, y: got.relTop - truth.relTop, h: got.height - truth.height }
        : { x: got.left - truth.left, y: got.top - truth.top, h: got.height - truth.height }
      for (const k of ['x', 'y', 'h']) d[k] = +d[k].toFixed(1)
      // 阈值 1.5px:亚像素吸附 + 整数化的固有噪声。要防的是「长一截 / 偏上 / 成比例跑偏」这类可见错位。
      const ok = Math.abs(d.x) <= 1.5 && Math.abs(d.y) <= 1.5 && Math.abs(d.h) <= 1.5
      check(`zoom=${zoom} ${c.label}:覆盖层与原生 caret 几何一致`, ok,
        `Δx=${d.x} Δy=${d.y} Δ高=${d.h}(真值高 ${truth.height.toFixed(1)},实画 ${got.height.toFixed(1)})`)
    }
  }

  // 程序化清空(发送后 React setDraft('') 落到 DOM):不触发 input/selectionchange,
  // 光标必须自己归位到空框起点。病史:发完消息光标留在原文末尾不动。
  await page.evaluate(() => { document.body.style.zoom = '' })
  await taCase(70)
  await page.waitForTimeout(180)
  const beforeClear = await drawn('textarea.t2c-ta')
  await page.evaluate(() => { document.getElementById('ta').value = '' })
  await page.waitForTimeout(500) // 轮询 100ms + transform 过渡
  const home = await drawn('textarea.t2c-ta')
  // 真值不是 (0,0):空框 caret 在行盒里居中,顶上有半行距(此处 (22.4−17)/2≈2.7px)。
  // 与其它用例同源 —— 拿同排版 contenteditable 的偏移 0 处 range 当真值。
  const truth0 = await page.evaluate(() => {
    const ce = document.getElementById('truth')
    const r = document.createRange()
    r.setStart(ce.firstChild, 0)
    r.collapse(true)
    const b = r.getBoundingClientRect()
    const cr = ce.getBoundingClientRect()
    return { relLeft: b.left - cr.left, relTop: b.top - cr.top }
  })
  check('聊天框 程序化清空后光标归位(发送后)',
    !!home && Math.abs(home.relLeft - truth0.relLeft) <= 1.5 && Math.abs(home.relTop - truth0.relTop) <= 1.5,
    home ? `清空前 (${beforeClear.relLeft.toFixed(1)}, ${beforeClear.relTop.toFixed(1)}) → 清空后 (${home.relLeft.toFixed(1)}, ${home.relTop.toFixed(1)}),真值 (${truth0.relLeft.toFixed(1)}, ${truth0.relTop.toFixed(1)})` : '覆盖层没画出来')

  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
