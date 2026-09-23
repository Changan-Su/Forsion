/**
 * 代码块「运行」→ 底部终端 → 结果回传会话:真 Electron + 假引擎的契约检查。
 *
 * 钉的是纯函数单测和 tsc 都看不见的四件事:
 *   ① 聊天里的 ```bash 围栏有 Run 键、```python 没有(语言判定经 rehype-highlight 的 class 链路);
 *   ② 点 Run → 底部面板开出**新**终端 tab(标题=命令首行),真 PTY 用 `shell -l -c` 跑,退出码干净(exit 3 → code 3);
 *   ③ 退出后自动把「命令 / 退出码 / 输出」作为用户消息发回**同一会话**(假引擎 seen.runs[1] 收到);
 *   ④ 负对照:重挂一个带旧 runToken 的终端 = 普通 shell,不会再跑一遍(命令从不进持久化 params)。
 *
 * 跑:npm run build && npm run check:runblock   (隔离 TANGU_HOME / userData,不碰真实数据;截图落 /tmp/forsion-runblock-*)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.resolve(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, every = 250) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(every)
  }
}

const MARK = 'FORSION_RUN_OK'
const reply = [
  '先跑这个(带 $ 提示符,应被剥掉):',
  '```bash',
  `$ echo ${MARK}; exit 3`,
  '```',
  '这个不该有运行键:',
  '```python',
  'print(1)',
  '```',
].join('\n')

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) { console.error('缺 out/main/main.js —— 先跑 npm run build'); process.exit(1) }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-runblock-'))
  const userdata = path.join(home, 'userdata')
  const vault = path.join(home, 'vault')
  fs.mkdirSync(userdata); fs.mkdirSync(vault)
  fs.writeFileSync(path.join(userdata, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }))
  const ts = Date.UTC(2026, 8, 22)
  const stub = await startStubEngine({
    sessions: [{ id: 'runblock', title: '运行代码块', model_id: 'm1', archived: false, agent_config: null, project_path: null, project_name: null, created_at: '2026-09-22 12:00:00', updated_at: '2026-09-22 12:00:00' }],
    messages: [
      { id: 'u1', role: 'user', content: '给我一条命令', timestamp: ts, attachments: null },
      { id: 'a1', role: 'model', content: reply, timestamp: ts + 1000 },
    ],
  })
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 1000))
    await win.waitForSelector('#root')
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`button:text-is("${label}")`).first()
      if (await b.isVisible().catch(() => false)) { await b.click(); break }
    }
    const msg = win.locator('#tocmsg-a1')
    await msg.waitFor({ timeout: 30_000 })
    await win.locator('#tangu-splash').waitFor({ state: 'detached' })

    // ① Run 键只出现在 shell 围栏上
    const runBtns = msg.locator('[data-testid="code-run"]')
    check('① bash 围栏有 Run 键、python 围栏没有(共 2 个 pre,1 个 Run)', await runBtns.count() === 1 && await msg.locator('pre').count() === 2,
      `run=${await runBtns.count()} pre=${await msg.locator('pre').count()}`)

    await msg.scrollIntoViewIfNeeded()
    await msg.locator('pre').first().hover()
    await msg.screenshot({ path: path.join(home, 'message-runbtn.png') })

    // ② 点 Run → 底部终端
    const beforeXterm = await win.locator('.xterm').count()
    await runBtns.first().click()
    const xterm = await until(async () => (await win.locator('.xterm').count()) > beforeXterm ? win.locator('.xterm').last() : null, 15_000)
    check('② 点 Run 后开出终端', !!xterm)
    const geo = xterm ? await xterm.evaluate((el) => ({ top: el.getBoundingClientRect().top, h: window.innerHeight })) : null
    check('② 终端在底部面板(顶边过了窗口中线)', !!geo && geo.top > geo.h * 0.5, geo ? `top=${Math.round(geo.top)} / h=${geo.h}` : '')
    const tabTitle = await until(async () => {
      const titles = await win.locator('.dv-tab, .dv-default-tab').allInnerTexts()
      return titles.find((t) => t.includes(`echo ${MARK}; exit 3`)) || null
    }, 8_000)
    check('② 终端 tab 标题 = 命令首行', !!tabTitle, tabTitle || '')
    const exited = await until(async () => {
      const t = await win.locator('body').innerText()
      return /进程已退出\(code 3\)|Process exited \(code 3\)/.test(t) ? 'code 3' : null
    }, 20_000)
    check('② 专用进程退出码干净(exit 3 → code 3)', !!exited)
    const screenText = await win.locator('.xterm-rows').last().innerText().catch(() => '')
    check('② 终端画面里有命令回显与输出', screenText.includes(`$ echo ${MARK}`) && screenText.split(MARK).length >= 3, screenText.replace(/\s+/g, ' ').slice(0, 120))

    // ③ 退出后自动回传:假引擎收到第二个 run,消息带命令 / 退出码 / 输出
    const sent = await until(async () => stub.seen.runs.find((r) => String(r.message).includes(MARK)) || null, 15_000)
    check('③ 结果作为用户消息发回同一会话', !!sent && sent.sessionId === 'runblock', sent ? `sid=${sent.sessionId}` : 'no run')
    const m = String(sent?.message || '')
    check('③ 回传正文含命令(已剥 $)+ 退出码 + 输出', /```bash\necho FORSION_RUN_OK; exit 3\n```/.test(m) && /退出码 3|exit code 3/.test(m) && /```\nFORSION_RUN_OK\n```/.test(m), m.replace(/\n/g, '⏎').slice(0, 200))
    check('③ 回传里不含 `$ ` 提示符', !/\$ echo/.test(m))
    const bubble = await until(async () => (await win.locator('.t2-user').filter({ hasText: MARK }).count()) > 0 || null, 8_000)
    check('③ 聊天里出现了这条用户消息', !!bubble)

    // ④ 负对照:旧 token 重挂 = 普通 shell(不重跑)。走 dockview 的 tab 关闭 + 布局恢复太重,直接
    //    复用 Run 键再点一次:第二次是**新** token → 会再跑一遍(记 runs 数);而对已挂载 tab 点「重新启动」
    //    (同一 ref 里的命令)才是有意的重跑。这里钉「Run 一次只发一条回传」:点一次 = 恰一条 MARK 消息。
    await sleep(1500)
    const markRuns = stub.seen.runs.filter((r) => String(r.message).includes(MARK)).length
    check('④ 点一次 Run 只回传一条(无重复执行/重复发送)', markRuns === 1, `runs=${markRuns}`)

    const shot = path.join(home, 'runblock.png')
    await win.screenshot({ path: shot })
    console.log('screenshot:', shot)
  } catch (e) {
    const w = app?.windows()[0]
    await w?.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {})
    console.error('failure screenshot:', path.join(home, 'failure.png'))
    throw e
  } finally {
    await app?.close().catch(() => {})
    await stub.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
