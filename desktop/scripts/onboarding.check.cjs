/**
 * Real Electron, isolated home + stub model catalog. No login or permission grants.
 * 电脑历史那一页连的是真主进程:PI_CU_SOCKET_PATH 指到一个不存在的 socket,主进程把它当外部助手,连不上只落 disconnected,
 * 绝不去拉起这台机器上真的 Computer Use 助手(不设这个变量,开关一开就会拉)。
 * 本机没有那一页(非 macOS / Windows,或产品不带 Computer Use)时,相关断言整段跳过并打一行 SKIP。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const ROOT = path.join(__dirname, '..')
const APP_ROOT = process.env.FORSION_APP_ROOT || ROOT
const OUT = process.env.ONBOARDING_SHOTS || '/tmp/forsion-onboarding-review'
const results = []
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-onboarding-'))
  const models = [
    ...Array.from({ length: 14 }, (_, i) => ({ id: `cloud-${i}`, name: ['GPT-5.4', 'Claude Sonnet 4.6', 'Gemini 3.1 Pro', 'Qwen 3.5', 'DeepSeek V3.2', 'GPT-5 mini'][i % 6] + (i > 5 ? ` · ${i}` : ''),
      provider: i < 7 ? 'OpenAI' : 'Anthropic', source: 'forsion', groupId: i < 7 ? 'daily' : 'reasoning', groupName: i < 7 ? '日常对话 / Everyday' : '深入思考 / Reasoning', groupSortOrder: i < 7 ? 0 : 1, modelType: 'llm' })),
    { id: 'local/qwen', name: 'Qwen local', provider: 'Ollama', source: 'direct', modelType: 'llm' },
    { id: 'local/hidden', name: 'Hidden model', provider: 'Ollama', source: 'direct', modelType: 'llm' },
    { id: 'image', name: 'Image-only model', provider: 'Image', source: 'forsion', modelType: 'image_gen' },
  ]
  const specialConfig = {
    historian: { enabled: true, modelId: 'history-model', everyRounds: 7, firstRoundTrigger: true, autoEmoji: false, mode: 'independent', prompt: 'Keep this prompt', harnessCandidates: true },
    muse: { enabled: true, modelId: 'muse-model', restartWindowHours: 1, maxRestartsPerWindow: 3, maxIterationsPerCycle: 20, maxTodosPerWindow: 5,
      supervisorPollMinutes: 5, activeHours: { start: 9, end: 17 }, allowedFolders: ['/my/project'], mode: 'ask', heartbeatMinutes: 120, notify: 'digest', escalateTo: '' },
  }
  const originalConfig = structuredClone(specialConfig)
  const specialWrites = []
  let failSpecialSave = false
  const stub = await startStubEngine({ models, override: async ({ path: p, method, body }) => {
    if (p !== '/agent/special/config') return undefined
    if (method === 'POST') {
      const patch = await body(); specialWrites.push(patch)
      if (failSpecialSave) return { __code: 503, body: { error: 'simulated save failure' } }
      if (patch.historian) Object.assign(specialConfig.historian, patch.historian)
      if (patch.muse) Object.assign(specialConfig.muse, patch.muse)
    }
    return { config: specialConfig }
  } })
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', APP_ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_CLOUD_URL: stub.url, PI_CU_SOCKET_PATH: path.join(home, 'no-helper.sock') }, timeout: 45000 })
    const win = await app.firstWindow()
    win.setDefaultTimeout(15000)
    await win.waitForSelector('.ob-flow')
    const errors = []
    win.on('pageerror', (e) => errors.push(e.message))
    await win.evaluate(() => localStorage.setItem('forsion_model_picker_v1', JSON.stringify({ groups: [{ id: 'local', name: '本机模型 / Local' }], assignments: { 'local/qwen': 'local' }, hidden: ['local/hidden'] })))
    await win.reload()
    await win.waitForSelector('.ob-flow')
    async function size(width, height) {
      await app.evaluate(({ BrowserWindow }, dimensions) => { const w = BrowserWindow.getAllWindows().find((w) => w.isVisible()); w.setMinimumSize(360, 400); w.setContentSize(...dimensions) }, [width, height])
    }
    async function geometry(name, screenshot = true) {
      // Let the compositor present the entered step before reviewing its colors/text.
      await win.waitForTimeout(350)
      // 入场动效在标题和内容的子元素上(逐项滑入):整棵子树都收尾再量,否则量到的是滑到一半的位置。循环播放的(转圈、状态点)收不了尾,跳过。
      await win.locator('.ob-stage').evaluate((el) => el.getAnimations({ subtree: true }).forEach((a) => { try { a.finish() } catch { /* infinite */ } }))
      const state = await win.evaluate(() => {
        const shell = document.querySelector('.ob-flow'), content = document.querySelector('.ob-content'), footer = document.querySelector('.ob-footer')
        const r = footer.getBoundingClientRect()
        // 真应用里(子元素的滑入 translate 在合成线程上跑)动效收尾之后,.ob-content 记着的滚动范围可能还是滑到一半时的:
        // 实测多 2~4px,落在哪一步不固定,等动效自己播完也一样;这时没有任何元素越界(逐个量过 getBoundingClientRect),
        // 随便动一下样式它就归零。所以先把第一层挪 1px 再放回,让它按现在的排版重算,再量 —— 重算前后差多少记进 staleBy,
        // 真溢出不会被这一下抹掉(挪回原位之后该多宽还是多宽)。
        const rawW = content.scrollWidth, rawH = content.scrollHeight
        for (const c of content.children) { c.style.translate = '-1px 0'; void content.scrollWidth; c.style.translate = '' }
        const scrollW = content.scrollWidth, scrollH = content.scrollHeight
        // 横向溢出时直接点名是谁撑出去的:逐层把子元素整个挪到左边界外,挪走就不溢出的那个往里走(伪元素、溢出的文字也能定位到它的主人)。
        // 用 transform 挪而不是 display:none —— 后者改排版(网格会重排),放回来还会把 CSS 动效重播一遍,量到的就不是原样了。
        const over = () => content.scrollWidth > content.clientWidth + 1
        let wide
        if (over()) {
          const edge = content.getBoundingClientRect().right
          const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className?.baseVal ?? el.className).trim().replace(/\s+/g, '.')}`
          const unfinished = content.getAnimations({ subtree: true }).filter((x) => x.playState !== 'finished').map((x) => `${x.animationName ?? x.transitionProperty}:${x.playState}@${name(x.effect?.target ?? content)}${x.effect?.pseudoElement ?? ''}`)
          let node = content
          for (;;) {
            const culprit = [...node.children].find((c) => { const d = c.style.transform, tr = c.style.transition; c.style.transition = 'none'; c.style.transform = 'translateX(-99999px)'; const fixed = !over(); c.style.transform = d; void c.offsetWidth; c.style.transition = tr; return fixed })
            if (!culprit) break
            node = culprit
          }
          const cs = getComputedStyle(node), pseudo = (which) => { const ps = getComputedStyle(node, which); return ps.content === 'none' ? undefined : `${which} ${ps.position} inset ${ps.inset} w ${ps.width} translate ${ps.translate} transform ${ps.transform}` }
          wide = { el: name(node), past: Math.round((node.getBoundingClientRect().right - edge) * 10) / 10, own: node.scrollWidth - node.clientWidth,
            translate: cs.translate, transform: cs.transform, whiteSpace: cs.whiteSpace, text: node.children.length ? undefined : node.textContent.slice(0, 40),
            before: pseudo('::before'), after: pseudo('::after'), unfinished, fonts: document.fonts.status }
        }
        return { step: shell.dataset.step, contentH: content.clientHeight, scrollH, contentW: content.clientWidth, scrollW,
          staleBy: rawW !== scrollW || rawH !== scrollH ? [rawW - scrollW, rawH - scrollH] : undefined,
          footerVisible: r.bottom <= innerHeight + 1 && r.top >= 0, shellOverflow: shell.scrollWidth > shell.clientWidth + 1, wide }
      })
      if (screenshot) await win.screenshot({ path: path.join(OUT, `${name}.png`) })
      results.push({ name, ...state })
      assert(state.footerVisible, `${name}: footer outside viewport`)
      assert(!state.shellOverflow && state.scrollW <= state.contentW + 1, `${name}: horizontal overflow ${JSON.stringify(state)}`)
      assert(state.scrollH <= state.contentH + 1, `${name}: page needs scrolling ${JSON.stringify(state)}`)
      console.log(`PASS ${name} (${state.contentH}px, no page scroll${state.staleBy ? `; stale scroll extent +${state.staleBy.join('/+')}px recomputed` : ''})`)
    }
    async function move(button) {
      const previous = await win.locator('.ob-flow').getAttribute('data-step')
      await button.click()
      await win.waitForFunction((step) => document.querySelector('.ob-flow')?.getAttribute('data-step') !== step, previous)
    }
    const next = () => move(win.locator('.ob-footer .btn.primary'))
    const prev = () => move(win.locator('.ob-footer .btn.ghost').first())
    // 权限那一步的分页按名字找:有几页取决于这台电脑(操作电脑 / 电脑历史不一定有)。
    const tab = (name) => win.locator('.ob-sections button').filter({ hasText: name })
    const TAB = { history: /^(电脑历史|Computer history)$/, media: /^(语音与媒体|Voice and media)$/ }
    const historyEnabled = () => win.evaluate(() => window.tangu.computerHistory?.get().then((v) => v.state.enabled) ?? null)
    const historySwitch = win.getByRole('switch', { name: /^(记录电脑历史|Record computer history)$/ })
    let historySeen = false
    /** 走到权限那一步之后:等分页条画出来(进这一步时要先读一次设备权限快照)。没有这一步返回 false。 */
    async function atPermissions() {
      if (!(await win.locator('.ob-flow[data-step="permissions"]').count())) return false
      await win.waitForSelector('.ob-sections button')
      return true
    }
    async function openHistory() {
      if (!(await tab(TAB.history).count())) return false
      await tab(TAB.history).click()
      await win.waitForSelector('.ob-history')
      // macOS 那一行授权状态是另一次 IPC 读回来的,等它画出来再量
      if (process.platform === 'darwin') await win.waitForSelector('.ob-history [data-permission="computerAccessibility"]')
      historySeen = true
      return true
    }
    for (const locale of ['zh', 'en']) {
      await win.locator('.locale-seg button').nth(locale === 'zh' ? 0 : 1).click()
      for (const dimensions of [[1280, 800], [1024, 720], [900, 640]]) {
        await size(...dimensions)
        const prefix = `${locale}-${dimensions.join('x')}`
        await win.evaluate(() => { localStorage.removeItem('forsion_tangu_onboarding_done'); localStorage.removeItem('forsion_tangu_onboarding_version') })
        await win.reload(); await win.waitForSelector('.ob-flow')
        await geometry(`${prefix}-welcome`)
        await next(); await geometry(`${prefix}-connect`)
        await win.locator('.ob-connect-option').last().click(); await geometry(`${prefix}-byok`)
        await next(); await win.waitForSelector('.ob-model-choice')
        await geometry(`${prefix}-models`)
        assert.equal(await win.locator('.ob-model-groups button').count(), 4)
        await win.locator('.ob-model-groups button').last().click()
        assert.equal(await win.locator('.ob-model-option').count(), 1)
        assert.match(await win.locator('.ob-model-option').innerText(), /Qwen local/)
        await win.locator('.ob-model-option').click()
        await win.locator('.ob-model-search input').fill('does-not-exist')
        assert.equal(await win.locator('.ob-model-option').count(), 0)
        assert.match(await win.locator('.ob-model-selection').innerText(), /Qwen local/)
        await win.locator('.ob-model-search input').fill('')
        await next()
        assert.equal(await win.evaluate(() => window.tangu.getConfig().then((c) => c.modelId)), 'local/qwen')
        await geometry(`${prefix}-appearance`)
        await win.locator('.ob-sections button').nth(1).click(); await geometry(`${prefix}-colors`)
        await win.locator('.ob-sections button').nth(2).click(); await geometry(`${prefix}-font`)
        await next(); await geometry(`${prefix}-workspace`)
        await next()
        // 本机环境:探测是真跑 node/git/docker --version,等行出来再量 —— 量「检测中…」空态会假绿。
        await win.waitForSelector('.ob-env-tools .env-probe-row')
        assert((await win.locator('.env-probe-row').count()) >= 5, 'env step lists the probed tools')
        await geometry(`${prefix}-env`)
        if (locale === 'zh' && dimensions[0] === 1280) {
          // 换源即存盘,再重挂检测区(安装命令按检测时的源生成);存盘前选中态不许先翻过去。
          const china = win.locator('.ob-env-option').nth(1)
          await china.click()
          await win.waitForFunction(() => document.querySelectorAll('.ob-env-option')[1]?.getAttribute('aria-checked') === 'true')
          assert.equal(await win.evaluate(() => window.tangu.getConfig().then((c) => c.mirror)), 'china')
          await win.waitForSelector('.ob-env-tools .env-probe-row')
          await geometry(`${prefix}-env-china`)
          await win.locator('.ob-env-option').first().click()
          await win.waitForFunction(() => document.querySelectorAll('.ob-env-option')[0]?.getAttribute('aria-checked') === 'true')
          assert.equal(await win.evaluate(() => window.tangu.getConfig().then((c) => c.mirror)), 'default')
        }
        // 后台 Agent 排在权限前一步(Muse 的开关和电脑历史前后挨着)。
        await next()
        await win.waitForSelector('.ob-background-layout[aria-busy="false"]')
        await geometry(`${prefix}-background`)
        const historian = win.getByRole('switch', { name: 'Historian', exact: true })
        const muse = win.getByRole('switch', { name: 'Muse', exact: true })
        if (locale === 'zh' && dimensions[0] === 1280) {
          assert.equal(await historian.getAttribute('aria-checked'), 'true')
          assert.equal(await muse.getAttribute('aria-checked'), 'true')
          failSpecialSave = true
          await historian.click(); await win.waitForSelector('.ob-background-error')
          assert.equal(await historian.getAttribute('aria-checked'), 'true', 'failed save retains the current choice')
          await geometry(`${prefix}-background-save-failure`)
          failSpecialSave = false
          await historian.click(); await win.waitForFunction(() => document.querySelector('[aria-label="Historian"][role="switch"]')?.getAttribute('aria-checked') === 'false')
          await muse.click(); await win.waitForFunction(() => document.querySelector('[aria-label="Muse"][role="switch"]')?.getAttribute('aria-checked') === 'false')
          assert.deepEqual(specialWrites, [{ historian: { enabled: false } }, { historian: { enabled: false } }, { muse: { enabled: false } }])
          assert.deepEqual(specialConfig.historian, { ...originalConfig.historian, enabled: false })
          assert.deepEqual(specialConfig.muse, { ...originalConfig.muse, enabled: false })
          await geometry(`${prefix}-background-disabled`)
        } else {
          assert.equal(await historian.getAttribute('aria-checked'), 'false', 're-entering preserves Historian opt-out')
          assert.equal(await muse.getAttribute('aria-checked'), 'false', 're-entering preserves Muse opt-out')
        }
        await next()
        if (await atPermissions()) {
          await win.waitForSelector('.desktop-permissions-section')
          await geometry(`${prefix}-permissions`)
          if (await openHistory()) {
            assert.equal(await historySwitch.getAttribute('aria-checked'), 'false', 'computer history is off by default')
            await geometry(`${prefix}-history`)
            if (locale === 'zh' && dimensions[0] === 1280) {
              // 拨开关先弹同意说明;这时还没开。取消 → 仍然关。
              await historySwitch.click()
              await win.waitForSelector('.ob-history-dialog[open]')
              await win.waitForTimeout(450)
              await win.screenshot({ path: path.join(OUT, `${prefix}-history-consent.png`) })
              const fits = await win.locator('.ob-history-dialog').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth })
              assert(fits, 'consent dialog fits inside the window')
              assert.equal(await historyEnabled(), false, 'opening the consent dialog does not enable recording')
              await win.locator('.ob-history-dialog .btn.ghost').click()
              await win.waitForSelector('.ob-history-dialog[open]', { state: 'detached' })
              assert.equal(await historyEnabled(), false, 'cancel leaves it off')
              // 确认才开:真主进程落配置;助手连不上(假 socket)→ 如实显示成没在录的状态,开关没有假装成功。
              await historySwitch.click()
              await win.locator('.ob-history-dialog .btn.primary').click()
              await win.waitForFunction(() => { const el = document.querySelector('.ob-history'); return el && el.dataset.chStatus !== 'off' })
              assert.equal(await historyEnabled(), true, 'confirming turns it on')
              const shown = await win.locator('.ob-history').getAttribute('data-ch-status')
              assert.notEqual(shown, 'recording', `no helper is reachable, so the status must not claim recording (got ${shown})`)
              await geometry(`${prefix}-history-enabled-${shown}`)
              // 再关掉:不需要确认,后面的几轮都从「关」开始。
              await historySwitch.click()
              await win.waitForFunction(() => document.querySelector('.ob-history')?.dataset.chStatus === 'off')
              assert.equal(await historyEnabled(), false)
            }
          }
          await tab(TAB.media).click(); await win.waitForSelector('[data-permission="microphone"]'); await geometry(`${prefix}-media`)
          await next()
        }
        await geometry(`${prefix}-done`)
        // 完成页列出后台 Agent 和电脑历史此刻的状态
        const rows = await win.locator('.ob-summary button').allInnerTexts()
        assert(rows.some((r) => /Historian/.test(r)), `done page lists background agents: ${JSON.stringify(rows)}`)
        if (historySeen) assert(rows.some((r) => /电脑历史|Computer history/.test(r)), `done page lists computer history: ${JSON.stringify(rows)}`)
      }
    }
    if (!historySeen) console.log('SKIP computer history page: not offered on this host (platform / Computer Use unavailable)')
    else assert.equal(await historyEnabled(), false, 'walking the guide without confirming leaves computer history off')
    // Dark mode, narrow responsive surface and the 110% UI zoom the product is actually used at, through the real preference path.
    const narrow = async (name) => { await size(390, 844); await geometry(name); await size(1024, 720) }
    await size(1024, 720)
    await win.reload(); await win.waitForSelector('.ob-flow'); await next(); await next(); await win.waitForSelector('.ob-model-choice'); await next()
    await win.locator('.ob-sections button').first().click()
    await win.locator('.ob-appearance-options .seg button').nth(1).click()
    await geometry('en-dark-appearance')
    await narrow('en-narrow-appearance')
    await prev(); await win.waitForSelector('.ob-model-choice'); await geometry('en-dark-models')
    await narrow('en-narrow-models')
    await win.locator('.ob-model-default').click(); await next()
    assert.equal(await win.evaluate(() => window.tangu.getConfig().then((c) => c.modelId)), '')
    await next(); await next()
    await win.waitForSelector('.ob-env-tools .env-probe-row')
    await narrow('en-narrow-env')
    await next(); await win.waitForSelector('.ob-background-layout[aria-busy="false"]'); await geometry('en-dark-background')
    await narrow('en-narrow-background')
    await next()
    if (await atPermissions()) {
      if (await openHistory()) {
        await geometry('en-dark-history')
        await narrow('en-narrow-history')
        // 900×640 配 110% 界面缩放(= 818×582 的 CSS 视口):这一页最挤的情形,不许整页滚动。
        const zoom = (factor) => app.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows().find((w) => w.isVisible()).webContents.setZoomFactor(f), factor)
        await size(900, 640); await zoom(1.1)
        await geometry('en-dark-zoom110-history')
        await prev(); await win.waitForSelector('.ob-background-layout[aria-busy="false"]'); await geometry('en-dark-zoom110-background')
        await next(); await atPermissions(); await openHistory()
        await zoom(1); await size(1024, 720)
        await historySwitch.click(); await win.waitForSelector('.ob-history-dialog[open]'); await win.waitForTimeout(450)
        await win.screenshot({ path: path.join(OUT, 'en-dark-history-consent.png') })
        await win.keyboard.press('Escape')
        await win.waitForSelector('.ob-history-dialog[open]', { state: 'detached' })
        assert.equal(await historyEnabled(), false, 'Escape closes the consent dialog without enabling')
      }
      await next()
    }
    // 完成页的一行点回去改(回到电脑历史那一页),再回来。
    if (historySeen) {
      await move(win.locator('.ob-summary button').filter({ hasText: /Computer history/ }))
      assert.equal(await win.locator('.ob-sections button.active').innerText(), 'Computer history')
      // 回头看完,从左栏直接回到已经到过的最后一页(不用把「下一步」重点一遍);没到过的步骤才不能跳。
      await move(win.locator('button.ob-progress-item').last())
      assert.equal(await win.locator('.ob-flow').getAttribute('data-step'), 'done', 'the rail jumps ahead to a step already reached')
    }
    await geometry('en-dark-done')
    await next()
    await win.waitForSelector('.ob-flow', { state: 'detached' })
    assert.equal(await win.evaluate(() => localStorage.getItem('forsion_tangu_onboarding_done')), '1')
    assert.equal(specialConfig.historian.enabled, false)
    assert.equal(specialConfig.muse.enabled, false)
    assert.equal(specialWrites.length, 3, 'reopening never writes enable defaults over opt-outs')
    assert.equal(errors.length, 0, errors.join('\n'))
    if (historySeen) assert.equal(await historyEnabled(), false, 'finishing the guide leaves computer history off')
    // 版本更新后再进来:走过引导的人只看「更新了什么」+ 上次之后新增的那一步(电脑历史),没有完成页。
    await win.evaluate(() => localStorage.setItem('forsion_tangu_onboarding_version', '2.0.0'))
    await win.reload(); await win.waitForSelector('.ob-flow[data-mode="update"]')
    await win.waitForSelector('.ob-update-notes .changelog-entry')
    await geometry('en-dark-update-welcome')
    const railItems = await win.locator('.ob-progress-item').count()
    assert.equal(railItems, historySeen ? 2 : 1, 'update guide lists only what is new')
    if (historySeen) {
      await next(); await atPermissions()
      await win.waitForSelector('.ob-history')
      assert.equal(await win.locator('.ob-sections button.active').innerText(), 'Computer history', 'update guide opens on the new page')
      await geometry('en-dark-update-history')
    }
    await win.locator('.ob-footer .btn.primary').click()
    await win.waitForSelector('.ob-flow', { state: 'detached' })
    assert.notEqual(await win.evaluate(() => localStorage.getItem('forsion_tangu_onboarding_version')), '2.0.0', 'finishing records the current version')
    await win.reload(); await win.waitForSelector('.shell-host')
    await win.waitForTimeout(1500)
    assert.equal(await win.locator('.ob-flow').count(), 0, 'the update guide does not come back on the next launch')
    assert.equal(errors.length, 0, errors.join('\n'))
    console.log('PASS update guide: what changed + the new step only, once')
    // 完成页指向「设置 → 常规设置 → 本机运行环境」:这个子页必须真的存在,且工具清单排在最前(2.11.4 埋在「连接」页底部没人找得到)。
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
    console.log(`PASS finish + persistence + no renderer errors; ${results.length} layout cases`)
  } finally {
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2))
    if (app) await app.close().catch(() => {})
    await stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
