// Page instructions + @Agent tasks + slash category tabs, against the real v4 editor.
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

async function settleSlashMenu(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const menu = document.querySelector('.slash-menu')
    if (!menu) return
    await Promise.all(menu.getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished.catch(() => {})))
  })
  await page.waitForFunction(() => {
    const menu = document.querySelector('.slash-menu')
    return !menu || getComputedStyle(menu).opacity === '1'
  })
}
async function screenshot(page, name, fullPage = true) {
  await page.evaluate(() => document.fonts.ready)
  await settleSlashMenu(page)
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
async function openSlash(page, text = '/') {
  await endOfPage(page)
  await page.keyboard.type(text, { delay: 25 })
  await page.waitForSelector('.slash-menu')
}
const slashActive = (page) => page.evaluate(() => {
  const menu = document.querySelector('.slash-menu')
  const rows = [...(menu?.querySelectorAll('.slash-item[data-key]') || [])]
  const selected = rows.find((row) => row.hasAttribute('data-active') && row.getAttribute('data-active') !== 'false')
  const tabs = [...(menu?.querySelectorAll('.slash-category-tab') || [])]
  const tab = tabs.find((item) => item.getAttribute('aria-selected') === 'true')
  return {
    category: tab?.dataset.category || null,
    categories: tabs.map((item) => ({ category: item.dataset.category, role: item.getAttribute('role'), text: item.textContent })),
    panelCategory: menu?.querySelector('.slash-list')?.getAttribute('data-category') || null,
    panelRole: menu?.querySelector('.slash-list')?.getAttribute('role') || null,
    tablistRole: menu?.querySelector('.slash-category-tabs')?.getAttribute('role') || null,
    index: rows.indexOf(selected), key: selected?.dataset.key || null,
    keys: rows.map((row) => row.dataset.key), text: selected?.textContent || '',
    count: rows.length, oldCapsules: menu?.querySelectorAll('.slash-ai-capsule').length || 0,
    emptyText: rows.length ? '' : menu?.querySelector('.slash-list')?.textContent?.trim() || '',
  }
})
async function waitCategory(page, category) {
  await page.waitForFunction((category) => document.querySelector('.slash-category-tab[aria-selected="true"]')?.getAttribute('data-category') === category, category)
  return slashActive(page)
}

const PLUGIN_FIXTURE = `
ctx.registerSlashItem({ id: 'document-agent-fixture', label: 'Plugin Fixture', group: 'Document checks', keywords: 'pluginfixture',
  run: () => { window.__slashPluginRuns = (window.__slashPluginRuns || 0) + 1; return 'PLUGIN_FIXTURE_OUTPUT'; } })
`
async function installSlashPlugin(page) {
  await page.evaluate((code) => {
    // Plugin loading refreshes its scoped vault inventory; this harness has no folders.
    window.amadeus.listFolders ??= async () => []
    return window.__ep.loadPlugin(code, { id: 'document-agent-fixture' })
  }, PLUGIN_FIXTURE)
}

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
    const h6Index = first.keys.indexOf('h6')
    for (let index = 0; index < h6Index; index++) await page.keyboard.press('ArrowDown')
    const h6 = await slashActive(page)
    await page.keyboard.press('ArrowDown')
    const card = await slashActive(page)
    await page.keyboard.press('ArrowDown')
    const ul = await slashActive(page)
    check('S12 Basic keyboard order follows the visible heading, card and list rows', h6Index >= 0 && h6.key === 'h6' && card.key === 'card' && ul.key === 'ul' && first.keys.slice(h6Index, h6Index + 3).join(',') === 'h6,card,ul', { h6: h6.key, card: card.key, ul: ul.key, keys: first.keys })
    await page.keyboard.press('ArrowLeft')
    const last = await waitCategory(page, 'plugin')
    await page.keyboard.press('ArrowRight')
    const wrapped = await waitCategory(page, 'basic')
    await page.keyboard.press('ArrowRight')
    const second = await waitCategory(page, 'ai')
    check('S1 slash defaults to Basic and left/right cycles the three category tabs', first.category === 'basic' && first.categories.map((tab) => tab.category).join(',') === 'basic,ai,plugin' && first.categories.every((tab) => tab.role === 'tab') && first.tablistRole === 'tablist' && first.count > 0 && last.category === 'plugin' && wrapped.category === 'basic' && second.category === 'ai', { first, last, wrapped, second })
    check('S2 an empty Plugin category remains selectable with an explicit empty state', last.count === 0 && !!last.emptyText && last.panelRole === 'tabpanel' && last.panelCategory === 'plugin', last)
    await page.keyboard.press('ArrowDown')
    const down = await slashActive(page)
    await page.keyboard.press('ArrowUp')
    const up = await slashActive(page)
    check('S3 up/down selects normal command rows inside the current category', second.keys.join(',') === 'ai,instructions,agent-task,prompt' && second.index === 0 && down.index === 1 && down.key === 'instructions' && down.category === 'ai' && up.index === 0 && up.category === 'ai' && second.oldCapsules === 0, { second, down, up })
    const composing = await page.evaluate((PM) => {
      const editor = document.querySelector(PM)
      // Set ProseMirror's composition state as an IME does, not just one key's flag.
      editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      const events = [
        { key: 'ArrowRight', isComposing: true },
        { key: 'ArrowDown', isComposing: true },
        { key: 'Enter', isComposing: true },
        { key: 'ArrowRight', keyCode: 229 },
      ].map((options) => {
        const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true })
        editor.dispatchEvent(event)
        return { ...options, prevented: event.defaultPrevented }
      })
      editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
      return events
    }, PM)
    const afterComposition = await slashActive(page)
    check('S4 IME arrows and Enter do not switch categories or execute commands', composing.every((event) => !event.prevented) && afterComposition.category === 'ai' && afterComposition.index === 0 && await page.locator('[data-document-agent]').count() === 0, { composing, active: afterComposition })
    await page.evaluate(() => {
      const input = document.createElement('textarea'); input.id = 'unrelated-input'; document.body.append(input); input.focus()
    })
    await page.keyboard.type('outside')
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
    const untouched = await page.evaluate(() => ({ value: document.getElementById('unrelated-input').value, focused: document.activeElement?.id, blocks: document.querySelectorAll('[data-document-agent]').length, calls: window.__documentAgent.calls.length, drafts: window.__documentAgent.drafts.length }))
    check('S5 slash shortcuts do not capture keys from a different input', untouched.value === 'outside\n' && untouched.focused === 'unrelated-input' && untouched.blocks === 0 && untouched.calls === 0 && untouched.drafts === 0, untouched)
  })
  await scenario(browser, 'slash-reopen', async (openPage) => {
    const page = await openPage('# Categories\n\nKeep this text.\n')
    await openSlash(page)
    await page.keyboard.press('ArrowRight')
    await waitCategory(page, 'ai')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.slash-menu', { state: 'hidden' })
    await openSlash(page)
    const reopened = await slashActive(page)
    check('S6 reopening an empty slash query resets to Basic', reopened.category === 'basic' && reopened.count > 0, reopened)
  })
  await scenario(browser, 'slash-instructions', async (openPage) => {
    const page = await openPage('# AI commands\n\nPreserve this paragraph.\n')
    await openSlash(page)
    await page.keyboard.press('ArrowRight')
    await waitCategory(page, 'ai')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-document-agent="instructions"]')
    await flush(page)
    const saved = await disk(page)
    check('S7 Enter inserts the selected instructions row and preserves surrounding prose', saved.includes('forsion-instructions') && saved.includes('Preserve this paragraph.') && !saved.includes('\n/'), saved)
  })
  await scenario(browser, 'slash-task', async (openPage) => {
    const page = await openPage('# Task command\n\nKeep this text.\n')
    await openSlash(page)
    await page.keyboard.press('ArrowRight')
    await waitCategory(page, 'ai')
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter')
    await page.waitForSelector('[data-document-agent="task"]')
    const state = await activity(page)
    check('S8 selecting the task command row creates an editable draft only', await page.locator('[data-document-agent="task"] textarea').count() === 1 && state.calls.length === 0 && state.runs.length === 0, state)
  })
  await scenario(browser, 'slash-plugin', async (openPage) => {
    const page = await openPage('# Plugins\n\nKeep plugin context.\n')
    await installSlashPlugin(page)
    await openSlash(page)
    const basic = await slashActive(page)
    await page.keyboard.press('ArrowLeft')
    await waitCategory(page, 'plugin')
    await page.waitForSelector('.slash-item[data-key]:has-text("Plugin Fixture")')
    const plugin = await slashActive(page)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__upage.probe.view().state.doc.textContent.includes('PLUGIN_FIXTURE_OUTPUT'))
    await flush(page)
    const saved = await disk(page), runs = await page.evaluate(() => window.__slashPluginRuns)
    check('S9 registered plugin commands appear as rows in Plugin and execute on Enter', basic.category === 'basic' && !basic.keys.some((key) => key.includes('document-agent-fixture')) && plugin.count === 1 && plugin.oldCapsules === 0 && runs === 1 && saved.includes('PLUGIN_FIXTURE_OUTPUT') && saved.includes('Keep plugin context.'), { basic, plugin, runs, saved })
  })
  await scenario(browser, 'slash-search-categories', async (openPage) => {
    const page = await openPage('# Search\n\nKeep this paragraph.\n')
    await installSlashPlugin(page)
    await openSlash(page, '/ai')
    const foundAI = await waitCategory(page, 'ai')
    await page.keyboard.press('ArrowLeft')
    const filteredBasic = await waitCategory(page, 'basic')
    const queryAfterLeft = await page.evaluate(() => window.__upage.probe.view().state.selection.$from.parent.textContent)
    await page.locator('.slash-category-tab[data-category="plugin"]').click()
    const filteredPlugin = await waitCategory(page, 'plugin')
    await page.locator('.slash-category-tab[data-category="ai"]').click()
    const restoredAI = await waitCategory(page, 'ai')
    const aiKeys = ['ai', 'instructions', 'agent-task', 'prompt']
    check('S10 search discovers AI globally while manual category switches retain the query', foundAI.keys.join(',') === aiKeys.join(',') && filteredBasic.keys.every((key) => !aiKeys.includes(key)) && filteredPlugin.keys.every((key) => !aiKeys.includes(key)) && queryAfterLeft === '/ai' && restoredAI.keys.join(',') === foundAI.keys.join(',') && restoredAI.categories.length === 3, { foundAI, filteredBasic, filteredPlugin, restoredAI, queryAfterLeft })
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace')
    const cleared = await waitCategory(page, 'basic')
    await page.keyboard.type('pluginfixture', { delay: 25 })
    const foundPlugin = await waitCategory(page, 'plugin')
    await page.waitForSelector('.slash-item[data-key]:has-text("Plugin Fixture")')
    await page.keyboard.press('ArrowRight')
    const emptyBasic = await waitCategory(page, 'basic')
    const queryAfterRight = await page.evaluate(() => window.__upage.probe.view().state.selection.$from.parent.textContent)
    await page.keyboard.press('ArrowLeft')
    await waitCategory(page, 'plugin')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.__slashPluginRuns === 1)
    check('S11 clearing a query restores Basic and plugin search crosses categories without trapping navigation', cleared.category === 'basic' && cleared.count > 0 && foundPlugin.count === 1 && emptyBasic.count === 0 && !!emptyBasic.emptyText && queryAfterRight === '/pluginfixture', { cleared, foundPlugin, emptyBasic, queryAfterRight })
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
    await openSlash(page, '/ai')
    const menu = await slashActive(page)
    check('R9 a non-host engine hides unsupported AI task and prompt command rows', menu.category === 'ai' && menu.keys.join(',') === 'ai,instructions' && menu.categories.length === 3 && menu.oldCapsules === 0, menu)
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
      for (const width of [1200, 480]) {
        const page = await openPage('# Document commands\n\nPreserve this paragraph.\n', `&upane${mode === 'dark' ? '&udark' : ''}`, width)
        if (mode === 'dark') await page.waitForFunction(() => document.documentElement.dataset.mode === 'dark')
        if (mode === 'english') await page.evaluate(() => window.__upage.setLocale('en'))
        await openSlash(page)
        const suffix = `${mode}${width === 480 ? '-narrow' : ''}`
        // Full-page screenshots can resize the layout and dismiss anchored menus.
        await screenshot(page, `slash-basic-${suffix}`, false)
        await page.keyboard.press('ArrowRight')
        await waitCategory(page, 'ai')
        const geometry = await page.evaluate(() => {
          const menu = document.querySelector('.slash-menu')
          const box = menu.getBoundingClientRect()
          const tabs = [...menu.querySelectorAll('.slash-category-tab')].map((node) => {
            const rect = node.getBoundingClientRect()
            return { text: node.textContent.trim(), top: rect.top, height: rect.height, width: rect.width, client: node.clientWidth, scroll: node.scrollWidth }
          })
          const rows = [...menu.querySelectorAll('.slash-item[data-key]')].map((node) => {
            const rect = node.getBoundingClientRect()
            return { key: node.dataset.key, top: rect.top, width: rect.width, height: rect.height, categoryTab: node.matches('.slash-category-tab'), role: node.getAttribute('role') }
          })
          return { tabs, rows, left: box.left, right: box.right, viewport: window.innerWidth, oldCapsules: menu.querySelectorAll('.slash-ai-capsule').length }
        })
        const expectedTabs = mode === 'english' ? ['Basic', 'AI', 'Plugins'] : ['基本', 'AI', '插件']
        check(`V1 ${suffix} has three category capsules and four full command rows`, geometry.tabs.map((tab) => tab.text).join(',') === expectedTabs.join(',') && geometry.tabs.every((tab) => Math.abs(tab.top - geometry.tabs[0].top) < 1 && tab.scroll <= tab.client + 1) && geometry.rows.length === 4 && geometry.rows.every((row, index) => row.role === 'menuitem' && !row.categoryTab && row.width > geometry.tabs[0].width * 2 && (index === 0 || row.top >= geometry.rows[index - 1].top + geometry.rows[index - 1].height - 1)) && geometry.left >= -1 && geometry.right <= geometry.viewport + 1 && geometry.oldCapsules === 0, geometry)
        await screenshot(page, `slash-ai-${suffix}`, false)
        if (mode === 'light' && width === 1200) {
          await settleSlashMenu(page)
          await page.locator('.slash-menu').screenshot({ path: path.join(OUT, 'slash-categories-menu.png') })
          await page.keyboard.press('ArrowRight')
          await waitCategory(page, 'plugin')
          await screenshot(page, 'slash-plugin-empty-light', false)
        }
      }
    }
  })
}

