/** 卸载规范(10-28 A 确认框 + D 回收站)的真 Electron 走查:真主进程 × 引擎真路由(agents / trash / solo)× 隔离 SQLite / home,
 *  其余接口交给假引擎。走一遍:名册删 Agent → 确认框逐项写去向 → 撤销 → 再删 → 设置 › 系统 › 回收站 → 恢复。截图落在 SHOT_DIR(缺省隔离家目录)。
 *  先 build 两边:cd ../tangu-agent && npm run build && cd ../desktop && npm run build
 *  node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="卸载确认框 + 回收站" --eta=4 -- node scripts/uninstall-trash.check.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const express = require('express')
const ROOT = path.resolve(__dirname, '..')
const ENGINE = path.resolve(ROOT, '../tangu-agent/dist')
const load = (name) => import(pathToFileURL(path.join(ENGINE, name)).href)
let failed = 0
function check(name, ok) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failed++ }

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js')) || !fs.existsSync(path.join(ENGINE, 'routes/trash.js'))) throw new Error('先 build tangu-agent 与 desktop')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tangu-uninstall-'))
  process.env.TANGU_HOME = home
  const SHOTS = process.env.SHOT_DIR || home
  fs.mkdirSync(SHOTS, { recursive: true })
  const userData = path.join(home, 'userdata')
  const [{ configureTangu }, { createTanguProfile }, { createSqliteHost }, { STANDALONE_SCHEMA }, { toSqliteDDL }, { createLocalMemoryBrain },
    registry, teams, { default: agentsRouter }, { default: trashRouter }, { default: soloRouter }, { default: assetsRouter }] = await Promise.all([
    load('seams/runtime.js'), load('profiles/index.js'), load('adapters/standalone/sqliteHost.js'), load('db/schemaStandalone.js'), load('core/dialectDDL.js'),
    load('adapters/standalone/localMemoryBrain.js'), load('agents/agentRegistry.js'), load('agents/teamRegistry.js'),
    load('routes/agents.js'), load('routes/trash.js'), load('routes/solo.js'), load('routes/assets.js'),
  ])
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'e2e', userId: 'uninstall-instrument' })
  db.exec(toSqliteDDL(STANDALONE_SCHEMA))
  configureTangu({ host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: { calculateCost: async () => 0, logApiUsage: async () => {} },
    brain: { memory: createLocalMemoryBrain(), llm: {}, users: { getUserById: async () => ({ id: 'uninstall-instrument' }) } } })
  for (const [slug, name] of [['scout', 'Scout'], ['helper', 'Helper'], ['writer', 'Writer']]) await registry.saveAgent({ slug, name, description: 'Uninstall instrument', systemPrompt: 'Test agent', createdBy: 'user' })
  await teams.saveTeam({ slug: 'trio', name: 'Trio', members: [{ slug: 'scout', role: '' }, { slug: 'helper', role: '' }, { slug: 'writer', role: '' }], lead: 'helper' })
  fs.writeFileSync(path.join(home, 'agents/scout/MEMORY.md'), '- Scout 的一条记忆\n')
  const skillDir = path.join(home, 'agents/helper/skills/tidy')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: tidy\ndescription: Tidy up notes\n---\nKeep notes tidy.\n')

  const stub = await startStubEngine()
  const backend = express()
  backend.use(express.json())
  backend.use((req, _res, next) => { req.headers.authorization = 'Bearer e2e'; next() })
  backend.use(agentsRouter); backend.use(trashRouter); backend.use(soloRouter); backend.use(assetsRouter)
  backend.use(async (req, res) => {
    try {
      const r = await fetch(`${stub.url}${req.originalUrl}`, { method: req.method, headers: { 'content-type': 'application/json' }, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: JSON.stringify(req.body || {}) }) })
      res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(Buffer.from(await r.arrayBuffer()))
    } catch (e) { res.status(500).json({ detail: e.message }) }
  })
  const server = await new Promise((resolve) => { const s = backend.listen(0, '127.0.0.1', () => resolve(s)) })
  const url = `http://127.0.0.1:${server.address().port}`
  const open = await fetch(`${url}/agent/solo/agent/scout/open`, { method: 'POST' }).then((r) => r.json())
  const chatId = open.session?.id
  const chatArchived = () => db.prepare('SELECT archived FROM chat_sessions WHERE id = ?').get(chatId)?.archived
  const trashIds = () => (fs.existsSync(path.join(home, 'trash')) ? fs.readdirSync(path.join(home, 'trash')) : [])
  const members = async () => { const t = await teams.getTeam('trio'); return (t?.members || []).map((m) => m.slug).join(',') }
  for (const dir of [userData, `${userData}-dev`]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: url, token: 'e2e' })) }

  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: url } })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await win.waitForSelector('#root')
    check('首启引导已跳过', await skipOnboarding(win))
    const wait = async (fn, label, ms = 8000) => { for (let i = 0; i < ms / 50; i++) { if (await fn()) return true; await win.waitForTimeout(50) } console.log(`  (等待超时:${label})`); return false }
    const enterAgents = async () => {
      const slot = win.locator('.rb-slot[data-id="space:agents"] .rb-space').first()
      if (await slot.count()) await slot.click()
      else {
        await win.locator('.rb-top .rb-more').first().click(); await win.waitForTimeout(300)
        await win.locator('.rb-top .rb-space[aria-label="Agents"]').first().click()
        await win.evaluate(() => document.querySelector('.rb-open-top .rb-more')?.click())
      }
      await win.locator('.agents-roster').first().waitFor({ timeout: 15000 })
    }
    const askDelete = async () => {
      await win.getByRole('button', { name: 'Scout 的操作', exact: false }).first().click().catch(async () => {
        await win.locator('.agents-roster-row').filter({ hasText: 'Scout' }).locator('.agents-roster-more').first().click()
      })
      await win.getByRole('menuitem', { name: '删除 Agent', exact: true }).first().click()
      const dlg = win.locator('[data-uninstall-dialog] .un-dlg')
      await dlg.waitFor({ timeout: 8000 })
      await wait(async () => (await dlg.locator('.un-row').count()) >= 3 && !(await dlg.textContent()).includes('正在'), 'preview rows')
      return dlg
    }
    await enterAgents()
    await win.locator('.agents-roster-item').filter({ hasText: 'Scout' }).first().waitFor({ timeout: 10000 })

    // ① 确认框:逐项写去向,勾选项缺省不勾
    let dlg = await askDelete()
    const text = await dlg.textContent()
    check('确认框标题点名 Agent', text.includes('删除 Agent「Scout」'))
    check('定义、记忆与 Library → 回收站', /定义、记忆与 Library[\s\S]*回收站/.test(text))
    check('历史私聊 · 1 条 → 归档', text.includes('历史私聊 · 1') && text.includes('归档'))
    check('团队成员位 → 移出团队', text.includes('团队「Trio」里的成员位') && text.includes('移出团队'))
    check('「一并删除这些私聊」缺省不勾', (await dlg.locator('input[type="checkbox"]').first().isChecked()) === false)
    check('确认钮叫「删除」', (await dlg.locator('.dialog-btn[data-danger]').textContent()).trim() === '删除')
    await dlg.screenshot({ path: path.join(SHOTS, 'agent-dialog.png') })
    await win.screenshot({ path: path.join(SHOTS, 'agent-dialog-window.png') })
    // 手机上是底部抽屉(window.tangu.mobile 判定;这里只验样式:手动挂上 un-sheet。窗口有最小宽度,实际停在 880,不是真手机宽)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(390, 844))
    await win.evaluate(() => document.querySelector('[data-uninstall-dialog] .dialog-overlay')?.classList.add('un-sheet'))
    await win.waitForTimeout(400)
    const box = await dlg.boundingBox(), vh = await win.evaluate(() => innerHeight), vw = await win.evaluate(() => innerWidth)
    check('抽屉样式:贴底、占满宽', !!box && Math.abs(box.y + box.height - vh) <= 1 && box.width >= vw - 1)
    await win.screenshot({ path: path.join(SHOTS, 'agent-sheet.png') })
    await win.evaluate(() => document.querySelector('[data-uninstall-dialog] .dialog-overlay')?.classList.remove('un-sheet'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900))
    await win.waitForTimeout(300)

    // ② 删除 → 撤销提示 6 秒 → 撤销
    await dlg.locator('.dialog-btn[data-danger]').click()
    const toast = win.locator('.ntf-item, [class*="ntf"]').filter({ hasText: '已删除 Agent「Scout」' }).first()
    check('删后出现带「撤销」的提示', await toast.waitFor({ timeout: 8000 }).then(() => true, () => false) && await toast.locator('.ntf-action', { hasText: '撤销' }).count() === 1)
    check('文件进回收站、名册里没了', await wait(() => !fs.existsSync(path.join(home, 'agents/scout')) && trashIds().length === 1, 'trash'))
    check('私聊已归档', !!chatArchived())
    check('移出团队 Trio', await members() === 'helper,writer')
    await win.screenshot({ path: path.join(SHOTS, 'undo-toast.png') })
    await toast.locator('.ntf-action').click()
    check('撤销:文件放回原处、回收站空了', await wait(() => fs.existsSync(path.join(home, 'agents/scout/MEMORY.md')) && trashIds().length === 0, 'undo'))
    check('撤销:私聊取消归档', await wait(() => !chatArchived(), 'unarchive'))
    check('撤销:回到团队原来的位置', await wait(async () => await members() === 'scout,helper,writer', `team seat (${await members()})`)) // 引擎恢复时团队座位最后接回,别跟在取消归档后面立刻读
    check('撤销:名册里又有 Scout', await win.locator('.agents-roster-item').filter({ hasText: 'Scout' }).first().waitFor({ timeout: 8000 }).then(() => true, () => false))

    // ③ 再删一次,去设置 › 系统 › 回收站恢复
    dlg = await askDelete()
    await dlg.locator('.dialog-btn[data-danger]').click()
    check('再删:进回收站', await wait(() => trashIds().length === 1, 'trash 2'))
    const opened = app.waitForEvent('window', { timeout: 20000 }).catch(() => null)
    await win.keyboard.press('Meta+Comma')
    const sp = await opened
    check('设置浮窗打开', !!sp)
    if (sp) {
      await sp.waitForSelector('.settings-main', { timeout: 20000 })
      await sp.locator('.settings-nav').getByRole('button', { name: '回收站', exact: true }).first().click()
      const row = sp.locator('[data-trash-entry]').first()
      check('回收站页列出 Scout', await row.waitFor({ timeout: 8000 }).then(() => true, () => false) && (await row.textContent()).includes('Scout · Agent'))
      check('写明剩余天数与私聊已归档', /还剩 30 天/.test(await row.textContent()) && (await row.textContent()).includes('私聊已归档'))
      await sp.waitForTimeout(700) // 设置页有入场淡入,截早了整行发灰
      console.log('  row opacity/color:', await row.evaluate((el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= +getComputedStyle(n).opacity; return `${o} ${getComputedStyle(el.querySelector('b')).color}` }))
      await sp.screenshot({ path: path.join(SHOTS, 'trash-page.png') })
      await row.getByRole('button', { name: '恢复', exact: true }).click()
      check('回收站恢复:文件、私聊、团队都回来', await wait(async () => fs.existsSync(path.join(home, 'agents/scout/MEMORY.md')) && !chatArchived() && await members() === 'scout,helper,writer', 'restore'))
      check('回收站页变空', await sp.locator('[data-trash-empty]').waitFor({ timeout: 8000 }).then(() => true, () => false))
      await sp.screenshot({ path: path.join(SHOTS, 'trash-empty.png') })
    }

    // ④ Agent 自己的技能:技能页 → 删除技能 → 确认框 → 进回收站 → 撤销(10-28 评审:这条曾因确认框挂错分支而点了没反应)
    await win.bringToFront()
    await win.locator('.agents-roster-item').filter({ hasText: 'Helper' }).first().click()
    await win.locator('.agent-section-nav [role="tab"][id$="-skills"]').first().click()
    await win.locator('.agent-skill-row button.agent-skill-summary').filter({ hasText: 'tidy' }).first().click()
    await win.getByRole('button', { name: '删除技能', exact: true }).first().click()
    const sdlg = win.locator('[data-uninstall-dialog] .un-dlg')
    check('技能:删除技能打开确认框', await sdlg.waitFor({ timeout: 8000 }).then(() => true, () => false))
    await wait(async () => (await sdlg.locator('.un-row').count()) >= 1 && !(await sdlg.textContent()).includes('正在'), 'skill preview rows')
    check('技能:文件夹 → 回收站', /回收站/.test(await sdlg.textContent()))
    await sdlg.screenshot({ path: path.join(SHOTS, 'skill-dialog.png') })
    await sdlg.locator('.dialog-btn[data-danger]').click()
    check('技能:文件夹进回收站', await wait(() => !fs.existsSync(skillDir) && trashIds().length === 1, 'skill trash'))
    const stoast = win.locator('.ntf-item, [class*="ntf"]').filter({ has: win.locator('.ntf-action', { hasText: '撤销' }) }).last()
    await stoast.locator('.ntf-action').click()
    check('技能:撤销放回原处', await wait(() => fs.existsSync(path.join(skillDir, 'SKILL.md')) && trashIds().length === 0, 'skill undo'))
  } finally {
    await app?.close().catch(() => {})
    server.close(); stub.close?.()
  }
  console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASS'} · 截图在 ${SHOTS}`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
