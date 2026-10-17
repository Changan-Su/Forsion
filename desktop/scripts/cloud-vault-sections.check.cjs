/**
 * Amadeus Cloud 侧「同步库分区」× 真 Electron(10-17 云同步分区方案 B)。
 *
 * 真同步要签过名的 Forsion Extend,本地改的装不进来 —— 这里停用随包 Extend(disabledBundles),在渲染层桩一个 window.amadeusSync(数据面),
 * 左栏组件、CSS、菜单全是本检出的真代码;隔离 home 里的库按云镜像的样子摆好文件夹,桩把侧别报成 cloud。
 *
 * 钉住:
 *  ① 同步库分区排在「Cloud工作区」前面,Cloud工作区 在最后;
 *  ② 分区头的设备标签:标记里的设备名、本机写「本机」、多台写 +N;本机注册表里条目全关掉的记录不占分区;
 *     本机刚开、标记还没拉回来的库也算上「本机」;
 *  ③ Cloud工作区 里的根文件夹右键有「设为同步库分区」,点了调 entrySyncMark(name, true);
 *     手动 / 旧标记的分区头右键只有「不再作为同步库分区」→ entrySyncMark(name, false);本机在同步、或标记里记着设备的库没有这一项。
 *
 * 需先 npm run build(读 out/)。用法:node scripts/cloud-vault-sections.check.cjs [--shots=<目录>](亮 / 暗各拍一张)
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

const STATE = {
  vaults: [
    { vaultRoot: '/elsewhere/Notes', cloudName: 'Notes', entries: [{ path: 'a.md', kind: 'page' }] }, // 本机在同步、标记还没拉回来
    { vaultRoot: '/elsewhere/Old', cloudName: 'Old', entries: [] }, // 条目全关掉:不该占分区
  ],
  activeRoot: null,
  cloudRoot: '',
  mirrorVaults: ['Fiary', 'Manual', 'WMOSv11', 'constructor'], // constructor:库名撞 Object 原型上的键也得照常渲染
  mirrorVaultDevices: {
    WMOSv11: [{ id: 'desk-win', name: 'Windows 台式机', since: '2026-10-17' }],
    Fiary: [{ id: 'desk-me', name: 'MacBook Pro' }, { id: 'desk-win', name: 'Windows 台式机' }],
  },
  deviceId: 'desk-me',
}

function stub(state) {
  const calls = (window.__markCalls = [])
  const status = { enabled: true, state: 'idle', lastSyncAt: Date.now(), pending: 0, conflicts: 0, skipped: [], error: null, pendingDeletions: 0, side: 'cloud' }
  window.amadeusSync = {
    get: async () => status,
    onStatus: () => () => {},
    onEntrySyncChange: () => () => {},
    entrySyncGet: async () => state,
    entrySyncEnable: async () => ({ ok: true }),
    entrySyncDisable: async () => ({ ok: true }),
    entrySyncClosure: async () => ({ pages: [], files: [], subPages: [] }),
    entrySyncMark: async (name, on) => { calls.push([name, on]); return { ok: true } },
  }
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-vault-sections-'))
  const vault = path.join(home, 'Cloud')
  for (const p of ['WMOSv11/02 Areas/x.md', 'WMOSv11/Daily/y.md', 'WMOSv11/WMOS 首页.md', 'Fiary/2026/a.md', 'Fiary/Fiary 索引.md',
    'Manual/m.md', 'constructor/c.md', 'CMP/x.md', 'docs/x.md', '闪念盒/x.md', '收件箱.md']) {
    fs.mkdirSync(path.dirname(path.join(vault, p)), { recursive: true }); fs.writeFileSync(path.join(vault, p), `# ${path.basename(p, '.md')}\n`)
  }
  for (const ud of ['userdata', 'userdata-dev']) {
    fs.mkdirSync(path.join(home, ud), { recursive: true })
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json']) fs.writeFileSync(path.join(home, ud, f), JSON.stringify({ lastVault: vault, localVault: vault }))
    // 随包的 Forsion Extend 在时 window.amadeusSync 是 contextBridge 暴露的真对象、改不动;停用它,preload 删键,桩才接得上。
    fs.writeFileSync(path.join(home, ud, 'tangu-desktop-config.json'), JSON.stringify({ disabledBundles: ['forsion-extend'] }))
  }
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT], cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', TANGU_HARNESS_QUIET: '1' },
  })
  try {
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 860))
    await win.addInitScript(stub, STATE)
    await win.waitForSelector('#root', { timeout: 30_000 })
    check('跳过首启引导', await skipOnboarding(win))
    // 侧别:Amadeus 自己的左栏不挂胶囊(胶囊在 Ribbon 的 Unit 切换器里,隔离实例不上架),而且它启动时 restoreVault 会把
    // vaultSide 置回 local。所以先进 Amadeus 让库恢复完,再去挂着 VaultSideSwitch 的 Tangu 左栏(首次挂载按桩的
    // get().side 把全局 vaultSide 置成 cloud),最后从 Ribbon 切回 Amadeus。
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'amadeus')`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.amx-tree .amx-sec-head', { timeout: 30_000 })
    await win.waitForTimeout(1200)
    await win.locator('.rb-slot[data-id="space:tangu"]').first().click()
    await win.waitForSelector('.t2sw', { timeout: 30_000 })
    await win.waitForTimeout(1200)
    const slot = win.locator('.rb-slot[data-id="space:amadeus"]').first()
    check('Ribbon 上找到笔记入口', (await slot.count()) > 0)
    await slot.click()
    await win.waitForSelector('.amx-tree .amx-sec-head', { timeout: 30_000 })
    await win.waitForFunction(() => [...document.querySelectorAll('.amx-tree .amx-sec-head .t2s-group-label')].some((e) => e.textContent === 'WMOSv11'), null, { timeout: 15_000 }).catch(() => {})
    const secs = await win.evaluate(() => [...document.querySelectorAll('.amx-tree .amx-sec-head')].map((h) => ({
      label: h.querySelector('.t2s-group-label')?.textContent ?? '',
      device: h.querySelector('.amx-sec-device')?.textContent ?? '',
      title: h.querySelector('.amx-sec-device')?.getAttribute('title') ?? '',
    })))
    const labels = secs.map((s) => s.label)
    const ws = labels.indexOf('Cloud工作区')
    check('① 同步库分区在前,Cloud工作区 在最后', ws === labels.length - 1 && ['Fiary', 'Manual', 'Notes', 'WMOSv11', 'constructor'].every((n) => labels.indexOf(n) > -1 && labels.indexOf(n) < ws), JSON.stringify(labels))
    check('② 条目全关掉的本机记录不占分区', !labels.includes('Old'))
    const dev = Object.fromEntries(secs.map((s) => [s.label, s.device]))
    check('② 设备标签:他机名字 / 本机 +N / 本机刚开的也算 / 旧标记不画', dev.WMOSv11 === 'Windows 台式机' && dev.Fiary === '本机+1' && dev.Notes === '本机' && dev.Manual === '' && dev.constructor === '', JSON.stringify(dev))
    check('② 悬停列出全部设备与起始日期', secs.find((s) => s.label === 'WMOSv11')?.title.includes('2026-10-17'), secs.find((s) => s.label === 'WMOSv11')?.title)

    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true })
      await win.waitForTimeout(1000) // 等 Space 切换的淡入走完
      await win.screenshot({ path: path.join(SHOTS, 'cloud-sections-light.png') })
      await win.evaluate(() => { document.documentElement.dataset.mode = 'dark'; document.documentElement.classList.add('dark') })
      await win.waitForTimeout(300)
      await win.screenshot({ path: path.join(SHOTS, 'cloud-sections-dark.png') })
      await win.evaluate(() => { document.documentElement.dataset.mode = 'light'; document.documentElement.classList.remove('dark') })
    }

    const menuItems = async () => win.evaluate(() => [...document.querySelectorAll('.ctx-menu button')].map((b) => b.textContent.trim()))
    const closeMenu = () => win.mouse.click(900, 600)
    await win.locator('.amx-tree .t2s-folder-row', { hasText: 'CMP' }).first().click({ button: 'right' })
    const cmp = await menuItems()
    check('③ Cloud工作区 的根文件夹右键有「设为同步库分区」', cmp.includes('设为同步库分区'), cmp.join(' / '))
    if (SHOTS) await win.screenshot({ path: path.join(SHOTS, 'cloud-sections-menu.png') })
    await win.locator('.ctx-menu button', { hasText: '设为同步库分区' }).click().catch(() => {})
    await win.waitForTimeout(200)
    check('③ 点了调 entrySyncMark("CMP", true)', JSON.stringify(await win.evaluate(() => window.__markCalls)) === '[["CMP",true]]', JSON.stringify(await win.evaluate(() => window.__markCalls)))

    await win.locator('.amx-tree .amx-sec-grab', { hasText: 'Manual' }).click({ button: 'right' })
    const manual = await menuItems()
    check('③ 手动分区头右键只有「不再作为同步库分区」(不给整份文件夹菜单,免得从分区头删掉整个库)', JSON.stringify(manual) === '["不再作为同步库分区"]', manual.join(' / '))
    await win.locator('.ctx-menu button', { hasText: '不再作为同步库分区' }).click().catch(() => {})
    await win.waitForTimeout(200)
    check('③ 点了调 entrySyncMark("Manual", false)', JSON.stringify(await win.evaluate(() => window.__markCalls)) === '[["CMP",true],["Manual",false]]', JSON.stringify(await win.evaluate(() => window.__markCalls)))
    await win.locator('.amx-tree .amx-sec-grab', { hasText: 'WMOSv11' }).click({ button: 'right' })
    const withDev = await menuItems()
    check('③ 有设备在同步的分区头右键不给取消(取消了也会被它们补回来)', !withDev.some((m) => m.includes('同步库分区')), withDev.join(' / ') || '(无菜单)')
    await closeMenu()
    await win.locator('.amx-tree .amx-sec-grab', { hasText: 'Notes' }).click({ button: 'right' })
    const mine = await menuItems()
    check('③ 本机在同步的库没有这一项(内容还没到时不弹菜单)', !mine.some((m) => m.includes('同步库分区')), mine.join(' / ') || '(无菜单)')
    await closeMenu()
    await win.locator('.amx-tree .t2s-folder-row', { hasText: '02 Areas' }).first().click({ button: 'right' })
    const nested = await menuItems()
    check('③ 非根文件夹没有这一项', nested.length > 0 && !nested.some((m) => m.includes('同步库分区')), nested.join(' / '))
  } finally {
    await app.close()
  }
  const failed = results.filter((x) => !x).length
  console.log(failed ? `\n${failed} FAIL` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
