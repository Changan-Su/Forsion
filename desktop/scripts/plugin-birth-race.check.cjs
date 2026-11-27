/**
 * 「插件给新笔记填内容 / 插件接进宿主模板」的端到端契约(真 Electron × 真外置插件 × 真「新建笔记」按钮 × 落盘核对)。
 *
 * 背景:移植 Obsidian Templater 的「文件夹模板」时,插件的写法是 ctx.app.onVaultEvent 收到 `create`(约 200ms 一批)
 * 之后 ctx.app.writeFile 把渲染好的模板写进那篇空笔记。本窗渲染层发起的写主进程不回灌给本窗(electron/amadeus/ipc.ts
 * handle():渲染层 IPC 起源只发 SSE 给远端),而刚打开那篇空笔记的编辑器只在挂载时补读一次。
 * 2026-11-15 实测(phase old,3/3 一致):编辑器 +130~200ms 挂载读到空白,插件那一写 +265~292ms 才落盘 —— 编辑器一直显示空白;
 * 用户打一个字,防抖保存撞上 CAS(盘上已是模板)→ 本地胜:盘上只剩用户打的字,模板被挪进「(conflict …)」副本。
 * 新接缝 ctx.registerNoteBirth:宿主在**写盘之前**问插件,模板随出生那一写落盘,编辑器一打开就是它。
 *
 * 判据:
 *   old-*   观察项(老路的实际表现,如实打印,不计入失败)。
 *   N1      registerNoteBirth 存在(新宿主)
 *   N2      点「新建笔记」后,第一次看到文件时盘上就已经是模板(出生那一写带着它,不是先空后填);插件拿到 path / folder / signal
 *   N3      编辑器打开就显示模板
 *   N4      在正文打一个字,防抖保存后盘上 = 模板 + 那个字,这一篇没有冲突副本
 *   T1–T3   ctx.registerTemplateProcessor:选择器列出插件声明的文件夹里的模板(库外 / 绝对路径不列);插入时插件先处理原文
 *           (kind = insert),宿主再替换 {{title}};结果落盘
 *   S1–S2   慢插件(1.5 秒才答):等待期间右上角出现「正在准备这篇笔记」提示并带插件名与取消钮;答完提示收起、笔记带模板出生
 *   C1–C2   不答的插件:点提示上的「取消」→ 笔记照常空白出生并打开,插件的 signal 被 abort;不会等 10 分钟
 *   E1      抛错的插件:提示点名插件,笔记照常空白出生并打开
 *
 * ⚠️ 量的是 out/ 里的产物,源码改了没 `npm run build` 就是白测。GUI 台架,走 devlock(见仓根 CLAUDE.md / gui-verify)。
 * 跑:npm run check:pluginbirth
 * 负对照:--nc=nohook(新插件不注册 registerNoteBirth / registerTemplateProcessor)—— 期望 N2 起、T、S、C、E 段变红。
 * 截图:PB_SHOT=<png 路径> 时在等待提示出现那一刻截整窗(观感自查)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')

const ROOT = path.join(__dirname, '..')
const NC = (process.argv.find((a) => a.startsWith('--nc=')) || '').split('=')[1] || ''
const TEMPLATE = '## Folder template\n\nTEMPLATE-MARKER-7f3a\n'
const MARK = 'TEMPLATE-MARKER-7f3a'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
function observe(name, detail) {
  console.log(`OBS   ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms
  for (;;) {
    let v = null
    try { v = await fn() } catch { v = null }
    if (v || Date.now() > end) return v
    await sleep(step)
  }
}

/** 老路插件:onVaultEvent create → writeFile 模板(Templater 文件夹模板的移植写法)。只在 window.__pbMode === 'old' 时动手。 */
const OLD_MAIN = `
var T = ${JSON.stringify(TEMPLATE)}
var log = { push: function (x) { (window.__pbLog = window.__pbLog || []).push(x) } }
if (ctx.app.onVaultEvent) ctx.app.onVaultEvent(function (evs) {
  if (window.__pbMode !== 'old') return
  evs.forEach(function (e) {
    if (e.kind !== 'create' || !/\\.md$/.test(e.path)) return
    log.push({ t: Date.now(), ev: 'create-event', path: e.path })
    ctx.app.readFile(e.path).then(function (cur) {
      if (cur !== '' && cur != null) { log.push({ t: Date.now(), ev: 'skip-nonempty', path: e.path }); return }
      return ctx.app.writeFile(e.path, T).then(function () { log.push({ t: Date.now(), ev: 'write', path: e.path }) })
    })
  })
})
`

