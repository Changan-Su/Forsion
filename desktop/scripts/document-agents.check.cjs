// Page instructions + @Agent tasks + slash AI capsules, against the real v4 editor.
// The Tangu seam is a fake: this proves UI, CAS save and dispatch ordering, not model behavior.
// Freeze frontend writes while running (Vite HMR invalidates in-flight observations).
// HARNESS_URL=http://localhost:5268/harness.html node scripts/e2e-editor.cjs --check=document-agents
const fs = require('fs')
const os = require('os')
const path = require('path')
const { chromium } = require('playwright-core')

const URL = process.env.HARNESS_URL || 'http://localhost:5268/harness.html'
const OUT = process.env.DOCUMENT_AGENT_SHOTS || '/private/tmp/forsion-document-agents-ui'
const PM = '.unified-body .ProseMirror'
const results = []
const errors = []
fs.mkdirSync(OUT, { recursive: true })

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const entry of fs.readdirSync(root).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const exe = path.join(root, entry, 'chrome-mac-arm64', app)
      if (fs.existsSync(exe)) return exe
    }
  }
  throw new Error('Chromium not found; set CHROMIUM_EXE')
}

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const fence = (kind, body) => `\`\`\`forsion-${kind}\n${typeof body === 'string' ? body : JSON.stringify(body)}\n\`\`\``
const task = (id = 'task-1', extra = {}) => fence('task', { v: 1, id, agent: 'researcher', prompt: 'Summarize this page with sources.', ...extra })

async function installProbe(page) {
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((entry) => entry.name).find((name) => /\/src\/amadeus\/plugins\/tanguSeam\.ts(\?|$)/.test(name))
    const seam = await import(url || '/src/amadeus/plugins/tanguSeam.ts')
    window.__documentAgent = { calls: [], runs: [], drafts: [], opens: [], inline: [], events: [], hold: false, release: null, serial: 0, hostExecution: true }
    const state = window.__documentAgent
    state.agents = new URLSearchParams(location.search).has('uemptyagents') ? [] : [{ slug: 'researcher', name: 'Researcher' }, { slug: 'writer', name: 'Writer' }]
    state.rosterListeners = new Set()
    window.addEventListener('tangu:open-session', (event) => state.opens.push(event.detail))
    seam.setTanguProbe({
      activeModel: () => ({ id: 'fake-model', name: 'Harness model' }),
      models: () => [{ id: 'fake-model', name: 'Harness model' }], activeSpace: () => 'amadeus', subscribe: () => () => {},
      hostExecution: () => state.hostExecution,
      agents: () => state.agents,
      subscribeAgents: (callback) => { state.rosterListeners.add(callback); return () => state.rosterListeners.delete(callback) },
      agentStatus: (sessionId) => ({ phase: 'idle', sessionId, runId: null, since: 0, textChars: 0, reasoningChars: 0 }),
      subscribeAgentStatus: (callback, sessionId) => { state.status = { callback, sessionId }; return () => { state.status = null } },
      askInChat: () => {},
      startChat: async (options) => { state.drafts.push(options); return { ok: true } },
      openDocumentTask: (sessionId) => state.opens.push(sessionId),
      complete: async (request) => { state.inline.push(request); return { text: 'Improved prose.', toolCallText: false } },
      submitDocumentTask: async (options) => {
        const sessionId = `document-session-${++state.serial}`
        state.calls.push({ key: options.key, agent: options.agent, prompt: options.prompt, vaultRoot: options.vaultRoot, sessionId })
        state.events.push('create')
        if (state.hold) await new Promise((resolve) => { state.release = resolve })
        if (!options.alive()) { state.events.push('cancelled'); return { ok: false, error: 'Source became inactive' } }
        try {
          await options.onCreated(sessionId)
          const saved = window.__upage.vault.get('Unified.md') || ''
          const bound = new RegExp(`"sessionId"\\s*:\\s*"${sessionId}"`).test(saved)
          state.events.push(bound ? 'bound-on-disk' : 'binding-not-saved')
          if (!bound) throw new Error('Session association was not persisted before dispatch')
          if (!options.alive()) { state.events.push('cancelled'); return { ok: false, sessionId, error: 'Source became inactive' } }
          state.runs.push({ sessionId, prompt: options.prompt, saved })
          state.events.push('run')
          return { ok: true, sessionId }
        } catch (error) {
          state.events.push('save-failed')
          return { ok: false, error: String(error?.message || error) }
        }
      },
    })
    window.__upage.pageStore.setState({ vaultRoot: '/harness-vault', vaultSide: 'local' })
    window.__upage.switchFile('Probe-remount.md', '# Probe remount\n')
  })
  await page.waitForTimeout(100)
  await page.evaluate(() => window.__upage.switchFile('Unified.md'))
  await page.waitForSelector(PM)
  await page.waitForTimeout(200)
}

