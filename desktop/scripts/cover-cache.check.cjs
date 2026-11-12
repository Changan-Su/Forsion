// Real Chromium + production NoteCover/CoverPicker + real IndexedDB.
// npm run check:covercache; set HARNESS_URL to an isolated worktree's harness.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chromium } = require('playwright-core')
const URL_ROOT = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const SHOTS = process.env.COVER_SHOTS || path.join(os.tmpdir(), 'forsion-cover-cache-shots')
fs.mkdirSync(SHOTS, { recursive: true })
function executable() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('Set CHROMIUM_EXE')
}
let passed = 0
function check(name, condition) { assert.ok(condition, name); passed++; console.log(`PASS ${name}`) }
const imageReady = (p) => p.waitForFunction(() => {
  const i = document.querySelector('.amx-cover img')
  return i && i.naturalWidth > 0 && !i.hidden
}).catch(async (error) => {
  console.error(await p.evaluate(() => ({ title: document.title, text: document.body.innerText.slice(0, 1800), images: [...document.querySelectorAll('.amx-cover img')].map((i) => ({ src: i.src, hidden: i.hidden, width: i.naturalWidth })) })))
  throw error
})
async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-cover-cache-profile-'))
  const launch = () => chromium.launchPersistentContext(profile, { executablePath: executable(), headless: true, viewport: { width: 1200, height: 850 }, locale: 'zh-CN' })
  let context = await launch()
  try {
    const p = await context.newPage()
    const errors = []
    p.on('pageerror', (e) => { errors.push(e.message); console.error('pageerror', e.message) })
    const gen = await context.newPage()
    const png = Buffer.from(await gen.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 1600; c.height = 900
      const g = c.getContext('2d'); g.fillStyle = '#7195b5'; g.fillRect(0, 0, c.width, c.height)
      g.fillStyle = '#c1d3bc'; g.fillRect(0, 500, 1600, 400)
      return c.toDataURL('image/png').split(',')[1]
    }), 'base64')
    await gen.close()
    let blocked = false, requests = 0, holdThumbnail = false
    const heldThumbnails = []
    await context.route('https://images.unsplash.com/**', (route) => {
      requests++
      if (holdThumbnail) { heldThumbnails.push(route); return }
      return blocked ? route.abort() : route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: png })
    })
    const cover = 'https://images.unsplash.com/photo-1470770841072-f978cf4d019e?cover-cache-test'
    const md = `---\ncover: ${cover}\ncover_y: 37\n---\n# Cover cache\n\nKeep this body unchanged.\n`
    const target = `${URL_ROOT}?upage&upane&useed=${encodeURIComponent(md)}`
    await p.goto(target, { waitUntil: 'domcontentloaded' })
    await imageReady(p)
    check('Remote cover displays through a cached Blob', await p.locator('.amx-cover img').getAttribute('src').then((s) => s.startsWith('blob:')))
    check('Cache load never rewrites frontmatter/body', await p.evaluate(() => window.__upage.writes.length === 0))
    const initial = requests
    blocked = true
    await p.reload({ waitUntil: 'domcontentloaded' })
    await imageReady(p)
    check('Full cover survives reload with image network blocked', requests === initial)
    await p.hover('.amx-cover')
    await p.locator('.amx-cover-tools button').filter({ hasText: '更换封面' }).click()
    await p.waitForSelector('.amx-coverpick-failed')
    check('Uncached thumbnails show an actionable failure', await p.locator('.amx-coverpick-failed').count() > 0)
    blocked = false
    holdThumbnail = true
    await p.locator('.amx-coverpick-item').first().click()
    await p.waitForFunction(() => document.querySelector('.amx-coverpick-item')?.getAttribute('aria-busy') === 'true')
    await p.locator('.amx-coverpick-item').first().click()
    check('Repeated clicks during thumbnail retry never select an unready image', await p.evaluate(() => window.__upage.writes.length === 0))
    holdThumbnail = false
    for (const route of heldThumbnails) await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: png })
    await p.waitForFunction(() => {
      const i = document.querySelector('.amx-coverpick-item img')
      return i && i.naturalWidth > 0 && !i.hidden
    })
    check('Failed thumbnail click retries without selecting a broken cover', await p.evaluate(() => window.__upage.writes.length === 0))
    await p.getByRole('button', { name: '关闭封面选择器', exact: true }).click()
    // Warm the entire gallery, reopen offline and select a different cover.
    await p.hover('.amx-cover')
    await p.locator('.amx-cover-tools button').filter({ hasText: '更换封面' }).click()
    await p.waitForFunction(() => [...document.querySelectorAll('.amx-coverpick-item img')].length === 12 && [...document.querySelectorAll('.amx-coverpick-item img')].every((i) => i.naturalWidth > 0))
    check('All featured images use Unsplash and persist locally', await p.locator('.amx-coverpick-item img').evaluateAll((imgs) => imgs.every((i) => i.src.startsWith('blob:'))))
    await p.screenshot({ path: path.join(SHOTS, 'gallery-light.png') })
    await p.getByRole('button', { name: '关闭封面选择器', exact: true }).click()
    const warm = requests
    blocked = true
    await p.reload({ waitUntil: 'domcontentloaded' })
    await imageReady(p)
    await p.hover('.amx-cover')
    await p.locator('.amx-cover-tools button').filter({ hasText: '更换封面' }).click()
    await p.waitForFunction(() => [...document.querySelectorAll('.amx-coverpick-item img')].length === 12 && [...document.querySelectorAll('.amx-coverpick-item img')].every((i) => i.naturalWidth > 0))
    check('Gallery thumbnails survive reload offline', requests === warm)
    await p.getByRole('textbox', { name: '搜索精选图片…', exact: true }).fill('森林')
    await p.getByRole('button', { name: '搜索', exact: true }).click()
    check('Chinese search filters the Unsplash collection', await p.locator('.amx-coverpick-item').count() === 1)
    await p.getByRole('textbox', { name: '搜索精选图片…', exact: true }).fill('no-matching-photo')
    await p.getByRole('button', { name: '搜索', exact: true }).click()
    check('Empty search explicitly reports no matching picks', await p.locator('.amx-coverpick-item').count() === 0 && await p.getByText('未找到匹配的精选图片，可使用链接或上传。').isVisible())
    await p.getByRole('button', { name: '关闭封面选择器', exact: true }).click()
    // No cache for this legacy Picsum URL; assert failure and preserve the original choice.
    await context.route('https://picsum.photos/**', (route) => route.abort())
    const legacy = 'https://picsum.photos/seed/aurora/1600/900'
    const failedMd = md.replace(cover, legacy)
    await p.goto(`${URL_ROOT}?upage&upane&udark&useed=${encodeURIComponent(failedMd)}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.amx-cover-error')
    check('Legacy Picsum failure displays retry/change actions', await p.locator('.amx-cover-error button').count() === 3)
    check('Legacy failure preserves the saved URL and body', await p.evaluate(() => window.__upage.writes.length === 0 && window.__upage.vault.get('Unified.md').includes('picsum.photos/seed/aurora')))
    await p.screenshot({ path: path.join(SHOTS, 'cover-failure-dark.png') })
    await p.locator('.amx-cover-error').getByRole('button', { name: '移除', exact: true }).click()
    await p.waitForFunction(() => !document.querySelector('.amx-cover'))
    check('A failed cover remains removable', await p.locator('.amx-cover').count() === 0)
    await p.goto(`${URL_ROOT}?upage&upane&udark&useed=${encodeURIComponent(failedMd)}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.amx-cover-error')
    await p.getByRole('button', { name: '更换封面', exact: true }).first().click()
    await p.locator('.amx-coverpick-item').first().click()
    await p.waitForSelector('.amx-cover-error')
    check('Selecting an uncached full image offline reports failure', await p.locator('.amx-cover-error').isVisible())
    blocked = false
    await p.getByRole('button', { name: '关闭封面选择器', exact: true }).click()
    await p.locator('.amx-cover-error').getByRole('button', { name: '重试', exact: true }).click()
    await imageReady(p)
    check('Cover retry recovers when the network returns', await p.locator('.amx-cover-error').count() === 0)
    await p.waitForFunction(() => window.__upage.writes.some((w) => w.text.includes('images.unsplash.com') && w.text.includes('Keep this body unchanged.') && w.text.includes('cover_y: 37')))
    check('Changing cover saves a portable URL and preserves body/focal point', true)
    check('No uncaught React/runtime errors', errors.length === 0)
    const uncached = await context.newPage()
    await uncached.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Storage unavailable') } }) })
    await uncached.goto(target, { waitUntil: 'domcontentloaded' })
    await imageReady(uncached)
    check('Unavailable local storage still displays the image and warns', await uncached.locator('.amx-cover-cache-hint').isVisible())
    await uncached.close()
    // Concurrent requests for one URL download once, without persisting invalid responses.
    const concurrentBefore = requests
    await p.evaluate(async () => {
      const { loadCoverImage } = await import('/src/amadeus/chrome/coverImageCache.ts')
      await Promise.all(Array.from({ length: 4 }, () => loadCoverImage('https://images.unsplash.com/coalesced-test')))
    })
    check('Concurrent loads share one download', requests === concurrentBefore + 1)
    await context.route('https://images.unsplash.com/invalid-test', (r) => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: 'not an image' }))
    const invalid = await p.evaluate(async () => {
      const { loadCoverImage } = await import('/src/amadeus/chrome/coverImageCache.ts')
      return loadCoverImage('https://images.unsplash.com/invalid-test').then(() => false, () => true)
    })
    check('Invalid image responses are rejected before caching', invalid)
    const resources = await p.evaluate(async () => {
      const { loadCoverImage } = await import('/src/amadeus/chrome/coverImageCache.ts')
      const originalFetch = window.fetch
      let active = 0, peak = 0, started = 0, canceled = 0
      window.fetch = (url, init) => String(url).includes('/resource-test/') ? new Promise((_resolve, reject) => {
        active++; started++; peak = Math.max(peak, active)
        init.signal.addEventListener('abort', () => { active--; canceled++; reject(init.signal.reason) }, { once: true })
      }) : originalFetch(url, init)
      const wait = async (test) => { for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 10)); if (!test()) throw new Error('Resource probe did not start') }
      try {
        const a = new AbortController(), b = new AbortController()
        const shared = [loadCoverImage('https://images.unsplash.com/resource-test/shared', false, a.signal), loadCoverImage('https://images.unsplash.com/resource-test/shared', false, b.signal)]
        const sharedDone = Promise.allSettled(shared)
        await wait(() => active === 1)
        a.abort()
        const retained = active === 1
        b.abort()
        await sharedDone
        const sharedCanceled = canceled === 1
        peak = started = canceled = 0
        const controllers = Array.from({ length: 8 }, () => new AbortController())
        const done = Promise.allSettled(controllers.map((c, i) => loadCoverImage(`https://images.unsplash.com/resource-test/${i}`, false, c.signal)))
        await wait(() => active === 4)
        controllers.forEach((c) => c.abort())
        await done
        await wait(() => active === 0)
        return { retained, sharedCanceled, peak, started, canceled }
      } finally { window.fetch = originalFetch }
    })
    check('Shared download stays alive until its last consumer leaves', resources.retained && resources.sharedCanceled)
    check('Downloads are capped at four; abandoned active/queued loads are canceled', resources.peak === 4 && resources.started === 4 && resources.canceled === 4)
    let localRequests = 0
    await context.route('**/cached-asset.png', (r) => { localRequests++; return r.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'no-store' }, body: png }) })
    const localUrl = new URL('/cached-asset.png', URL_ROOT).href
    await p.goto(`${URL_ROOT}?upage&upane&useed=${encodeURIComponent(md.replace(cover, localUrl))}`, { waitUntil: 'domcontentloaded' })
    await imageReady(p)
    const localBefore = localRequests
    await p.reload({ waitUntil: 'domcontentloaded' })
    await imageReady(p)
    check('Native/local asset URLs bypass the remote cache and reload current bytes', localRequests > localBefore && await p.locator('.amx-cover img').getAttribute('src').then((src) => src === localUrl))
    await context.close()
    context = await launch()
    let restartedRequests = 0
    await context.route('https://images.unsplash.com/**', (r) => { restartedRequests++; return r.abort() })
    const restarted = await context.newPage()
    await restarted.goto(target, { waitUntil: 'domcontentloaded' })
    await imageReady(restarted)
    check('Cache survives a complete browser restart with network blocked', restartedRequests === 0)
    console.log(`${passed} passed; screenshots: ${SHOTS}`)
    await context.close()
  } finally { await context.close(); fs.rmSync(profile, { recursive: true, force: true }) }
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