/** 新接缝插件:registerNoteBirth + registerTemplateProcessor。window.__pbMode 决定出生这一问怎么答。负对照 --nc=nohook 时都不注册。 */
const NEW_MAIN = `
var T = ${JSON.stringify(TEMPLATE)}
var log = { push: function (x) { (window.__pbLog = window.__pbLog || []).push(x) } }
window.__pbHasBirth = typeof ctx.registerNoteBirth === 'function'
var on = ${JSON.stringify(NC)} !== 'nohook'
if (on && ctx.registerNoteBirth) ctx.registerNoteBirth({
  id: 'folder-template',
  initial: function (info) {
    var mode = window.__pbMode
    var entry = { t: Date.now(), ev: 'ask', mode: mode, path: info.path, folder: info.folder, hasSignal: !!info.signal, aborted: false }
    log.push(entry)
    if (info.signal) info.signal.addEventListener('abort', function () { entry.aborted = true })
    if (mode === 'new') return T
    if (mode === 'new-slow') return new Promise(function (r) { setTimeout(function () { r(T) }, 1500) })
    if (mode === 'new-hang') return new Promise(function () {})
    if (mode === 'new-throw') throw new Error('probe failure')
    return null
  },
})
if (on && ctx.registerTemplateProcessor) ctx.registerTemplateProcessor({
  id: 'probe-processor',
  name: 'Probe processor',
  folders: function () { return ['MyTemplates', 'MyTemplates/', '../Outside', '/abs/Templates'] },
  process: function (source, info) {
    log.push({ t: Date.now(), ev: 'process', kind: info.kind, templatePath: info.templatePath, targetPath: info.targetPath, sawRawTitleVar: source.indexOf('{{title}}') >= 0 })
    return source.replace('<%name%>', 'processed-by-plugin')
  },
})
`

function writePlugin(pluginsDir, id, main) {
  const dir = path.join(pluginsDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'main.js'), main)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', minAppVersion: '0.0.1', description: 'e2e probe, not a product plugin' }, null, 2))
}

/** 那篇的正文编辑器:标题区 .amx-doc[data-unified-path] 与正文 .unified-body 是同一个父节点下的兄弟。 */
const ED = (p) => `(() => { const d = document.querySelector('[data-unified-path="' + ${JSON.stringify(p)} + '"]'); return d && d.parentElement ? d.parentElement.querySelector('.unified-body .ProseMirror') : null })()`

/** 页内时间线:装一个轮询器,每 40ms 记一次「这篇的编辑器在不在、显示什么」,文本变化才记。 */
const ARM = (p) => `(() => {
  window.__pbTl = []
  let last = undefined
  clearInterval(window.__pbTimer)
  window.__pbTimer = setInterval(() => {
    const ed = ${ED(p)}
    const v = ed ? ed.innerText : null
    if (v !== last) { last = v; window.__pbTl.push({ t: Date.now(), text: v }) }
  }, 40)
  return Date.now()
})()`

const editorText = (p) => `(() => { const ed = ${ED(p)}; return ed ? ed.innerText : null })()`
const noticeTexts = `[...document.querySelectorAll('.ntf')].map((n) => n.innerText).join(' || ')`

async function clickNewNote(win) {
  if (!(await win.locator('.t2s-special', { hasText: '新建笔记' }).first().count().catch(() => 0))) {
    await win.click('.dv-edge-left').catch(() => {})
    await win.waitForTimeout(800)
  }
  await win.locator('.t2s-special', { hasText: '新建笔记' }).first().click()
}

