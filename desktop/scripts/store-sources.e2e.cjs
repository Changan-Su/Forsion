/** Store sources through the real main process (Electron, IPC, files): add a source served from a local fixture,
 * install a skill and a Forsion plugin from it, check the files, the provenance record and the updater registration,
 * refuse an install whose confirmed type no longer matches the catalog, then uninstall and check the records go.
 * The renderer half (left column, source page, confirmation) is `npm run check:marketui`; this covers what that stub skips.
 * Run: npm run build, then node scripts/store-sources.e2e.cjs
 */
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert/strict')
const { createHash } = require('crypto'), JSZip = require('jszip')
const electron = require('./lib/launch-electron.cjs')
const ROOT = path.join(__dirname, '..')

async function until(check, description) {
  const deadline = Date.now() + 45000
  while (!await check()) { assert.ok(Date.now() < deadline, `Timed out: ${description}`); await new Promise((r) => setTimeout(r, 100)) }
}
const zipOf = async (files) => { const z = new JSZip(); for (const [k, v] of Object.entries(files)) z.file(k, v); return z.generateAsync({ type: 'nodebuffer' }) }
const sha = (buf) => createHash('sha256').update(buf).digest('hex')

async function main() {
  assert.ok(fs.existsSync(path.join(ROOT, 'out/main/main.js')), 'Run npm run build first')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-store-sources-')), userData = path.join(home, 'userdata')
  const files = {
    'poster.zip': await zipOf({ 'SKILL.md': '---\nname: poster-layout\ndescription: Poster layout rules\nversion: 1.2.0\n---\n# Poster layout\n' }),
    'palette.zip': await zipOf({ 'manifest.json': JSON.stringify({ id: 'palette-tools', name: 'Palette tools', version: '0.4.2', apiVersion: 1 }), 'main.js': 'export default { onload() {} }' }),
  }
  let base
  const catalog = () => ({
    schema: 1, title: { zh: '图片 Skills 大全', en: 'Image skills' }, author: 'Pixel Lab',
    items: [
      { id: 'poster', type: 'skill', name: '海报排版', version: '1.2.0', summary: 'Poster rules', package: { url: `${base}/pkg/poster.zip`, sha256: sha(files['poster.zip']) } },
      { id: 'palette', type: 'amadeus-plugin', name: '取色板', version: '0.4.2', package: { url: `${base}/pkg/palette.zip`, sha256: sha(files['palette.zip']) } },
    ],
  })
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    if (req.url === '/forsion-store.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(catalog())) }
    const m = /^\/pkg\/(.+)$/.exec(req.url)
    if (m && files[m[1]]) { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(files[m[1]]) }
    res.writeHead(404); res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`
  fs.mkdirSync(`${userData}-dev`); fs.writeFileSync(path.join(`${userData}-dev`, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'managed', cloudUrl: base, unitHostEnabled: false }))
  const env = { ...process.env, TANGU_HOME: home, TANGU_CLOUD_URL: base }; delete env.TANGU_BACKEND_URL
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT], cwd: ROOT, env, timeout: 60000 })
    const win = await app.firstWindow(); win.setDefaultTimeout(15000); await win.waitForSelector('#root')
    await until(() => win.evaluate(() => !!window.tangu?.marketSourcesAdd), 'store source bridge')

    const src = await win.evaluate((u) => window.tangu.marketSourcesAdd(u, 'zh'), `${base}/forsion-store.json`)
    assert.equal(src.title, '图片 Skills 大全'); assert.equal(src.origin, 'user'); assert.equal(src.trusted, false)
    const cat = await win.evaluate((id) => window.tangu.marketSourcesCatalog(id, { locale: 'zh' }), src.id)
    assert.deepEqual(cat.items.map((x) => [x.id, x.type]), [[`src_${src.id}_poster`, 'skill'], [`src_${src.id}_palette`, 'amadeus-plugin']])

    // The renderer sends the type the user confirmed; a different one (the catalog changed in between) is refused before any write.
    const wrong = await win.evaluate((id) => window.tangu.marketInstall(id, undefined, { type: 'skill' }).then(() => 'installed', (e) => String(e.message)), `src_${src.id}_palette`)
    assert.match(wrong, /resolve: source-item-changed/)
    assert.ok(!fs.existsSync(path.join(home, 'plugins', `src-${src.id}-palette`)), 'refused install wrote nothing')

    const skill = await win.evaluate((id) => window.tangu.marketInstall(id, undefined, { type: 'skill' }), `src_${src.id}_poster`)
    assert.equal(skill.type, 'skill'); assert.equal(skill.slug, `src-${src.id}-poster`)
    assert.ok(fs.readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8').includes('Poster layout'), 'skill files landed')
    const plugin = await win.evaluate((id) => window.tangu.marketInstall(id, undefined, { type: 'amadeus-plugin' }), `src_${src.id}_palette`)
    assert.equal(plugin.type, 'amadeus-plugin'); assert.equal(plugin.slug, `src-${src.id}-palette`)
    assert.equal(JSON.parse(fs.readFileSync(path.join(plugin.path, 'manifest.json'), 'utf8')).id, 'palette-tools')

    // Provenance on disk (written before the updater registration) and in the renderer's view.
    const statePath = path.join(home, '.store-sources', 'state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    const origin = `url:127.0.0.1:${server.address().port}`
    assert.deepEqual(state.installs.map((x) => [x.cardId, x.type, x.origin]).sort(), [[`src_${src.id}_palette`, 'amadeus-plugin', origin], [`src_${src.id}_poster`, 'skill', origin]])
    const installs = await win.evaluate(() => window.tangu.marketSourcesInstalls('zh'))
    assert.equal(installs.length, 2); assert.ok(installs.every((x) => x.sourceTitle === '图片 Skills 大全' && !x.removed))
    const updates = await win.evaluate(() => window.tangu.marketUpdateStatus())
    assert.ok(updates.items.some((x) => x.id === `src_${src.id}_palette`), 'plugin registered with the updater')

    // Uninstall removes the files and the provenance records.
    await win.evaluate((slug) => window.tangu.marketUninstall('skill', slug), skill.slug)
    await win.evaluate((slug) => window.tangu.marketUninstall('amadeus-plugin', slug), plugin.slug)
    assert.ok(!fs.existsSync(skill.path) && !fs.existsSync(plugin.path), 'files removed')
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).installs, [])
    assert.deepEqual(await win.evaluate(() => window.tangu.marketSourcesInstalls('zh')), [])

    // Removing the source keeps nothing behind.
    await win.evaluate((id) => window.tangu.marketSourcesRemove(id), src.id)
    assert.deepEqual(await win.evaluate(() => window.tangu.marketSourcesList('zh')), [])
    assert.ok(hits.includes('/pkg/poster.zip') && hits.includes('/pkg/palette.zip'))
    console.log('PASS store sources e2e: add, catalog, type-change refusal, skill + plugin install, provenance, updater registration, uninstall, remove')
  } finally {
    if (app) await app.close().catch(() => {})
    server.close(); fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
