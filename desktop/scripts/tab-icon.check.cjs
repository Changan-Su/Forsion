// 笔记 tab 的图标(2026-08-31 用户实报「tab 栏图标也没有显示」)。
// 跑的是**真 WbTab × 真 dockview**(?dock 台架),只把视图内容换成占位;图标组件是产品那一份
// (amadeusViews.NoteTabIcon)。用法:npm run check:tabicon
//
// ⚠️ 这一层证不到「图标表本身新不新鲜」—— 那是主进程索引的事,归 electron/amadeus/fs/pageWrite.test.ts
//    与真机点验。这里只证:表里有值就上 tab、值变了 tab 跟着变、没值回退通用文件图标。
const fs = require('fs')
const os = require('os')
const path = require('path')
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

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 主区 tab 上此刻画的是什么:emoji 文本 / 有没有回退的 svg。 */
const tabIcon = (p) => p.evaluate(() => {
  const tab = [...document.querySelectorAll('.dv-tab .wb-tab')].find((t) => !t.className.includes('wb-tab--icon'))
  if (!tab) return null
  const emoji = tab.querySelector('.amx-tab-emoji')
  return {
    name: tab.querySelector('.wb-tab-name')?.textContent ?? '',
    emoji: emoji?.textContent ?? null,
    // ⚠️ 只认**图标槽**里的 svg:tab 右端还有个 × 关闭钮(也是 svg),按 'svg' 一刀切恒为真 =
    //    「回退没发生」这一半永远测不出来(本仪器第一版就是这么假绿的)。
    svg: !!tab.querySelector('svg.wb-tab-ic'),
    // 图标不许把固定高的 tab 撑开(emoji 天生比 svg 高)。
    h: Math.round((emoji ?? tab.querySelector('svg.wb-tab-ic'))?.getBoundingClientRect().height ?? 0),
    tabH: Math.round(tab.getBoundingClientRect().height),
  }
})

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium() })
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 800 } })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?dock`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.dv-tab', { timeout: 20000 })
  await p.evaluate(() => window.__dock.open('notev', { notePath: '甲.md' }))
  await p.waitForTimeout(400)
  const noIcon = await tabIcon(p)
  record('T1 没设图标:tab 回退通用文件图标(不是空白)', !!noIcon && noIcon.emoji === null && noIcon.svg, JSON.stringify(noIcon))

  await p.evaluate(() => window.__dock.setIcons({ '甲.md': '📕' }))
  await p.waitForTimeout(300)
  const withIcon = await tabIcon(p)
  record('T2 图标表里有值 → tab 上就是那个 emoji(不再是通用图标)',
    withIcon?.emoji === '📕' && !withIcon.svg, JSON.stringify(withIcon))
  record('T3 emoji 不把 tab 撑高(tab 高度与图标高度都在 32px 行内)',
    !!withIcon && withIcon.h > 0 && withIcon.h <= withIcon.tabH && withIcon.tabH <= 40, JSON.stringify(withIcon))

  // 改成另一个 → 跟着变(组件订阅了 icons 表,不是首帧读一次)
  await p.evaluate(() => window.__dock.setIcons({ '甲.md': '🌲' }))
  await p.waitForTimeout(300)
  if (process.argv.includes('--shot')) {
    await p.screenshot({ path: path.join(process.env.SHOT_DIR || os.tmpdir(), 'tab-icon.png'), clip: { x: 0, y: 0, width: 640, height: 120 } })
  }
  const changed = await tabIcon(p)
  record('T4 换图标 tab 当场跟上(订阅的是表,不是首帧快照)', changed?.emoji === '🌲', JSON.stringify(changed))

  // 删掉 → 回退
  await p.evaluate(() => window.__dock.setIcons({}))
  await p.waitForTimeout(300)
  const cleared = await tabIcon(p)
  record('T5 清掉图标 → 回退通用文件图标(不留空槽)', cleared?.emoji === null && cleared.svg, JSON.stringify(cleared))

  // 别的视图不受影响:没有 TabIcon 的视图照旧画自己的静态图标
  await p.evaluate(() => window.__dock.open('mainv', {}, true))
  await p.waitForTimeout(300)
  const others = await p.evaluate(() =>
    [...document.querySelectorAll('.dv-tab .wb-tab')].filter((t) => !t.className.includes('wb-tab--icon')).map((t) => ({
      name: t.querySelector('.wb-tab-name')?.textContent ?? '', svg: !!t.querySelector('svg.wb-tab-ic'), emoji: !!t.querySelector('.amx-tab-emoji'),
    })))
  record('T6 没声明 TabIcon 的视图照旧画静态图标(接缝是可选的,不影响别人)',
    others.length >= 2 && others.every((o) => o.svg && !o.emoji), JSON.stringify(others))

  await browser.close()
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  console.log('SKIP  「图标表新不新鲜」(主进程索引 → pageIcons):见 electron/amadeus/fs/pageWrite.test.ts + 真机点验')
  process.exit(ok === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