async function open(browser, markdown, flags = '', width = 1200) {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width, height: 900 } })
  page.setDefaultTimeout(8000)
  page.on('pageerror', (error) => { errors.push(error.message); console.log('[pageerror]', error.message) })
  await page.addInitScript(() => performance.setResourceTimingBufferSize(100000))
  await page.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(markdown)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector(PM, { timeout: 120000 })
  await installProbe(page)
  return page
}

async function flush(page) {
  await page.waitForFunction(() => !!window.__upage.lifecycle)
  await page.evaluate(() => window.__upage.lifecycle.flushUnifiedPath('Unified.md', true))
}
const disk = (page) => page.evaluate(() => window.__upage.vault.get('Unified.md'))
const activity = (page) => page.evaluate(() => ({ calls: window.__documentAgent.calls, runs: window.__documentAgent.runs, drafts: window.__documentAgent.drafts, opens: window.__documentAgent.opens, inline: window.__documentAgent.inline, events: window.__documentAgent.events }))

async function screenshot(page, name, fullPage = true) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage })
}
async function scenario(browser, name, run) {
  const pages = []
  const make = async (...args) => { const page = await open(browser, ...args); pages.push(page); return page }
  try { await run(make) } catch (error) {
    check(name, false, String(error?.stack || error))
    for (let index = 0; index < pages.length; index++) if (!pages[index].isClosed()) await screenshot(pages[index], `failure-${name}-${index}`).catch(() => {})
  } finally { for (const page of pages) await page.close() }
}
async function endOfPage(page, newLine = true) {
  await page.evaluate(() => {
    const view = window.__upage.probe.view()
    view.focus()
    view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.atEnd(view.state.doc)))
  })
  if (newLine) await page.keyboard.press('Enter')
}
async function openSlash(page, text = '/ai') {
  await endOfPage(page)
  await page.keyboard.type(text, { delay: 25 })
  await page.waitForSelector('.slash-menu')
}
const slashActive = (page) => page.evaluate(() => {
  const menu = document.querySelector('.slash-menu')
  const selected = menu?.querySelector('[role="menuitem"][data-active]:not([data-active="false"]), [role="menuitem"].active')
  const capsules = [...(menu?.querySelectorAll('.slash-ai-capsule') || [])]
  return { index: capsules.indexOf(selected), text: selected?.textContent || '', count: capsules.length, inGroup: !!selected?.closest('.slash-ai-capsules') }
})

async function selectText(page, text) {
  const point = await page.evaluate(({ PM, text }) => {
    const walk = document.createTreeWalker(document.querySelector(PM), NodeFilter.SHOW_TEXT)
    let node
    while ((node = walk.nextNode())) {
      const at = node.data.indexOf(text)
      if (at < 0 || node.parentElement?.closest('textarea,pre,.unified-embed')) continue
      const start = document.createRange(), end = document.createRange()
      start.setStart(node, at); start.setEnd(node, at + 1)
      end.setStart(node, at + text.length - 1); end.setEnd(node, at + text.length)
      const a = start.getBoundingClientRect(), b = end.getBoundingClientRect()
      return { x1: a.left + 1, x2: b.right - 1, y: a.top + a.height / 2 }
    }
    return null
  }, { PM, text })
  if (!point) throw new Error(`Text not found: ${text}`)
  await page.mouse.move(point.x1, point.y); await page.mouse.down()
  await page.mouse.move(point.x2, point.y, { steps: 6 }); await page.mouse.up()
  await page.waitForSelector('[data-testid="inline-toolbar"]')
}

