/**
 * 拖入反馈守卫(全应用;2026-10-12 之前只管 Amadeus,聊天区和工作区遮罩的同款虚线框因此留到了 2.13.2):
 *  1. 任何样式表里,带拖拽 / 落区状态的选择器都不许画虚线边框或虚线轮廓;
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

// 全应用:带拖拽 / 落区状态的选择器不许画虚线边框 / 轮廓(注释先剥掉,免得注释里的字眼算进选择器)。
// 已知上限:按「最内层花括号」切规则,不认 CSS 嵌套(`.x.dragover { &::after { … } }` 里父级的状态会丢)。
// 现在全应用样式表没有用嵌套;哪天用上了,这里要换成真的解析器。
const walkCss = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
  e.name === 'node_modules' ? [] : e.isDirectory() ? walkCss(path.join(dir, e.name)) : e.name.endsWith('.css') ? [path.join(dir, e.name)] : []
))
// 前面不许是 - 或字母:`--border: 2px dashed …` 这种自定义属性不是边框
const DASHED = /(?<![-\w])(?:outline|border)(?:-[\w-]+)?\s*:[^;{}]*\bdashed\b/i
const DRAG_STATE = /drag|(?<!back)drop(?!down)/i
// 拖动时的落位占位(日历拖日程、仪表盘拖卡片;不是包住整块的框)。要不要也去掉 2026-10-12 已问用户、未答;答了之后删掉这两条。
const PENDING = ['.amx-cal-dropghost', '.dash3-card[data-dragging]']
const cssFiles = [path.join(ROOT, 'frontend/src'), path.join(ROOT, '../lcl')].flatMap(walkCss)
const offenders = cssFiles.flatMap((file) => (
  [...fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    // 选择器列表逐个判:豁免只豁免它自己那一个,不连带同一条规则里的别的选择器
    .filter((m) => DASHED.test(m[2]) && m[1].split(',').some((sel) => DRAG_STATE.test(sel) && !PENDING.some((p) => sel.includes(p))))
    .map((m) => `${path.relative(ROOT, file)}: ${m[1].trim().slice(0, 80)}`)
))
check(
  'A2 全应用:拖拽 / 落区状态的规则没有 dashed outline / border',
  cssFiles.length > 20 && offenders.length === 0,
  offenders.length ? offenders.join(' | ') : `扫了 ${cssFiles.length} 个样式表`,
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
