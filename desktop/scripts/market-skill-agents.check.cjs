/**
 * 商店技能「装给哪些 Agent」：真 Electron × 假商店后端 × 桩引擎，真下载、真解压到隔离 HOME。
 * 商店详情选「只给 Coding」→ 安装 → 断言桩引擎收到：其余能用技能的 Agent 各一条屏蔽，「指定」档的 Coding 名单加上这条，
 * 技能档「关」的 Muse 不动；对话里的商店卡也出现同一个下拉。截图进 ../outputs/market-skill-agents/。
 * 用法：先 npx electron-vite build，再 node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="技能装给谁" --eta=3 -- node scripts/market-skill-agents.check.cjs
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), { execFileSync } = require('child_process')
const { launch, boot, enterSpace, captureWindow } = require('./lib/uiux-electron.cjs')
const OUT = path.resolve(__dirname, '../../outputs/market-skill-agents')
fs.mkdirSync(OUT, { recursive: true })
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` | ${detail}` : ''}`) }

const ID = '5e87a4de-464d-4041-81e2-72cc15f85897', SLUG = 'scan-docs'
const T = '2026-10-20T08:00:00.000Z'
const ITEM = { id: ID, type: 'skill', source: 'zip', name: '本地文档与图片理解', summary: '离线读懂截图、扫描件和 PDF。', description: '离线读懂截图、扫描件和 PDF。', author: 'Demo', installSlug: SLUG, downloads: 3, latestTag: null, iconUrl: null, latestVersion: '1.0.0', tags: [], createdAt: T, updatedAt: T, readme: '# Scan docs', githubRepoUrl: null, npmPackage: null }
const AGENTS = [
  { slug: 'xyra', name: 'Arioso' }, { slug: 'aria', name: 'Aria' },
  { slug: 'recita', name: 'Recita', enabledSkillIds: ['local:notes'] }, { slug: 'coding', name: 'Coding', enabledSkillIds: ['local:review'] },
  { slug: 'muse', name: 'Muse', enabledSkillIds: [] },
].map((a) => ({ ...a, description: '', createdBy: 'user', libraryDir: `/tmp/uiux-lib/${a.slug}/Library` }))

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-skill-agents-'))
  fs.mkdirSync(path.join(tmp, 'pkg')); fs.writeFileSync(path.join(tmp, 'pkg', 'SKILL.md'), '---\nname: scan-docs\ndescription: Read scans offline\n---\n\nRead scans.\n')
  execFileSync('zip', ['-qr', path.join(tmp, 'scan.zip'), 'SKILL.md'], { cwd: path.join(tmp, 'pkg') })
  let base = ''
  const cloud = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/pkg/scan.zip') { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(fs.readFileSync(path.join(tmp, 'scan.zip'))) }
    let body = {}, code = 200
    if (p === '/api/market/items') body = { items: [ITEM] }
    else if (p === `/api/market/items/${ID}`) body = ITEM
    else if (p === `/api/market/items/${ID}/install`) body = { type: 'skill', installSlug: SLUG, downloadUrl: `${base}/pkg/scan.zip`, source: 'zip' }
    else if (/\/(comments|versions)$/.test(p)) body = { items: [], total: 0 }
    else { code = 401; body = { detail: 'signed out' } }
    res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
  })
  await new Promise((r) => cloud.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${cloud.address().port}`
  process.env.TANGU_CLOUD_URL = base
  const engineCalls = []
  const entry = { key: `user:${SLUG}`, id: `local:${SLUG}`, slug: SLUG, scope: 'user', name: SLUG, description: '', availability: 'available', disabled: false, disabledForAgent: false }
  const MK = JSON.stringify({ kind: 'marketplace', version: 1, items: [(({ readme, ...x }) => x)(ITEM)] })
  const sessions = [{ id: 'mk', title: 'Find a scan skill', summary: '', model_id: 'm1', archived: false, created_at: '2026-10-28 10:30:00', updated_at: '2026-10-28 10:30:00', projectless: true, project_path: null, agent_config: { agentSlug: 'xyra', execMode: 'host' } }]
  const ctx = await launch({ tag: 'skill-agents', overrideHome: true, fixtures: { agents: AGENTS, sessions }, messages: [],
    stubOverride: async ({ path: p, method, url, body }) => {
      if (p === '/agent/agents' && method === 'GET') return { agents: AGENTS }
      if (p === '/agent/skills/catalog' && method === 'GET') return { skills: [entry] }
      const dis = /^\/agent\/skills\/catalog\/([^/]+)\/disabled$/.exec(p)
      if (dis && method === 'PUT') { const b = await body(); engineCalls.push(`${b.disabled ? 'hide' : 'show'} ${decodeURIComponent(dis[1])} ${b.agentSlug || url.searchParams.get('agentSlug')}`); return { ok: true } }
      const ag = /^\/agent\/agents\/([^/]+)$/.exec(p)
      if (ag && method === 'PATCH') { const b = await body(); engineCalls.push(`save ${ag[1]} ${(b.enabledSkillIds || []).join(',')}`); return { agent: { ...AGENTS.find((a) => a.slug === ag[1]), ...b } } }
      if (p === '/agent/sessions/mk/messages') return { messages: [{ id: 'u1', role: 'user', content: 'Any skill that reads scans?', timestamp: 1 }, { id: 'a1', role: 'model', content: 'This one fits.', timestamp: 2, tool_calls: [{ id: 'm1', type: 'function', function: { name: 'search_marketplace', arguments: '{"query":"scan"}' }, ui_content_offset: 0 }], tool_results: [{ tool_call_id: 'm1', name: 'search_marketplace', content: MK, isError: false }] }] }
    } })
  const { app, win } = ctx
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 }); await enterSpace(win, 'tangu')
    // 对话里的商店卡：技能卡左下出现「装给 所有 Agent」
    await win.locator('.t2s-srow[data-sel-id="mk"]').first().click()
    const chatTrigger = win.locator('[data-marketplace-item] .mk-agents-trigger').first()
    check('对话里的技能商店卡出现「装给」下拉', await chatTrigger.waitFor({ timeout: 10000 }).then(() => true, () => false))
    check('缺省写「所有 Agent」', /所有 Agent/.test(await chatTrigger.textContent().catch(() => '')))
    await captureWindow(app, path.join(OUT, 'chat-card.png'))
    // 商店详情
    await win.evaluate(() => window.tangu.openFloatingPanel({ id: 'market', title: '商店', builtin: 'market' }))
    let mk; for (let i = 0; i < 150 && !mk; i++) { mk = app.windows().find((w) => w.url().includes('id=market')); if (!mk) await win.waitForTimeout(100) }
    await mk.locator('.mk-card-title').first().click(); await mk.locator('.mk-detail-hero').waitFor({ timeout: 10000 })
    const trigger = mk.locator('[data-market-skill-agents] .mk-agents-trigger')
    check('商店详情的安装键下出现「装给」下拉', await trigger.waitFor({ timeout: 8000 }).then(() => true, () => false))
    await trigger.click()
    const rows = mk.locator('.capability-menu [role=menuitemcheckbox]')
    check('清单 = 所有 Agent + 5 个 Agent', (await rows.count()) === 6, String(await rows.count()))
    check('技能档「关」的 Muse 不可选', await rows.filter({ hasText: 'Muse' }).isDisabled())
    // 只给 Coding：从「所有」依次点掉 Arioso、Aria、Recita（菜单不关）
    for (const n of ['Arioso', 'Aria', 'Recita']) await rows.filter({ hasText: n }).first().click()
    check('多选菜单点了不关', await rows.first().isVisible())
    check('按钮写上选中的名字', (await trigger.textContent()).includes('Coding'), await trigger.textContent())
    const shootMarket = async (name) => fs.writeFileSync(path.join(OUT, name), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('id=market')).webContents.capturePage()).toPNG().toString('base64')), 'base64'))
    await shootMarket('store-detail-menu.png')
    await mk.keyboard.press('Escape')
    check('Esc 收起菜单', await mk.locator('.capability-menu').waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false))
    await mk.waitForTimeout(300); await shootMarket('store-detail.png')
    await mk.locator('.mk-detail-actions .btn.primary').first().click()
    for (let i = 0; i < 100 && engineCalls.length < 4; i++) await mk.waitForTimeout(100)
    const home = ctx.home
    check('技能真的装进了隔离 HOME 的公共技能区', fs.readdirSync(home, { recursive: true }).some((f) => String(f).endsWith(path.join('skills', SLUG, 'SKILL.md'))))
    check('只给 Coding：Arioso / Aria / Recita 各屏蔽一条，Coding 名单加上，Muse 不动',
      JSON.stringify(engineCalls) === JSON.stringify([`hide user:${SLUG} xyra`, `hide user:${SLUG} aria`, `hide user:${SLUG} recita`, `save coding local:review,local:${SLUG}`]), JSON.stringify(engineCalls))
  } finally { await ctx.close(); cloud.close(); fs.rmSync(tmp, { recursive: true, force: true }) }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `${failed} FAILED` : 'ALL PASS'); process.exitCode = failed ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
