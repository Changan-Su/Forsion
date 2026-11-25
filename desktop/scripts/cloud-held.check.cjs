/**
 * 文件夹同步「先放着」的界面接线 × 真 Electron(2026-11-25,云同步稳定性方案 #r2 第四节第 1 条)。
 *
 * 引擎(Forsion Extend 0.10.13+)遇到「两边都有、内容不同、又没有同步记录」的文件不再出冲突副本,而是先放着,
 * 状态里带 held 列表(同时以 reason 'HELD' 列进 skipped,给旧界面看)。这里停用随包 Extend,在渲染层桩一个
 * window.amadeusSync,报一个按条目同步的库有 3 篇待定,钉住:
 *  ① 本地侧左栏「云同步」分区挂出「3 篇和云端不一样，等你定」,跳过行不重复数它们(HELD 被滤掉);
 *  ② 「逐篇看」展开每篇和「哪边更新」;勾掉一篇后点「用这台的」→ resolveHeld({ binding: 库根, paths: 其余两篇, choice: 'local' });
 *  ③ 状态栏同步项显示「3 篇等你定」;
 *  ④ 旧 Extend(没有 resolveHeld)时按钮不可点。
 *
 * 需先 npm run build(读 out/)。用法:node scripts/cloud-held.check.cjs [--shots=<目录>](亮 / 暗各一张)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.join(__dirname, '..')
const SHOTS = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8)
const results = []
const check = (name, ok, detail) => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`) }

const DIR = 'Course Notes'

function stub(cfg) {
  window.__resolveCalls = []
  const day = (d) => Date.parse(`2026-11-${d}T10:00:00Z`)
  const held = [1, 2, 3].map((i) => ({
    path: `${cfg.cloudName}/${cfg.dir}/Lecture ${i}.md`,
    local: `${cfg.dir}/Lecture ${i}.md`,
    localHash: `l${i}`.padEnd(64, '0'), localSize: 1200 + i, localMtimeMs: i === 3 ? day(1) : day(24),
    remoteSeq: 1, remoteHash: `r${i}`.padEnd(64, '0'), remoteUpdatedAt: '2026-11-13T05:37:00.000Z', since: day(24),
  }))
  const entry = {
    enabled: true, state: 'idle', lastSyncAt: Date.now(), pending: 0, conflicts: 0, error: null, pendingDeletions: 0, maxFileBytes: null,
    skipped: [{ path: `${cfg.cloudName}/${cfg.dir}/Big.pdf`, reason: 'TOO_LARGE' }, ...held.map((h) => ({ path: h.path, reason: 'HELD' }))],
    held, heldCount: held.length, binding: cfg.root,
  }
  const mirror = { enabled: true, state: 'idle', lastSyncAt: Date.now(), pending: 0, conflicts: 0, skipped: [], error: null, pendingDeletions: 0, maxFileBytes: null, held: [], heldCount: 0, side: 'local' }
  window.amadeusSync = {
    get: async () => mirror,
    syncNow: async () => mirror,
    onStatus: (cb) => { setTimeout(() => cb(entry), 300); setTimeout(() => cb(entry), 3000); return () => {} },
    onEntrySyncChange: () => () => {},
    entrySyncGet: async () => ({ vaults: [{ vaultRoot: cfg.root, cloudName: cfg.cloudName, entries: [{ path: cfg.dir, kind: 'folder' }] }], activeRoot: cfg.root, cloudRoot: '', mirrorVaults: [], mirrorVaultDevices: {}, deviceId: 'desk-me' }),
    entrySyncEnable: async () => ({ ok: true }),
    entrySyncDisable: async () => ({ ok: true }),
    entrySyncClosure: async () => ({ pages: [], files: [], subPages: [] }),
    entrySyncMark: async () => ({ ok: true }),
    ...(cfg.old ? {} : { resolveHeld: async (payload) => { window.__resolveCalls.push(payload); return entry } }),
  }
}

async function run({ old }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-held-')))
  const vault = path.join(home, 'Notes')
  for (const p of [1, 2, 3, 4].map((i) => `${DIR}/Lecture ${i}.md`).concat(['Inbox.md'])) {
    fs.mkdirSync(path.dirname(path.join(vault, p)), { recursive: true }); fs.writeFileSync(path.join(vault, p), `# ${path.basename(p, '.md')}\n`)
  }
  for (const ud of ['userdata', 'userdata-dev']) {
    fs.mkdirSync(path.join(home, ud), { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(home, ud, f), JSON.stringify({ lastVault: vault, localVault: vault }))
    // 随包 Extend 在时 window.amadeusSync 是 contextBridge 暴露的真对象、改不动;停用它,桩才接得上。
    fs.writeFileSync(path.join(home, ud, 'tangu-desktop-config.json'), JSON.stringify({ disabledBundles: ['forsion-extend'] }))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1' },
  })
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 860))
    await win.addInitScript(stub, { root: vault, cloudName: 'Notes', dir: DIR, old })
    await win.waitForSelector('#root', { timeout: 30_000 })
    if (!old) check('跳过首启引导', await skipOnboarding(win))
    else await skipOnboarding(win)
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'amadeus')`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.amx-tree .amx-sec-head', { timeout: 30_000 })
    // 「云同步」分区缺省收着:点开它
    await win.locator('.amx-tree .amx-sec-head', { hasText: '云同步' }).first().click()
    await win.waitForSelector('.amx-tree .amx-cs-row', { timeout: 15_000 }).catch(() => {})
    const notice = win.locator('.amx-tree .amx-held').first()
    await notice.waitFor({ timeout: 15_000 }).catch(() => {})
    const title = await notice.locator('.amx-held-title').textContent().catch(() => '')
    if (old) {
      await notice.locator('.amx-held-link').click()
      const disabled = await notice.locator('.amx-held-actions button').evaluateAll((bs) => bs.map((b) => b.disabled))
      check('④ 旧 Extend(没有 resolveHeld):四个按钮都不可点', disabled.length === 4 && disabled.every(Boolean), JSON.stringify(disabled))
      return
    }
    check('① 左栏「云同步」分区挂出待定条', title === '3 篇和云端不一样，等你定', title)
    const skipRow = await win.locator('.amx-tree .amx-cs-warn').first().textContent().catch(() => '')
    check('① 跳过行只数真正跳过的(HELD 滤掉)', skipRow.includes('1 项未同步'), skipRow)
    const bar = await win.locator('.sb-click', { hasText: '等你定' }).first().textContent().catch(() => '')
    check('③ 状态栏显示「3 篇等你定」', bar.includes('3 篇等你定'), bar)
    await notice.locator('.amx-held-link').click()
    const rows = await notice.locator('.amx-csd-item').evaluateAll((ls) => ls.map((l) => l.textContent))
    check('② 逐篇看:三篇,各标哪边更新', rows.length === 3 && rows[0].includes('这台更新') && rows[2].includes('云端更新'), JSON.stringify(rows))
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true })
      await win.waitForTimeout(600)
      const box = await win.locator('.amx-tree').first().boundingBox()
      await win.screenshot({ path: path.join(SHOTS, 'held-sidebar-light.png'), clip: { x: 0, y: 0, width: Math.min(1280, (box?.x ?? 0) + (box?.width ?? 360) + 40), height: 860 } })
      await win.evaluate(() => { document.documentElement.dataset.mode = 'dark'; document.documentElement.classList.add('dark') })
      await win.waitForTimeout(300)
      await win.screenshot({ path: path.join(SHOTS, 'held-sidebar-dark.png'), clip: { x: 0, y: 0, width: Math.min(1280, (box?.x ?? 0) + (box?.width ?? 360) + 40), height: 860 } })
      await win.evaluate(() => { document.documentElement.dataset.mode = 'light'; document.documentElement.classList.remove('dark') })
      await win.screenshot({ path: path.join(SHOTS, 'held-window.png') })
    }
    await notice.locator('.amx-csd-item input').nth(2).click()
    await notice.locator('.amx-held-actions button', { hasText: '用这台的' }).click()
    await win.waitForTimeout(200)
    const calls = await win.evaluate(() => window.__resolveCalls)
    check('② 勾掉一篇后点「用这台的」:只处理勾着的两篇,带上库根', JSON.stringify(calls) === JSON.stringify([{ binding: vault, paths: [`Notes/${DIR}/Lecture 1.md`, `Notes/${DIR}/Lecture 2.md`], choice: 'local' }]), JSON.stringify(calls))
  } finally {
    await app.close()
  }
}

async function main() {
  await run({ old: false })
  await run({ old: true })
  const failed = results.filter((x) => !x).length
  console.log(failed ? `\n${failed} FAIL` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
