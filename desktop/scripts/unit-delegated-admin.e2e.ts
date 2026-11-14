/**
 * Delegated admin shell, page level: the real web shell (vite dev of web/) in Chromium, with a fake device behind
 * page.route. Allow / deny is decided by the same predicates unitWeb uses (delegatedEngineAllowed /
 * delegatedNonEngineAllowed), so this harness drifts with the real route table, never with a hand-copied list.
 *
 *   · /unit/whoami answers the delegated admin role (operator name + approval cap);
 *   · allowed routes answer fixtures; everything else answers 403 LOCAL_ONLY and is recorded as an "outside hit".
 *
 * Asserts: lands on Agent management; walk list → edit description + save → disable a skill → add a schedule entry →
 * create an Agent → upload its avatar → delete it (no undo offered); idle past the poll window; owner layout untouched; zero outside hits; no local-only notice on the page; no notes / chat / calendar in the ribbon;
 * no Hooks / MCP in settings; no full-page reload.
 *
 * Run: cd desktop && npx tsx scripts/unit-delegated-admin.e2e.ts
 *   SHOT_DIR=<dir>  write screenshots (JPEG ≤1200px wide) there
 *   E2E_PORT=<port> fixed vite port (default: a free one; never 5173)
 *   KEEP_GOING=1    don't stop at the first failed step (report everything)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Page, type Route } from 'playwright-core'
import { delegatedEngineAllowed, delegatedNonEngineAllowed } from '../electron/unitWeb'
import { validateEntryInput } from '../../tangu-agent/src/services/agentSchedule'

const WEB = path.resolve(import.meta.dirname, '../../web')
const SHOT_DIR = process.env.SHOT_DIR || ''
const KEEP_GOING = process.env.KEEP_GOING === '1'

function findChromium(): string {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p } catch { /* fall through */ }
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue
    for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(root, d, rel)
        if (fs.existsSync(p)) return p
      }
    }
  }
  throw new Error('Chromium not found; set CHROMIUM_EXE')
}

const freePort = (): Promise<number> => new Promise((res, rej) => {
  const srv = net.createServer()
  srv.once('error', rej)
  srv.listen(0, () => { const { port } = srv.address() as net.AddressInfo; srv.close(() => res(port)) })
})