async function slashScenarios(browser) {
  await scenario(browser, 'slash-navigation', async (openPage) => {
    const page = await openPage('# AI commands\n\nPreserve this paragraph.\n')
    await openSlash(page)
    const first = await slashActive(page)
    await page.keyboard.press('ArrowLeft')
    const last = await slashActive(page)
    await page.keyboard.press('ArrowRight')
    const wrapped = await slashActive(page)
    await page.keyboard.press('ArrowRight')
    const second = await slashActive(page)
    check('S1 /ai capsules navigate left/right and wrap', first.count === 4 && first.index === 0 && last.index === 3 && wrapped.index === 0 && second.index === 1, { first, last, wrapped, second })
    const composing = await page.evaluate((PM) => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true, isComposing: true })
      document.querySelector(PM).dispatchEvent(event)
      return event.defaultPrevented
    }, PM)
    const afterComposition = await slashActive(page)
    check('S2 composing arrows are not consumed', !composing && afterComposition.index === 1, { prevented: composing, active: afterComposition })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await openSlash(page, '/')
    await page.keyboard.press('ArrowDown')
    const below = await slashActive(page)
    await page.keyboard.press('ArrowUp')
    const above = await slashActive(page)
    check('S4 up/down navigates across the AI group as one row', !below.inGroup && above.inGroup, { below, above })
    await page.evaluate(() => {
      const input = document.createElement('textarea'); input.id = 'unrelated-input'; document.body.append(input); input.focus()
    })
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter')
    const untouched = await page.evaluate(() => ({ value: document.getElementById('unrelated-input').value, focused: document.activeElement?.id, tasks: document.querySelectorAll('[data-document-agent="task"]').length }))
    check('S5 slash shortcuts do not capture keys from a different input', untouched.value === '\n' && untouched.focused === 'unrelated-input' && untouched.tasks === 0, untouched)
  })
  await scenario(browser, 'slash-instructions', async (openPage) => {
    const page = await openPage('# AI commands\n\nPreserve this paragraph.\n')
    await openSlash(page)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-document-agent="instructions"]')
    await flush(page)
    const saved = await disk(page)
    check('S3 Enter inserts instructions and preserves surrounding prose', saved.includes('forsion-instructions') && saved.includes('Preserve this paragraph.') && !saved.includes('/ai'), saved)
  })
  await scenario(browser, 'slash-task', async (openPage) => {
    const page = await openPage('# Task command\n\nKeep this text.\n')
    await openSlash(page)
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Enter')
    await page.waitForSelector('[data-document-agent="task"]')
    const state = await activity(page)
    check('S6 selecting the task capsule creates an editable draft only', await page.locator('[data-document-agent="task"] textarea').count() === 1 && state.calls.length === 0 && state.runs.length === 0, state)
  })
}

async function mentionScenario(browser) {
  await scenario(browser, 'mention-agent', async (openPage) => {
    const page = await openPage('# Mentions\n\nBefore  after.\n')
    await page.evaluate(() => {
      const view = window.__upage.probe.view(); let position = -1
      view.state.doc.descendants((node, at) => { if (node.isText && node.text.includes('Before  after.')) position = at + 'Before '.length })
      view.focus(); view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(position))))
    })
    await page.keyboard.type('@Researcher', { delay: 25 })
    await page.waitForSelector('.wiki-suggest')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-document-agent="task"]')
    await flush(page)
    const saved = await disk(page), state = await activity(page)
    check('M1 @Agent inserts an assigned draft without losing surrounding text or executing', saved.includes('Before') && saved.includes('after.') && saved.includes('"agent":"researcher"') && state.calls.length === 0 && state.runs.length === 0, { saved, state })
  })
}