/** 在那篇的正文里打一个字(新建后焦点在标题栏,先点进正文)。 */
async function typeInBody(win, p, ch) {
  const box = await win.evaluate(`(() => { const ed = ${ED(p)}; if (!ed) return null; const r = ed.getBoundingClientRect(); return { x: r.left + 20, y: r.top + Math.min(r.height - 4, 12) } })()`)
  if (!box) throw new Error(`没找到 ${p} 的正文编辑器`)
  await win.mouse.click(box.x, box.y)
  await win.keyboard.press('Meta+ArrowDown').catch(() => {})
  await win.keyboard.type(ch)
}

/** 收掉右上角的通知卡(老路留下的冲突副本提示等),免得后面的等待提示被挤进队列。 */
async function clearNotices(win) {
  for (let i = 0; i < 12; i++) {
    const x = win.locator('.ntf .ntf-close').first()
    if (!(await x.count().catch(() => 0))) break
    await x.click().catch(() => {})
    await win.waitForTimeout(150)
  }
}

const conflictCopiesOf = (vault, p) => fs.readdirSync(vault).filter((f) => f.startsWith(`${p.replace(/\.md$/, '')} (conflict`))
const askOf = async (win, mode) => (await win.evaluate('(window.__pbLog || []).slice()')).find((e) => e.ev === 'ask' && e.mode === mode) || null

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  if (NC) console.log(`⚠️ 负对照模式 --nc=${NC}:期望 N2 起变红\n`)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-pbirth-'))
  const vault = path.join(home, 'vault')
  const userData = path.join(home, 'userdata')
  fs.mkdirSync(path.join(vault, 'MyTemplates'), { recursive: true })
  fs.mkdirSync(`${userData}-dev`, { recursive: true })
  fs.writeFileSync(path.join(vault, 'Welcome.md'), '# Welcome\n')
  fs.writeFileSync(path.join(vault, 'MyTemplates', 'Meeting.md'), 'Meeting for {{title}}\n\nPROC:<%name%>\n')
  fs.writeFileSync(path.join(`${userData}-dev`, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vault, localVault: vault }, null, 2))
  const pluginsDir = path.join(home, 'plugins')
  writePlugin(pluginsDir, 'pbprobe-old', OLD_MAIN)
  writePlugin(pluginsDir, 'pbprobe-new', NEW_MAIN)

  const app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1' },
  })
  const disk = (p) => { try { return fs.readFileSync(path.join(vault, p), 'utf8') } catch { return null } }
  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1440, height: 900 })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.evaluate(`localStorage.setItem('forsion_default_space', 'amadeus')`)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForSelector('.am-app', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    const loaded = await waitFor(() => win.evaluate('typeof window.__pbHasBirth !== "undefined"'), 15000)
    if (!loaded) throw new Error('前置失败:探针插件没装载')

    // ── phase old:老路(onVaultEvent create → writeFile)。观察项,三轮看稳不稳。 ──
    for (const p of ['未命名.md', '未命名-2.md', '未命名-3.md']) {
      await win.evaluate(`window.__pbMode = 'old'; window.__pbLog = []`)
      const t0 = await win.evaluate(ARM(p))
      await clickNewNote(win)
      const first = await waitFor(() => disk(p) != null && { at: Date.now(), text: disk(p) }, 8000, 10)
      const filled = await waitFor(() => (disk(p) || '').includes(MARK) && Date.now(), 4000, 20)
      await win.waitForTimeout(2500)
      const shownAfter = await win.evaluate(editorText(p))
      const tl = await win.evaluate('window.__pbTl.slice()')
      const log = await win.evaluate('window.__pbLog.slice()')
      const write = log.find((e) => e.ev === 'write' && e.path === p)
      const mount = tl.find((e) => e.text != null)
      observe(`old ${p} 出生那一写`, `盘上第一次看到 = ${JSON.stringify(first && first.text)}`)
      observe(`old ${p} 插件补写落盘`, write ? `点击后 +${write.t - t0}ms(create 事件 +${(log.find((e) => e.ev === 'create-event' && e.path === p) || { t: NaN }).t - t0}ms)` : `没写(log=${JSON.stringify(log)})${filled ? '' : ',盘上也没有模板'}`)
      observe(`old ${p} 编辑器`, `挂载于 +${mount ? mount.t - t0 : NaN}ms,挂载时显示 ${JSON.stringify(mount && mount.text)};2.5 秒后显示 ${JSON.stringify(shownAfter)}`)
      await typeInBody(win, p, 'Z')
      await win.waitForTimeout(2500)
      const copies = conflictCopiesOf(vault, p)
      observe(`old ${p} 打一个字 + 防抖保存之后`, `盘上 = ${JSON.stringify(disk(p))};编辑器 = ${JSON.stringify(await win.evaluate(editorText(p)))};冲突副本 = ${JSON.stringify(copies.map((c) => [c, disk(c)]))}`)
    }
    await win.evaluate(`window.__pbMode = 'off'`)
    await clearNotices(win)

    // ── phase new:registerNoteBirth ──
    const hasBirth = await win.evaluate('window.__pbHasBirth === true')
    check('N1 宿主提供 ctx.registerNoteBirth', hasBirth)
    const pn = '未命名-4.md'
    {
      await win.evaluate(`window.__pbMode = 'new'; window.__pbLog = []`)
      const t0 = await win.evaluate(ARM(pn))
      await clickNewNote(win)
      const first = await waitFor(() => disk(pn) != null && disk(pn), 8000, 10)
      const ask = await askOf(win, 'new')
      check('N2 盘上第一次看到这篇时就已经是模板(出生那一写带着它);插件拿到 path / folder / signal', first === TEMPLATE && ask && ask.path === pn && ask.folder === '' && ask.hasSignal,
        `first=${JSON.stringify(first)} ask=${JSON.stringify(ask)}`)
      const shown = await waitFor(async () => { const v = await win.evaluate(editorText(pn)); return v && v.includes(MARK) && v }, 5000)
      const tl = await win.evaluate('window.__pbTl.slice()')
      const mount = tl.find((e) => e.text != null)
      check('N3 编辑器打开就显示模板(挂载时那一帧就有)', shown && mount && (mount.text || '').includes(MARK), `mount=${JSON.stringify(mount && [mount.t - t0, mount.text])} shown=${JSON.stringify(shown)}`)
      await typeInBody(win, pn, 'Z')
      await win.waitForTimeout(2500)
      const after = disk(pn) || ''
      check('N4 打一个字保存后盘上 = 模板 + 那个字,这一篇没有冲突副本', after.includes(MARK) && after.includes('Z') && conflictCopiesOf(vault, pn).length === 0,
        `disk=${JSON.stringify(after)} copies=${JSON.stringify(conflictCopiesOf(vault, pn))}`)
    }

    // ── 模板处理器:宿主的模板选择器 + 插件处理原文 ──
    {
      await win.evaluate(`window.__pbMode = 'off'; window.__pbLog = []`)
      await win.evaluate(`window.dispatchEvent(new CustomEvent('amadeus:template-picker', { detail: { v4Path: ${JSON.stringify(pn)} } }))`)
      const listed = await waitFor(async () => {
        const rows = await win.evaluate(`[...document.querySelectorAll('.cmd-item .cmd-path')].map((e) => e.textContent)`)
        return rows.includes('MyTemplates/Meeting.md') && rows
      }, 5000)
      const rows = listed || await win.evaluate(`[...document.querySelectorAll('.cmd-item .cmd-path')].map((e) => e.textContent)`)
      check('T1 选择器列出插件声明的文件夹里的模板(重复的只列一次,库外 / 绝对路径不列)', listed && rows.filter((r) => r === 'MyTemplates/Meeting.md').length === 1 && !rows.some((r) => /Outside|abs/.test(r)), JSON.stringify(rows))
      if (listed) await win.locator('.cmd-item', { hasText: 'MyTemplates/Meeting.md' }).first().click()
      else await win.keyboard.press('Escape').catch(() => {})
      const done = await waitFor(() => (disk(pn) || '').includes('processed-by-plugin') && disk(pn), 6000)
      const proc = (await win.evaluate('(window.__pbLog || []).slice()')).find((e) => e.ev === 'process')
      check('T2 插件先处理原文(kind = insert,看到的是没替换过的 {{title}})', proc && proc.kind === 'insert' && proc.templatePath === 'MyTemplates/Meeting.md' && proc.targetPath === pn && proc.sawRawTitleVar, JSON.stringify(proc))
      check('T3 插入结果 = 插件处理 + 宿主替换 {{title}},已落盘', done && done.includes('PROC:processed-by-plugin') && done.includes('Meeting for 未命名-4') && done.includes(MARK), JSON.stringify(done || disk(pn)))
    }
    await clearNotices(win)

    // ── 慢插件:等待提示 ──
    {
      const p = '未命名-5.md'
      await win.evaluate(`window.__pbMode = 'new-slow'; window.__pbLog = []`)
      await clickNewNote(win)
      const notice = await waitFor(async () => { const txt = await win.evaluate(noticeTexts); return /正在准备这篇笔记/.test(txt) && txt }, 3000)
      if (notice && process.env.PB_SHOT) await win.screenshot({ path: process.env.PB_SHOT }).catch(() => {}) // 观感自查用:等待提示那一刻的整窗截图
      check('S1 慢插件答复前出现「正在准备这篇笔记」提示,带插件名与取消钮,此时还没写盘', notice && notice.includes('pbprobe-new') && /取消/.test(notice) && disk(p) == null, `${JSON.stringify(notice)} disk=${JSON.stringify(disk(p))}`)
      const born = await waitFor(() => disk(p), 6000)
      const gone = await waitFor(async () => !/正在准备这篇笔记/.test(await win.evaluate(noticeTexts)), 3000)
      const shown = await waitFor(async () => { const v = await win.evaluate(editorText(p)); return v && v.includes(MARK) && v }, 5000)
      check('S2 答完提示收起,笔记带模板出生并打开', born === TEMPLATE && gone && shown, `disk=${JSON.stringify(born)} noticeGone=${!!gone} shown=${JSON.stringify(shown)}`)
    }

    // ── 不答的插件:取消 ──
    {
      const p = '未命名-6.md'
      await win.evaluate(`window.__pbMode = 'new-hang'; window.__pbLog = []`)
      await clickNewNote(win)
      const btn = win.locator('.ntf', { hasText: '正在准备这篇笔记' }).locator('.ntf-action').first()
      const has = await waitFor(async () => (await btn.count()) > 0, 3000)
      check('C1 不答的插件:等待提示上有取消钮,点之前笔记还没写盘', has && disk(p) == null, `btn=${!!has} disk=${JSON.stringify(disk(p))}`)
      let clicked = false
      const t = Date.now()
      if (has) { await btn.click(); clicked = true }
      const born = await waitFor(() => disk(p) != null && { text: disk(p) }, 4000, 20)
      const opened = await waitFor(async () => (await win.evaluate(editorText(p))) != null, 5000)
      const ask = await askOf(win, 'new-hang')
      check('C2 点取消后笔记照常空白出生并打开(不等 10 分钟),插件的 signal 被 abort', clicked && ask && ask.aborted && born && born.text === '' && opened && Date.now() - t < 6000,
        `clicked=${clicked} disk=${JSON.stringify(born)} opened=${!!opened} ${Date.now() - t}ms ask=${JSON.stringify(ask)}`)
    }
    await clearNotices(win)

    // ── 抛错的插件 ──
    {
      const p = '未命名-7.md'
      await win.evaluate(`window.__pbMode = 'new-throw'; window.__pbLog = []`)
      await clickNewNote(win)
      const born = await waitFor(() => disk(p) != null && { text: disk(p) }, 5000, 20)
      const opened = await waitFor(async () => (await win.evaluate(editorText(p))) != null, 5000)
      const toast = await waitFor(async () => { const txt = await win.evaluate(noticeTexts); return /pbprobe-new.*没能准备这篇笔记|没能准备这篇笔记.*probe failure/.test(txt) && txt }, 3000)
      const ask = await askOf(win, 'new-throw')
      check('E1 抛错的插件:提示点名插件,笔记照常空白出生并打开', ask && toast && born && born.text === '' && opened, `ask=${!!ask} toast=${JSON.stringify(toast)} disk=${JSON.stringify(born)} opened=${!!opened}`)
    }

    const bad = results.filter((r) => !r.ok)
    console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
