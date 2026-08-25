/**
 * Amadeus 拖入反馈守卫:
 *  1. 文档 / 画布都不再画整面虚线框;
 *  2. 文档只留顶部短光条,画布只留舞台顶部短光条,两者不叠;
 *  3. CanvasStage 退出画布或拖拽在别处结束时会主动清掉瞬态 class。
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

;(async () => {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
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

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
