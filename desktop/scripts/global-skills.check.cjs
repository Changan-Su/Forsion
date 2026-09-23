/** Real SettingsModal skill library: catalog list/detail/create wiring and screenshots. Run after npm run build. */
const fs = require('fs'), os = require('os'), path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const OUT = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-global-skills-shots-'))
fs.mkdirSync(OUT, { recursive: true })
const KEY_USER = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const KEY_BUILTIN = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const KEY_LEGACY = 'dddddddddddddddddddddddd'
const skills = [
  { key: KEY_BUILTIN, id: 'local:show-time', slug: 'show-time', name: 'Show time', description: 'Read the local clock when a task needs the current time.', icon: null, version: null, scope: 'user', owner: null, path: '/bundle/skills/show-time', provenance: 'builtin', origin: null, readOnly: true, disabled: false, disabledForAgent: false, availability: 'available', shadowedBy: null },
  { key: KEY_USER, id: 'local:writing-guide', slug: 'writing-guide', name: '写作规范', description: '为中文文档整理结构与措辞。', icon: null, version: null, scope: 'user', owner: null, path: '/host/.forsion/tangu/skills/writing-guide', provenance: 'user', origin: null, readOnly: false, disabled: false, disabledForAgent: false, availability: 'available', shadowedBy: null },
  { key: KEY_LEGACY, id: 'local:Legacy_Skill', slug: 'Legacy_Skill', name: 'Legacy skill', description: 'An older folder name.', icon: null, version: null, scope: 'user', owner: null, path: '/host/.forsion/tangu/skills/Legacy_Skill', provenance: 'user', origin: null, compatibility: 'legacy-slug', readOnly: true, disabled: false, disabledForAgent: false, availability: 'available', shadowedBy: null },
]
const details = {
  [KEY_USER]: { content: '## 工作方式\n\n先判断读者与目标，再给出清晰的结构。', files: [{ path: 'SKILL.md', size: 130 }, { path: 'references/style.md', size: 92 }] },
  [KEY_BUILTIN]: { content: 'Use the current clock only when needed.', files: [{ path: 'SKILL.md', size: 80 }] },
  [KEY_LEGACY]: { content: 'Older instructions.', files: [{ path: 'SKILL.md', size: 60 }] },
}
const checks = []
const disabledRequests = []
function check(label, ok, extra = '') { checks.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` | ${extra}` : ''}`) }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-global-skills-'))
  const stub = await startStubEngine({ sessions: [], handle: async ({ path: p, method, body }) => {
    if (p === '/agent/skills/catalog' && method === 'GET') return { skills }
    if (p === '/agent/skills' && method === 'GET') return { skills: [{ id: 'cloud-copy', name: '写作规范 · 云端', description: '仅正文副本', source: 'user', icon: null, category: null }] }
    if (p.startsWith('/agent/skills/catalog/') && method === 'GET') {
      const key = p.split('/').pop()
      const skill = skills.find((s) => s.key === key)
      return skill ? { skill: { ...skill, ...(details[key] || { content: '', files: [] }) } } : { __code: 404, body: { detail: 'not found' } }
    }
    if (p === '/agent/skills/catalog' && method === 'POST') {
      const input = await body()
      const skill = { ...skills[1], key: 'cccccccccccccccccccccccc', id: `local:${input.slug}`, slug: input.slug, name: input.name, description: input.description, path: `/host/.forsion/tangu/skills/${input.slug}` }
      skills.push(skill)
      details[skill.key] = { content: input.content, files: [{ path: 'SKILL.md', size: 100 }] }
      return { skill: { ...skill, ...details[skill.key] } }
    }
    if (p.endsWith('/disabled') && method === 'PUT') {
      const key = p.split('/')[4]
      const input = await body()
      const skill = skills.find((item) => item.key === key)
      if (!skill) return { __code: 404, body: { detail: 'not found' } }
      skill.disabled = !!input.disabled
      skill.availability = skill.disabled ? 'disabled' : 'available'
      disabledRequests.push({ key, disabled: skill.disabled })
      return { ok: true }
    }
  } })
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'skills-test-token' }))
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, PI_CU_SOCKET_PATH: path.join(home, 'bridge.sock') } })
    const main = await app.firstWindow()
    await main.waitForSelector('.shell-host', { timeout: 30000, state: 'attached' })
    await skipOnboarding(main)
    await main.evaluate((key) => window.tangu.openFloatingPanel({ id: 'settings', title: '设置', builtin: 'settings', params: { tab: 'skills', skillKey: key } }), KEY_USER)
    let panel
    for (let i = 0; i < 120; i++) {
      panel = app.windows().find((page) => page.url().includes('window=floating'))
      if (panel) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!panel) throw new Error('Settings panel did not open')
    await panel.locator('.gsk-library').waitFor({ timeout: 30000 })
    await panel.locator('.gsk-group').first().waitFor({ timeout: 15000 })
    check('global and cloud groups render', await panel.getByText('我的技能', { exact: true }).count() > 0 && await panel.getByText('我的云端正文副本', { exact: true }).count() > 0)
    await panel.locator('.gsk-row.selected', { hasText: '写作规范' }).waitFor({ timeout: 10000 })
    check('skillKey deep link selects the exact global copy', await panel.locator('.gsk-row.selected', { hasText: '写作规范' }).count() === 1)
    await panel.getByText('references/style.md', { exact: true }).waitFor({ timeout: 10000 })
    check('detail reads body, path and attached files', await panel.locator('.gsk-content pre').innerText() === details[KEY_USER].content && await panel.locator('.gsk-meta code').innerText() === skills[1].path)
    const libraryShot = path.join(OUT, 'global-skills-library.png')
    await panel.screenshot({ path: libraryShot })
    console.log(`SCREENSHOT ${libraryShot}`)
    await panel.locator('.gsk-group-toggle').click()
    await panel.locator('.gsk-row', { hasText: 'Show time' }).click()
    await panel.getByRole('button', { name: '更多操作', exact: true }).click()
    await panel.getByRole('menuitem', { name: '停用', exact: true }).click()
    await panel.getByText('已停用', { exact: true }).first().waitFor({ timeout: 10000 })
    check('read-only included skill can be paused globally', disabledRequests.length === 1 && disabledRequests[0].key === KEY_BUILTIN && disabledRequests[0].disabled && skills[0].disabled)
    await panel.locator('.gsk-row', { hasText: 'Legacy skill' }).click()
    await panel.getByText('旧目录名仍可使用；请复制为新技能后再编辑或停用。').waitFor({ timeout: 10000 })
    check('legacy folder is visible without an unsupported pause action', await panel.locator('.gsk-detail .gsk-more').count() === 0)
    await panel.getByRole('button', { name: '复制到我的技能', exact: true }).click()
    check('legacy copy starts with a valid new folder name', /^[a-z0-9][a-z0-9-]*$/.test(await panel.locator('.gsk-form').getByLabel('目录名（可选）').inputValue()))
    await panel.locator('.gsk-form').getByRole('button', { name: '取消' }).click()
    await panel.getByRole('button', { name: '添加技能' }).click()
    const menuStyle = await panel.locator('.capability-menu').evaluate((el) => ({ animation: getComputedStyle(el).animationName, size: getComputedStyle(el).fontSize, token: getComputedStyle(el).getPropertyValue('--menu-text-size').trim(), portal: el.parentElement.parentElement === document.body }))
    check('skill menu uses shared motion and escapes the settings scroll container', menuStyle.animation === 'ui-menu-enter' && menuStyle.portal, JSON.stringify(menuStyle))
    await panel.keyboard.press('Escape')
    check('Escape returns focus to the add trigger', await panel.getByRole('button', { name: '添加技能', exact: true }).evaluate((el) => el === document.activeElement))
    await panel.getByRole('button', { name: '添加技能', exact: true }).press('ArrowDown')
    await panel.waitForTimeout(240)
    await panel.screenshot({ path: path.join(OUT, 'global-skills-menu.png') })
    await panel.getByRole('menuitem', { name: '新建技能' }).click()
    const form = panel.locator('.gsk-form')
    await form.getByLabel('名称').fill('会议纪要')
    await form.getByLabel('用途').fill('把讨论整理成决策与行动项。')
    await form.getByLabel('SKILL.md 正文').fill('## 步骤\n\n先提取决定，再整理待办。')
    check('create form derives a safe folder name', await form.getByLabel('目录名').inputValue() === 'hui-yi-ji-yao' || (await form.getByLabel('目录名').inputValue()).length > 0)
    const formShot = path.join(OUT, 'global-skills-create.png')
    await panel.screenshot({ path: formShot })
    console.log(`SCREENSHOT ${formShot}`)
    await form.getByRole('button', { name: '保存', exact: true }).click()
    await panel.getByText('技能已保存。', { exact: true }).waitFor({ timeout: 10000 })
    check('create persists through catalog and selects the result', skills.length === 4 && await panel.locator('.gsk-row.selected', { hasText: '会议纪要' }).count() === 1)
    const overflow = await panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    check('desktop panel has no horizontal overflow', overflow <= 0, `overflow=${overflow}`)
    await panel.setViewportSize({ width: 760, height: 850 })
    await panel.waitForTimeout(250)
    const narrow = await panel.evaluate(() => {
      const list = document.querySelector('.gsk-list')?.getBoundingClientRect()
      const detail = document.querySelector('.gsk-detail')?.getBoundingClientRect()
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, stacked: !!list && !!detail && detail.top >= list.bottom }
    })
    check('narrow settings stack list and detail without horizontal overflow', narrow.stacked && narrow.overflow <= 0, JSON.stringify(narrow))
    await panel.emulateMedia({ reducedMotion: 'reduce' })
    await panel.getByRole('button', { name: '来源', exact: true }).click()
    check('reduced motion disables menu animation', await panel.locator('.capability-menu').evaluate((el) => getComputedStyle(el).animationName) === 'none')
    await panel.keyboard.press('End')
    await panel.keyboard.press('Enter')
    check('source picker works with keyboard in the narrow view', await panel.locator('.gsk-row').count() === 1)
    await panel.getByRole('button', { name: '来源', exact: true }).click()
    await panel.keyboard.press('Home')
    await panel.keyboard.press('Enter')
    const narrowShot = path.join(OUT, 'global-skills-narrow.png')
    await panel.screenshot({ path: narrowShot })
    console.log(`SCREENSHOT ${narrowShot}`)
  } finally {
    if (app) await app.close().catch(() => {})
    await stub.close()
  }
  console.log(`${checks.filter(Boolean).length}/${checks.length} passed`)
  if (checks.some((ok) => !ok)) process.exitCode = 1
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