async function taskScenarios(browser) {
  const source = `# Research\n\n${fence('instructions', 'Keep source links.')}\n\n${task()}\n\nUnchanged conclusion.\n`
  await scenario(browser, 'task-lifecycle', async (openPage) => {
    const page = await openPage(source, '&upane')
    check('T1 opening a page with an actionable block never runs it', (await activity(page)).calls.length === 0)
    await page.evaluate(() => { window.__documentAgent.hold = true })
    await page.locator('[data-document-agent="task"] .am-doc-agent-action').dblclick()
    await page.waitForFunction(() => window.__documentAgent.calls.length > 0)
    check('T2 double click creates one pending submission', (await activity(page)).calls.length === 1)
    await page.evaluate(() => window.__documentAgent.release())
    await page.waitForFunction(() => window.__documentAgent.runs.length === 1)
    const state = await activity(page)
    check('T3 session association is saved before execution, with page context', state.events.join(',') === 'create,bound-on-disk,run' && state.calls[0].vaultRoot === '/harness-vault' && state.calls[0].agent === 'researcher' && state.calls[0].prompt.includes('Unified.md') && state.calls[0].prompt.includes('Keep source links.'), state)
    await page.locator('[data-document-agent="task"] .am-doc-agent-action').click()
    await page.waitForTimeout(150)
    const reopened = await activity(page)
    check('T4 opening a submitted task opens its session without resubmitting', reopened.calls.length === 1 && reopened.runs.length === 1 && reopened.opens.includes('document-session-1'), reopened.opens)
    await screenshot(page, 'document-agents-light')
  })
  await scenario(browser, 'task-source-gone', async (openPage) => {
    const page = await openPage(source)
    await page.evaluate(() => { window.__documentAgent.hold = true })
    await page.locator('[data-document-agent="task"] .am-doc-agent-action').click()
    await page.waitForFunction(() => !!window.__documentAgent.release)
    await page.evaluate(() => window.__upage.switchFile('Other.md', '# Other\n\nKeep other page intact.\n'))
    await page.waitForFunction(() => document.querySelector('.unified-body .ProseMirror')?.textContent.includes('Keep other page intact.'))
    await page.evaluate(() => window.__documentAgent.release())
    await page.waitForTimeout(250)
    const state = await activity(page)
    check('T5 switching page during creation cancels execution', state.runs.length === 0 && state.events.includes('cancelled'), state)
  })
  await scenario(browser, 'task-save-failure', async (openPage) => {
    const page = await openPage(source)
    await page.evaluate(() => { window.__upage.failWrites = Infinity })
    await page.locator('[data-document-agent="task"] textarea').fill('An unsaved task draft')
    await page.locator('[data-document-agent="task"] .am-doc-agent-action').click()
    await page.waitForSelector('[data-document-agent="task"] [role="alert"]')
    const state = await activity(page)
    check('T6 a failed strict save blocks session creation and execution', state.calls.length === 0 && state.runs.length === 0 && !(await disk(page)).includes('An unsaved task draft'), state)
  })
  await scenario(browser, 'task-binding-failure', async (openPage) => {
    const page = await openPage(source)
    await page.evaluate(() => { window.__documentAgent.hold = true })
    await page.locator('[data-document-agent="task"] .am-doc-agent-action').click()
    await page.waitForFunction(() => !!window.__documentAgent.release)
    await page.evaluate(() => { window.__upage.failWrites = Infinity; window.__documentAgent.release() })
    await page.waitForFunction(() => window.__documentAgent.events.includes('save-failed'))
    const state = await activity(page)
    check('T7 a failed session-binding save never starts the agent', state.calls.length === 1 && state.runs.length === 0 && !(await disk(page)).includes('document-session-1'), state)
  })
}

