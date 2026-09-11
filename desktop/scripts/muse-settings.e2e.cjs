/**
 * Muse 设置卡回归(2026-09-10 重排:基本 / 节奏 / 通知 / 预算折叠)。真 Electron × 假引擎:
 * 打开 设置 → 智能体 → 后台智能体,断言小节顺序、巡检/重启字样已撤、文件夹提示随档位切换、切档打到 POST、
 * 预算默认折叠且展开是四个字段、「难活交给」是名册下拉且不含 muse;拍两张截图(默认 / 展开预算+全开档)。
 * 先 `npm run build`;跑法 `npm run e2e:musesettings`;截图 $TMPDIR/forsion-muse-settings{,-auto}.png(SHOT_DIR 可改)。
 */
const fs = require('fs'), os = require('os'), path = require('path')
const ROOT = path.resolve(__dirname, '..')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const OUT = process.env.SHOT_DIR || os.tmpdir()
const SHOT1 = path.join(OUT, 'forsion-muse-settings.png'), SHOT2 = path.join(OUT, 'forsion-muse-settings-auto.png')

const results = []
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${ok ? '' : ` — ${detail}`}`) }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-muse-settings-'))
  let conf = {
    historian: { enabled: false, modelId: '', everyRounds: 5, firstRoundTrigger: true, mode: 'independent', prompt: '', harnessCandidates: false },
    muse: { enabled: true, modelId: 'm1', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5, supervisorPollMinutes: 5,
      activeHours: null, allowedFolders: ['/Users/me/Documents/Notes'], mode: 'ask', heartbeatMinutes: 120, notify: 'immediate', escalateTo: 'coder' },
  }
  const posted = []
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
      if (p === '/agent/special/config' && method === 'POST') { const b = await body(); posted.push(b); conf = { historian: { ...conf.historian, ...(b.historian || {}) }, muse: { ...conf.muse, ...(b.muse || {}) } }; return { config: conf } }
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
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1400, height: 1000 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.locator('.ntf-close').evaluateAll((bs) => bs.forEach((b) => b.click())).catch(() => {})
    await win.keyboard.press('Meta+Comma')
    await win.waitForTimeout(1200)
    check('设置打开', (await win.locator('.settings-main').count()) > 0)
    const nav = win.locator('.settings-nav')
    for (const l of ['智能体', '后台智能体']) {
      const b = nav.getByRole('button', { name: l, exact: true }).first()
      await b.scrollIntoViewIfNeeded().catch(() => {})
      await b.click()
      await win.waitForTimeout(700)
    }
    const card = win.locator('.agent-card').nth(1)
    check('Muse 卡渲染', (await card.count()) === 1 && (await card.locator('.ac-title').textContent()).includes('Muse'))
    await card.scrollIntoViewIfNeeded()
    await win.waitForTimeout(300)
    const secs = await card.locator('.ac-sec').allTextContents()
    check('三个小节标题:节奏 / 通知 / 预算', JSON.stringify(secs) === JSON.stringify(['节奏', '通知', '预算']), JSON.stringify(secs))
    const labels = await card.locator('label').allTextContents()
    check('巡检间隔 / 重启 字样已撤', !labels.some((l) => /巡检|重启/.test(l)), JSON.stringify(labels))
    const hintAsk = await card.locator('textarea').locator('xpath=following-sibling::div[contains(@class,"hint")]').first().textContent()
    check('审批档:文件夹提示=只是提示', /只是提示/.test(hintAsk), hintAsk)
    const esc = card.locator('select').nth(3)
    check('难活交给 = 下拉且选中 coder,不含 muse', (await esc.inputValue()) === 'coder' && !(await esc.locator('option').allTextContents()).some((o) => /Muse/.test(o)), await esc.locator('option').allTextContents().then(JSON.stringify))
    check('预算默认折叠', !(await card.locator('details').evaluate((d) => d.open)))
    await win.screenshot({ path: SHOT1 })

    await card.locator('details summary').click()
    await card.locator('select').nth(1).selectOption('auto')
    await win.waitForTimeout(500)
    const hintAuto = await card.locator('textarea').locator('xpath=following-sibling::div[contains(@class,"hint")]').first().textContent()
    check('切全开档:文件夹提示=可直接读写', /可直接读写/.test(hintAuto), hintAuto)
    check('切档位打到 POST /agent/special/config', posted.some((b) => b.muse && b.muse.mode === 'auto'), JSON.stringify(posted))
    const budgetLabels = await card.locator('details label').allTextContents()
    check('预算展开:窗口 / 周期 / TODO / 轮数', budgetLabels.length === 4 && /预算窗口/.test(budgetLabels[0]) && /周期/.test(budgetLabels[1]), JSON.stringify(budgetLabels))
    await card.scrollIntoViewIfNeeded()
    await win.screenshot({ path: SHOT2 })
  } finally {
    await app.close().catch(() => {})
    stub.close()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过;截图 ${SHOT1} / ${SHOT2}`)
  process.exit(failed.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
