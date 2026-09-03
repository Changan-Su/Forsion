// 选中卡片的关系焦点：祖先链 + 自己的子树与连线保持清晰，其余卡片/层级线轻退。
// 用法：node scripts/e2e-editor.cjs --check=canvas-related-lines [--shot=/tmp/related-lines.png]
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const exe = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(exe)) return exe
    }
  }
  throw new Error('找不到 chromium，设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const shotArg = process.argv.find((arg) => arg.startsWith('--shot='))
const SHOT = shotArg ? shotArg.slice('--shot='.length) : null
const SEED = [
  '---',
  'amadeus_schema: amadeus.page/4',
  'amadeus_canvas: {"v":1,"mode":"canvas","main":{"x":40,"y":520,"w":520},"cards":[{"ref":"root","x":40,"y":100,"w":220},{"ref":"child","x":380,"y":100,"w":220},{"ref":"grandchild","x":760,"y":100,"w":220},{"ref":"sibling","x":380,"y":360,"w":220},{"ref":"cover","x":625,"y":82,"w":110}],"tree":{"child":"root","grandchild":"child","sibling":"root"}}',
  '---', '',
  '主卡正文。', '',
  '<!-- a root -->', '# 根卡片', '上游起点。', '<!-- /a root -->', '',
  '<!-- a child -->', '# 当前节点', '选中这张卡片。', '<!-- /a child -->', '',
  '<!-- a grandchild -->', '# 子级节点', '下游关系。', '<!-- /a grandchild -->', '',
  '<!-- a sibling -->', '# 兄弟分支', '不应被强调。', '<!-- /a sibling -->', '',
  '<!-- a cover -->', '# 遮挡卡', '<!-- /a cover -->', '',
].join('\n')

const checks = []
function check(name, ok, detail = '') {
  checks.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  try {
    await page.addInitScript(() => {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key?.startsWith('amx.noteSurfaceMode:')) localStorage.removeItem(key)
      }
    })
    await page.goto(`${URL}?upage&upane&useed=${encodeURIComponent(SEED)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.amx-el-conn.is-tree', { timeout: 20_000 })
    await page.waitForTimeout(500)

    await page.click('.amx-ucard[data-anchor="child"]', { position: { x: 16, y: 16 } })
    await page.waitForSelector('.amx-el-selbox[data-anchor="child"]')
    await page.waitForTimeout(260)

    const state = await page.evaluate(() => {
      const line = (id) => {
        const svg = document.querySelector(`.amx-el-conn[data-el="${id}"]`)
        const halo = svg?.querySelector('.amx-el-conn-halo')
        const core = svg?.querySelector('.amx-el-conn-core')
        return {
          related: svg?.classList.contains('is-related') ?? false,
          z: svg ? getComputedStyle(svg).zIndex : '',
          paths: svg?.querySelectorAll('path').length ?? 0,
          haloFilter: halo ? getComputedStyle(halo).filter : '',
          haloWidth: halo ? getComputedStyle(halo).strokeWidth : '',
          coreWidth: core ? getComputedStyle(core).strokeWidth : '',
          opacity: svg ? Number(getComputedStyle(svg).opacity) : -1,
        }
      }
      const cardOpacity = (anchor) => {
        const card = document.querySelector(`.amx-ucard[data-anchor="${anchor}"]`)
        return card ? Number(getComputedStyle(card).opacity) : -1
      }
      return {
        parent: line('t:child'),
        child: line('t:grandchild'),
        sibling: line('t:sibling'),
        cards: Object.fromEntries(['root', 'child', 'grandchild', 'sibling', 'cover'].map((anchor) => [anchor, cardOpacity(anchor)])),
        focusRules: document.querySelectorAll('style[data-amx-related-focus-rules]').length,
      }
    })

    check('选中中间卡：父级线与子级线都进入 related 态', state.parent.related && state.child.related, JSON.stringify(state))
    check('兄弟分支不误亮', !state.sibling.related, JSON.stringify(state.sibling))
    check('相关线提升到卡片上方', state.parent.z === '2' && state.child.z === '2', `parent=${state.parent.z} child=${state.child.z}`)
    check('相关线由虚化底线 + 清晰核心线组成', state.parent.paths === 2 && state.child.paths === 2
      && state.parent.haloFilter.includes('blur') && parseFloat(state.parent.haloWidth) > parseFloat(state.parent.coreWidth), JSON.stringify(state.parent))
    check('选中卡、全部父级和子级卡片保持完整显示', state.cards.root === 1 && state.cards.child === 1 && state.cards.grandchild === 1, JSON.stringify(state.cards))
    check('兄弟与无关遮挡卡柔和淡出', state.cards.sibling > 0.4 && state.cards.sibling < 0.5 && state.cards.cover > 0.4 && state.cards.cover < 0.5, JSON.stringify(state.cards))
    check('无关层级线同步后退', state.sibling.opacity > 0.1 && state.sibling.opacity < 0.25, JSON.stringify(state.sibling))

    if (SHOT) {
      await page.screenshot({ path: SHOT, fullPage: false })
      console.log(`SHOT  ${SHOT}`)
    }

    await page.click('.amx-ucard[data-anchor="cover"]', { position: { x: 16, y: 16 } })
    await page.waitForSelector('.amx-el-selbox[data-anchor="cover"]')
    await page.waitForTimeout(260)
    const switched = await page.evaluate(() => {
      const opacity = (anchor) => {
        const card = document.querySelector(`.amx-ucard[data-anchor="${anchor}"]`)
        return card ? Number(getComputedStyle(card).opacity) : -1
      }
      return { cover: opacity('cover'), child: opacity('child'), related: document.querySelectorAll('.amx-el-conn.is-related').length }
    })
    check('淡出卡仍可一击切换为新焦点', switched.cover === 1 && switched.child > 0.4 && switched.child < 0.5 && switched.related === 0, JSON.stringify(switched))

    await page.keyboard.press('Escape')
    await page.waitForTimeout(260)
    const afterEscape = await page.evaluate(() => ({
      related: document.querySelectorAll('.amx-el-conn.is-related').length,
      focusRules: document.querySelectorAll('style[data-amx-related-focus-rules]').length,
      opacities: [...document.querySelectorAll('.amx-ucard')].map((card) => Number(getComputedStyle(card).opacity)),
    }))
    check('取消选中后聚焦完整收起', afterEscape.related === 0 && afterEscape.focusRules === 0 && afterEscape.opacities.every((opacity) => opacity === 1), JSON.stringify(afterEscape))
  } finally {
    await browser.close()
  }

  const failed = checks.filter((ok) => !ok).length
  console.log(`\n${checks.length - failed}/${checks.length} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