async function instructionsScenarios(browser) {
  const source = `# Writing\n\n${fence('instructions', 'Keep source links.')}\n\n> ${fence('instructions', 'NESTED MUST NOT APPLY').replace(/\n/g, '\n> ')}\n\n这段需要润色的文字。\n`
  await scenario(browser, 'instructions-context', async (openPage) => {
    const page = await openPage(source)
    const input = page.locator('[data-document-agent="instructions"][data-active="true"] textarea')
    await input.fill('Use concise prose. Preserve citations.')
    const immediate = await page.evaluate(() => {
      const texts = []; window.__upage.probe.view().state.doc.forEach((node) => { if (node.type.name === 'code_block' && node.attrs.language === 'forsion-instructions') texts.push(node.textContent) }); return texts
    })
    check('I1 typing updates the document before blur', immediate.includes('Use concise prose. Preserve citations.'), immediate)
    await flush(page)
    await page.evaluate(() => window.__upage.switchFile('Other.md', '# Other\n'))
    await page.waitForTimeout(100)
    await page.evaluate(() => window.__upage.switchFile('Unified.md'))
    await page.waitForSelector('[data-document-agent="instructions"]')
    check('I2 saved instructions survive reopening the note', await input.inputValue() === 'Use concise prose. Preserve citations.')
    const nested = page.locator('[data-document-agent="instructions"][data-active="false"]')
    check('I3 nested instructions clearly show they do not apply', await nested.count() === 1 && (await nested.textContent()).includes('移到页面顶层后生效'))
    await selectText(page, '需要润色的文字')
    await page.click('[data-testid="inline-toolbar"] [data-act="ai"]')
    await page.click('[data-testid="itb-ai-menu"] [data-ai="improve"]')
    await page.waitForFunction(() => window.__documentAgent.inline.length > 0)
    const request = (await activity(page)).inline[0]
    check('I4 inline AI receives only this page’s top-level instructions', JSON.stringify(request.pageInstructions).includes('Use concise prose. Preserve citations.') && !JSON.stringify(request.pageInstructions).includes('NESTED MUST NOT APPLY'), request)
  })
}

async function taskAnchorScenario(browser) {
  await scenario(browser, 'task-source-anchor', async (openPage) => {
    const duplicated = task('duplicate-id')
    const page = await openPage(`# Duplicate tasks\n\n${duplicated}\n\nKeep this separator.\n\n${duplicated}\n`)
    await page.evaluate(() => { window.__documentAgent.hold = true })
    await page.locator('[data-document-agent="task"] .am-doc-agent-action').first().click()
    await page.waitForFunction(() => !!window.__documentAgent.release)
    await page.evaluate(() => {
      const view = window.__upage.probe.view()
      let first = null
      view.state.doc.descendants((node, position) => {
        if (!first && node.type.name === 'code_block' && node.attrs.language === 'forsion-task') first = { position, size: node.nodeSize }
      })
      if (!first) throw new Error('Original task fixture is missing')
      view.dispatch(view.state.tr.delete(first.position, first.position + first.size))
    })
    await flush(page)
    await page.evaluate(() => window.__documentAgent.release())
    await page.waitForFunction(() => window.__documentAgent.events.some((event) => ['cancelled', 'save-failed', 'run'].includes(event)))
    const state = await activity(page), saved = await disk(page)
    const remaining = await page.locator('[data-document-agent="task"]').count()
    check('T8 deleting the source during creation never binds or runs an identical later copy', state.calls.length === 1 && state.runs.length === 0 && remaining === 1 && !saved.includes('sessionId') && saved.includes('Keep this separator.'), { state, remaining, saved })
  })
}

