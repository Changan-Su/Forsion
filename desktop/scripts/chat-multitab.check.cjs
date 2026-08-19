/**
 * 「同一类视图能不能开成多个标签」的引擎契约(真 Chromium + 真 Dockview + 真 dockviewStore,harness.html?dock)。
 *
 * 为什么存在:用户实报「chat view 同一时间只能开一个,可它本质是打开一个 session,该像文件那样支持多标签」。
 * 根因在 openView:singleton 的复用分支跑在 newTab 判定**之前**,且 reuseKey 没给时「命中任意同类型 panel」
 * → ⌘点击「在新标签页打开」被静默吞掉(setActive 就返回了);就算放行,panel id 还恒取裸 type,第二份必撞名。
 * 这两句只在引擎里,纯函数单测看不见,真 chat 又要后端才有会话 —— 故用仪器专用的单例视图 singlev 验引擎本身。
 *
 * 判据:
 *   1 裸开一次 = 一个 panel(单例语义没被我改坏)
 *   2 带 newTab 再开 = 两个 panel、id 不同(⌘点击不再被吞)
 *   3 两份各自带住自己的参数(第二份不是第一份的别名 —— 会话/笔记就靠这个各显示各的)
 *   4 再裸开一次 = 仍是两个(不带 newTab 时 singleton 照旧复用,不会点一下多一个)
 *
 * 跑:npm run check:chattabs   (5173 没起会自起 vite,跑完自收;CHROMIUM_EXE 可覆盖)
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
    vite = spawn('npx', ['vite', 'frontend'], { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' })
    let up = false
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 500))
      up = await ping()
    }
    if (!up) throw new Error('vite 起不来')
  }
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await page.addInitScript(() => localStorage.clear()) // 布局落 localStorage,别串味
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.dockh-body[data-tag="main"]', { timeout: 20000 })
    await page.waitForTimeout(500)

    const r = await page.evaluate(async () => {
      const d = window.__dock
      const singles = () => d.panels().filter((p) => p.type === 'singlev')
      const wait = () => new Promise((res) => setTimeout(res, 120))
      const first = d.open('singlev', { pinned: 'A' })
      await wait()
      const afterFirst = singles()
      const second = d.open('singlev', { pinned: 'B' }, true)
      await wait()
      const afterSecond = singles()
      d.open('singlev', { pinned: 'C' })
      await wait()
      const afterThird = singles()
      return {
        first,
        second,
        afterFirst: afterFirst.length,
        afterSecond: afterSecond.map((p) => ({ id: p.id, pinned: p.params.pinned })),
        afterThird: afterThird.length,
      }
    })

    check('1 裸开一次 = 一个 panel', r.afterFirst === 1, `${r.afterFirst} 个`)
    check(
      '2 带 newTab 再开 = 两个 panel,id 不同(⌘点击不再被 singleton 吞掉)',
      r.afterSecond.length === 2 && r.first !== r.second && !!r.second,
      `ids=${JSON.stringify(r.afterSecond.map((p) => p.id))}(旧行为:第二次 setActive 就返回 → 恒 1 个)`,
    )
    check(
      '3 两份各带各的参数(第二份不是第一份的别名)',
      r.afterSecond.length === 2 && r.afterSecond[0].pinned !== r.afterSecond[1].pinned,
      JSON.stringify(r.afterSecond.map((p) => p.pinned)),
    )
    check(
      '4 不带 newTab 时 singleton 照旧复用(不会点一下多一个)',
      r.afterThird === 2,
      `${r.afterThird} 个(>2 = 单例语义被改坏;<2 = 上一条的 newTab 压根没开出来)`,
    )

    const bad = results.filter((x) => !x.ok)
    console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await browser.close()
    if (vite) vite.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
