/**
 * 拖入反馈与虚线边框守卫(全应用;2026-10-12 之前只管 Amadeus,聊天区和工作区遮罩的同款虚线框因此留到了 2.13.2):
 *  1. 任何样式表、任何内联样式里都不许有虚线边框或虚线轮廓(拖入框、占位按钮都算);
 *  2. 文档只留顶部短光条,画布只留舞台顶部短光条,两者不叠;
 *  3. CanvasStage 退出画布或拖拽在别处结束时会主动清掉瞬态 class;
 *  4. 聊天区:整块淡染 + 输入框亮起,不描边;拖拽在别处结束时窗口级收尾。
 *
 * 跑:npm run check:dropfeedback
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..')
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const dir of fs.readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of [
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const exe = path.join(cache, dir, 'chrome-mac-arm64', app)
      if (fs.existsSync(exe)) return exe
    }
  }
  throw new Error('找不到 Chromium(可用 CHROMIUM_EXE 指定)')
}

const hostCss = fs.readFileSync(path.join(ROOT, 'frontend/src/amadeus-host.css'), 'utf8')
const editorCss = fs.readFileSync(path.join(ROOT, 'frontend/src/amadeus/styles.css'), 'utf8')
const canvasSource = fs.readFileSync(path.join(ROOT, 'frontend/src/amadeus/unified/canvasStage.tsx'), 'utf8')

// 静态门禁先守语义:这两个状态选择器以后不能又被改回 dashed。
const dropRules = [...`${hostCss}\n${editorCss}`.matchAll(/[^{}]*(?:amx-dragover|amx-dropzone)[^{}]*\{[^{}]*\}/g)]
  .map((m) => m[0])
check(
  'A 拖入状态规则没有整页 dashed outline / border',
  dropRules.length >= 2 && dropRules.every((rule) => !/\b(?:outline|border)(?:-[\w-]+)?\s*:[^;{}]*\bdashed\b/i.test(rule)),
  `检查 ${dropRules.length} 个 dragover/dropzone 规则块`,
)

// 全应用:样式表里不许有虚线边框 / 轮廓(2026-10-12 用户定:包住整块的拖入框和小的占位按钮都不要虚线)。
// 注释先剥掉。不算数的:`text-decoration-style: dashed`(没建出来的双链的下划线,不是边框)。
// 已知上限:只看 CSS 的 border / outline 和 TSX 里的内联样式;SVG 的 stroke-dasharray、canvas 的 setLineDash 不管
// (图表参考线、画布连线预览、关系图的幽灵节点这类是图形里的线,不是界面边框)。
const walk = (dir, exts) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).flatMap((e) => (
  e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name), exts) : exts.some((x) => e.name.endsWith(x)) ? [path.join(dir, e.name)] : []
))
// 前面不许是 - 或字母:`--border: 2px dashed …` 这种自定义属性不是边框
const DASHED = /(?<![-\w])(?:outline|border)(?:-[\w-]+)?\s*:[^;{}]*\bdashed\b/i
const SRC_DIRS = [path.join(ROOT, 'frontend/src'), path.join(ROOT, '../lcl')]
const cssFiles = SRC_DIRS.flatMap((d) => walk(d, ['.css']))
const offenders = cssFiles.flatMap((file) => (
  [...fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => DASHED.test(m[2]))
    .map((m) => `${path.relative(ROOT, file)}: ${m[1].trim().replace(/\s+/g, ' ').slice(0, 80)}`)
))
check(
  'A2 全应用:样式表里没有 dashed outline / border',
  cssFiles.length > 20 && offenders.length === 0,
  offenders.length ? offenders.join(' | ') : `扫了 ${cssFiles.length} 个样式表`,
)
// 内联样式同样不许:borderStyle: 'dashed' / border: '1px dashed …' / outline: `… dashed`
const INLINE_DASHED = /\b(?:border|outline)[A-Za-z]*\s*:\s*['"`][^'"`\n]*\bdashed\b/
const tsFiles = SRC_DIRS.flatMap((d) => walk(d, ['.ts', '.tsx'])).filter((f) => !/\.test\.tsx?$/.test(f))
const inlineOffenders = tsFiles.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
  .map((line, n) => (INLINE_DASHED.test(line) ? `${path.relative(ROOT, file)}:${n + 1}` : null)).filter(Boolean))
check(
  'A3 全应用:TS / TSX 的内联样式里没有 dashed outline / border',
  tsFiles.length > 200 && inlineOffenders.length === 0,
  inlineOffenders.length ? inlineOffenders.join(' | ') : `扫了 ${tsFiles.length} 个源文件`,
)

const cleanupBlock = canvasSource.match(/return \(\) => \{[\s\S]*?\n\s*\}\n\s*\}, \[active, toStage\]\)/)?.[0] ?? ''
check(
  'B CanvasStage effect 清理会主动移除 amx-dropzone',
  /clearDropzone\(\)/.test(cleanupBlock),
  cleanupBlock ? '退出画布也清 class' : '未找到 effect cleanup',
)
for (const event of ['dragend', 'drop', 'blur']) {
  check(
    `C ${event} 结束拖拽会清提示且卸载监听`,
    new RegExp(`window\\.addEventListener\\('${event}', clearDropzone\\)`).test(canvasSource)
      && new RegExp(`window\\.removeEventListener\\('${event}', clearDropzone\\)`).test(cleanupBlock),
  )
}

// 聊天区的引用拖拽(ChatView 的 refDrop):拖拽在别处结束也要收。OS 文件那条(data-filedrop)由 composer2.filesdrop.test.ts 钉。
const chatView = fs.readFileSync(path.join(ROOT, 'frontend/src/views/ChatView.tsx'), 'utf8')
const refClear = chatView.match(/if \(!refDrop\) return[\s\S]*?\}, \[refDrop\]\)/)?.[0] ?? ''
check(
  'H 聊天区 refdrop 在 dragend / drop / blur 时窗口级收尾并卸载监听',
  ['dragend', 'drop', 'blur'].every((ev) => refClear.includes(`window.addEventListener('${ev}', clear`) && refClear.includes(`window.removeEventListener('${ev}', clear`)),
  refClear ? '' : '未找到 refDrop 的收尾 effect',
)

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1000, height: 700 } })
  await page.setContent(`<!doctype html>
    <style>
      :root { --primary: rgb(45, 170, 190); --accent: rgb(45, 170, 190); --bg: rgb(24, 24, 24); --border: transparent; }
      ${hostCss}
      ${editorCss}
      #doc, #canvas-editor, #inactive-editor { width: 600px; height: 180px; margin: 10px; }
    </style>
    <div id="doc" class="am-app amx-editor amx-dragover"></div>
    <div id="canvas-editor" class="am-app amx-editor amx-dragover">
      <div id="stage" class="amx-stage amx-dropzone"></div>
    </div>
    <div id="inactive-editor" class="am-app amx-editor amx-dragover">
      <div id="inactive-stage" class="amx-stage amx-stage-off amx-dropzone"><div>document mode</div></div>
    </div>`)

  const measured = await page.evaluate(() => {
    const style = (selector, pseudo) => getComputedStyle(document.querySelector(selector), pseudo)
    const pick = (selector, pseudo) => {
      const s = style(selector, pseudo)
      return {
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        backgroundImage: s.backgroundImage,
        backgroundColor: s.backgroundColor,
        backgroundSize: s.backgroundSize,
        width: s.width,
        height: s.height,
        display: s.display,
        pointerEvents: s.pointerEvents,
        content: s.content,
      }
    }
    return {
      doc: pick('#doc'),
      canvasEditor: pick('#canvas-editor'),
      stage: pick('#stage'),
      stageCue: pick('#stage', '::after'),
      inactiveStage: pick('#inactive-stage'),
      inactiveCue: pick('#inactive-stage', '::after'),
    }
  })

  check(
    'D 文档模式无外圈,只画顶部短光条',
    measured.doc.outlineStyle === 'none'
      && measured.doc.backgroundImage.includes('linear-gradient')
      && /3px/.test(measured.doc.backgroundSize),
    JSON.stringify(measured.doc),
  )
  check(
    'E 画布模式不叠文档反馈,舞台本身也无外圈',
    measured.canvasEditor.backgroundImage === 'none'
      && measured.stage.outlineStyle === 'none',
    JSON.stringify({ editor: measured.canvasEditor, stage: measured.stage }),
  )
  check(
    'F 画布反馈是局部 96×4px 光条且不挡交互',
    parseFloat(measured.stageCue.width) === 96
      && parseFloat(measured.stageCue.height) === 4
      && measured.stageCue.pointerEvents === 'none'
      && measured.stageCue.backgroundColor !== 'rgba(0, 0, 0, 0)',
    JSON.stringify(measured.stageCue),
  )
  check(
    'G 即使旧 class 泄到文档模式也画不出外圈',
    measured.inactiveStage.display === 'contents'
      && measured.inactiveStage.outlineStyle === 'none'
      && measured.inactiveCue.content === 'none',
    JSON.stringify({ stage: measured.inactiveStage, cue: measured.inactiveCue }),
  )

  // 聊天区:两种拖入标记下都是「整块淡染 + 输入框亮起」,伪元素不描边。
  await page.setContent(`<!doctype html>
    <style>
      :root { --accent-ink: rgb(45, 170, 190); --bg-card: rgb(40, 40, 40); }
      ${fs.readFileSync(path.join(ROOT, '../lcl/components/chatBox.css'), 'utf8')}
      ${fs.readFileSync(path.join(ROOT, 'frontend/src/views/chat2/chat2.css'), 'utf8')}
      .t2-chat-view { width: 600px; height: 200px; margin: 10px; }
    </style>
    <div id="files" class="t2-chat-view" data-filedrop><div class="t2c-card"></div></div>
    <div id="refs" class="t2-chat-view refdrop"><div class="t2c-card"></div></div>
    <div id="idle" class="t2-chat-view"><div class="t2c-card"></div></div>`)
  const chat = await page.evaluate(() => Object.fromEntries(['files', 'refs', 'idle'].map((id) => {
    const el = document.getElementById(id)
    const wash = getComputedStyle(el, '::after'); const card = getComputedStyle(el.querySelector('.t2c-card'))
    return [id, { content: wash.content, washBorder: wash.borderTopStyle, washOutline: wash.outlineStyle, washBg: wash.backgroundColor, cardBorder: card.borderTopColor }]
  })))
  for (const id of ['files', 'refs']) {
    check(
      `I 聊天区 ${id}:整块淡染不描边,输入框描边换主题色`,
      chat[id].content !== 'none' && chat[id].washBorder === 'none' && chat[id].washOutline === 'none'
        && chat[id].washBg !== 'rgba(0, 0, 0, 0)' && chat[id].cardBorder === 'rgb(45, 170, 190)',
      JSON.stringify(chat[id]),
    )
  }
  check('J 聊天区平时什么都不画', chat.idle.content === 'none' && chat.idle.cardBorder !== 'rgb(45, 170, 190)', JSON.stringify(chat.idle))

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