async function safetyAndShots(browser) {
  const source = `# Document agents\n\n${fence('instructions', 'Keep sources and preserve the page structure.')}\n\n${task()}\n\n${fence('prompt', { v: 1, id: 'prompt-1', agent: 'writer', prompt: 'Draft a short introduction using this page.' })}\n\nSupporting notes stay here.\n`
  await scenario(browser, 'late-agent-roster', async (openPage) => {
    const page = await openPage(source, '&uemptyagents')
    const absent = await page.locator('[data-document-agent="task"] select option[value="writer"]').count() === 0
    await endOfPage(page)
    await page.keyboard.type('@Writer', { delay: 25 })
    await page.evaluate(() => {
      window.__documentAgent.agents = [{ slug: 'writer', name: 'Writer' }]
      for (const listener of window.__documentAgent.rosterListeners) listener()
    })
    await page.waitForFunction(() => document.querySelector('[data-document-agent="task"] select option[value="writer"]')?.textContent === 'Writer')
    await page.waitForSelector('.wiki-suggest')
    const mention = await page.locator('.wiki-suggest .wiki-item-name').allTextContents()
    check('R10 a late agent roster updates selectors and the open mention menu', absent && mention.includes('Writer') && await page.locator('[data-document-agent="prompt"] select option[value="writer"]').textContent() === 'Writer', mention)
  })
  await scenario(browser, 'readonly-and-malformed', async (openPage) => {
    const page = await openPage(`${source}\n${fence('task', '{"v":1,"id":"broken"')}`, '&uro')
    const state = await activity(page)
    check('R1 read-only documents have no execution or edit controls', await page.locator('[data-document-agent] button').count() === 0 && await page.locator('[data-document-agent] textarea').count() === 0 && state.calls.length === 0)
    check('R2 malformed task source remains visible and creates no action', await page.locator('[data-document-agent="task"]').count() === 1 && (await page.locator(PM).textContent()).includes('"broken"'))
  })
  await scenario(browser, 'remote-host-capability', async (openPage) => {
    const page = await openPage(source)
    await page.evaluate(() => { window.__documentAgent.hostExecution = false; window.__upage.switchFile('Other.md', '# Other\n') })
    await page.waitForTimeout(100)
    await page.evaluate(() => window.__upage.switchFile('Unified.md'))
    await page.waitForSelector('[data-document-agent="task"]')
    check('R8 a non-host engine cannot submit an existing page task', await page.locator('[data-document-agent="task"] .am-doc-agent-action').isDisabled())
    await openSlash(page)
    const menu = await slashActive(page)
    const labels = await page.locator('.slash-ai-capsule').evaluateAll((capsules) => capsules.map((capsule) => capsule.getAttribute('aria-label') || capsule.textContent))
    check('R9 a non-host engine hides the task insertion capsule', menu.count >= 2 && menu.count < 4 && labels.every((label) => !!label && !label.includes('Agent 任务')), labels)
  })
  await scenario(browser, 'prompt-and-screenshots', async (openPage) => {
    const page = await openPage(source, '&upane')
    await page.locator('[data-document-agent="prompt"] .am-doc-agent-action').click()
    await page.locator('[data-document-agent="prompt"] .am-doc-agent-action').click()
    const state = await activity(page)
    check('R3 prompt templates repeatedly open unsent drafts', state.drafts.length === 2 && state.drafts.every((draft) => draft.send === false) && state.runs.length === 0, state)
    await page.locator('[data-document-agent="prompt"]').hover()
    const codeTools = await page.evaluate(() => [...document.querySelectorAll('[data-document-agent]')].map((node) => {
      const tools = node.closest('.unified-embed-host')?.querySelector('.amx-code-tools')
      return { found: !!tools, display: tools ? getComputedStyle(tools).display : null }
    }))
    check('R7 embedded actions hide code toolbars even on hover', codeTools.length === 3 && codeTools.every((tools) => tools.found && tools.display === 'none'), codeTools)
    await screenshot(page, 'blocks-light')
    await page.setViewportSize({ width: 480, height: 900 })
    await screenshot(page, 'blocks-narrow')
    const geometry = await page.evaluate(() => [...document.querySelectorAll('[data-document-agent]')].map((node) => ({ width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right, scroll: node.scrollWidth, client: node.clientWidth })))
    check('R4 narrow blocks fit their viewport without horizontal overflow', geometry.length === 3 && geometry.every((box) => box.right <= 481 && box.scroll <= box.client + 1), geometry)
    const lightTheme = await page.evaluate(() => ({ mode: document.documentElement.dataset.mode, background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }))
    const debug = await page.evaluate(() => [...document.querySelectorAll('[data-document-agent]')].map((node) => node.closest('.unified-embed-host')?.outerHTML))
    fs.writeFileSync(path.join(OUT, 'embed-dom.json'), JSON.stringify(debug, null, 2))
    const dark = await openPage(source, '&upane&udark')
    await dark.waitForFunction(() => document.documentElement.dataset.mode === 'dark')
    const darkTheme = await dark.evaluate(() => ({ mode: document.documentElement.dataset.mode, background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }))
    check('R6 dark screenshots use actual dark theme tokens', darkTheme.mode === 'dark' && darkTheme.background !== lightTheme.background, { lightTheme, darkTheme })
    await screenshot(dark, 'blocks-dark')
    await dark.setViewportSize({ width: 480, height: 900 })
    await screenshot(dark, 'blocks-dark-narrow')
    await page.evaluate(() => window.__upage.setLocale('en'))
    await screenshot(page, 'blocks-english-narrow')
    check('R5 English labels cross the embedded React root boundary', (await page.locator('[data-document-agent="instructions"]').textContent()).includes('Page instructions'))
  })
}

