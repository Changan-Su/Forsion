/** Real Chat View actions across tool-separated text, with isolated clipboard and backend. Build first. */
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('node:assert/strict')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')
const ROOT = path.resolve(__dirname, '..')
async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-reply-copy-'))
  const stub = await startStubEngine({ sessions: [{ id: 'copy-test', title: 'Reply copy', model_id: 'm1', agent_config: null, project_path: '/tmp/demo', project_name: 'demo', archived: false,
    created_at: '2026-11-12T00:00:00Z', updated_at: '2026-11-12T00:00:00Z' }] })
  fs.mkdirSync(path.join(home, 'userdata-dev'), { recursive: true })
  fs.writeFileSync(path.join(home, 'userdata-dev', 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'copy-test' }))
  const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' } })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.dv-groupview', { timeout: 30000, state: 'attached' }); await skipOnboarding(win)
    await enterSpace(win, 'tangu')
    await win.waitForTimeout(1200)
    const row = win.locator('.t2s-srow[data-sel-id="copy-test"]').first()
    if (!await row.count()) {
      await win.locator('.t2s-group-toggle').filter({ hasText: 'demo' }).first().click()
    }
    await row.click()
    await win.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async text => { window.__copiedReply = text } } }))
    stub.script([
      { type: 'token', payload: { delta: 'First paragraph.\n\nSecond paragraph.' } },
      { type: 'tool_call', payload: { id: 'copy-tool', name: 'read_file', arguments: '{"path":"demo.txt"}' } },
      { type: 'tool_result', payload: { id: 'copy-tool', result: 'fixture', elapsedMs: 5 } },
      { type: 'token', payload: { delta: 'Final paragraph.' } },
    ])
    const input = win.locator('.t2c-ta').first()
    await input.fill('Check reply copy'); await input.press('Enter')
    const reply = win.locator('.t2-asst').last()
    await reply.locator('.t2-content').filter({ hasText: 'Final paragraph.' }).waitFor()
    await reply.hover()
    await reply.locator('.t2-actions button[title="复制"]').click()
    const expected = 'First paragraph.\n\nSecond paragraph.\n\nFinal paragraph.'
    assert.equal(await win.evaluate(() => window.__copiedReply), expected)
    await win.evaluate(() => { window.__copiedReply = '' })
    await input.fill('/copy'); await input.press('Enter')
    await win.waitForFunction(expected => window.__copiedReply === expected, expected, { timeout: 5000 })
    console.log('PASS Chat copy button and /copy include every paragraph across tool calls')
  } catch (error) {
    await app.windows()[0]?.screenshot({ path: path.join(home, 'failure.png') }).catch(() => {})
    throw error
  } finally { await app.close(); await stub.close(); console.log('Evidence:', home) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
