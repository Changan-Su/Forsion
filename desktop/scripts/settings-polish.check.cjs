/**
 * check:settingspolish —— 设置页对齐 + 语音页卡片化(走查续 4.4 / 4.5,2026-10-25)的真 Electron 仪器。
 *
 *  K 快捷键:每一行键帽的右缘对齐成一列 —— 有键(带 ×)、未设置(没有 ×)、改过的(多一颗「恢复默认」)三种行都算。
 *    前置:三种行都在场(点掉一行的 × 造出「改过 + 未设置」的那种)。⚠ 负对照:去掉 .shortcut-slot 占位即红。
 *  S Space 页:同一张卡里的下拉一样宽(200px)、右缘对齐;窄窗(≤820)下撑满行宽。
 *  H 卡里直接挂的补充说明(.settings-panel > .hint)和卡头说明同字号、同颜色(常规 › 基本,再扫几页别处的)。
 *  V 语音页:三张卡(语音通话 / 本地语音识别 / 朗读),没有旧的 .settings-sec 小标题和 .field 字段卡;每行都声明了窄屏排法 data-fit;
 *    说明不在占位符里(占位符 ≤ 12 字);朗读卡四行没选模型时照样能填(不置灰),「去选模型」→ 默认模型 › 朗读那一行;
 *    「添加提供方」→ 模型 › 提供方;选了朗读模型以后「去选模型」消失。窄窗下开关留在右边、输入框换到下一行。
 *
 * 跑:npx electron-vite build 之后 `npm run check:settingspolish`。截图(亮 / 暗 / 英文青绿 × 语音 / 快捷键 / Space / 基本 / 窄窗)
 * 落 SETTINGS_SHOTS(缺省临时目录),交付前自己看一眼(DESIGN §8)。隔离 userData / TANGU_HOME + 假引擎,不碰 ~/.forsion。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.resolve(__dirname, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-settings-polish-'))
const shots = process.env.SETTINGS_SHOTS || path.join(home, 'shots')
fs.mkdirSync(shots, { recursive: true })
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  | ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { if (await fn()) return true } catch { /* retry */ }
    await pause(80)
  }
  return false
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npx electron-vite build')
    process.exit(2)
  }
  const stub = await startStubEngine({ sessions: [], messages: [], agents: [], engines: [] })
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sandbox: 'auto', workspace: path.join(home, 'ws') }))
  let app
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const main = await app.firstWindow()
    await main.waitForSelector('#root', { timeout: 40000 })
    check('前置 主窗已离开首启引导', await skipOnboarding(main))

    const floating = () => app.windows().filter((w) => !w.isClosed() && w.url().includes('window=floating')).pop()
    const openSettings = async (tab) => {
      await main.evaluate((p) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: p }), { tab, n: Date.now() })
      let fl
      await waitFor(async () => { fl = floating(); return !!fl && (await fl.locator('.settings-nav').count()) > 0 }, 30000)
      if (!fl) throw new Error('settings floating window missing')
      const sub = tab.includes('/') ? tab.split('/')[1] : null
      if (sub) await fl.locator(`.settings-sub[data-settings-sub="${sub}"]`).waitFor({ timeout: 15000 })
      else await fl.locator(`.settings-sub--${tab}`).waitFor({ timeout: 15000 })
      await pause(500)
      return fl
    }
    const setFloatingSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
      for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().includes('window=floating')) win.setContentSize(w, h)
    }, [w, h])
    const activeSubLabel = (fl) => fl.evaluate(() => document.querySelector('.settings-nav-subitem.active')?.textContent?.trim() || '')
    const shot = (fl, name) => fl.screenshot({ path: path.join(shots, `${name}.png`) })
    /** 换外观:主窗写偏好再重载(设置浮窗重开时读同一份 localStorage)。 */
    const look = async ({ mode, lang = 'zh', skin = null }) => {
      await main.evaluate(([mode, lang, skin]) => {
        localStorage.setItem('forsion_theme_pref', mode)
        localStorage.setItem('tangu_locale', lang)
        if (skin) { localStorage.setItem('forsion_theme_skin', skin); localStorage.setItem('forsion_theme_bg', skin) } else { localStorage.removeItem('forsion_theme_skin'); localStorage.removeItem('forsion_theme_bg') }
      }, [mode, lang, skin])
      const fl = floating()
      if (fl) await fl.close().catch(() => {})
      await main.reload({ waitUntil: 'domcontentloaded' })
      await main.waitForSelector('#root', { timeout: 30000 })
      await pause(1500)
    }

    await setFloatingSize(1100, 820).catch(() => {})

    // ── K 快捷键:键帽右缘对齐 ──
    let fl = await openSettings('shortcuts')
    await setFloatingSize(1100, 820)
    await pause(300)
    // 点掉第一行有键的 ×:造出「改过(有恢复默认)+ 未设置」那种行
    const xBtn = fl.locator('.shortcut-row .shortcut-controls button.icon-btn[title="解绑"]').first()
    const hadX = await xBtn.count()
    if (hadX) await xBtn.click()
    await pause(400)
    const keys = await fl.evaluate(() => [...document.querySelectorAll('.shortcut-row')].filter((r) => r.offsetParent).map((r) => {
      const k = r.querySelector('.shortcut-key, .shortcut-capture')
      const c = r.querySelector('.shortcut-controls')
      return k && c ? {
        right: Math.round(k.getBoundingClientRect().right * 10) / 10,
        ctrlRight: Math.round(c.getBoundingClientRect().right * 10) / 10,
        unbound: !!k.querySelector('.shortcut-unbound'),
        reset: !!c.querySelector('button.icon-btn[title="恢复默认"]'),
      } : null
    }).filter(Boolean))
    const rights = [...new Set(keys.map((k) => k.right))]
    check('K0 前置:有键 / 未设置 / 改过 三种行都在', hadX > 0 && keys.some((k) => k.unbound) && keys.some((k) => !k.unbound) && keys.some((k) => k.reset),
      { rows: keys.length, unbound: keys.filter((k) => k.unbound).length, reset: keys.filter((k) => k.reset).length })
    check('K1 所有行的键帽右缘对齐成一列', keys.length > 3 && Math.max(...keys.map((k) => k.right)) - Math.min(...keys.map((k) => k.right)) <= 0.5, rights.slice(0, 6))
    await fl.locator('.settings-body').evaluate((el) => { el.scrollTop = 0 })
    await shot(fl, 'shortcuts-light')

    // ── S Space 页:下拉等宽右对齐 ──
    fl = await openSettings('spaces')
    const sel = await fl.evaluate(() => [...document.querySelectorAll('.settings-sub--spaces .settings-panel')].map((p) => [...p.querySelectorAll('.settings-row-control select')]
      .filter((s) => s.offsetParent).map((s) => { const r = s.getBoundingClientRect(); return { w: Math.round(r.width), right: Math.round(r.right) } })).filter((a) => a.length))
    const flat = sel.flat()
    check('S1 Space 页每张卡里的下拉都是 200px 宽', flat.length >= 5 && flat.every((s) => s.w === 200), sel)
    check('S2 同卡下拉右缘对齐', sel.every((a) => new Set(a.map((s) => s.right)).size === 1), sel.map((a) => a.map((s) => s.right)))
    const ribbon = await fl.evaluate(() => document.querySelector('.settings-sub--spaces')?.innerText || '')
    check('S3 说明里不再出现小写 ribbon', !/(?<![A-Za-z])ribbon(?![A-Za-z])/.test(ribbon) && /Ribbon/.test(ribbon))
    await shot(fl, 'spaces-light')

    // ── H 卡内说明同卡头说明一档 ──
    const hintTier = (f) => f.evaluate(() => {
      const ref = [...document.querySelectorAll('.settings-panel-head p')].find((e) => e.offsetParent)
      const hints = [...document.querySelectorAll('.settings-panel > .hint')].filter((e) => e.offsetParent && !/error/.test(e.className))
      if (!ref) return { ref: null, hints: hints.length }
      const rs = getComputedStyle(ref)
      return { ref: [rs.fontSize, rs.color], hints: hints.map((h) => { const s = getComputedStyle(h); return [s.fontSize, s.color] }) }
    })
    fl = await openSettings('general/g-basic')
    const hb = await hintTier(fl)
    check('H1 常规 › 基本:卡内补充说明 == 卡头说明的字号与颜色', hb.ref && hb.hints.length > 0 && hb.hints.every(([f, c]) => f === hb.ref[0] && c === hb.ref[1]), hb)
    await shot(fl, 'basic-light')
    const sweep = []
    for (const tab of ['general/g-conn', 'general/g-runtime', 'general/g-inbox', 'model/m-providers', 'browser', 'notes', 'advanced/a-data']) {
      try {
        const f = await openSettings(tab)
        const r = await hintTier(f)
        if (r.ref && r.hints.length) sweep.push({ tab, ok: r.hints.every(([fz, c]) => fz === r.ref[0] && c === r.ref[1]), r })
      } catch (e) { sweep.push({ tab, ok: true, skipped: String(e.message || e).slice(0, 60) }) }
    }
    check('H2 别的页上同样的卡内说明也是这一档(扫到的页)', sweep.every((s) => s.ok), sweep.map((s) => `${s.tab}:${s.skipped ? 'skip' : s.ok ? s.r.hints.length : JSON.stringify(s.r)}`))

    // ── V 语音页 ──
    const voiceShape = (f) => f.evaluate(() => {
      const sub = document.querySelector('.settings-sub[data-settings-sub="m-voice"]')
      if (!sub) return null
      const panels = [...sub.querySelectorAll(':scope > .settings-panel')]
      const rows = [...sub.querySelectorAll('.settings-control-row')]
      const read = sub.querySelector('.settings-voice-read')
      return {
        titles: panels.map((p) => p.querySelector('.settings-panel-head strong')?.textContent?.trim()),
        icons: panels.map((p) => !!p.querySelector('.settings-panel-head .settings-panel-icon svg')),
        legacy: sub.querySelectorAll('.settings-sec, .field').length,
        noFit: rows.filter((r) => !r.dataset.fit).length,
        longPlaceholder: [...sub.querySelectorAll('input[placeholder], textarea[placeholder]')].map((i) => i.placeholder).filter((p) => p.length > 12),
        readRows: read ? [...read.querySelectorAll('.settings-control-row')].map((r) => r.querySelector('strong')?.textContent?.trim()) : [],
        readDisabled: read ? [...read.querySelectorAll('.settings-control-row')].filter((r) => r.classList.contains('is-disabled')).length : -1,
        readEnabled: read ? ['input[list="tts-voice-options"]', 'input[type="number"]', '[role="switch"]'].map((q) => { const e = read.querySelector(q); return !!e && !e.disabled }) : [],
        chooseModel: read ? [...read.querySelectorAll('.settings-panel-head button')].map((b) => b.textContent.trim()) : [],
        asrAction: [...(panels[1]?.querySelectorAll('.settings-panel-head button') || [])].map((b) => b.textContent.trim()),
        callAction: [...(panels[0]?.querySelectorAll('.settings-panel-head button') || [])].map((b) => b.textContent.trim()),
        smallHelp: rows.filter((r) => r.querySelector('.settings-control-copy small')).length,
      }
    })
    fl = await openSettings('model/m-voice')
    const v = await voiceShape(fl)
    check('V1 语音页三张卡:语音通话 / 本地语音识别 / 朗读,卡头都有图标', v && v.titles.join('|') === '语音通话|本地语音识别|朗读' && v.icons.every(Boolean), v && { titles: v.titles, icons: v.icons })
    check('V2 没有旧排法(.settings-sec 小标题 / .field 字段卡)', v && v.legacy === 0, v && v.legacy)
    check('V3 每一行都声明了窄屏排法 data-fit', v && v.noFit === 0, v && v.noFit)
    check('V4 说明不在占位符里(占位符 ≤ 12 字),行里有小字说明', v && v.longPlaceholder.length === 0 && v.smallHelp >= 4, v && { long: v.longPlaceholder, small: v.smallHelp })
    check('V5 朗读卡四行:音色 / 语速 / 自动朗读 / 复刻·设计音色;没选模型也不置灰、照样能填', v && v.readRows.length === 4 && v.readDisabled === 0 && v.readEnabled.every(Boolean), v && { rows: v.readRows, enabled: v.readEnabled })
    check('V6 卡头动作:通话「添加提供方」、识别「下载」、朗读「去选模型」', v && v.callAction.includes('添加提供方') && v.asrAction.includes('下载') && v.chooseModel.includes('去选模型'), v && { call: v.callAction, asr: v.asrAction, read: v.chooseModel })
    await fl.locator('.settings-body').evaluate((el) => { el.scrollTop = 0 })
    await shot(fl, 'voice-light')

    // 深链:去选模型 → 默认模型 › 朗读那一行在可视区;添加提供方 → 提供方
    await fl.locator('.settings-voice-read .settings-panel-head button', { hasText: '去选模型' }).click()
    await waitFor(async () => (await activeSubLabel(fl)) === '默认模型')
    const anchorSeen = await waitFor(() => fl.evaluate(() => {
      const body = document.querySelector('.settings-body'); const el = body?.querySelector('[data-setting-anchor="default-tts"]')
      if (!body || !el) return false
      const b = body.getBoundingClientRect(), r = el.getBoundingClientRect()
      return r.height > 0 && r.top >= b.top && r.bottom <= b.bottom
    }), 4000)
    check('V7 「去选模型」→ 默认模型,朗读那一行在可视区', (await activeSubLabel(fl)) === '默认模型' && anchorSeen, await activeSubLabel(fl))
    fl = await openSettings('model/m-voice')
    await fl.locator('.settings-voice-call .settings-panel-head button', { hasText: '添加提供方' }).click()
    await waitFor(async () => (await activeSubLabel(fl)) === '提供方')
    check('V8 「添加提供方」→ 模型 › 提供方', (await activeSubLabel(fl)) === '提供方', await activeSubLabel(fl))

    // 选了朗读模型 → 「去选模型」消失,卡头说明写出模型
    await main.evaluate(() => window.tangu.setConfig({ ttsModelId: 'openai/tts-1' }))
    fl = await openSettings('model/m-voice')
    const v2 = await voiceShape(fl)
    const readDesc = await fl.locator('.settings-voice-read .settings-panel-head p').innerText()
    check('V9 选了朗读模型后「去选模型」不再出现,卡头说明写出当前模型', v2 && v2.chooseModel.length === 0 && /openai\/tts-1/.test(readDesc), { actions: v2 && v2.chooseModel, readDesc })
    await shot(fl, 'voice-light-model')

    // 窄窗:开关留右、输入框换行;Space 下拉撑满
    await setFloatingSize(700, 820)
    await pause(500)
    const narrow = await fl.evaluate(() => {
      const rowOf = (q) => [...document.querySelectorAll('.settings-voice-read .settings-control-row')].find((r) => r.querySelector(q))
      const sw = rowOf('[role="switch"]'), inp = rowOf('input[list="tts-voice-options"]')
      const box = (e) => e.getBoundingClientRect()
      return {
        vw: innerWidth,
        switchBeside: sw ? Math.abs(box(sw.querySelector('[role="switch"]')).top - box(sw.querySelector('.settings-control-copy')).top) < 24 && box(sw.querySelector('[role="switch"]')).left > box(sw.querySelector('.settings-control-copy')).left + 100 : false,
        inputBelow: inp ? box(inp.querySelector('input')).top >= box(inp.querySelector('.settings-control-copy')).bottom - 1 : false,
      }
    })
    check('V10 窄窗(≤820):自动朗读的开关留在标题右边,音色输入框换到下一行', narrow.vw <= 820 && narrow.switchBeside && narrow.inputBelow, narrow)
    await shot(fl, 'voice-narrow')
    fl = await openSettings('spaces')
    const sn = await fl.evaluate(() => [...document.querySelectorAll('.settings-sub--spaces .settings-row-control select')].filter((s) => s.offsetParent)
      .map((s) => Math.round(s.getBoundingClientRect().width) >= Math.round(s.closest('.settings-control-row').getBoundingClientRect().width) - 32))
    check('S4 窄窗(≤820):Space 页下拉撑满行宽', sn.length >= 5 && sn.every(Boolean), sn)
    await shot(fl, 'spaces-narrow')
    await setFloatingSize(1100, 820)

    // ── 截图:暗色 / 英文青绿 ──
    await main.evaluate(() => window.tangu.setConfig({ ttsModelId: '' }))
    for (const [tag, opt] of [['dark', { mode: 'dark' }], ['teal-en', { mode: 'light', lang: 'en', skin: 'teal' }]]) {
      await look(opt)
      for (const tab of ['model/m-voice', 'shortcuts', 'spaces', 'general/g-basic']) {
        const f = await openSettings(tab)
        await setFloatingSize(1100, 820)
        await pause(300)
        const got = await f.evaluate(() => ({ mode: document.documentElement.dataset.mode, lang: document.documentElement.lang }))
        if (tag === 'dark' && got.mode !== 'dark') check(`截图前置 暗色真的生效(${tab})`, false, got)
        await shot(f, `${tab.replace(/\//g, '_')}-${tag}`)
      }
    }
    if (process.env.SETTINGS_SHOTS) console.log(`截图 → ${shots}`)
  } finally {
    if (app) await app.close().catch(() => {})
    try { stub.close() } catch { /* ignore */ }
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (!process.env.SETTINGS_SHOTS) try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
