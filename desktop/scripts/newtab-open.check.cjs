/**
 * 「＋ 新标签页里开东西,就该开在这个标签」的端到端契约(真 Electron)。
 *
 * 用户实报(2026-08-16):「开着 chat A 的情况下 new tab,然后选新对话或者别的会话,
 * 他们都会直接替换 A chatview,而不是在第二个 new tab 里面打开。」
 * 根因:所有「新对话」入口都写 `openView('chat', {followActive:true, reuseKey:'primary'})`,
 * 而 singleton 的复用分支会直接 setActive 到已有的主聊天 —— 你站在哪个标签它根本不看,
 * 于是空白标签一直空着,老聊天反被 updateParameters 清成新对话。
 *
 * 判据(修复前的实测:③ 三个标签、「新建标签页」还在、聊天数 1 —— 即老聊天被顶掉、新标签白开):
 *   1 点 ＋ 之后确实有一张可见的空白启动器
 *   2 在里面点「新对话」→ 启动器不再占着一个标签(它自己变成了聊天)
 *   3 聊天在场且可见,且主区标签没有净增(不留一个没人用的空白标签)
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测(同 check:chatside)。
 * 跑:npm run check:newtab
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SNAP = `(() => {
  const tabs = [...document.querySelectorAll('.wb-tab')].map((t) => t.querySelector('.wb-tab-name')?.textContent || '')
  return {
    tabs,
    chatVisible: [...document.querySelectorAll('.t2-chat-view')].filter((e) => e.getBoundingClientRect().width > 0).length,
    launcherTabs: tabs.filter((n) => n === '新建标签页' || n === 'New tab').length,
    launcherVisible: [...document.querySelectorAll('.newtab')].filter((e) => e.getBoundingClientRect().width > 0).length,
  }
})()`

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-newtab-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(1500)
    // ⚠️钉住启动 Space:2026-08-28 起「启动时进入」的缺省是 ribbon 主位槽(=主页 Space),
    // 主页既没有侧栏也没有聊天面板 —— 本脚本验的是 Tangu Space 的形态,不钉就一路等超时。
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'tangu')`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(2000)

    const before = await win.evaluate(SNAP)
    await win.click('.dv-new-tab')
    await win.waitForTimeout(900)
    const blank = await win.evaluate(SNAP)
    check(
      '1 点 ＋ 开出一张可见的空白启动器',
      blank.launcherVisible === 1 && blank.launcherTabs === 1,
      JSON.stringify(blank),
    )

    // 侧栏「新对话」(SpecialRow);左栏折叠时先展开。
    if (!(await win.locator('.t2s-special', { hasText: '新对话' }).first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(800)
    }
    await win.locator('.t2s-special', { hasText: '新对话' }).first().click()
    await win.waitForTimeout(1200)
    const after = await win.evaluate(SNAP)

    check(
      '2 在空白标签里点「新对话」→ 这个标签自己变成聊天(不再是空白启动器)',
      after.launcherTabs === 0 && after.launcherVisible === 0,
      JSON.stringify(after) + '(修复前:launcherTabs=1 —— 空白标签还在,内容跑去顶掉老聊天了)',
    )
    check(
      '3 聊天可见,且主区标签没有净增(没留下没人用的空白标签)',
      after.chatVisible === 1 && after.tabs.length <= before.tabs.length + 1,
      `标签 ${before.tabs.length} → ${blank.tabs.length} → ${after.tabs.length};可见聊天 ${after.chatVisible}`,
    )

    const bad = results.filter((r) => !r.ok)
    console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await app.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
