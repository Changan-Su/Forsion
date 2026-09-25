/**
 * Background agent settings in an isolated Electron window with a stub engine.
 * Covers Historian/Muse navigation, deferred field patches, retained text/newlines,
 * save failure, discard, keyboard menus, reduced motion, narrow and English/dark screenshots.
 * Run after npm run build: npm run e2e:musesettings. SHOT_DIR optionally sets the artifact directory.
 */
const fs = require('fs'), os = require('os'), path = require('path')
const ROOT = path.resolve(__dirname, '..')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const OUT = process.env.SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-special-ux-'))
const SHOT1 = path.join(OUT, 'forsion-muse-settings.png'), SHOT2 = path.join(OUT, 'forsion-muse-settings-auto.png')

const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${detail}`}`) }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-muse-settings-'))
  let conf = {
    historian: { enabled: false, modelId: '', everyRounds: 5, firstRoundTrigger: true, mode: 'independent', prompt: '', harnessCandidates: false },
    muse: { enabled: true, modelId: 'm1', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5, supervisorPollMinutes: 5,
      activeHours: null, allowedFolders: ['/Users/me/Documents/Notes'], mode: 'ask', heartbeatMinutes: 120, notify: 'immediate', escalateTo: 'coder' },
  }
  const posted = []
  let failSave = false
  const stub = await startStubEngine({
    sessions: [], messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
    agents: [
      { slug: 'xyra', name: 'Xyra', description: '', model: '', tools: [], thinkingLevel: '', maxIterations: null, approvalMode: '' },
      { slug: 'coder', name: 'Coder', description: '', model: '', tools: [], thinkingLevel: '', maxIterations: null, approvalMode: '' },
      { slug: 'muse', name: 'Muse', description: '', model: '', tools: [], thinkingLevel: '', maxIterations: null, approvalMode: '' },
    ],
    handle: async ({ path: p, method, body }) => {
      if (p === '/agent/special/config' && method === 'GET') return { config: conf, defaults: { historianPrompt: '' } }
      if (p === '/agent/special/config' && method === 'POST') { if (failSave) return { __code: 503, body: { detail: 'test save failure' } }; const b = await body(); posted.push(b); conf = { historian: { ...conf.historian, ...(b.historian || {}) }, muse: { ...conf.muse, ...(b.muse || {}) } }; return { config: conf } }
      if (p === '/agent/special/muse/status') return { status: { enabled: true, hasModel: true, running: false, restartsThisWindow: 0, maxRestartsPerWindow: 3, lastCycleAt: null, lastError: null, sessionId: null } }
      return undefined
    },
  })
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  try {
    let win = await app.firstWindow()
    await win.setViewportSize({ width: 1400, height: 1000 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.locator('.ntf-close').evaluateAll((bs) => bs.forEach((b) => b.click())).catch(() => {})
    // 设置画在独立浮窗里(Floating Panel 化 2026-09-20):开窗前先 arm window 事件,拿到后 win 换成浮窗 page。
    const opened = app.waitForEvent('window')
    await win.keyboard.press('Meta+Comma')
    win = await opened
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.settings-main', { timeout: 30_000 }).catch(() => {})
    check('设置开在独立浮窗里', (await win.locator('.settings-main').count()) > 0)
    const nav = win.locator('.settings-nav')
    for (const l of ['Agent', '后台 Agent']) {
      const b = nav.getByRole('button', { name: l, exact: true }).first()
      await b.scrollIntoViewIfNeeded().catch(() => {})
      await b.click()
      await win.waitForTimeout(700)
    }
    const root = win.locator('.special-agents')
    await root.waitFor()
    check('Historian and Muse share a clear two-item selector', await root.getByRole('tab').count() === 2)
    check('only the selected agent shows its fields', await root.getByRole('tabpanel').count() === 1)
    await root.getByRole('tab', { name: /Muse/ }).click()
    const card = root.getByRole('tabpanel')
    check('advanced budget is collapsed by default', await card.locator('details', { hasText: '预算' }).evaluate((el) => !el.open))
    check('ask mode explains folder access', (await card.textContent()).includes('只是提示'))
    await win.screenshot({ path: SHOT1 })
    await card.getByRole('button', { name: '权限档', exact: true }).click()
    await win.getByRole('menuitemradio', { name: '全开（完全自动）', exact: true }).click()
    check('full auto updates folder guidance immediately', (await card.textContent()).includes('可直接读写'))
    const folders = card.getByRole('textbox', { name: '额外文件夹（每行一个绝对路径）', exact: true })
    await folders.fill('/Users/me/Documents/Notes\n')
    await folders.press('End')
    await folders.pressSequentially('/Users/me/Projects')
    check('a newline stays editable while entering a second folder', (await folders.inputValue()).includes('\n/Users/me/Projects'))
    check('editing does not POST on every keystroke', posted.length === 0)
    await card.locator('details > summary').filter({ hasText: '预算' }).click()
    check('budget exposes its four limits', await card.locator('details', { hasText: '预算' }).locator('input[type=number]').count() === 4)
    await card.locator('details > summary').filter({ hasText: '通知' }).click()
    await card.getByRole('button', { name: '难活交给', exact: true }).click()
    check('escalation preserves Coder and excludes Muse', await win.getByRole('menuitemradio', { name: 'Coder', exact: true }).getAttribute('aria-checked') === 'true' && await win.getByRole('menuitemradio', { name: 'Muse', exact: true }).count() === 0)
    await win.keyboard.press('Escape')
    await root.getByRole('tab', { name: /Historian/ }).click()
    await card.locator('summary').filter({ hasText: '高级设置' }).click()
    const prompt = card.getByRole('textbox')
    await prompt.fill('Write concise notes.\nKeep evidence.')
    await root.getByRole('tab', { name: /Muse/ }).click()
    check('switching agents keeps the unsaved folder draft', (await folders.inputValue()).includes('/Users/me/Projects'))
    await nav.getByRole('button', { name: 'Agent 名册', exact: true }).click()
    await nav.getByRole('button', { name: '后台 Agent', exact: true }).click()
    await root.getByRole('tab', { name: /Muse/ }).click()
    check('settings navigation preserves unsaved drafts', (await folders.inputValue()).includes('/Users/me/Projects'))
    await root.getByRole('button', { name: '保存更改', exact: true }).click()
    await root.getByText('更改已保存', { exact: true }).waitFor()
    check('one save commits both drafts as field patches', posted.length === 1 && posted[0].muse.mode === 'auto' && posted[0].muse.allowedFolders.length === 2 && posted[0].historian.prompt.includes('Keep evidence.') && !('enabled' in posted[0].muse))
    await card.getByRole('switch', { name: 'Muse（缪斯）', exact: true }).click()
    failSave = true
    await root.getByRole('button', { name: '保存更改', exact: true }).click()
    await root.locator('.special-error').waitFor()
    check('failed save keeps the draft and offers retry', await card.getByRole('switch', { name: 'Muse（缪斯）', exact: true }).getAttribute('aria-checked') === 'false' && await root.getByRole('button', { name: '保存更改', exact: true }).isEnabled())
    failSave = false
    await root.getByRole('button', { name: '放弃修改', exact: true }).click()
    check('discard restores the stored enabled state', await card.getByRole('switch', { name: 'Muse（缪斯）', exact: true }).getAttribute('aria-checked') === 'true' && posted.length === 1)
    await win.screenshot({ path: SHOT2 })
    await win.setViewportSize({ width: 760, height: 850 })
    await win.waitForTimeout(250)
    check('narrow background settings do not overflow', await root.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
    await win.screenshot({ path: path.join(OUT, 'forsion-special-narrow.png') })
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await card.getByRole('button', { name: '权限档', exact: true }).click()
    check('background menu respects reduced motion', await win.locator('.capability-menu').evaluate((el) => getComputedStyle(el).animationName === 'none'))
    await win.keyboard.press('Escape')
    await win.evaluate(() => { localStorage.setItem('tangu_locale', 'en'); localStorage.setItem('forsion_theme', 'dark') })
    await win.reload()
    await win.locator('.settings-nav').getByRole('button', { name: 'Agents', exact: true }).click()
    await win.locator('.settings-nav').getByRole('button', { name: 'Background agents', exact: true }).click()
    await win.locator('.special-agents').waitFor()
    await win.screenshot({ path: path.join(OUT, 'forsion-special-english-dark.png') })
  } finally {
    await app.close().catch(() => {})
    stub.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过;截图 ${SHOT1} / ${SHOT2}`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
