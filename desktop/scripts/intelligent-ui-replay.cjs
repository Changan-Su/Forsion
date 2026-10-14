/** Replay real-model answers in real isolated Electron and screenshot them: how the opening
 * conclusion, the native view and the closing line read as one answer. Nothing is asserted about
 * the wording; this is the instrument for looking at a live run with your own eyes.
 * Input: `iuiparity-evidence.json` from a live run (tangu-agent `--only iuiparity`).
 *   node scripts/intelligent-ui-replay.cjs <evidence.json> [--only=camp,trip] [--out=<dir>] [--dark]
 * Stub transport, isolated user data; never touches installed app data. Run it under the e2e devlock. */
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const ROOT = path.resolve(__dirname, '..')
const arg = (name) => process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3)
const file = process.argv.slice(2).find((s) => !s.startsWith('--'))
if (!file) { console.error('usage: node scripts/intelligent-ui-replay.cjs <iuiparity-evidence.json> [--only=a,b] [--out=<dir>] [--dark]'); process.exit(2) }
const OUT = path.resolve(arg('out') || path.join(ROOT, 'outputs/intelligent-ui-replay'))
const only = arg('only')?.split(',')
const SESSION = { id: 's1', title: 'Intelligent UI replay', summary: '', model_id: 'm1', archived: false, agent_config: null, project_path: '/tmp/intelligent-ui-replay', project_name: 'Replay', created_at: '2026-10-13 09:00:00', updated_at: '2026-10-13 09:00:00' }

async function openSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 30000 })
  await enterSpace(win, 'tangu')
  if (!(await win.locator('.t2s-search input').first().isVisible().catch(() => false))) await win.locator('.dv-edge-left').click().catch(() => {})
  await win.locator('.t2s-srow[data-sel-id="s1"]').first().click({ timeout: 15000 })
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => r.views?.length && (!only || only.includes(r.id)))
  if (!rows.length) { console.error('no answers with a view in that file (older runs carry no `views`)'); process.exit(2) }
  fs.mkdirSync(OUT, { recursive: true })
  const stub = await startStubEngine({ sessions: [SESSION], messages: [], models: [{ id: 'm1', name: 'Replay', provider: 'stub', contextWindow: 128000 }] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-iui-replay-'))
  for (const dir of [path.join(home, 'userdata'), path.join(home, 'userdata-dev')]) {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'test' }))
  }
  const app = await electron.launch({ args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT, env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url } })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root')
    await win.evaluate((dark) => { localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', dark ? 'dark' : 'light'); localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_tangu_onboarding_done', '1') }, process.argv.includes('--dark'))
    for (const [i, r] of rows.entries()) {
      stub.state.messages = [
        { id: `u${i}`, role: 'user', content: r.q, timestamp: Date.now() },
        { id: `m${i}`, role: 'model', content: r.content, timestamp: Date.now(),
          tool_calls: r.views.map((v) => ({ id: v.id, type: 'function', function: { name: v.name, arguments: v.arguments }, ui_content_offset: v.offset })),
          tool_results: r.views.map((v) => ({ tool_call_id: v.id, name: v.name, content: 'rendered', isError: false })) },
      ]
      await win.reload()
      for (const label of ['跳过引导', 'Skip']) { const b = win.getByText(label, { exact: true }); if (await b.count()) await b.first().click().catch(() => {}) }
      await openSession(win)
      const answer = win.locator('.t2-asst-col').last()
      await answer.waitFor({ timeout: 20000 })
      await win.waitForTimeout(1200) // images and the sandboxed card settle
      const name = `${String(i + 1).padStart(2, '0')}-${r.id.replace('+', '-followup')}`
      // top: the user's message and how the answer opens
      await win.locator('.t2-user-row, .t2-user, [data-role="user"]').first().evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' })).catch(() => answer.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' })))
      await win.waitForTimeout(300); await win.screenshot({ path: path.join(OUT, `${name}-top.png`) })
      // end: how it closes (the ask, the last line)
      await answer.evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }))
      await win.waitForTimeout(300); await win.screenshot({ path: path.join(OUT, `${name}-end.png`) })
      console.log(`SHOT ${name}  views=${r.views.map((v) => v.name).join('+')}  lead=${r.lead}  tail=${r.tail}`)
    }
    console.log(`${rows.length} answers replayed. Screenshots: ${OUT}`)
  } finally {
    await app.close().catch(() => {}); stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
