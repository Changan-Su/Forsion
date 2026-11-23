// Isolated Electron renderer against the engine's actual SQLite page reader.
const assert = require('node:assert/strict')
const path = require('node:path')
const U = require('./lib/uiux-electron.cjs')

async function main() {
  const load = name => import(path.resolve(__dirname, '../../tangu-agent/dist', name + '.js'))
  const { createSqliteHost } = await load('adapters/standalone/sqliteHost')
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'fixture', userId: 'u' })
  const { configureTangu } = await load('seams/runtime')
  const { createTanguProfile } = await load('profiles/index')
  configureTangu({ host, profile: createTanguProfile({ toolBuiltins: [], sandboxMode: 'none' }) })
  db.exec((await load('core/dialectDDL')).toSqliteDDL((await load('db/schemaStandalone')).STANDALONE_SCHEMA))
  await (await load('db/migrate')).runMigration()
  const { chatHistoryPage } = await load('services/chatHistoryPage')
  const { listMessagesPage } = await load('routes/sessions')
  const sid = 'fx-p2'
  const insert = db.prepare('INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
  for (let i = 0; i < 400; i++) insert.run('m' + i, sid, i % 2 ? 'model' : 'user', 'Message ' + i + '\n\n' + 'Long text for realistic scrolling. '.repeat(40), i)
  const reads = []
  let releaseConfig
  const configGate = new Promise(resolve => { releaseConfig = resolve })
  const { app, win, close } = await U.launch({ tag: 'history-page', overrideHome: true,
    stubOverride: async ({ path: p, url }) => {
      const q = url.searchParams
      if (p === '/agent/sessions/' + sid + '/config') {
        await configGate
        return { agent_config: {} }
      }
      if (p === '/agent/sessions/search') return { hits: [{ id: sid, title: 'Probe session two', updatedAt: '2026-11-22', hit: { messageId: 'm41', role: 'assistant', timestamp: 41, snippet: 'needle content' } }] }
      if (p !== '/agent/sessions/' + sid + '/messages') return
      if (q.get('view') === 'cards') return { messages: await (await load('services/chatHistoryPage')).chatCardRows(sid, 24) }
      const limit = Number(q.get('limit') || 200)
      const page = q.get('view') === 'page' && await chatHistoryPage(sid, limit, { beforeId: q.get('before_id'), afterId: q.get('after_id'),
        aroundId: q.get('around_id'), known: JSON.parse(q.get('known') || '{}') })
      const body = page ? { messages: page.rows, failed_runs: page.failed, page: page.page } : { messages: await listMessagesPage(sid, limit) }
      reads.push({ rows: body.messages.length, bytes: Buffer.byteLength(JSON.stringify(body)), query: [...q.keys()] })
      return body
    },
  })
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    const row = win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session two' }).first()
    await row.waitFor()
    const first = win.locator('.t2-stream #tocmsg-m399').first()
    const t0 = Date.now()
    await row.click()
    await first.waitFor({ timeout: 12000 })
    const firstMs = Date.now() - t0
    releaseConfig()
    await U.sleep(700)
    assert.equal(await win.locator('.t2-stream [id^="tocmsg-"]').count(), 24)
    assert.equal(reads[0].rows, 24)
    const baseline = Buffer.byteLength(JSON.stringify({ messages: await listMessagesPage(sid, 200) }))
    const start = reads.length
    const idleMs = process.argv.includes('--quick') ? 5500 : 60000
    await U.sleep(idleMs)
    const idle = reads.slice(start)
    assert.ok(idle.length >= (process.argv.includes('--quick') ? 1 : 10))
    assert.ok(idle.every(r => r.rows === 0))
    console.log(JSON.stringify({ firstMs, firstBytes: reads[0].bytes, idleResponses: idle.length,
      idleMs, idleHistoryResponseBytes: idle.reduce((n,r) => n+r.bytes, 0), previous200RowBytesPerResponse: baseline }))
    const viewport = win.locator('.t2-stream').first()
    const pos = () => viewport.evaluate(el => {
      const top = el.getBoundingClientRect().top
      const row = [...el.querySelectorAll('[id^="tocmsg-"]')].find(r => r.getBoundingClientRect().bottom > top + 1)
      return row && { id: row.id, offset: row.getBoundingClientRect().top - top }
    })
    await viewport.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })); el.scrollTop = 180 })
    const before = await pos()
    await viewport.evaluate(el => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 })))
    await win.locator('#tocmsg-m352').first().waitFor({ state: 'attached' })
    await U.sleep(450)
    const at = await pos()
    assert.ok(before && at && at.id === before.id && Math.abs(at.offset - before.offset) < 12, JSON.stringify({ before, at }))
    db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run('Updated from another device', 'm399')
    await win.waitForFunction(() => document.querySelector('#tocmsg-m399')?.textContent.includes('Updated from another device'))
    assert.ok(reads.some(r => r.query.includes('known') && r.rows === 1))
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await win.keyboard.press(mod + '+P')
    await win.locator('.amx-qf-input').fill('needle')
    const hit = win.locator('[data-testid="qf-hit"]').first()
    await hit.waitFor()
    for (let i = 0; i < 12 && !await hit.evaluate(el => el.classList.contains('sel')); i++) await win.keyboard.press('ArrowDown')
    await win.keyboard.press(mod + '+Enter')
    await win.waitForFunction(() => {
      const el = document.querySelector('.t2-stream #tocmsg-m41'), root = el?.closest('.t2-stream')
      if (!root) return false
      const y = el.getBoundingClientRect().top - root.getBoundingClientRect().top
      return y >= -2 && y < root.clientHeight
    }, null, { timeout: 12000 })
    assert.ok(reads.some(r => r.query.includes('around_id')))
    await U.sleep(1500)
    const anchor = await pos()
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Probe session one' }).first().click()
    await row.click()
    await U.sleep(1800)
    const restored = await pos()
    assert.ok(anchor && restored && anchor.id === restored.id && Math.abs(anchor.offset - restored.offset) < 12, JSON.stringify({ anchor, restored }))
    await U.captureWindow(app, path.join(U.shotDir('chat-history'), 'reading-position.png'))
    console.log('PASS independent cold open, stable idle, one-row edit, prepend anchor, distant search, saved reading position')
  } catch (e) { console.error((await win.locator('body').innerText()).slice(0, 1800), reads.slice(-4)); throw e } finally { releaseConfig(); await close(); db.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
