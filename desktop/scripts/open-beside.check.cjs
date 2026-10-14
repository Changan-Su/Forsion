/**
 * 「开在旁边那半屏」的引擎契约(真 Chromium + 真 Dockview + 真 dockviewStore,harness.html?dock)。
 *
 * 为什么存在:2026-10-13 用户定「文件类型的双链点击后默认分屏打开(图片不算)」。落点在引擎的
 * openView(…, { split: true }):笔记留在原来那一半,文件开到旁边;旁边已经有一半就落在那一半里当新标签,
 * 反复点不会越分越多。调用链的另一半(openWikiLink 把 split 带到各个打开函数)是纯转发,由类型检查兜。
 *
 * 判据:
 *   1 主区只有一半时 split 打开 = 多出一个组,新 panel 在原组的右边,原 panel 没被顶掉
 *   2 再 split 打开一个 = 组数不变,落在旁边那一半里(同组两个标签)
 *   3 焦点在右半时 split 打开 = 落到左半(另一半),仍是两个组
 *   4 不带 split 的打开照旧就地导航(panel 数不变)
 *   5 带 newTab 时 newTab 优先(不分屏)
 *
 * 跑:npm run check:openbeside   (5173 没起会自起 vite,跑完自收;worktree 里设 HARNESS_URL)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
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

const BASE = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const URL = `${BASE}?dock`

function ping() {
  return new Promise((res) => {
    const req = http.get(BASE, (r) => { res(r.statusCode === 200); r.resume() })
    req.on('error', () => res(false))
    req.setTimeout(1500, () => { req.destroy(); res(false) })
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function main() {
  let vite = null
  if (!(await ping())) {
    const port = new (require('url').URL)(BASE).port || '5173'
    const viteEntry = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js')
    vite = spawn(process.execPath, [viteEntry, 'frontend', '--port', port, '--strictPort'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await page.addInitScript(() => localStorage.clear()) // 布局落 localStorage,别串味
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.dockh-body[data-tag="main"]', { timeout: 20000 })
    await page.waitForTimeout(500)

    const r = await page.evaluate(async () => {
      const d = window.__dock
      const wait = () => new Promise((res) => setTimeout(res, 150))
      const groups = () => { const g = d.mainGroups(); return { n: new Set(g.map((x) => x.group)).size, list: g } }
      const of = (id) => d.mainGroups().find((x) => x.id === id)
      const note = d.open('navv', { label: 'note' }, true)
      await wait()
      const before = groups()
      const noteGroup = of(note).group
      const a = d.openBeside('navv', { label: 'fileA' })
      await wait()
      const s1 = { n: groups().n, a: of(a), note: of(note), noteStill: d.panels().some((p) => p.id === note && p.params.label === 'note') }
      d.nav.activate(note)
      await wait()
      const b = d.openBeside('navv', { label: 'fileB' })
      await wait()
      const s2 = { n: groups().n, a: of(a), b: of(b), note: of(note) }
      // 焦点留在右半(b 刚开、已激活):再 split → 落回左半
      const c = d.openBeside('navv', { label: 'fileC' })
      await wait()
      const s3 = { n: groups().n, c: of(c), note: of(note) }
      const count = d.panels().length
      d.open('navv', { label: 'inplace' })
      await wait()
      const s4 = { before: count, after: d.panels().length, n: groups().n }
      const nt = d.open('navv', { label: 'tab' }, true)
      await wait()
      const s5 = { n: groups().n, after: d.panels().length, id: nt }
      return { before: before.n, noteGroup, s1, s2, s3, s4, s5 }
    })

    check(
      '1 只有一半时 split 打开 = 多一个组,新 panel 在原 panel 右边,原 panel 还在',
      r.s1.n === r.before + 1 && !!r.s1.a && r.s1.a.group !== r.s1.note.group && r.s1.a.left > r.s1.note.left && r.s1.noteStill,
      `组 ${r.before}→${r.s1.n};left note=${r.s1.note && r.s1.note.left} file=${r.s1.a && r.s1.a.left}`,
    )
    check(
      '2 再 split 打开一个 = 组数不变,落在旁边那一半里(和上一个同组)',
      r.s2.n === r.before + 1 && !!r.s2.b && r.s2.b.group === r.s2.a.group && r.s2.b.group !== r.noteGroup && r.s2.note.group === r.noteGroup,
      `组 ${r.s2.n};a=${r.s2.a && r.s2.a.group} b=${r.s2.b && r.s2.b.group}`,
    )
    check(
      '3 焦点在右半时 split 打开 = 落到另一半(左半),仍是两个组',
      r.s3.n === r.before + 1 && !!r.s3.c && r.s3.c.group === r.noteGroup && r.s3.c.group !== r.s2.b.group,
      `组 ${r.s3.n};c=${r.s3.c && r.s3.c.group} 左半=${r.noteGroup}`,
    )
    check('4 不带 split 的打开照旧就地导航(panel 数不变)', r.s4.after === r.s4.before && r.s4.n === r.s3.n, `${r.s4.before}→${r.s4.after}`)
    check('5 newTab 不分屏(组数不变,多一个 panel)', r.s5.n === r.s4.n && r.s5.after === r.s4.after + 1, `组 ${r.s5.n};panel ${r.s4.after}→${r.s5.after}`)

    const bad = results.filter((x) => !x.ok)
    console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