async function slashScreenshots(browser) {
  await scenario(browser, 'slash-screenshots', async (openPage) => {
    for (const mode of ['light', 'dark', 'english']) {
      const page = await openPage('# AI commands\n\nPreserve this paragraph.\n', `&upane${mode === 'dark' ? '&udark' : ''}`)
      if (mode === 'english') await page.evaluate(() => window.__upage.setLocale('en'))
      await openSlash(page)
      await page.keyboard.press('ArrowRight')
      const labels = await page.locator('.slash-ai-capsule .slash-label').evaluateAll((nodes) => nodes.map((node) => {
        const range = document.createRange(); range.selectNodeContents(node)
        const lines = [...range.getClientRects()].filter((rect) => rect.width > 0)
        const button = node.closest('button').getBoundingClientRect()
        return { text: node.textContent, lines: lines.length, top: button.top, fits: lines.every((line) => line.left >= button.left && line.right <= button.right) }
      }))
      check(`V1 ${mode} AI capsules use a single row of unwrapped labels`, labels.length === 4 && labels.every((label) => label.lines === 1 && label.fits && Math.abs(label.top - labels[0].top) < 1), labels)
      // Full-page screenshots can resize the layout and dismiss anchored menus.
      await screenshot(page, `slash-ai-${mode}`, false)
    }
  })
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const only = (process.argv.find((arg) => arg.startsWith('--group=')) || '').slice('--group='.length).split(',').filter(Boolean)
  const selected = (group) => !only.length || only.includes(group)
  try {
    if (selected('slash')) await slashScenarios(browser)
    if (selected('mention')) await mentionScenario(browser)
    if (selected('tasks')) await taskScenarios(browser)
    if (selected('tasks') || selected('anchor')) await taskAnchorScenario(browser)
    if (selected('instructions')) await instructionsScenarios(browser)
    if (selected('shots')) await safetyAndShots(browser)
    if (selected('shots') || selected('slash-shots')) await slashScreenshots(browser)
  } finally { await browser.close() }
  check('No browser page errors', errors.length === 0, errors)
  fs.writeFileSync(path.join(OUT, `report-${only.join('-') || 'all'}.json`), JSON.stringify({ url: URL, groups: only, results, errors }, null, 2))
  const failed = results.filter((result) => !result.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed. Artifacts: ${OUT}`)
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
