/**
 * 普通 Markdown 文件链接 + 预览刷新 + 复制公式(DSH 借鉴第一批 D24–D26):真 Electron × 真组件 × 可编剧假引擎。
 * file-citation.e2e 的姊妹篇:那边是 `[[路径#L行]]`,这边是 GPT / Codex 系模型常写的普通链接。
 *
 *   L1 `[src/app.ts:42](src/app.ts:42)`、`[这段](src/app.ts:12-15)`、`[说明](notes/long.md)` 渲染成文件引用条,
 *      相对路径按会话目录(project_path)拼;网址照旧是网页链接
 *   L2 点 `app.ts:42` → Desk 里开 CodeMirror,第 42 行高亮且在视口里
 *   R1 代码文件:用户滚到别处后点「重新加载」,滚动位置不回顶部(旧码:先清空 → 转圈 → 回到第 1 行)
 *   R2 Markdown 文件(编辑器每读完一次重挂):同上
 *   C1 选中聊天里的公式按 ⌘C,剪贴板是 TeX 源码,不是 MathML + 排版两份(跑完把剪贴板原样还回去)
 *
 * 需先 npm run build。用法:npm run e2e:chatfilelinks
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const SHOTS = process.env.CHATFILELINKS_SHOTS || ''
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const shot = async (win, name) => { if (SHOTS) await win.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => {}) }

/** Desk 里正文滚动容器的位置:取滚得最远的那个(代码 = .cm-scroller,Markdown = 编辑器自己的滚动层)。 */
const deskScroll = (win) => win.evaluate(() => {
  const body = document.querySelector('.agent-desk .wsfile-body')
  if (!body) return null
  let best = { top: 0, cls: '', max: 0 }
  for (const el of [body, ...body.querySelectorAll('*')]) {
    const max = el.scrollHeight - el.clientHeight
    if (max > 40 && max > best.max) best = { top: el.scrollTop, cls: el.classList[0] || el.tagName, max }
  }
  return best
})
const setDeskScroll = (win, top) => win.evaluate((y) => {
  const body = document.querySelector('.agent-desk .wsfile-body')
  let best = null; let bestMax = 0
  for (const el of [body, ...body.querySelectorAll('*')]) {
    const max = el.scrollHeight - el.clientHeight
    if (max > 40 && max > bestMax) { best = el; bestMax = max }
  }
  if (best) best.scrollTop = y
  return best ? best.scrollTop : null
}, top)
async function reloadInDesk(win) {
  await win.locator('.agent-desk button[title="更多"]').first().click()
  await win.locator('text=重新加载').first().click()
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chatfilelinks-'))
  const proj = path.join(home, 'proj')
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
  fs.mkdirSync(path.join(proj, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'src', 'app.ts'), Array.from({ length: 200 }, (_, i) => `L${String(i + 1).padStart(3, '0')} = ${i + 1} // marker line`).join('\n'))
  const md = ['# 长说明', '']
  for (let s = 1; s <= 60; s++) md.push(`## 第${s}节`, '', `第 ${s} 节的内容,凑够高度。`, '再来一行正文。', '')
  fs.writeFileSync(path.join(proj, 'notes', 'long.md'), md.join('\n'))
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(vaultDir, { recursive: true })
  const udDev = path.join(home, 'userdata-dev')
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(path.join(udDev, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }))

  const SESSION = {
    id: 's1', title: '文件链接会话', summary: '', model_id: 'm1', archived: false, emoji: null,
    agent_config: null, project_path: proj, project_name: 'proj',
    created_at: '2026-11-03 09:00:00', updated_at: '2026-11-03 09:00:00',
  }
  const stub = await startStubEngine({
    sessions: [SESSION],
    messages: [{
      id: 'hm1', role: 'model', timestamp: 1793700000000,
      content: '入口在 [src/app.ts:42](src/app.ts:42),初始化见[这段](src/app.ts:12-15),背景看[说明](notes/long.md),'
        + '官网是 [forsion.net](https://forsion.net)。面积公式 $\\frac{a}{b}$ 先记着。',
    }],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
  })
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
  const clipBefore = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => null)
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 40_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 40_000 })
    await win.waitForTimeout(1200)
    // 「上次 Space」跟着共用的渲染层存储走(见 file-citation.e2e):确定性切到 Agent 聊天
    const spaceBtn = win.locator('.rb-space[data-space-id="tangu"]').first()
    if (await spaceBtn.count().catch(() => 0)) { await spaceBtn.click().catch(() => {}); await win.waitForTimeout(1000) }
    if (!(await win.locator('.t2s-mode').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    await win.locator('.t2s-srow', { hasText: '文件链接会话' }).first().click().catch(() => {})
    await win.waitForSelector('.t2-content a.wikilink', { timeout: 30_000 }).catch(() => {})
    await win.waitForTimeout(800)
    await shot(win, '1-bubble')

    // L1 引用条齐、路径按会话目录拼;网址还是网页链接
    const chips = win.locator('.t2-content a.wikilink')
    const labels = await chips.allInnerTexts().catch(() => [])
    const targets = await chips.evaluateAll((els) => els.map((e) => e.getAttribute('data-wiki'))).catch(() => [])
    check('L1 三条文件链接渲染成引用条:app.ts:42 | 这段 | 说明,路径拼在会话目录下',
      labels.join('|') === 'app.ts:42|这段|说明' && targets.every((x) => x && x.startsWith(proj)),
      `labels=${labels.join('|')} targets=${targets.join(',')}`)
    const web = await win.locator('.t2-content a[href="https://forsion.net"]').count().catch(() => 0)
    check('L1b 网址照旧是网页链接', web === 1, `web=${web}`)

    // C1 选中公式按 ⌘C → 剪贴板是 TeX
    await win.evaluate(() => {
      const k = document.querySelector('.t2-content .katex')
      const r = document.createRange(); r.selectNode(k)
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    })
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+C' : 'Control+C')
    await win.waitForTimeout(400)
    await win.evaluate(() => window.getSelection()?.removeAllRanges())
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText()).catch(() => null)
    check('C1 选中公式按 ⌘C,剪贴板是 TeX 源码', clip === '$\\frac{a}{b}$', JSON.stringify(clip))

    // L2 点 app.ts:42 → Desk 里 CodeMirror,42 行高亮且在视口里
    await chips.first().click()
    await win.waitForSelector('.agent-desk.open .cm-editor', { timeout: 20_000 }).catch(() => {})
    let cite = null
    for (let t0 = Date.now(); Date.now() - t0 < 20_000;) {
      cite = await win.evaluate(() => {
        const m = document.querySelector('.agent-desk .cm-citeline')
        const sc = document.querySelector('.agent-desk .cm-scroller')
        if (!m || !sc) return null
        const r = m.getBoundingClientRect(); const s = sc.getBoundingClientRect()
        return { text: (m.textContent || '').slice(0, 8), inView: r.bottom > s.top && r.top < s.bottom }
      }).catch(() => null)
      if (cite?.text?.startsWith('L042')) break
      await win.waitForTimeout(400)
    }
    await shot(win, '2-desk-line42')
    check('L2 点 app.ts:42 → Desk 打开文件,第 42 行高亮且在视口里', !!cite?.text?.startsWith('L042') && cite.inView, JSON.stringify(cite))

    // R1 代码文件:滚到别处 → 重新加载 → 位置还在
    await win.waitForTimeout(1600) // 落地提醒动画放完
    const set1 = await setDeskScroll(win, 2400)
    await win.waitForTimeout(300)
    // 改掉文件内容:读回来的新字出现在视口里 = 真重读过,不是按钮没响应、位置自然没动
    fs.writeFileSync(path.join(proj, 'src', 'app.ts'), fs.readFileSync(path.join(proj, 'src', 'app.ts'), 'utf8').replace(/marker line/g, 'reloaded line'))
    await reloadInDesk(win)
    await win.waitForTimeout(2500)
    const after1 = await deskScroll(win)
    const fresh1 = await win.evaluate(() => (document.querySelector('.agent-desk .cm-content')?.textContent || '').includes('reloaded line'))
    await shot(win, '3-code-after-reload')
    check('R1 代码预览点「重新加载」后读到新内容,且停在原处、不回第 1 行', fresh1 && set1 > 0 && !!after1 && Math.abs(after1.top - set1) < 40,
      `fresh=${fresh1} set=${set1} after=${JSON.stringify(after1)}`)

    // R2 Markdown(编辑器每读完一次重挂):同上
    await chips.nth(2).click()
    await win.waitForTimeout(3000)
    const set2 = await setDeskScroll(win, 1500)
    await win.waitForTimeout(300)
    const beforeMd = await deskScroll(win)
    fs.writeFileSync(path.join(proj, 'notes', 'long.md'), md.join('\n').replace(/再来一行正文。/g, '重读过的正文。'))
    await reloadInDesk(win)
    await win.waitForTimeout(3000)
    const after2 = await deskScroll(win)
    const fresh2 = await win.evaluate(() => (document.querySelector('.agent-desk .wsfile-body')?.textContent || '').includes('重读过的正文'))
    await shot(win, '4-md-after-reload')
    check('R2 Markdown 预览点「重新加载」后读到新内容,且停在原处(编辑器重挂也找得回)', fresh2 && set2 > 0 && !!after2 && Math.abs(after2.top - set2) < 40,
      `fresh=${fresh2} set=${set2} before=${JSON.stringify(beforeMd)} after=${JSON.stringify(after2)}`)

  } finally {
    if (typeof clipBefore === 'string') await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), clipBefore).catch(() => {})
    await app.close().catch(() => {})
    try { stub.close() } catch { /* 桩关闭失败不该盖掉断言结果 */ }
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
