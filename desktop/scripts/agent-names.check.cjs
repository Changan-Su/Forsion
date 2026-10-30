/**
 * Agent 双语名字:真 Electron × 桩引擎。Agent 页头部(大字 / 副名 / 显示偏好)、英文名校验、保存带上三个字段、
 * 新建表单、切界面语言跟着换、群聊旧记录回认、私聊标题现取、@ 候选两个名字都能搜到。截图进 ../outputs/agent-names/。
 * 用法:先 npx electron-vite build,再 node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="双语名字" --eta=2 -- node scripts/agent-names.check.cjs
 */
const fs = require('fs'), path = require('path')
const { launch, boot, enterSpace, captureWindow } = require('./lib/uiux-electron.cjs')
const OUT = path.resolve(__dirname, '../../outputs/agent-names')
fs.mkdirSync(OUT, { recursive: true })
let failed = 0
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` | ${detail}` : ''}`) }

const lib = (slug) => ({ libraryDir: `/tmp/agent-names/${slug}/Library` })
const AGENTS = [
  { slug: 'xyra', name: 'Arioso', nameZh: '行香子', nameEn: 'Arioso' }, { slug: 'aria', name: 'Aria', nameZh: '浣溪沙', nameEn: 'Aria' },
  { slug: 'recita', name: 'Recita', nameZh: '临江仙', nameEn: 'Recita' }, { slug: 'coding', name: 'Coding', nameZh: '', nameEn: 'Coding' },
  { slug: 'helper', name: '小助手', nameZh: '小助手', nameEn: '' },
].map((a) => ({ description: '', model: '', tools: [], thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: 'p', soul: '', createdBy: 'user', ...a, ...lib(a.slug) }))
const base = { archived: false, model_id: 'm1', created_at: '2026-10-30 10:00:00', updated_at: '2026-10-30 10:00:00', projectless: true, project_path: null, project_name: null }
const sessions = [
  { ...base, id: 'team', title: 'Atlas team', agent_config: { groupChat: true, groupAgents: ['aria', 'recita'], agentSlug: 'aria' } },
  { ...base, id: 'solo', title: 'New Chat', agent_config: { soloAgentSlug: 'aria', agentSlug: 'aria' } },
]
const teamMessages = [
  { id: 'u', session_id: 'team', role: 'user', content: '开始', timestamp: 1 },
  { id: 'a', session_id: 'team', role: 'model', content: '**🗣 Aria**\n\n老记录,发言时叫 Aria', timestamp: 2 }, // 没有 agent_slug 的老记录
  { id: 'b', session_id: 'team', role: 'model', content: '**🗣 Recita**\n\n新记录带 slug', agent_slug: 'recita', timestamp: 3 },
]

async function main() {
  const saves = [], creates = []
  const ctx = await launch({ tag: 'agent-names', overrideHome: true, fixtures: { agents: AGENTS, sessions }, messages: [],
    stubOverride: async ({ path: p, method, body }) => {
      if (p === '/agent/agents' && method === 'GET') return { agents: AGENTS }
      if (p === '/agent/agents' && method === 'POST') { const b = await body(); creates.push(b); const agent = { ...AGENTS[0], ...b, createdBy: 'user', ...lib(b.slug) }; AGENTS.push(agent); return { agent } }
      const ag = /^\/agent\/agents\/([^/]+)$/.exec(p)
      if (ag && method === 'PATCH') { const b = await body(); saves.push(b); const a = AGENTS.find((x) => x.slug === ag[1]); Object.assign(a, b); return { agent: a } }
      if (p === '/agent/sessions/team/messages') return { messages: teamMessages }
    } })
  const { app, win } = ctx
  const reloadInto = async (space, locale) => {
    await win.evaluate(([s, l]) => { localStorage.setItem('forsion_default_space', s); localStorage.setItem('tangu_locale', l) }, [space, locale])
    await win.reload(); await win.waitForSelector('.dv-groupview'); await win.waitForTimeout(1200)
  }
  const pick = (name) => win.locator('.agents-roster-item').filter({ hasText: name }).first().click()
  const main = () => win.locator('[data-agent-profile] .agent-character-name').first()
  const alt = () => win.locator('[data-agent-profile] .agent-character-altname').first()
  try {
    await boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    await reloadInto('agents', 'zh')
    await win.locator('[data-agents-space]').waitFor()
    await pick('浣溪沙')
    await main().waitFor()
    check('中文界面:大字是中文名', await main().inputValue() === '浣溪沙')
    check('副名是英文名', await alt().inputValue() === 'Aria', await alt().getAttribute('aria-label'))
    check('名册显示中文名', await win.locator('.agents-roster-item').filter({ hasText: '临江仙' }).count() === 1)
    await captureWindow(app, path.join(OUT, 'profile-zh.png'))

    await alt().fill('Aria 浣')
    check('英文名有汉字:就地提示', (await win.locator('.agent-character-identity [role=alert]').textContent().catch(() => '')) === '英文名不能有汉字')
    check('英文名有汉字:保存灰掉', await win.locator('.agent-profile-save .btn.primary').isDisabled())
    await captureWindow(app, path.join(OUT, 'profile-han-error.png'))
    await alt().fill('Aria Two')
    await win.locator('.agent-profile-save .btn.primary').click()
    await win.waitForTimeout(400)
    check('保存带上改的字段和显示名', saves.at(-1)?.nameEn === 'Aria Two' && saves.at(-1)?.name === '浣溪沙', JSON.stringify(saves.at(-1)))

    await win.locator('[data-agent-profile] .agent-character-pref').first().click()
    await win.locator('.capability-menu [role=menuitemradio]').filter({ hasText: '英文名' }).click()
    check('选英文名:大字换成英文名', await main().inputValue() === 'Aria Two')
    await win.locator('.agent-profile-save .btn.primary').click()
    await win.waitForTimeout(400)
    check('保存偏好', saves.at(-1)?.namePref === 'en' && saves.at(-1)?.name === 'Aria Two', JSON.stringify(saves.at(-1)))
    check('中文界面的名册也用英文名', await win.locator('.agents-roster-item').filter({ hasText: 'Aria Two' }).count() === 1)
    Object.assign(AGENTS[1], { name: 'Aria', nameEn: 'Aria', namePref: undefined })

    await pick('Coding')
    await main().waitFor()
    check('没有中文名:大字用英文名,副名空着让填', await main().inputValue() === 'Coding' && await alt().inputValue() === '' && await alt().getAttribute('placeholder') === '中文名')

    await reloadInto('agents', 'en')
    await win.locator('[data-agents-space]').waitFor()
    await pick('Aria')
    await main().waitFor()
    check('英文界面:大字英文名,副名中文名', await main().inputValue() === 'Aria' && await alt().inputValue() === '浣溪沙')
    check('只有中文名的 Agent 在英文界面显示原名', await win.locator('.agents-roster-item').filter({ hasText: '小助手' }).count() === 1)
    await captureWindow(app, path.join(OUT, 'profile-en.png'))

    await reloadInto('agents', 'zh')
    await win.locator('[data-agents-space]').waitFor()
    await win.locator('.agents-roster-create').click()
    const form = win.locator('.agent-create-form'); await form.waitFor()
    const submit = form.locator('.btn.primary')
    await form.getByLabel('中文名', { exact: true }).fill('小满')
    await form.getByLabel('工作指令', { exact: true }).fill('Do it.')
    check('只填中文名:id 空着,创建灰掉', await form.getByLabel('ID（文件夹名）').inputValue() === '' && await submit.isDisabled())
    await form.getByLabel('英文名', { exact: true }).fill('Little Fullness')
    check('id 由英文名推', await form.getByLabel('ID（文件夹名）').inputValue() === 'little-fullness')
    await form.getByLabel('ID（文件夹名）').fill('aria')
    check('id 撞名:就地提示', /已/.test(await form.locator('[role=alert]').textContent().catch(() => '')) && await submit.isDisabled())
    await form.getByLabel('英文名', { exact: true }).fill('Scout')
    check('手改过的 id 不再跟着英文名变', await form.getByLabel('ID（文件夹名）').inputValue() === 'aria')
    await form.getByLabel('ID（文件夹名）').fill('')
    await form.getByLabel('英文名', { exact: true }).fill('Scou')
    await form.getByLabel('英文名', { exact: true }).fill('Scout')
    check('清空后恢复跟随', await form.getByLabel('ID（文件夹名）').inputValue() === 'scout')
    await captureWindow(app, path.join(OUT, 'create.png'))
    await submit.click(); await win.waitForTimeout(400)
    check('新建带 id 和两个名字', creates[0]?.slug === 'scout' && creates[0]?.nameZh === '小满' && creates[0]?.nameEn === 'Scout', JSON.stringify(creates[0]))

    await reloadInto('tangu', 'zh')
    await enterSpace(win, 'tangu')
    await win.evaluate(() => window.__tanguOpenSession?.('team'))
    await win.locator('.t2s-srow[data-sel-id="team"]').first().click().catch(() => {})
    await win.waitForSelector('.t2-name', { timeout: 8000 })
    const names = await win.locator('.t2-name').allTextContents()
    check('群聊老记录按前缀名回认,显示现在的名字', names.some((n) => n.includes('浣溪沙')), names.join(' | '))
    check('群聊新记录按 slug 回认', names.some((n) => n.includes('临江仙')), names.join(' | '))
    await captureWindow(app, path.join(OUT, 'team.png'))
    const box = win.locator('textarea').last()
    await box.click(); await box.pressSequentially('@Rec')
    const cand = win.locator('.t2c-menu-item').first()
    check('@ 输入英文名能搜到,候选行两个名字', /临江仙 · Recita/.test(await cand.textContent().catch(() => '')))
    await cand.click()
    check('插入的是当前显示名', (await box.inputValue()).includes('@临江仙 '), await box.inputValue())
  } finally { await ctx.close?.() ?? await app.close().catch(() => {}) }
  console.log(failed ? `✗ ${failed} 项失败` : '✓ 全部通过')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