async function startVite(): Promise<{ url: string; stop: () => void }> {
  const port = Number(process.env.E2E_PORT) || await freePort()
  if (port === 5173) throw new Error('5173 is reserved for the user dev server')
  const child: ChildProcess = spawn('npx', ['vite', '--strictPort', '--host', '127.0.0.1'], {
    cwd: WEB, env: { ...process.env, PORT: String(port), TANGU_DEV_PROXY: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  let out = ''
  child.stdout?.on('data', (d) => { out += String(d) })
  child.stderr?.on('data', (d) => { out += String(d) })
  const stop = (): void => { try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } }
  const url = `http://127.0.0.1:${port}/`
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`vite exited: ${out}`)
    if (out.replace(/\x1b\[[0-9;]*m/g, '').includes(`:${port}/`)) return { url, stop }
    await new Promise((r) => setTimeout(r, 200))
  }
  stop()
  throw new Error(`vite did not start: ${out}`)
}

// ── fake device ────────────────────────────────────────────────────────────────────────────────────────────────
type Hit = { method: string; path: string }
const outside: Hit[] = []
const allowedHits: Hit[] = []
const writes: Hit[] = []
let approvalCap = 'auto-edit'
const agents: Array<Record<string, unknown>> = [
  { slug: 'xyra', name: 'Xyra', nameZh: '扶桑', nameEn: 'Xyra', description: '日常助手', systemPrompt: 'You help.', approvalMode: 'auto-edit', libraryDir: '/x/agents/xyra' },
  { slug: 'writer', name: 'Writer', nameZh: '写手', nameEn: 'Writer', description: '写周报', systemPrompt: 'You write.', approvalMode: 'readonly', libraryDir: '/x/agents/writer' },
  // 审批档未设(空 = 跟随会话):远端写空值会被引擎钳成上限,所以编辑器不提供「跟随会话」,显示成上限那档
  { slug: 'reader', name: 'Reader', nameZh: '读者', nameEn: 'Reader', description: '读资料', systemPrompt: 'You read.', libraryDir: '/x/agents/reader' },
]
const catalog = [
  { key: 'user:summarize', id: 'local:summarize', slug: 'summarize', name: 'Summarize', description: 'Summarize long text', scope: 'user', provenance: 'user', availability: 'available', disabled: false, disabledForAgent: false, path: '/x/skills/summarize' },
  { key: 'user:translate', id: 'local:translate', slug: 'translate', name: 'Translate', description: 'Translate text', scope: 'user', provenance: 'user', availability: 'available', disabled: false, disabledForAgent: false, path: '/x/skills/translate' },
]
const scheduleRejects: string[] = []
const schedules: Record<string, Array<Record<string, unknown>>> = { xyra: [], writer: [] }

function fixture(method: string, p: string, body: unknown): { status?: number; json?: unknown; text?: string; contentType?: string } {
  if (p === '/unit/whoami') return { json: { ok: true, role: 'delegated-admin', operator: { name: 'Alex Chen' } } }
  if (p === '/unit/config') return { json: { config: {} } }
  if (p === '/unit/plugins') return { json: { appVersion: '2.14.1', plugins: [] } }
  if (p === '/unit/spaces') return { json: { spaces: [] } }
  if (!p.startsWith('/engine/')) return { status: 404, json: { detail: 'fixture: not found' } }
  const e = p.slice('/engine'.length)
  if (e === '/health') return { json: { ok: true, sandbox: 'none', version: 'e2e' } }
  if (e === '/agent/agents' && method === 'GET') return { json: { agents, remote: true, approvalCap } }
  if (e === '/agent/agents' && method === 'POST') {
    const b = body as Record<string, unknown>
    const created = { ...b, slug: b.slug, approvalMode: approvalCap, libraryDir: `/x/agents/${b.slug}` }
    agents.push(created)
    return { json: { agent: created } }
  }
  let m = e.match(/^\/agent\/agents\/([^/]+)$/)
  if (m && method === 'PATCH') {
    const a = agents.find((x) => x.slug === m![1])
    if (!a) return { status: 404, json: { detail: 'Agent not found' } }
    Object.assign(a, body as object)
    return { json: { agent: a } }
  }
  if (m && method === 'DELETE') {
    const i = agents.findIndex((x) => x.slug === m![1])
    if (i >= 0) agents.splice(i, 1)
    return { json: { ok: true, trashId: 'trash-1' } }
  }
  if (/^\/agent\/agents\/[^/]+\/avatar$/.test(e)) return method === 'GET' ? { status: 404, json: { detail: 'no avatar' } } : { json: { ok: true, avatar: 'avatar.png' } }
  if (e === '/agent/agents-meta') return { json: { defaultSlug: 'xyra', order: [] } }
  if (e === '/agent/tool-catalog') return { json: { tools: [{ name: 'read_file', description: 'Read a file' }, { name: 'web_search', description: 'Search the web' }] } }
  if (e.startsWith('/agent/models')) return { json: { models: [{ id: 'codex/gpt-6-luna', name: 'GPT 6 Luna', provider: 'codex' }], defaultModelId: 'codex/gpt-6-luna', directProviders: [] } }
  if (e === '/agent/skills') return { json: { skills: catalog.map((c) => ({ id: c.id, name: c.name, description: c.description })) } }
  if (e === '/agent/skills/catalog') return { json: { skills: catalog } }
  m = e.match(/^\/agent\/skills\/catalog\/([^/]+)\/disabled$/)
  if (m && method === 'PUT') {
    const c = catalog.find((x) => x.key === decodeURIComponent(m![1]))
    if (c) c.disabledForAgent = !!(body as { disabled?: boolean }).disabled
    return { json: { ok: true } }
  }
  if (e === '/agent/special/schedule') return { json: { schedules: Object.entries(schedules).map(([slug, entries]) => ({ slug, name: slug, entries })) } }
  m = e.match(/^\/agent\/special\/schedule\/([^/]+)\/entries$/)
  if (m && method === 'POST') {
    const b = body as Record<string, unknown>
    // Same validation the engine runs on this route, so a malformed form body fails here too.
    const v = validateEntryInput(b as Parameters<typeof validateEntryInput>[0], { slug: m[1] })
    if (!v.ok) { scheduleRejects.push(v.error); return { status: 400, json: { detail: v.error } } }
    const entry = { id: `e${Date.now()}`, name: '', date: '', repeat: '', auto: false, prompt: '', description: '', todo: false, lastRun: '', ...b }
    ;(schedules[m[1]] ||= []).push(entry)
    return { json: { entry, created: true } }
  }
  m = e.match(/^\/agent\/special\/schedule\/([^/]+)\/entries\/([^/]+)$/)
  if (m && method === 'DELETE') { schedules[m[1]] = (schedules[m[1]] || []).filter((x) => x.id !== m![2]); return { json: { ok: true } } }
  return { status: 404, json: { detail: 'fixture: no data' } }
}

async function device(route: Route): Promise<void> {
  const req = route.request()
  const u = new URL(req.url())
  const p = u.pathname
  const method = req.method().toUpperCase()
  const engine = p === '/engine' || p.startsWith('/engine/')
  const allowed = engine ? delegatedEngineAllowed(method, p.slice('/engine'.length) || '/') : delegatedNonEngineAllowed(method, p)
  const hit = { method, path: p }
  if (!allowed || p.startsWith('/api/')) {
    outside.push(hit)
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'LOCAL_ONLY', detail: 'This action is only available on the device itself' }) })
    return
  }
  allowedHits.push(hit)
  if (method !== 'GET' && method !== 'HEAD') writes.push(hit)
  let body: unknown = null
  try { body = req.postDataJSON() } catch { body = null }
  const r = fixture(method, p, body)
  await route.fulfill({ status: r.status ?? 200, contentType: r.contentType ?? 'application/json', body: r.text ?? JSON.stringify(r.json ?? {}) })
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────────────────────
const results: Array<{ name: string; ok: boolean; detail?: string }> = []
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
  if (!ok && !KEEP_GOING) throw new Error(`step failed: ${name}`)
}

