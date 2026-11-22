// Built standalone Web + its real cloud bridge. Only the same-origin HTTP service is a fixture.
// Run after a Web build: node scripts/note-replace.e2e.cjs
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const { chromium } = require('../../desktop/node_modules/playwright-core')
const { findChromium } = require('../../desktop/scripts/lib/find-chromium.cjs')
const { startPreview } = require('../../mobile/scripts/lib/preview.cjs')
const { startStubEngine } = require('../../desktop/scripts/lib/stub-engine.cjs')

const notes = new Map([
  ['实验记录.md', '# 光谱仪\n\n先做零点校准。\n\n> 原文写作零点校准。\n'],
  ['数据复核.md', '# 复核\n\n记录 **零点校准** 的偏差。\n\n`零点校准`\n'],
])
const hash = text => crypto.createHash('sha256').update(text).digest('hex')
const first = [...notes.keys()][0]

async function main() {
  const preview = await startPreview(process.env.WEB_FIXTURE_BUILD || path.join(__dirname, '..'))
  const stub = await startStubEngine({})
  const browser = await chromium.launch({ executablePath: findChromium() })
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 820 } })
  const blobs = new Map([...notes].map(([p, content], i) => [p, { id: 'note-' + i, path: p, kind: 'page', content, seq: 1, hash: hash(content) }]))
  const lookups = [], snapshots = [], writes = [], errors = []
  let legacy = false, seq = 1
  try {
    await preview.ready()
    const origin = new URL(preview.url).origin
    await ctx.addInitScript(() => {
      localStorage.setItem('forsion_token', 'fixture.' + btoa(JSON.stringify({ userId: 'note-test' })) + '.fixture')
      localStorage.setItem('forsion_tangu_onboarding_done', '1')
      localStorage.setItem('tangu_locale', 'zh')
      window.__FORSION_PRODUCT_RUNTIME__ = { id: 'note-test', displayName: 'Forsion', defaultSpace: 'amadeus', spaces: [], nativeFeatures: ['tangu', 'amadeus'], market: false, agentBackend: false, onboarding: false }
    })
    await ctx.route('**/*', async route => {
      const req = route.request(), u = new URL(req.url())
      if (u.origin !== origin) return route.abort()
      if (!u.pathname.startsWith('/api/')) return route.continue()
      const p = u.pathname.slice(4), method = req.method()
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
      if (p === '/auth/me' || p === '/brain/users/me') return json({ userId: 'note-test', username: 'note-test', tokenValid: true })
      if (p === '/auth/region') return json({ country: 'GB' })
      if (p === '/amadeus/vaults') return json({ vaults: [{ id: 'default', name: 'Cloud fixture', lastChangeSeq: seq }] })
      if (p === '/amadeus/vaults/default/tree') return json({ pages: [...blobs.keys()], folders: [], files: [], entries: [...blobs.values()].map(({path, kind, seq}) => ({path, kind, seq})), seq })
      if (p === '/amadeus/vaults/default/replace-candidates' && method === 'POST') {
        const {query} = req.postDataJSON()
        lookups.push(query)
        return legacy ? json({ detail: 'Not Found' }, 404) : json({paths: [...blobs].filter(([,f]) => f.content.includes(query)).map(([p]) => p)})
      }
      if (p === '/amadeus/vaults/default/replace-sources' && method === 'POST') {
        const {paths} = req.postDataJSON()
        snapshots.push([...paths])
        return json({files:paths.flatMap(key => {
          const file = blobs.get(key)
          return file ? [{path:key, source:file.content, fileId:file.id}] : []
        })})
      }
      if (p === '/amadeus/vaults/default/file') {
        const patch = method === 'PUT' ? req.postDataJSON() : null
        const file = blobs.get(patch ? patch.path : u.searchParams.get('path'))
        if (!file) return json({detail:'Not Found'}, 404)
        if (!patch) return json(file)
        writes.push({ ...patch })
        if (patch.baseSeq !== file.seq || patch.expectedHash !== file.hash || patch.expectedFileId !== file.id || patch.force)
          return json({code:'CONFLICT', seq:file.seq, content:file.content}, 409)
        file.content = patch.content
        file.hash = hash(file.content)
        file.seq = ++seq
        return json({ seq: file.seq, hash: file.hash })
      }
      if (p.endsWith('/asset-token')) return json({ token: 'fixture', ttlSec: 300 })
      if (p.endsWith('/page-props') || p.endsWith('/tags') || p.endsWith('/search')) return json([])
      if (/\/(events|stream)$/.test(p)) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
      if (p.startsWith('/amadeus/')) return json({})
      return route.fulfill({response: await route.fetch({url:stub.url + p + u.search})})
    })
    const page = await ctx.newPage()
    page.setDefaultTimeout(15000)
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto(preview.url + '?ui=desktop&vault=default&note=' + encodeURIComponent(first))
      await page.locator('.amx-tree').getByText('实验记录', {exact:true}).click()
      await page.locator('.unified-body .ProseMirror').filter({hasText:'先做零点校准'}).waitFor({timeout:60000})
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+f' : 'Control+Shift+f')
      await page.getByRole('button', { name: '跨笔记替换', exact: true }).click()
      const panel = page.locator('.amx-replace-panel')
      const query = panel.getByRole('textbox', {name:'查找正文'})
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '查找正文')
      await query.fill('零点校准')
      await panel.getByRole('textbox', {name:'替换为'}).fill('零位校准')
      await page.waitForTimeout(550)
      assert.deepEqual(lookups, [], 'Typing into a cloud search should not fetch candidate files')
      assert.deepEqual(snapshots, [])
      await panel.getByRole('button', {name:'查找', exact:true}).click()
      await panel.getByText('已选 2 / 3 处').waitFor()
      assert.deepEqual(lookups, ['零点校准'])
      assert.deepEqual(snapshots.flat().sort(), [...notes.keys()].sort())
      const quote = panel.locator('.amx-replace-row').filter({hasText: '引用原文 · 保留'})
      assert.equal(await quote.getByRole('checkbox').isChecked(), false)
      const row = panel.locator('.amx-replace-context').filter({hasText:'先做零点校准'})
      await row.click()
      const mark = page.locator('.amx-replace-body .amx-replace-mark[data-active=true]')
      await mark.getByText('零位校准', {exact:true}).waitFor()
      assert.equal(writes.length, 0)
      if (process.env.NOTE_REPLACE_SCREENSHOT) await page.screenshot({path: process.env.NOTE_REPLACE_SCREENSHOT})
      await panel.getByRole('button', {name:'替换 2 处', exact:true}).click()
      await panel.getByText('已替换 1 处', {exact:true}).first().waitFor()
      assert.equal(writes.length, 2)
      assert.equal(blobs.get(first).content, notes.get(first).replace('先做零点校准', '先做零位校准'))
      assert.equal(blobs.get('数据复核.md').content, notes.get('数据复核.md').replace('**零点校准**', '**零位校准**'))
      await panel.getByRole('button', {name:/撤销/}).click()
      await panel.getByText('已撤销 1 处', {exact:true}).first().waitFor()
      assert.equal(writes.length, 4)
      for (const [p, source] of notes) assert.equal(blobs.get(p).content, source)
      legacy = true
      await panel.getByRole('button', {name:'重新预览'}).click()
      await panel.getByRole('alert').filter({hasText:'云端服务需更新后才能跨笔记替换'}).waitFor()
      assert.equal(writes.length, 4)
      assert.equal(await panel.getByRole('button', {name:/替换 0 处/}).isDisabled(), true)
      assert.deepEqual(errors, [])
      console.log('PASS standalone Web: explicit search, protected quote and code, per-match preview, two CAS writes, two CAS undos, 404 upgrade message')
    } catch (error) {
      console.error('Rendered page:', (await page.locator('body').innerText()).slice(-1800), '\nRequests:', {lookups,snapshots,writes:writes.map(w=>w.path),errors})
      throw error
    }
  } finally { await ctx.unrouteAll({behavior:'ignoreErrors'}); await ctx.close(); await browser.close(); await stub.close(); preview.kill() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
