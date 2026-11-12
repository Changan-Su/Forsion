/** Real Electron + scripted engine: notification routing and rendered-message read receipts.
 * Run after npm run build: npm run check:muse-notifications. Isolated home; no real messages. */
const U = require('./lib/uiux-electron.cjs')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')
const sid = 'muse-notification-probe'
const messages = []
let unread = false, at = 0, attentionGets = 0
const reads = []
const base = { archived: false, model_id: 'm1', created_at: '2026-11-12 10:00:00', updated_at: '2026-11-12 10:00:00', projectless: true, project_path: null, project_name: null }
const session = { ...base, id: sid, title: 'Muse notification probe', agent_config: { soloAgentSlug: 'muse', agentSlug: 'muse' } }
const send = (content) => {
  at += 1000; unread = true
  const m = { id: `proactive-${at}`, session_id: sid, role: 'model', origin: 'proactive', content, timestamp: at }
  messages.push(m); return m.id
}
async function until(fn, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(100) } throw new Error('condition timed out') }
;(async () => {
  const ctx = await U.launch({ tag: 'muse-notifications', fixtures: {
    agents: [{ slug: 'muse', name: 'Muse', createdBy: 'system', libraryDir: '/tmp/muse-notifications/Library' }], sessions: [session],
  }, stubOverride: async ({ path, method, body }) => {
    if (path === '/agent/sessions/attention') { attentionGets++; return { sessions: unread ? [{ id: sid, unread: true, awaiting: false, count: 1, at }] : [] } }
    if (path === `/agent/sessions/${sid}/messages`) return { messages }
    if (path === `/agent/sessions/${sid}/config`) return { agentConfig: session.agent_config }
    if (path === `/agent/sessions/${sid}/read` && method === 'POST') {
      const b = await body(); reads.push(b.messageId)
      if (b.messageId === messages.at(-1)?.id) unread = false
      return { ok: true, unread, awaiting: false }
    }
  } })
  const { app, win } = ctx
  const mainWindow = await app.browserWindow(win)
  try {
    await app.evaluate(({ Notification, ipcMain }) => {
      globalThis.__museNativeNotices = []
      ipcMain.removeHandler('ui:notify')
      ipcMain.handle('ui:notify', (_event, title, body) => { globalThis.__museNativeNotices.push({ title, body }) })
      Notification.prototype.show = function () { globalThis.__museNativeNotices.push({ title: this.title, body: this.body }) }
    })
    const cdp = await win.context().newCDPSession(win)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    await U.boot(app, win, { space: 'home' })
    await mainWindow.evaluate((w) => { w.show(); w.focus() })
    const refresh = () => win.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    const first = send('A proactive message without a question.')
    await refresh()
    await win.locator('.ntf').filter({ hasText: '主动发来了一条新消息' }).waitFor()
    assert.equal(reads.length, 0); console.log('PASS ordinary proactive message notifies in another Space without marking read')
    await win.locator('.ntf').filter({ hasText: '主动发来了一条新消息' }).locator('.ntf-action').click()
    await win.locator(`#tocmsg-${first}`).waitFor()
    await until(() => reads.includes(first))
    console.log('PASS notification opens the chat and acknowledges the rendered message id')
    assert(await U.enterSpace(win, 'home', { real: true }))
    const second = send('Long history.\n\n' + 'An earlier paragraph for scrolling.\n\n'.repeat(100))
    await refresh()
    await delay(1200)
    assert(!reads.includes(second)); console.log('PASS stale activeId on Home does not acknowledge new arrivals')
    await win.locator('.ntf').filter({ hasText: '主动发来了一条新消息' }).locator('.ntf-action').click()
    await until(() => reads.includes(second))
    await win.locator('.t2-stream').first().hover()
    await win.mouse.wheel(0, -15000)
    await delay(1000)
    const third = send('New arrival while reading older history.')
    await refresh(); await delay(5500)
    assert(!reads.includes(third)); console.log('PASS reading old history leaves the new message unread')
    await win.locator('.t2-stream').first().evaluate((el) => { el.scrollTop = el.scrollHeight })
    await until(() => reads.includes(third))
    console.log('PASS scrolling the new message into view acknowledges it')
    await mainWindow.evaluate((w) => w.hide())
    await until(() => win.evaluate(() => document.hidden || !document.hasFocus()))
    const fourth = send('New arrival in a hidden window.')
    const before = attentionGets
    await until(() => attentionGets > before, 26000)
    await until(() => app.evaluate(() => globalThis.__museNativeNotices.length > 0))
    assert(!reads.includes(fourth)); console.log('PASS hidden window still polls and reaches native notification bridge without marking read')
    await mainWindow.evaluate((w) => { w.show(); w.focus() })
    await win.locator('.t2-stream').first().evaluate((el) => { el.scrollTop = el.scrollHeight })
    await until(() => reads.includes(fourth))
    console.log('PASS returning to the visible new message acknowledges it')
  } finally { await ctx.close() }
})().catch((e) => { console.error(e); process.exitCode = 1 })
