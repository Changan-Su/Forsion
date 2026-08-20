// Canvas 卡片二击进入编辑后的丝滑光标回归。
// 用生产 UnifiedPage + CanvasStage 的两段式交互,不是裸 contenteditable。
// 用法:npm run check:canvascaret(由 e2e-editor 自起/复用 Vite)。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const SEED = [
  '---',
  'amadeus_schema: amadeus.page/4',
  'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":0,"y":0,"w":600},"cards":[{"ref":"k1","x":700,"y":40,"w":300}]}',
  '---',
  '',
  '主卡正文。',
  '',
  '<!-- a k1 -->',
  '卡片正文。',
  '',
].join('\n')
const DOCUMENT_SEED = [
  '# 文档模式标题',
  '',
  '文档模式正文。',
  '',
].join('\n')

const results = []
function check(name, ok, detail) {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await page.goto(`${URL}?upage&upane&caret&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.amx-ucard[data-anchor="k1"] p', { timeout: 20000 })
  await page.waitForTimeout(600)

  const at = await page.evaluate(() => {
    const p = document.querySelector('.amx-ucard[data-anchor="k1"] p')
    const r = p.getBoundingClientRect()
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }
  })
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(160)
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(260)
  await page.keyboard.press('End')
  await page.waitForTimeout(240)

  const state = await page.evaluate(() => {
    const sel = getSelection()
    const rr = sel?.rangeCount ? sel.getRangeAt(0).getClientRects()[0] || sel.getRangeAt(0).getBoundingClientRect() : null
    const overlay = document.querySelector('.sc-caret')
    const or = overlay && getComputedStyle(overlay).display !== 'none' ? overlay.getBoundingClientRect() : null
    return {
      editing: !!document.querySelector('.amx-el-selbox.is-editing[data-anchor="k1"]'),
      pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
      documentFocus: document.hasFocus(),
      scOn: document.documentElement.classList.contains('sc-on'),
      selectionCollapsed: sel?.isCollapsed ?? false,
      anchorInHost: !!sel?.anchorNode && !!document.activeElement?.closest?.('.ProseMirror')?.contains(sel.anchorNode),
      hostRect: (() => { const r = document.activeElement?.closest?.('.ProseMirror')?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null })(),
      native: rr ? { left: rr.left, top: rr.top, height: rr.height } : null,
      overlay: or ? { left: or.left, top: or.top, height: or.height } : null,
    }
  })
  check('Canvas 卡片已进入文字编辑态', state.editing && state.pmFocus, JSON.stringify(state))
  check('Canvas 编辑态丝滑光标可见', !!state.overlay, JSON.stringify(state))
  check(
    'Canvas 丝滑光标与真实选区重合',
    !!state.native && !!state.overlay
      && Math.abs(state.native.left - state.overlay.left) <= 2
      && Math.abs(state.native.top - state.overlay.top) <= 2
      && Math.abs(state.native.height - state.overlay.height) <= 2,
    JSON.stringify(state),
  )

  // 文档模式会保留 Canvas 舞台 DOM，并用 display:contents 把两层外壳摘出布局。
  // 舞台本身仍声明 overflow:hidden，不能把这个“没有盒子”的祖先误当成真实裁剪边界。
  await page.goto(`${URL}?upage&upane&caret&useed=${encodeURIComponent(DOCUMENT_SEED)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.unified-body .ProseMirror p', { timeout: 20000 })
  await page.waitForTimeout(500)
  const docAt = await page.evaluate(() => {
    const p = document.querySelector('.unified-body .ProseMirror p')
    const r = p.getBoundingClientRect()
    return { x: r.left + Math.min(70, r.width / 2), y: r.top + r.height / 2 }
  })
  await page.mouse.click(docAt.x, docAt.y)
  await page.keyboard.press('End')
  await page.waitForTimeout(240)

  const docState = await page.evaluate(() => {
    const stage = document.querySelector('.amx-stage.amx-stage-off')
    const sel = getSelection()
    const rr = sel?.rangeCount ? sel.getRangeAt(0).getClientRects()[0] || sel.getRangeAt(0).getBoundingClientRect() : null
    const overlay = document.querySelector('.sc-caret')
    const or = overlay && getComputedStyle(overlay).display !== 'none' ? overlay.getBoundingClientRect() : null
    return {
      pmFocus: !!document.activeElement?.closest?.('.ProseMirror'),
      stageDisplay: stage ? getComputedStyle(stage).display : null,
      stageOverflow: stage ? getComputedStyle(stage).overflow : null,
      stageBoxes: stage?.getClientRects().length ?? -1,
      native: rr ? { left: rr.left, top: rr.top, height: rr.height } : null,
      overlay: or ? { left: or.left, top: or.top, height: or.height } : null,
    }
  })
  check(
    '文档模式舞台外壳无布局盒但保留 overflow 声明',
    docState.stageDisplay === 'contents' && docState.stageBoxes === 0 && docState.stageOverflow === 'hidden',
    JSON.stringify(docState),
  )
  check('文档模式丝滑光标可见', docState.pmFocus && !!docState.overlay, JSON.stringify(docState))
  check(
    '文档模式丝滑光标与真实选区重合',
    !!docState.native && !!docState.overlay
      && Math.abs(docState.native.left - docState.overlay.left) <= 2
      && Math.abs(docState.native.top - docState.overlay.top) <= 2
      && Math.abs(docState.native.height - docState.overlay.height) <= 2,
    JSON.stringify(docState),
  )

  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
