// 插模板合并 frontmatter(check:templatefm,评审 2026-09-27 G4-09)。
//
// 病:insertTemplate 只把模板正文插进 v4 笔记,模板自带的 frontmatter(tags / type / 自定义属性)整段丢弃。
// 现在:经实例的 fm 写口(unifiedPatchFm)合并 —— 目标已有的键不覆盖,tags / aliases 取并集,值里的 {{date}} 等照样替换。
// 真浏览器台架(?upage = 生产 UnifiedPage 全链):模板源用**真编译器** parsePageSource 解析(与主进程 readPage 对外来 md 走的
// importForeign 同一函数),桩掉 window.amadeus.readPage,调真 insertTemplate,断言落盘 md 的 fm 与正文。
// 用法:npm run check:templatefm(自带起停 vite;worktree 里设 HARNESS_URL 指到自己的端口)
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const TPL = '---\ntags: [daily]\ntype: journal\nmood: "{{date}}"\n---\n# {{title}}\n\n- [ ] 待办一\n'
const TPL_FM_ONLY = '---\ntags: [daily, x]\nstatus: draft\n---\n'

/** 打开 seed,把模板 src 插进去(光标放文末),返回最后一次落盘。 */
async function run(browser, seed, tpl) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.goto(`${BASE}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await page.waitForTimeout(500)
  const err = await page.evaluate(async (tpl) => {
    try {
      const src = await (await fetch('/src/amadeusTemplates.ts')).text()
      const m = src.match(/["'](\/@fs\/[^"']*compiler\/)markers\.ts["']/)
      if (!m) return 'compiler 模块路径没找到'
      const compiler = await import(m[1] + 'page.ts')
      window.amadeus.readPage = async (p) => compiler.parsePageSource(p, tpl, new Date().toISOString())
      const mod = await import('/src/amadeusTemplates.ts')
      const v = window.__upage.probe.view()
      let Base = v.state.selection.constructor
      while (Object.getPrototypeOf(Base) !== Function.prototype) Base = Object.getPrototypeOf(Base)
      const end = v.state.doc.content.size - 1
      v.dispatch(v.state.tr.setSelection(Base.fromJSON(v.state.doc, { type: 'text', anchor: end, head: end })))
      v.focus()
      await mod.insertTemplate('templates/daily.md', { v4Path: 'Unified.md' })
      return null
    } catch (e) { return String(e && e.message || e) }
  }, tpl)
  for (let t = 0; t < 40 && (await page.evaluate(() => window.__upage.writes.length)) === 0; t++) await page.waitForTimeout(100)
  await page.waitForTimeout(1200)
  const md = await page.evaluate(() => { const w = window.__upage.writes; return w.length ? w[w.length - 1].text : null })
  await page.close()
  return { md: md || '', err: err || errs[0] || null }
}

const fmOf = (md) => (/^---\n([\s\S]*?)\n---\n/.exec(md) || [])[1] ?? null
const today = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    // T1 目标没有 fm:模板的键全部进来(值里的 {{date}} 已替换),正文照插。
    {
      const r = await run(browser, '# 页\n\n正文。\n', TPL)
      const fm = fmOf(r.md)
      check('T1 目标无 fm:模板 tags / type / mood 进 fm({{date}} 已替换),正文照插',
        !r.err && fm != null && /tags:[\s\S]*daily/.test(fm) && /type: journal/.test(fm) && fm.includes(today()) && /# Unified/.test(r.md) && /- \[ \] 待办一/.test(r.md),
        JSON.stringify(r))
    }
    // T2 目标已有 fm:已有键不覆盖、tags 取并集、别的原样。
    {
      const r = await run(browser, '---\ntags: [x]\ntype: note\nkeep: 1\n---\n# 页\n\n正文。\n', TPL)
      const fm = fmOf(r.md) || ''
      check('T2 目标已有 fm:type 不被覆盖、tags 并集 [x, daily]、keep 原样、mood 新增',
        !r.err && /type: note/.test(fm) && !/journal/.test(fm) && /x[\s\S]*daily/.test((/tags:[^\n]*(?:\n\s+-[^\n]*)*/.exec(fm) || [''])[0]) && /keep: 1/.test(fm) && /mood:/.test(fm),
        JSON.stringify(r))
    }
    // T3 只有 fm、没有正文的模板:fm 照样合并(不因「没有正文」提前返回)。
    {
      const r = await run(browser, '---\ntags: [x]\n---\n# 页\n\n正文。\n', TPL_FM_ONLY)
      const fm = fmOf(r.md) || ''
      check('T3 只有 fm 的模板:tags 并集 [x, daily](x 不重复)、status 新增',
        !r.err && /daily/.test(fm) && (fm.match(/\bx\b/g) || []).length === 1 && /status: draft/.test(fm) && r.md.endsWith('# 页\n\n正文。\n'),
        JSON.stringify(r))
    }
  } finally {
    await browser.close()
  }
  const bad = results.filter((x) => !x).length
  console.log(`\n${results.length - bad}/${results.length} PASS`)
  process.exit(bad ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
