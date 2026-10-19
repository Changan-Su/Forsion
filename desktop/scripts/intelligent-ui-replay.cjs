/** Replay real-model answers in real isolated Electron and screenshot them: how the opening
 * conclusion, the native view and the closing line read as one answer. Nothing is asserted about
 * the wording; this is the instrument for looking at a live run with your own eyes.
 * Input: `iuiparity-evidence.json` / `iuicalc-evidence.json` from a live run (tangu-agent `--only …`).
 *   node scripts/intelligent-ui-replay.cjs <evidence.json> [--only=camp,trip] [--out=<dir>] [--dark]
 *   node scripts/intelligent-ui-replay.cjs --gallery [--only=loan,vocab] [--widths=760,375] [--modes=light,dark]
 * --gallery renders the hand-written v2 gallery (scripts/fixtures/intelligent-ui-gallery.json) with no model.
 * --widths / --modes shoot each card by itself at those container widths and themes instead of the
 * whole window; index.html in the output folder lays them out, with the engine's rejections and
 * values that failed at the initial values (from the live evidence) next to each answer.
 * Stub transport, isolated user data; never touches installed app data. Run it under the e2e devlock. */
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const ROOT = path.resolve(__dirname, '..')
const arg = (name) => process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3)
const file = process.argv.slice(2).find((s) => !s.startsWith('--'))
const galleryMode = process.argv.includes('--gallery')
if (!file && !galleryMode) { console.error('usage: node scripts/intelligent-ui-replay.cjs <evidence.json> | --gallery [--only=a,b] [--out=<dir>] [--dark] [--widths=760,375] [--modes=light,dark]'); process.exit(2) }
const widths = arg('widths')?.split(',').map(Number).filter(Boolean)
const modes = arg('modes')?.split(',') || [process.argv.includes('--dark') ? 'dark' : 'light']
/** Gallery documents as answers with one native view each. */
const galleryRows = () => Object.entries(JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/fixtures/intelligent-ui-gallery.json'), 'utf8')))
  .map(([id, doc]) => ({ id, q: doc.title, content: '', views: [{ id: `g-${id}`, name: 'intelligent_ui', offset: 0, arguments: JSON.stringify({ document: JSON.stringify(doc) }) }] }))
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
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
  const rows = (galleryMode ? galleryRows() : JSON.parse(fs.readFileSync(file, 'utf8'))).filter((r) => r.views?.length && (!only || only.includes(r.id)))
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
    const shots = new Map() // row id -> [{ file, label }]
    for (const mode of modes) {
    await win.evaluate((dark) => { localStorage.setItem('tangu_locale', 'zh'); localStorage.setItem('forsion_theme_pref', dark ? 'dark' : 'light'); localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_tangu_onboarding_done', '1') }, mode === 'dark')
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
      if (widths) {
        // Each native card by itself, at each container width (the e2e's way: the card is its own container).
        const cards = answer.locator('.intelligent-ui')
        for (let k = 0; k < await cards.count(); k++) for (const w of widths) {
          const card = cards.nth(k)
          await card.evaluate((el, px) => { el.style.width = `${px}px`; el.scrollIntoView({ block: 'start', behavior: 'instant' }) }, w)
          await win.waitForTimeout(250)
          const shot = `${name}-${k + 1}-${mode}-${w}.png`
          await card.screenshot({ path: path.join(OUT, shot) })
          shots.set(r.id, [...(shots.get(r.id) || []), { file: shot, label: `${mode} · ${w}px` }])
        }
        console.log(`SHOT ${name} ${mode} cards=${await cards.count()}`)
        continue
      }
      // top: the user's message and how the answer opens
      await win.locator('.t2-user-row, .t2-user, [data-role="user"]').first().evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' })).catch(() => answer.evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' })))
      await win.waitForTimeout(300); await win.screenshot({ path: path.join(OUT, `${name}-top.png`) })
      // end: how it closes (the ask, the last line)
      await answer.evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }))
      await win.waitForTimeout(300); await win.screenshot({ path: path.join(OUT, `${name}-end.png`) })
      console.log(`SHOT ${name}  views=${r.views.map((v) => v.name).join('+')}  lead=${r.lead}  tail=${r.tail}`)
    }
    }
    if (widths) fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Intelligent UI replay</title>
<style>body{margin:24px;font:14px/1.6 -apple-system,"PingFang SC",sans-serif;background:#f6f6f4;color:#1c1c1c}section{margin:0 0 40px}h2{font-size:16px;margin:0 0 4px}
.q{color:#666;margin:0 0 8px}.bad{color:#a33;white-space:pre-wrap;font-size:12px}.row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}figure{margin:0}figcaption{font-size:12px;color:#666}img{display:block;border:1px solid #ddd;border-radius:6px}</style>
${rows.map((r) => `<section><h2>${esc(r.id)}</h2><p class="q">${esc(r.q)}</p>${[...(r.rejected || []).map((x) => `引擎拒收:${x}`), ...(r.failedNotes || []).map((x) => `初值失败:${x}`)].map((x) => `<p class="bad">${esc(x)}</p>`).join('')}
<div class="row">${(shots.get(r.id) || []).map((s) => `<figure><img src="${esc(s.file)}" alt=""><figcaption>${esc(s.label)}</figcaption></figure>`).join('')}</div></section>`).join('\n')}`)
    console.log(`${rows.length} answers replayed. Screenshots: ${OUT}`)
  } finally {
    await app.close().catch(() => {}); stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