// Switching the category capsule must not move the menu. Above the caret the menu's bottom is pinned to the
// caret, so a menu that shrinks slides the capsule out from under the pointer (Basic -> AI used to drop 206px).
async function slashStability(browser) {
  await scenario(browser, 'slash-stable', async (openPage) => {
    const LONG = `# Stable\n\n${Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n\n')}\n`
    const geometry = (page) => page.evaluate(() => {
      const menu = document.querySelector('.slash-menu').getBoundingClientRect()
      const caret = window.getSelection().getRangeAt(0).getBoundingClientRect()
      return {
        tabs: Math.round(document.querySelector('.slash-category-tabs').getBoundingClientRect().top),
        height: Math.round(menu.height), above: menu.bottom <= caret.top + 1,
        footGap: Math.round(menu.bottom - document.querySelector('.slash-foot').getBoundingClientRect().bottom),
      }
    })
    // One click and two arrow presses: Basic -> AI -> Plugins -> Basic.
    const walk = async (page) => {
      // Not openSlash: the new last line scrolls into view first, and any outside scroll closes the menu.
      await endOfPage(page)
      await page.waitForTimeout(250)
      await page.keyboard.type('/', { delay: 25 })
      await page.waitForSelector('.slash-menu')
      await settleSlashMenu(page)
      const steps = [await geometry(page)]
      for (const [category, act] of [['ai', () => page.locator('.slash-category-tab[data-category="ai"]').click()], ['plugin', () => page.keyboard.press('ArrowRight')], ['basic', () => page.keyboard.press('ArrowRight')]]) {
        await act()
        await waitCategory(page, category)
        await settleSlashMenu(page)
        steps.push(await geometry(page))
      }
      return steps
    }
    const spread = (steps) => Math.max(...steps.map((step) => step.tabs)) - Math.min(...steps.map((step) => step.tabs))

    const low = await openPage(LONG, '&upane')
    const above = await walk(low)
    check('H1 above the caret, the category capsule stays put across Basic / AI / Plugins', above.every((step) => step.above) && spread(above) < 1, above)
    check('H2 a short category keeps the footer on the bottom edge', above.every((step) => step.footGap >= 0 && step.footGap <= 8), above.map((step) => step.footGap))
    await screenshot(low, 'slash-stable-above-basic', false)
    await low.locator('.slash-category-tab[data-category="ai"]').click()
    await waitCategory(low, 'ai')
    await settleSlashMenu(low)
    await screenshot(low, 'slash-stable-above-ai', false)
    // The floor belongs to one query: filtering to nothing must still shrink the menu.
    await low.keyboard.type('zzzz', { delay: 25 })
    await low.waitForFunction(() => !document.querySelector('.slash-item[data-key]'))
    await settleSlashMenu(low)
    const filtered = await geometry(low)
    check('H3 a new query releases the kept height', filtered.height < above[0].height - 50, { before: above[0].height, after: filtered.height })

    // Negative control: without the height floor the same walk moves the capsule, so H1 is measuring something real.
    const control = await openPage(LONG, '&upane')
    await control.addStyleTag({ content: '.am-app .slash-menu{min-height:0!important}' })
    const loose = await walk(control)
    check('H4 negative control: without the height floor the capsule moves', loose.every((step) => step.above) && spread(loose) > 50, loose)

    const high = await openPage('# Stable\n\nx\n', '&upane')
    const below = await walk(high)
    check('H5 below the caret, the capsule and the menu height stay put', below.every((step) => !step.above && step.height === below[0].height) && spread(below) < 1, below)
    await high.locator('.slash-category-tab[data-category="ai"]').click()
    await waitCategory(high, 'ai')
    await settleSlashMenu(high)
    await screenshot(high, 'slash-stable-below-ai', false)
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
    if (selected('slash') || selected('slash-stable')) await slashStability(browser)
  } finally { await browser.close() }
  check('No browser page errors', errors.length === 0, errors)
  fs.writeFileSync(path.join(OUT, `report-${only.join('-') || 'all'}.json`), JSON.stringify({ url: URL, groups: only, results, errors }, null, 2))
  const failed = results.filter((result) => !result.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed. Artifacts: ${OUT}`)
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