const LOCAL_ONLY_ZH = '只能在那台设备本机上进行'

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const png = path.join(SHOT_DIR, `${name}.png`)
  await page.screenshot({ path: png })
  // ≤1200px JPEG for the report (sips is macOS; fall back to the PNG elsewhere)
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('sips', ['-Z', '1200', '-s', 'format', 'jpeg', png, '--out', path.join(SHOT_DIR, `${name}.jpg`)], { stdio: 'ignore' })
    fs.rmSync(png)
  } catch { /* keep png */ }
}

async function main(): Promise<void> {
  const vite = await startVite()
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const errors: string[] = []
  let navigations = 0
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'zh-CN' })
    await ctx.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>
      w.__FORSION_UNIT_PAGE__ = { instanceId: 'delegated-fixture', name: 'Studio Mac', version: '2.14.1', projection: 'local', localCapabilities: { vault: true, engine: true, host: true } }
      w.__FORSION_PRODUCT_RUNTIME__ = { id: 'basic', displayName: 'Forsion', productName: 'Forsion', appId: 'com.forsion.basic', defaultSpace: 'home', spaces: [], nativeFeatures: ['tangu', 'amadeus', 'automation'], market: false, agentBackend: true, onboarding: false, unit: true }
      try {
        localStorage.setItem('tangu_locale', 'zh')
        // A stale layout from an earlier owner session must not pull the shell into notes.
        // The owner's saved layout (same browser) must be neither restored into this role nor overwritten by it.
        if (!sessionStorage.getItem('e2e-seeded')) {
          localStorage.setItem('forsion_tangu_active_space', 'amadeus')
          localStorage.setItem('tangu2_layout_v4', 'OWNER-LAYOUT')
          sessionStorage.setItem('e2e-seeded', '1')
        }
      } catch { /* ignore */ }
    })
    // Pathname prefix only: vite serves modules from paths like /@fs/…/services/engine/targets.ts.
    await ctx.route((u) => /^\/(?:unit|vault|engine|api)(?:\/|$)/.test(u.pathname), device)
    await ctx.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback()
      const response = await route.fetch()
      const html = (await response.text()).replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
      return route.fulfill({ response, body: html })
    })
    // TRACE=<substring>: print the JS stack of every fetch whose URL contains it (find who sends an outside request).
    if (process.env.TRACE) await ctx.addInitScript((needle: string) => {
      const orig = window.fetch
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (u.includes(needle)) console.log('[trace]', u, new Error().stack)
        return orig.call(this, input, init)
      } as typeof fetch
    }, process.env.TRACE)
    const page = await ctx.newPage()
    if (process.env.TRACE) page.on('console', (m) => { if (m.text().startsWith('[trace]')) console.log(m.text().slice(0, 2000)) })
    page.on('pageerror', (e) => errors.push(String(e.stack || e)))
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++ })
    if (process.env.MOBILE === '1') {
      // Phone shell (web loads the mobile entry for ?ui=mobile): boot only, then count outside hits.
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(vite.url + '?ui=mobile', { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-agents-space], .agents-roster', { timeout: 120_000 }).catch(() => null)
      await page.waitForTimeout(6000)
      await shot(page, 'admin-home-phone')
      check('phone shell: lands on Agent management', await page.locator('[data-agents-space], .agents-roster').count() > 0)
      check('phone shell: outside-whitelist hits = 0', outside.length === 0, outside.map((h) => `${h.method} ${h.path}`).join(' ; '))
      check('phone shell: no page errors', errors.length === 0, errors.slice(0, 3).join(' || '))
      return
    }
    await page.goto(vite.url, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.rb', { timeout: 120_000 })
    await page.waitForSelector('[data-agents-space]', { timeout: 30_000 }).catch(() => null)
    await page.waitForTimeout(3000)

    check('lands on Agent management', await page.locator('[data-agents-space]').count() > 0)
    check('role is visible to the shell', await page.evaluate(() => !!(window as unknown as { tangu?: { delegatedAdmin?: unknown } }).tangu?.delegatedAdmin))
    await shot(page, 'admin-home-light')

    // Ribbon: only Agent management related spaces.
    const spaces = await page.$$eval('[data-space-id]', (els) => [...new Set(els.map((e) => e.getAttribute('data-space-id')))])
    check('ribbon has no notes / chat / calendar / inbox', !spaces.some((s) => ['amadeus', 'tangu', 'calendar', 'inbox', 'home'].includes(String(s))), `spaces=${spaces.join(',')}`)
    const ribbonLabels = await page.locator('.rb button[aria-label], .rb [role="button"][aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    check('ribbon has no command palette / achievements / store / account', !ribbonLabels.some((l) => /命令面板|成就|商店|账号/.test(String(l))), ribbonLabels.join(','))
    // The new-tab launcher must not offer notes / chat / calendar either.
    await page.locator('.wb-tabs-new, [aria-label="新建标签页"], button[title="新建标签页"]').first().click().catch(() => null)
    await page.waitForTimeout(800)
    await shot(page, 'admin-launcher-light')
    await page.keyboard.press('Escape')

    // List → edit description → save
    await page.locator('.agents-roster-item', { hasText: '写手' }).first().click()
    await page.waitForSelector('[data-agent-profile="writer"]')
    const desc = page.locator('[data-agent-profile="writer"] .agent-character-desc')
    await desc.fill('写周报和月报')
    await page.locator('.agent-profile-save .btn.primary').click()
    await page.waitForFunction(() => !document.querySelector('.agent-profile-save.is-dirty'), null, { timeout: 10_000 })
    check('edit description saved', agents.find((a) => a.slug === 'writer')?.description === '写周报和月报')

    // Editor: dropped toggles absent, approval options above the cap not offered.
    const profile = page.locator('[data-agent-profile="writer"]')
    for (const d of await profile.locator('details.profile-disclosure').all()) await d.evaluate((el) => { (el as HTMLDetailsElement).open = true })
    const tabs = await profile.getByRole('tab').allInnerTexts()
    check('editor shows only config / skills / schedule tabs', tabs.length === 3, tabs.join(','))
    const dropped = await profile.locator('[data-field="activityAccess"], [data-field="cloudSync"], [data-standin], .agent-standin-group').count()
    const editorText = await profile.innerText()
    check('editor hides activity history / cloud sync / stand-in settings', dropped === 0 && !editorText.includes('分身'), `dropped=${dropped}`)
    await profile.locator('[data-profile-field="approval"] .profile-model-trigger').click()
    await page.waitForSelector('[data-profile-field="approval"] [role="option"]')
    await profile.locator('[data-profile-field="approval"]').scrollIntoViewIfNeeded()
    await page.waitForTimeout(600) // let the option list finish its entrance before the screenshot
    const offered = await profile.locator('[data-profile-field="approval"] [role="option"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-value')))
    check('approval options stop at the remote cap (auto-edit)', !offered.includes('full-auto') && !offered.includes('custom') && !offered.includes('') && offered.includes('readonly') && offered.includes('auto-edit'), `offered=${offered.join(',')}`)
    check('approval cap hint shown', (await profile.locator('[data-approval-cap="auto-edit"]').count()) === 1)
    await shot(page, 'admin-editor-light')
    await page.keyboard.press('Escape')

    // An Agent whose approval mode is unset: shown as the cap, no "follow session" option, opening it writes nothing.
    const writesBefore = writes.length
    await page.locator('.agents-roster-item', { hasText: '读者' }).first().click()
    const reader = page.locator('[data-agent-profile="reader"]')
    await reader.waitFor()
    const shown = await reader.locator('[data-profile-field="approval"] .profile-model-trigger').innerText()
    await reader.locator('[data-profile-field="approval"] .profile-model-trigger').click()
    await page.waitForSelector('[data-agent-profile="reader"] [data-profile-field="approval"] [role="option"]')
    const readerOffered = await reader.locator('[data-profile-field="approval"] [role="option"]').evaluateAll((els) => els.map((e) => ({ v: e.getAttribute('data-value'), sel: e.getAttribute('aria-selected') })))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
    check('unset approval shows the cap, no follow-session option, nothing saved on open', readerOffered.every((o) => o.v !== '') && readerOffered.find((o) => o.sel === 'true')?.v === 'auto-edit'
      && writes.length === writesBefore && (await reader.locator('.agent-profile-save.is-dirty').count()) === 0, `shown=${shown} offered=${JSON.stringify(readerOffered)}`)
    await page.locator('.agents-roster-item', { hasText: '写手' }).first().click()
    await page.waitForSelector('[data-agent-profile="writer"]')

    // Disable a skill for this Agent
    await page.getByRole('tab', { name: '技能' }).click()
    const skillBox = page.getByRole('checkbox', { name: /Translate/ }).first()
    await skillBox.waitFor({ timeout: 10_000 })
    await skillBox.uncheck()
    await page.waitForTimeout(800)
    check('skill disabled for the Agent', catalog.find((c) => c.key === 'user:translate')?.disabledForAgent === true)

    // Add a schedule entry
    await page.getByRole('tab', { name: '日程' }).click()
    await page.locator('[data-act="schedule-new"]').click()
    await page.locator('[data-schedule-form] input[name="name"]').fill('周五写周报')
    await page.locator('[data-schedule-form] input[name="date"]').fill('2026-11-20T09:00')
    await page.locator('[data-schedule-form] textarea[name="prompt"]').fill('写本周周报')
    await shot(page, 'admin-schedule-form-light')
    await page.locator('[data-schedule-form] button[type="submit"]').click()
    await page.waitForSelector('[data-schedule-entry]', { timeout: 10_000 })
    check('schedule entry created', (schedules.writer || []).some((x) => x.name === '周五写周报'))

    // Create an Agent
    await page.locator('.agents-roster-create').click()
    await page.locator('.agent-create-form input').first().fill('研究员')
    await page.getByLabel('英文名').fill('Researcher')
    await page.locator('.agent-create-form textarea').fill('You research.')
    await page.locator('.agent-create-form button[type="submit"]').click()
    await page.waitForSelector('[data-agent-profile="researcher"]', { timeout: 10_000 })
    check('new Agent created', agents.some((a) => a.slug === 'researcher'))
    check('schedule body passes the engine validator', scheduleRejects.length === 0, scheduleRejects.join(' ; '))

    // Avatar upload on the new Agent
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
    await page.locator('[data-agent-profile="researcher"] .agent-portrait-edit input[type="file"]').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: png })
    await page.waitForTimeout(1200)
    check('avatar uploaded', writes.some((w) => w.method === 'POST' && w.path === '/engine/agent/agents/researcher/avatar'))

    // Delete the new Agent: roster menu → confirm; the done notice offers no undo (restore is not reachable remotely)
    await page.locator('.agents-roster-row', { hasText: '研究员' }).first().locator('.agents-roster-more').click()
    await page.getByRole('menuitem', { name: '删除' }).click()
    await page.locator('.un-dlg button[data-danger]').click()
    await page.waitForTimeout(1200)
    check('Agent deleted', !agents.some((a) => a.slug === 'researcher') && writes.some((w) => w.method === 'DELETE' && w.path === '/engine/agent/agents/researcher'))
    check('delete notice offers no undo', (await page.getByRole('button', { name: '撤销' }).count()) === 0)

    // Pollers: tab hidden → visible + focus, then idle past the 15s poll window; nothing outside may go out.
    // (string form: tsx's keepNames wraps inline getters in __name, which the page doesn't have)
    await page.evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return 'hidden' } })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return 'visible' } })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })()`)
    await page.waitForTimeout(16_000)
    check('visibility / focus / 16s idle: outside-whitelist hits = 0', outside.length === 0, outside.map((h) => `${h.method} ${h.path}`).join(' ; '))

    // Settings: only Agent / skills pages
    await page.locator('.rb').getByRole('button', { name: '设置' }).first().click()
    await page.waitForSelector('.settings-nav, [data-settings-tab], .settings-modal', { timeout: 10_000 }).catch(() => null)
    await page.waitForTimeout(1500)
    const navText = await page.evaluate(() => (document.querySelector('.settings-nav, .settings-sidebar, [class*="settings"][class*="nav"]') as HTMLElement | null)?.innerText || '')
    check('settings nav shows Agent / skills only (no Hooks / MCP / sync / channels / models)', /Agent/.test(navText) && /技能/.test(navText) && !/Hooks|MCP|同步|通道|模型|常规/.test(navText), navText.replace(/\n+/g, ' / '))
    await shot(page, 'admin-settings-light')
    await page.getByRole('button', { name: '技能', exact: true }).first().click()
    await page.waitForTimeout(1500)
    check('settings skills page is a read-only list', (await page.locator('[data-delegated-admin]').count()) > 0 && (await page.locator('.gsk-row[data-skill-key]').count()) === 2)
    await page.locator('.gsk-row[data-skill-key]').first().click()
    await page.waitForTimeout(500)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    // Keyboard entries that survive the ribbon trim (command palette, quick find): opening them must not send anything outside.
    await page.keyboard.press('Meta+k'); await page.waitForTimeout(800)
    const palette = await page.locator('body').innerText()
    check('command palette offers no chat / notes / quick find', !/新对话|新建笔记|打开笔记|快速查找|成就/.test(palette.split('设置').slice(-1)[0] ?? palette))
    await page.keyboard.press('Escape'); await page.waitForTimeout(300)
    await page.keyboard.press('Meta+p'); await page.waitForTimeout(800); await page.keyboard.press('Escape'); await page.waitForTimeout(300)

    // Dark first screen
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.evaluate(() => { localStorage.setItem('forsion_theme', 'dark') })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-agents-space]', { timeout: 60_000 })
    await page.waitForTimeout(2500)
    await shot(page, 'admin-home-dark')

    const layouts = await page.evaluate(() => ({ owner: localStorage.getItem('tangu2_layout_v4'), scoped: Object.keys(localStorage).filter((k) => k.startsWith('tangu2_layout_v4:account:')) }))
    check('owner layout untouched; this role keeps its own', layouts.owner === 'OWNER-LAYOUT' && layouts.scoped.length > 0, JSON.stringify(layouts))
    const body = await page.locator('body').innerText()
    check('no local-only notice on the page', !body.includes(LOCAL_ONLY_ZH))
    check('outside-whitelist hits = 0', outside.length === 0, outside.map((h) => `${h.method} ${h.path}`).join(' ; '))
    check('no reload loop (2 navigations: boot + the dark reload)', navigations <= 2, `navigations=${navigations}`)
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' || '))
  } finally {
    fs.writeFileSync(path.join(SHOT_DIR || os.tmpdir(), 'delegated-admin-report.json'), JSON.stringify({ results, outside, allowed: allowedHits, writes }, null, 2))
    await browser.close()
    vite.stop()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed; outside hits ${outside.length}; allowed hits ${allowedHits.length}; writes ${writes.map((w) => `${w.method} ${w.path}`).join(', ')}`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => { console.error(e); console.log(`outside hits so far (${outside.length}):\n` + [...new Set(outside.map((h) => `${h.method} ${h.path}`))].join('\n')); process.exitCode = 1 })
