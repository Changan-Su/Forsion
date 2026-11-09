/**
 * check:first-run —— 首启引导四屏(开始 / 外观 / 关于你 / 认识你的 Agents 团队,11-05 定稿,11-06 第四轮 A4)在真 Electron 里走一遍。
 * 跳过引导 → 主页输入框下面「电脑历史还没开」那一行(出现、同意说明、✕ 不再提醒;动过电脑历史的不出)也在这里。
 * 隔离 home + 桩引擎(模型、卜算子配置、human/MEMORY.md、Agent 名单都由桩回,写入全记下来核对)。不登录、不授任何权限。
 * - 电脑历史连的是真主进程:macOS 指向不存在的 socket,Windows 指向不存在的助手可执行文件,绝不拉起这台机器上真的
 *   Computer Use 助手;「开始使用」之后那一下请辅助功能(permissions:request)在主进程里换成只记账的桩,不弹系统设置。
 *   本机没有电脑历史(非 macOS / Windows,或产品不带 Computer Use)时,相关断言整段跳过并打一行 SKIP。
 * - 每个语言 × 三个窗口尺寸量一遍四屏:底栏在窗口里、没有横向溢出;1280×800 下四屏都不用滚。
 * 先 npx electron-vite build;跑的时候占 GUI 锁(node ../../.claude/hooks/devlock.cjs run --vehicle=e2e -- npm run check:first-run)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..')
const APP_ROOT = process.env.FORSION_APP_ROOT || ROOT
const OUT = process.env.ONBOARDING_SHOTS || path.join(os.tmpdir(), 'forsion-onboarding-review')
const results = []
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-onboarding-'))
  const models = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `cloud-${i}`, name: ['GPT-6 Luna', 'Claude Sonnet 4.6', 'Gemini 3.1 Pro', 'Qwen 3.5', 'DeepSeek V3.2', 'GPT-5 mini'][i], provider: 'OpenAI', source: 'forsion', modelType: 'llm' })),
    { id: 'local/qwen', name: 'Qwen local', provider: 'Ollama', source: 'direct', modelType: 'llm' },
    { id: 'image', name: 'Image-only model', provider: 'Image', source: 'forsion', modelType: 'image_gen' },
  ]
  const specialConfig = {
    historian: { enabled: true, modelId: '', everyRounds: 7, firstRoundTrigger: true, autoEmoji: false, mode: 'independent', prompt: 'Keep this prompt', harnessCandidates: true },
    muse: { enabled: true, modelId: '', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5,
      supervisorPollMinutes: 5, activeHours: null, allowedFolders: ['/my/project'], mode: 'ask', heartbeatMinutes: 120, notify: 'digest', escalateTo: '' },
  }
  const agents = [
    { slug: 'xyra', name: 'Xyra', description: '', createdBy: 'builtin' },
    { slug: 'muse', name: 'Muse', nameZh: '卜算子', nameEn: 'Muse', description: '', createdBy: 'builtin' },
    { slug: 'coder', name: 'Coder', description: 'Writes code with you', createdBy: 'user' },
  ]
  // 新装机:引擎播种的英文空模板(tangu-agent/src/contracts/userMdTemplate.ts),「关于你」要当空、写时整份换掉
  const SEEDED = '# User Profile (USER.md)\n\n> Every Agent reads this profile. Record long-term information about yourself here.\n\n' +
    '## Name / What to call you\n\n## Preferences\n- \n\n## Level / Background\n\n## Long-term needs / Goals\n'
  const human = { scope: 'human', path: 'human/MEMORY.md', content: SEEDED, version: 'h1', exists: true, updatedAt: null, history: [], maxLength: 2000 }
  const specialWrites = [], introWrites = [], humanWrites = [], agentPatches = []
  let failIntro = false
  let signedIn = false // ④b 起:主进程回「已登录」,/agent/models 带云端后台模型(后台额度只计它)
  const stub = await startStubEngine({ models, override: async ({ path: p, method, body }) => {
    if (p === '/agent/models' && signedIn) return { models, defaultModelId: models[0].id, backgroundModelId: 'cloud-0', directProviders: [] }
    if (p === '/agent/special/config') {
      if (method === 'POST') {
        const patch = await body(); specialWrites.push(patch)
        if (patch.historian) Object.assign(specialConfig.historian, patch.historian)
        if (patch.muse) Object.assign(specialConfig.muse, patch.muse)
      }
      return { config: specialConfig }
    }
    if (p === '/agent/special/muse/intro' && method === 'POST') {
      const b = await body()
      if (failIntro) return { __code: 503, body: { detail: 'simulated save failure' } }
      introWrites.push(b)
      return { ok: true, config: specialConfig }
    }
    if (p === '/agent/human/MEMORY.md') {
      if (method === 'PUT') {
        const b = await body(); humanWrites.push(b)
        if (b.expectedVersion !== human.version) return { __code: 409, body: { error: 'version_conflict', detail: 'changed elsewhere' } }
        Object.assign(human, { content: b.content, version: `h${humanWrites.length + 1}`, exists: true })
        return { document: human, change: null }
      }
      return human
    }
    if (p === '/agent/agents' && method === 'GET') return { agents }
    // 「从其他 AI 搬过来」:扫到两家;审阅单打开时读一次空的整理状态
    if (p === '/agent/import/scan' && method === 'GET') return { tools: [{ id: 'claude-code', about: 3, rules: 1, project: 0, notes: 0, skills: 1 }, { id: 'codex', about: 2, rules: 0, project: 0, notes: 0, skills: 0 }], fresh: 5, freshTools: ['claude-code', 'codex'], last: null }
    if (p === '/agent/import/plan' && method === 'GET') return { state: 'idle', done: 0, total: 0, plan: null, error: null }
    const m = /^\/agent\/agents\/([^/]+)$/.exec(p)
    if (m && method === 'PATCH') {
      const b = await body(); agentPatches.push({ slug: m[1], ...b })
      const a = agents.find((x) => x.slug === m[1]); Object.assign(a, b)
      return { agent: a }
    }
    return undefined
  } })
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', APP_ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: stub.url,
        PI_CU_SOCKET_PATH: path.join(home, 'no-helper.sock'),
        PI_COMPUTER_USE_WINDOWS_HELPER_PATH: path.join(home, 'no-helper.exe') }, timeout: 45000 })
    const win = await app.firstWindow()
    win.setDefaultTimeout(15000)
    await win.waitForSelector('.ob-flow')
    await win.waitForFunction(() => !document.getElementById('tangu-splash'), null, { timeout: 30000 })
    // 请权限只记账:不装助手、不开系统设置、不弹引导窗。等界面出来再换(主进程这时已注册过自己的 handler;抢在它前面注册会让它启动时抛错)
    await app.evaluate(({ ipcMain }) => {
      globalThis.__permissionRequests = []
      ipcMain.removeHandler('permissions:request')
      ipcMain.handle('permissions:request', (_event, id) => {
        globalThis.__permissionRequests.push(id)
        return { platform: process.platform, appName: 'Forsion', computerUseAvailable: true, helperInstalled: false, helperRunning: false,
          permissions: { computerAccessibility: 'unknown', computerScreen: 'unknown', microphone: 'not-determined', camera: 'not-determined', screen: 'not-determined' } }
      })
    })
    const errors = []
    win.on('pageerror', (e) => errors.push(e.message))
    async function size(width, height) {
      await app.evaluate(({ BrowserWindow }, dimensions) => { const w = BrowserWindow.getAllWindows().find((w) => w.isVisible()); w.setMinimumSize(360, 400); w.setContentSize(...dimensions) }, [width, height])
    }
    const zoom = (factor) => app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows().find((w) => w.isVisible()).webContents.setZoomFactor(f), factor)
    /** 量这一屏:底栏在窗口里、没有横向溢出;mustFit = 这一屏在这个尺寸下不许要滚。 */
    async function geometry(name, { mustFit = false, screenshot = true } = {}) {
      await win.waitForTimeout(300)
      // 换屏动效(新屏滑进、旧屏替身滑出)放完再量:translate 会算进位置,替身也会让 .ob3-main 找到两个
      await win.waitForFunction(() => !document.querySelector('.ob3-main[data-lcl-exit]') && !document.getAnimations().some((a) => a.playState === 'running'
        && a.effect?.getComputedTiming?.().iterations !== Infinity && a.effect?.target?.closest?.('.ob3-main')), null, { timeout: 5000 })
      const state = await win.evaluate(() => {
        const shell = document.querySelector('.ob-flow'), main = document.querySelector('.ob3-main'), foot = document.querySelector('.ob3-foot')
        const r = foot.getBoundingClientRect()
        // 横向溢出时点名是谁撑出去的
        let wide
        if (main.scrollWidth > main.clientWidth + 1) {
          const edge = main.getBoundingClientRect().right
          wide = [...main.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > edge + 1).slice(-3)
            .map((el) => `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).trim().replace(/\s+/g, '.')}`)
        }
        return { step: shell.dataset.step, mainH: main.clientHeight, scrollH: main.scrollHeight, mainW: main.clientWidth, scrollW: main.scrollWidth,
          footerVisible: r.bottom <= innerHeight + 1 && r.top >= 0, shellOverflow: shell.scrollWidth > shell.clientWidth + 1, wide }
      })
      if (screenshot) await win.screenshot({ path: path.join(OUT, `${name}.png`) })
      const scrolls = state.scrollH > state.mainH + 1
      results.push({ name, ...state, scrolls })
      assert(state.footerVisible, `${name}: footer outside viewport`)
      assert(!state.shellOverflow && state.scrollW <= state.mainW + 1, `${name}: horizontal overflow ${JSON.stringify(state)}`)
      if (mustFit) assert(!scrolls, `${name}: needs scrolling ${JSON.stringify(state)}`)
      console.log(`PASS ${name} (${state.mainH}px${scrolls ? `, scrolls ${state.scrollH - state.mainH}px` : ', no scroll'})`)
    }
    const stepNow = () => win.locator('.ob-flow').getAttribute('data-step')
    /** 每次重载都会重放开屏(#tangu-splash 盖在最上面):等它退掉再量 / 截图,否则截到的是开屏。 */
    const settle = () => win.waitForFunction(() => !document.getElementById('tangu-splash'), null, { timeout: 30000 })
    /** 换屏时旧屏留一个替身滑出(带 data-lcl-exit,约 150ms):等它摘掉,不然按 data-* 找的严格选择器会找到两个。 */
    const noGhost = () => win.waitForFunction(() => !document.querySelector('.ob3-main[data-lcl-exit]'), null, { timeout: 5000 })
    async function next() {
      const previous = await stepNow()
      await win.locator('[data-ob-primary]').click()
      await win.waitForFunction((step) => document.querySelector('.ob-flow')?.getAttribute('data-step') !== step, previous)
      await noGhost()
    }
    /** 每屏等它的数据读回来再量:量「读取中」的空态会假绿。 */
    const ready = {
      start: () => win.waitForSelector('[data-ob-channels]'),
      theme: () => win.waitForSelector('.ob3-styles'),
      you: () => win.waitForSelector('[data-ob-you] [data-ob-you-name]:not([disabled])'),
      team: async () => { await win.waitForSelector('[data-ob-muse-model] .model-select-btn:not([disabled])'); await win.waitForSelector('[data-agent="coder"]') },
    }
    async function fresh() {
      await win.evaluate(() => { localStorage.removeItem('forsion_tangu_onboarding_done'); localStorage.removeItem('forsion_tangu_onboarding_version') })
      await win.reload(); await win.waitForSelector('.ob-flow[data-step="start"]'); await settle()
      await ready.start()
    }
    const historyEnabled = () => win.evaluate(() => window.tangu.computerHistory?.get().then((v) => v.state.enabled) ?? null)
    const setLocale = async (locale) => {
      await win.evaluate((l) => localStorage.setItem('tangu_locale', l), locale)
    }

    // ① 每个语言 × 三个尺寸,四屏各量一张
    for (const locale of ['zh', 'en']) {
      await setLocale(locale)
      for (const dimensions of [[1280, 800], [1024, 720], [900, 640]]) {
        await size(...dimensions)
        const prefix = `${locale}-${dimensions.join('x')}`
        const mustFit = dimensions[0] === 1280
        await fresh()
        for (const step of ['start', 'theme', 'you', 'team']) {
          assert.equal(await stepNow(), step)
          await ready[step]()
          await geometry(`${prefix}-${step}`, { mustFit })
          if (step !== 'team') await next()
        }
      }
    }

    // ①b 跳过引导 → 主页输入框下面再问一次电脑历史(这时电脑历史还从没动过);✕ 之后不再出。② 之前做:② 会开了又关(dataGen +1)
    await setLocale('zh'); await size(1280, 800); await fresh()
    await next(); await ready.theme(); await next(); await ready.you(); await next(); await ready.team()
    const historyOffered = await win.locator('[data-ob-history]').count() > 0
    await win.locator('.ob-skip').click(); await win.waitForSelector('.ob-flow', { state: 'detached' })
    assert.equal(await win.evaluate(() => localStorage.getItem('forsion_ch_ask')), 'pending', 'skipping the guide marks computer history as not asked')
    if (historyOffered) {
      const ask = win.locator('[data-ch-ask]')
      await ask.waitFor({ timeout: 20000 })
      await win.waitForTimeout(600)
      const placed = await ask.evaluate((el) => {
        const r = el.getBoundingClientRect(), composer = document.querySelector('.hp-composer')?.getBoundingClientRect()
        return { inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, belowComposer: !composer || r.top >= composer.bottom - 1 }
      })
      assert(placed.inView && placed.belowComposer, `home ask row sits under the composer, inside the window: ${JSON.stringify(placed)}`)
      await win.screenshot({ path: path.join(OUT, 'zh-home-ask.png') })
      await ask.locator('[data-ch-ask-enable]').click(); await win.waitForSelector('.ob-history-dialog[open] .ob-history-consent')
      await win.waitForTimeout(350)
      await win.screenshot({ path: path.join(OUT, 'zh-home-ask-consent.png') })
      await win.locator('.ob-history-dialog-foot .btn.ghost').click(); await win.waitForSelector('.ob-history-dialog[open]', { state: 'detached' })
      assert.equal(await historyEnabled(), false, 'cancelling the consent writes nothing')
      await ask.locator('[data-ch-ask-dismiss]').click(); await ask.waitFor({ state: 'detached' })
      assert.equal(await win.evaluate(() => localStorage.getItem('forsion_ch_ask')), 'dismissed')
      console.log('PASS home ask: skipping the guide → row under the composer → consent → dismissed for good')
    } else console.log('SKIP home ask row: computer history not offered on this host')
    await win.evaluate(() => localStorage.removeItem('forsion_ch_ask'))

    // ② 中文 1280×800 真走一遍,核对写进去的东西
    await setLocale('zh'); await size(1280, 800); await fresh()
    // 换屏有动效:继续 = 新屏从右滑进、旧屏替身往左滑出;返回反过来(真跑的 CSS 动画,用 animationstart 记下来)
    await win.evaluate(() => { window.__obAnims = []; document.addEventListener('animationstart', (e) => window.__obAnims.push(e.animationName), true) })
    await next(); await ready.theme()
    await win.locator('.ob3-back').click(); await win.waitForSelector('.ob-flow[data-step="start"]'); await ready.start(); await noGhost()
    // animationstart 在下一帧才派发:等它到齐再断言(到不齐 = 没动)
    const animNames = ['ob3-in-fwd', 'ob3-out-fwd', 'ob3-in-back', 'ob3-out-back']
    await win.waitForFunction((names) => names.every((n) => window.__obAnims.includes(n)), animNames, { timeout: 3000 }).catch(() => {})
    const anims = await win.evaluate(() => window.__obAnims)
    for (const name of animNames) assert(anims.includes(name), `screen change animates (${name}): ${anims.join(', ')}`)
    console.log('PASS screen changes slide: Continue forwards, Back backwards, the old screen slides out')
    assert.equal(await win.locator('[data-ob-title]').innerText(), '欢迎使用 Forsion')
    assert.equal(await win.locator('[data-ob-account]').count() + await win.locator('[data-ob-channels]').count() >= 1, true)
    assert.match(await win.locator('[data-ob-primary]').innerText(), /先不接/)
    await win.locator('[data-channel="key"]').click(); await win.waitForSelector('[data-ob-keyform]')
    await geometry('zh-start-keyform', { mustFit: true })
    await win.locator('[data-ob-keyform] button', { hasText: '返回' }).click(); await win.waitForSelector('[data-ob-keyform]', { state: 'detached' })
    await next(); await ready.theme(); await next(); await ready.you()
    // 关于你(方案 A):新装机的英文模板当空 —— 三问都是空的、占位看得见、自由框折叠着
    assert.equal(await win.locator('[data-ob-you-name]').inputValue(), '', 'the seeded template reads as empty')
    assert.equal(await win.locator('[data-ob-you] textarea').count(), 0, 'the free box starts folded')
    // 「从其他 AI 搬过来」:共用的导入入口一行,审阅单开在引导上面;单开着时背后回车不「继续」
    const impRow = win.locator('.ob3-imp [data-ai-import-row]')
    await impRow.waitFor()
    assert.match(await impRow.innerText(), /从其他 AI 搬过来[\s\S]*Claude Code、Codex/)
    await impRow.locator('[data-ai-import-open]').click()
    const sheetBox = await win.locator('.imp-sheet').boundingBox()
    assert(sheetBox, 'the import sheet opens')
    const onTop = await win.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.imp-sheet'), [sheetBox.x + sheetBox.width / 2, sheetBox.y + 30])
    assert(onTop, 'the import sheet shows above the guide')
    // 等入场动效放完再拍(半途的淡入看着像透明)
    await win.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming?.().iterations === Infinity), null, { timeout: 3000 }).catch(() => {})
    await win.screenshot({ path: path.join(OUT, 'zh-you-import-sheet.png') })
    // 焦点进单里,Tab 出不去(否则能摸到背后的「继续」)
    assert(await win.evaluate(() => !!document.activeElement?.closest('.imp-sheet')), 'focus moves into the import sheet')
    for (let i = 0; i < 14; i++) await win.keyboard.press('Tab')
    assert(await win.evaluate(() => !!document.activeElement?.closest('.imp-sheet')), 'Tab stays inside the import sheet')
    await win.evaluate(() => document.activeElement?.blur?.()); await win.keyboard.press('Enter'); await win.waitForTimeout(300)
    assert.equal(await stepNow(), 'you', 'Enter behind the open import sheet does not continue')
    await win.locator('.imp-sheet .modal-head .icon-btn').click(); await win.waitForSelector('.imp-sheet', { state: 'detached' })
    assert(await win.evaluate(() => document.activeElement?.hasAttribute('data-ai-import-open')), 'closing gives focus back to the opener')
    await win.locator('[data-ob-you-name]').fill('小鹿')
    await win.locator('[data-ob-you-work="design"]').click()
    await win.locator('[data-ob-you-work-own]').fill('独立开发一个记账 App')
    await win.locator('[data-ob-you-style="short"]').click()
    await win.locator('[data-ob-you-more]').click()
    await win.locator('[data-ob-you] textarea').fill('晚上 10 点以后别提醒我工作的事。')
    await geometry('zh-you-filled') // 自由框展开后可以滚(折叠着的缺省态在 ① 里按 mustFit 量过);底栏仍须在窗里
    await next(); await ready.team()
    assert.deepEqual(humanWrites.map((w) => [w.content, w.expectedVersion]), [['## 关于我\n- 称呼：小鹿\n- 在做：设计；独立开发一个记账 App\n- 回答：简短直接\n\n晚上 10 点以后别提醒我工作的事。\n', 'h1']],
      'About you saved once as one zh section (the seeded template replaced whole) with the version it was read at')
    const museText = await win.locator('[data-ob-muse]').innerText()
    assert(museText.includes('卜算子') && !museText.includes('Muse'), `Muse shows one name by UI language: ${museText.slice(0, 80)}`)
    // 没登录:模型行显示引擎实际会用的默认模型(桩的 defaultModelId = 第一个),不黄底、不替用户写
    assert.equal(await win.locator('[data-ob-muse-model].need').count(), 0, 'signed out with a default model: no pick is demanded')
    assert.match(await win.locator('[data-ob-muse-model] .model-select-btn').innerText(), /GPT-6 Luna · 默认/)
    assert.equal(await win.locator('[data-ob-muse-avatar] svg').count(), 0, 'Muse shows its own avatar, not a star icon')
    // 名单一行只介绍,没有开关;主动程度不问
    assert.equal(await win.locator('[data-ob-roster] [role="switch"]').count(), 0, 'the roster has no switches')
    assert.equal(await win.locator('[data-ob-muse] .ob3-q').count(), 2, 'two questions')
    // 模型行是设置页那个分组选择器:菜单 portal 到 body,引导开着时菜单层抬到引导上面(点得到 = 没被盖住)
    await win.locator('[data-ob-muse-model] .model-select-btn').click()
    await win.waitForSelector('.composer-menu--anchored')
    assert((await win.locator('.composer-menu--anchored .menu-source').count()) >= 1, 'model menu is grouped (Forsion / direct)')
    await win.waitForTimeout(300) // 菜单进场淡入放完再拍
    await win.screenshot({ path: path.join(OUT, 'zh-team-model-menu.png') })
    await win.locator('.composer-menu--anchored .menu-item', { has: win.locator('.grow', { hasText: /^Qwen local$/ }) }).click()
    await win.locator('[data-ob-muse] .ob3-pill', { hasText: '学习' }).click()
    if (historyOffered) {
      assert.match(await win.locator('[data-ob-ch-example]').innerText(), /开了之后，比如/)
      await win.waitForSelector('[data-ob-history][data-ch-draft="on"]')
      assert.equal(await historyEnabled(), false, 'the pre-switched draft is not written before Get started')
      await win.locator('[data-ob-history] .ob3-link').click(); await win.waitForSelector('.ob-history-dialog[open]')
      await win.waitForTimeout(350)
      const fits = await win.locator('.ob-history-dialog').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth })
      assert(fits, 'details dialog fits inside the window')
      await win.screenshot({ path: path.join(OUT, 'zh-team-history-details.png') })
      await win.keyboard.press('Escape'); await win.waitForSelector('.ob-history-dialog[open]', { state: 'detached' })
    } else console.log('SKIP computer history card: not offered on this host (platform / Computer Use unavailable)')
    // 写失败:停在这一屏、底栏报错,再点一次写上
    failIntro = true
    await win.locator('[data-ob-primary]').click()
    await win.waitForSelector('.ob3-foot [role="alert"]')
    assert.equal(await stepNow(), 'team', 'a failed write keeps the team screen')
    await geometry('zh-team-save-failure', { mustFit: true })
    failIntro = false
    await win.locator('[data-ob-primary]').click()
    await win.waitForSelector('.ob-flow', { state: 'detached' })
    assert.deepEqual(specialWrites.at(-1), { muse: { modelId: 'local/qwen' } })
    assert.deepEqual(introWrites, [{ focus: ['study'] }], 'only the changed question is sent; proactivity is not asked')
    assert.deepEqual(agentPatches, [], 'the guide no longer turns agents off')
    assert.equal(await win.evaluate(() => localStorage.getItem('forsion_ch_ask')), null, 'finishing the guide: Home does not ask again')
    if (historyOffered) {
      assert.equal(await historyEnabled(), true, 'Get started turns computer history on')
      const requested = await app.evaluate(() => globalThis.__permissionRequests)
      assert.deepEqual(requested, process.platform === 'darwin' ? ['computerAccessibility'] : [], 'macOS asks for Accessibility once')
      await win.evaluate(() => window.tangu.computerHistory.setEnabled(false))
    }
    assert.equal(await win.evaluate(() => localStorage.getItem('forsion_tangu_onboarding_done')), '1')
    console.log('PASS walk-through: About you, Muse model / focus, read-only roster, computer history written on Get started')

    // ③ 英文深色、窄窗、110% 缩放(用户实际用的缩放)
    await setLocale('en'); await size(1024, 720); await fresh()
    await next(); await ready.theme()
    await win.locator('[data-ob-mode] [role="tab"]').nth(1).click()
    await geometry('en-dark-theme')
    await size(390, 844); await geometry('en-narrow-theme'); await size(1024, 720)
    await next(); await ready.you()
    // 再进来:写过的那一节回填到三问(英文界面照样认中文标签),没改就不重写
    assert.equal(await win.locator('[data-ob-you-name]').inputValue(), '小鹿')
    assert.equal(await win.locator('[data-ob-you-style="short"]').getAttribute('aria-pressed'), 'true')
    assert.equal(await win.locator('[data-ob-you] textarea').inputValue(), '晚上 10 点以后别提醒我工作的事。')
    await size(390, 844); await geometry('en-narrow-you'); await size(1024, 720)
    const writesBefore = humanWrites.length
    await next(); await ready.team()
    assert.equal(humanWrites.length, writesBefore, 'About you is not rewritten when nothing changed')
    // ② 里开过又关掉(真主进程:开 → 关让 dataGen +1 并落盘):这台不再算「从没动过」,团队屏不替他预开
    if (historyOffered) await win.waitForSelector('[data-ob-history][data-ch-draft="off"]')
    await geometry('en-dark-team')
    await size(390, 844); await geometry('en-narrow-team')
    await size(900, 640); await zoom(1.1); await geometry('en-dark-zoom110-team')
    await zoom(1); await size(1024, 720)
    await win.locator('.ob3-dots button').first().click(); await ready.start(); await noGhost()
    await geometry('en-dark-start')
    await size(390, 844); await geometry('en-narrow-start'); await size(1024, 720)
    // 跳过引导不写这一屏
    const before = { intro: introWrites.length, agents: agentPatches.length }
    await win.locator('.ob-skip').click()
    await win.waitForSelector('.ob-flow', { state: 'detached' })
    assert.deepEqual({ intro: introWrites.length, agents: agentPatches.length }, before, 'skipping writes nothing')
    if (historyOffered) {
      assert.equal(await historyEnabled(), false, 'skipping leaves computer history off')
      // 电脑历史在 ② 里开过又关(动过了):跳过也不在主页再问
      await win.waitForSelector('.hp-composer', { timeout: 20000 }); await win.waitForTimeout(1200)
      assert.equal(await win.locator('[data-ch-ask]').count(), 0, 'someone who has touched computer history is not asked on Home')
    }

    // ④ 升级:上次看引导早于 2.13.8 → 完整引导、「欢迎回来」;2.13.8 及以后 → 只有「更新了什么」
    await win.evaluate(() => { localStorage.setItem('forsion_tangu_onboarding_done', '1'); localStorage.setItem('forsion_tangu_onboarding_version', '2.13.4') })
    await win.reload(); await win.waitForSelector('.ob-flow[data-mode="full"][data-step="start"]'); await settle()
    assert.equal(await win.locator('[data-ob-title]').innerText(), 'Welcome back')
    await geometry('en-dark-welcome-back')
    await win.locator('.ob-skip').click(); await win.waitForSelector('.ob-flow', { state: 'detached' })
    await win.evaluate(() => localStorage.setItem('forsion_tangu_onboarding_version', '2.13.8'))
    await win.reload(); await win.waitForSelector('.ob-flow[data-mode="update"][data-step="welcome"]'); await settle()
    await win.waitForSelector('.ob3-update .changelog-entry')
    assert.equal(await win.locator('.ob3-dots button').count(), 0, 'what changed only')
    await geometry('en-dark-update-welcome')
    await win.locator('[data-ob-primary]').click()
    await win.waitForSelector('.ob-flow', { state: 'detached' })
    assert.notEqual(await win.evaluate(() => localStorage.getItem('forsion_tangu_onboarding_version')), '2.13.8', 'finishing records the current version')
    await win.reload(); await win.waitForSelector('.shell-host')
    await win.waitForTimeout(1500)
    assert.equal(await win.locator('.ob-flow').count(), 0, 'the update guide does not come back on the next launch')
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log('PASS upgrade paths: before 2.13.8 = full guide, after = what changed only, once')

    // ④b 已登录 × 后台额度(11-09 方案 A):主进程换成「已登录」,账号额度说后台额度只计 cloud-0(GPT-6 Luna)。
    // 跟随云端 → 提示行开头带「后台额度」;菜单里它和「跟随云端 · 它」两处贴;换成别的 Forsion 模型 → 黄字 + ⚠ 点开讲额度组成
    signedIn = true
    specialConfig.muse.modelId = '' // 上一段写进去的是自己接的 Qwen local
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('auth:status')
      ipcMain.handle('auth:status', () => ({ loggedIn: true, accountId: 'acct-demo', user: { id: 'acct-demo', username: 'demo', displayName: 'Demo' } }))
      ipcMain.removeHandler('account:quota')
      ipcMain.handle('account:quota', () => ({ status: 200, json: { dailyLimit: 100, dailyRemaining: 100, weeklyLimit: 500, weeklyRemaining: 500,
        background: { sharePercent: 15, modelId: 'cloud-0', autoMain: false, dailyLimit: 15, dailyRemaining: 15, weeklyLimit: 75, weeklyRemaining: 75 } } }))
    })
    await setLocale('zh')
    await size(1280, 800)
    await win.evaluate(() => { localStorage.removeItem('forsion_tangu_onboarding_done'); localStorage.removeItem('forsion_tangu_onboarding_version') })
    await win.reload(); await win.waitForSelector('.ob-flow[data-step="start"]'); await settle()
    await win.waitForSelector('[data-ob-channels], [data-ob-account]'); await next()
    await ready.theme(); await next(); await ready.you(); await next(); await ready.team()
    const bgRow = win.locator('[data-ob-muse-model]')
    await win.waitForSelector('[data-ob-muse-model] [data-ob-bgq="counts"]')
    assert.match(await bgRow.locator('small').innerText(), /后台额度\s*AI 额度之外另送的一份，只有 GPT-6 Luna 计入/)
    assert.equal(await bgRow.locator('.model-select-btn [data-bgq-tag]').count(), 0, 'no tag inside the button (it would squeeze the model name)')
    await geometry('zh-team-bgquota', { mustFit: true })
    await bgRow.locator('.model-select-btn').click()
    await win.waitForSelector('.composer-menu--anchored')
    const tagged = await win.locator('.composer-menu--anchored .menu-item').evaluateAll((items) => items.filter((b) => b.querySelector('[data-bgq-tag]')).map((b) => b.querySelector('.grow')?.textContent))
    assert.deepEqual(tagged, ['跟随云端 · GPT-6 Luna', 'GPT-6 Luna'], `only the counted model and the follow item are tagged: ${JSON.stringify(tagged)}`)
    // 量布局宽(offsetWidth):菜单进场带缩放动画,getBoundingClientRect 会量到放到一半的宽
    const menuW = await win.locator('.composer-menu--anchored').evaluate((el) => el.offsetWidth)
    assert(menuW >= 320, `model menu at least 320 wide (${menuW})`)
    await win.waitForTimeout(300)
    await win.screenshot({ path: path.join(OUT, 'zh-team-bgquota-menu.png') })
    await win.locator('.composer-menu--anchored .menu-item', { has: win.locator('.grow', { hasText: /^Claude Sonnet 4\.6$/ }) }).click()
    await win.waitForSelector('[data-ob-muse-model] [data-ob-bgq="other"]')
    assert.match(await bgRow.locator('small').innerText(), /Claude Sonnet 4\.6 不计入后台额度，用的是 AI 额度/)
    await bgRow.locator('[data-ob-quota-info]').click()
    const pop = win.locator('[data-ob-quota-pop]')
    await pop.waitFor()
    await win.waitForTimeout(300)
    const popText = await pop.innerText()
    assert(popText.includes('AI 额度的 15%') && popText.includes('只在卜算子和自动化用 GPT-6 Luna 时扣') && popText.includes('从 AI 额度转入') && popText.includes('额度与积分'), `quota details: ${popText}`)
    const popFits = await pop.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth })
    assert(popFits, 'quota details fit inside the window')
    await win.screenshot({ path: path.join(OUT, 'zh-team-bgquota-details.png') })
    // 同一屏切到浅色再拍一张(只改根上的明暗属性,和方案页出图同一个做法;拍完还原)
    const mode0 = await win.evaluate(() => { const r = document.documentElement; const m = { mode: r.dataset.mode, dark: r.classList.contains('dark') }; r.dataset.mode = 'light'; r.classList.remove('dark'); return m })
    await win.waitForTimeout(200)
    await win.screenshot({ path: path.join(OUT, 'zh-team-bgquota-details-light.png') })
    await win.evaluate((m) => { const r = document.documentElement; if (m.mode) r.dataset.mode = m.mode; else delete r.dataset.mode; r.classList.toggle('dark', m.dark) }, mode0)
    await win.keyboard.press('Escape')
    await pop.waitFor({ state: 'detached' })
    await win.locator('[data-ob-primary]').click()
    await win.waitForSelector('.ob-flow', { state: 'detached' })
    assert.deepEqual(specialWrites.at(-1), { muse: { modelId: 'cloud-1' } })
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log('PASS signed in: background quota tagged on the counted model; another model warns and explains the quota')

    // ⑤ 设置 → 常规设置 → 本机运行环境:这个子页必须真的存在,且工具清单排在最前
    await win.locator('.ntf-close').evaluateAll((bs) => bs.forEach((b) => b.click())).catch(() => {})
    const opened = app.waitForEvent('window')
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma')
    const settings = await opened
    await settings.waitForLoadState('domcontentloaded')
    await settings.waitForSelector('.settings-main', { timeout: 30000 })
    const nav = settings.locator('.settings-nav')
    const runtimeLabel = await settings.evaluate(() => document.documentElement.lang?.startsWith('zh') ? '本机运行环境' : 'Local runtime')
    let entry = nav.getByRole('button', { name: runtimeLabel, exact: true })
    if (!(await entry.count())) await nav.getByRole('button', { name: /^(常规设置|General)$/ }).first().click()
    entry = nav.getByRole('button', { name: runtimeLabel, exact: true })
    await entry.first().click()
    await settings.waitForSelector('.settings-tools-panel .env-probe-row', { timeout: 30000 })
    const layout = await settings.evaluate(() => {
      const panels = [...document.querySelectorAll('.settings-sub .settings-panel')]
      return { first: panels[0]?.classList.contains('settings-tools-panel'), rows: document.querySelectorAll('.settings-tools-panel .env-probe-row').length,
        connProbe: !!document.querySelector('.settings-runtime-panel .env-probe') }
    })
    assert(layout.first && layout.rows >= 5 && !layout.connProbe, `settings runtime page: ${JSON.stringify(layout)}`)
    await settings.screenshot({ path: path.join(OUT, 'settings-runtime.png') })
    console.log(`PASS settings → general → ${runtimeLabel}: tools panel first (${layout.rows} rows)`)
    // 设置 → 模型 → 默认模型 → 后台任务:同一个选择器、同一个标签(引导里那个就是它)
    let defaults = nav.getByRole('button', { name: /^(默认模型|Default models)$/ })
    if (!(await defaults.count())) await nav.getByRole('button', { name: /^(模型|Models)$/ }).first().click()
    defaults = nav.getByRole('button', { name: /^(默认模型|Default models)$/ })
    await defaults.first().click()
    const bgSlot = settings.locator('.model-select-btn[aria-label="后台任务"], .model-select-btn[aria-label="Background tasks"]')
    await bgSlot.waitFor({ timeout: 30000 })
    await settings.waitForFunction(() => { const b = document.querySelector('.model-select-btn[aria-label="后台任务"], .model-select-btn[aria-label="Background tasks"]'); return !!b && !b.disabled }, null, { timeout: 30000 })
    await bgSlot.click()
    await settings.waitForSelector('.composer-menu--anchored')
    const slotTagged = await settings.locator('.composer-menu--anchored .menu-item').evaluateAll((items) => items.filter((b) => b.querySelector('[data-bgq-tag]')).map((b) => b.querySelector('.grow')?.textContent))
    assert.equal(slotTagged.length, 2, `settings background slot: follow item + GPT-6 Luna tagged: ${JSON.stringify(slotTagged)}`)
    assert(slotTagged.every((n) => /GPT-6 Luna$/.test(n || '')), JSON.stringify(slotTagged))
    await settings.waitForTimeout(300)
    await settings.screenshot({ path: path.join(OUT, 'settings-background-slot-menu.png') })
    await settings.keyboard.press('Escape')
    console.log('PASS settings → models → default models: the background slot tags the same model')
    const scrolled = results.filter((r) => r.scrolls).map((r) => r.name)
    console.log(`PASS finish + persistence + no renderer errors; ${results.length} layout cases${scrolled.length ? `; scroll inside the screen: ${scrolled.join(', ')}` : ''}`)
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
    if (app) await app.close().catch(() => {})
    await stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
