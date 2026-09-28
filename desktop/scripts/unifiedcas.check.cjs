// v4 统一编辑器的**写盘安全**仪器(评审 2026-09-27 波次 0a:G1-01 / D-03 / D-04)。
//
//  G 组(`?upage&udual`,同窗同一篇两个生产实例 A/B = 双标签 / 分屏 / Mini):
//   G1 A 打字 → B 回灌看得见 · G2 B 再打字 → A 的字没丢 · G3 再交替一轮零冲突零副本
//   G4 insertMarkdown 落进一个实例 → 另一个接着打字,两边内容都在盘上
//   G5 insertMarkdown 后**立刻**在另一个实例打字(真并发):要么都在盘上,要么被盖的那版进了冲突副本 + error 提示
//   G6 B 打一个字就关(卸载冲洗)→ 字落盘、A 回灌看得见、先前谁的字都没丢
//   G7 停手后 3s 写盘次数不再增长(两个实例互相规范化 = 乒乓写)
//  C 组(CAS,writeTextFile 带基线指纹):
//   C1 盘上被别的窗口悄悄改了(回灌通知还在路上)→ 本地有改动的写被拒 → 盘上那版进冲突副本 + 本地版落盘
//   C2 同上但本实例**没有用户改动**(只是编辑器规范化)→ 让位回灌,盘上那版原样保留、零副本
//   C3 陈旧且没改动的 B 被关掉 → 不许拿旧全文盖掉盘上新版(卸载冲洗的 isPristine 闸)
//  D 组(D-03 打字中外部改动):100ms / 600ms / 连续打字中 fire → 本地胜 + 冲突副本 = 外部那版 + error 提示带「打开副本」;
//   负对照:已落盘后 fire / 没改动时 fire → 照常回灌、零副本零提示
//   假冲突(返修 B1,盘上没离开本实例基线):D6 打字中 fire 原样内容 · D7 标题回车改名后立刻打正文 ·
//   D8 在途自写(盘先落 ack 晚回,`__upage.writeLagMs`)的回声 × 接着打字 → 一律零副本零提示、字照常落盘
//  F 组(D-04 写失败):F1 首次失败即提示 + 页面「未保存」条 · F2 退避自动重试 · F3 online 信号立刻补写、条消失
//   F4 失败中切走 → 草稿进本机、盘上不被覆盖 → 切回出「恢复草稿」条,点了才写 · F5 草稿 = 盘上内容时静默删掉
//   F6 离开确认只在非 Electron 宿主、且真有写不进去的内容时拦 · F7 失败存草稿后又打字、重试成功 → 旧草稿删掉
//   F8/F9 失败中把改动撤回到盘上那版(恢复信号到达 / 没等重试就切走)→ 条收掉、旧草稿删掉、切回不提示恢复
//   F10 同上、随后外部改动被回灌采纳(收口 N-4)→ 条收掉、旧草稿删掉
//   F11 改名 IPC 窗口里打字(收口 N-5)→ 退休实例卸载不在旧路径留孤儿草稿,同名新笔记不误弹恢复
//  L 组(在途自写 × 撤回,返修 R1;`__upage.writeLagMs` 造「盘先落、ack 晚回」):写在路上时用户把字删回旧基线 ——
//   L1 接着切走(卸载冲洗)→ 撤回落盘;两发写之间本机草稿一直在(前一发的 ack 不许删掉比它新的草稿)、零提示
//   L2 停在原页(schedule)→ 撤回同样落盘
//
// 用法:npm run check:unifiedcas(= node scripts/e2e-editor.cjs --check=unifiedcas;worktree 里设 HARNESS_URL)
const fs = require('fs'), os = require('os'), path = require('path')
const { chromium } = require('playwright-core')

function findChromium() {
  if (process.env.CHROMIUM_EXE) return process.env.CHROMIUM_EXE
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, d, 'chrome-mac-arm64', app)
      if (fs.existsSync(p)) return p
    }
  throw new Error('找不到 chromium,设 CHROMIUM_EXE 环境变量')
}

const URL = process.env.HARNESS_URL || 'http://localhost:5173/harness.html'
const PM = '.unified-body .ProseMirror'
const only = (process.env.ONLY || '').split(',').filter(Boolean) // ONLY=G,C 只跑这几组(调试用)
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function open(browser, seed, flags = '') {
  const p = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1200, height: 1100 } })
  p.errs = []
  p.on('pageerror', (e) => { p.errs.push(e.message); console.log('[pageerror]', e.message) })
  // 从第一帧就收 toast(挂载补读、首次失败都可能很早)
  await p.addInitScript(() => {
    window.__toasts = []
    window.addEventListener('amadeus:toast', (e) => window.__toasts.push({ ...e.detail, action: e.detail.action ? { label: e.detail.action.label } : undefined, run: e.detail.action?.run }))
  })
  await p.goto(`${URL}?upage${flags}&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 60000 })
  if (flags.includes('udual')) await p.waitForFunction((s) => document.querySelectorAll(s).length === 2, PM, { timeout: 60000 })
  await p.waitForFunction(() => !!window.__upage.lifecycle, null, { timeout: 20000 })
  await p.waitForTimeout(500)
  return p
}

/** 在第 idx 个实例(0=A 主实例,1=B)里把光标放到 text 之后并聚焦(直驱 PM 选区,不靠坐标)。 */
async function caretAfter(p, idx, text) {
  const ok = await p.evaluate(([idx, text]) => {
    const view = (idx ? window.__upage.probe2 : window.__upage.probe).view()
    let found = -1
    view.state.doc.descendants((node, pos) => {
      if (found >= 0) return false
      if (node.isText) { const i = node.text.indexOf(text); if (i >= 0) { found = pos + i + text.length; return false } }
      return true
    })
    if (found < 0) return false
    let proto = Object.getPrototypeOf(view.state.selection)
    while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
    view.focus()
    view.dispatch(view.state.tr.setSelection(proto.constructor.near(view.state.doc.resolve(found))))
    return true
  }, [idx, text])
  if (!ok) throw new Error(`caretAfter: 实例 ${idx} 里找不到「${text}」`)
}
async function typeIn(p, idx, after, str) {
  await caretAfter(p, idx, after)
  await p.keyboard.type(str)
}
const disk = (p) => p.evaluate(() => window.__upage.vault.get('Unified.md'))
const copies = (p) => p.evaluate(() => [...window.__upage.vault.entries()].filter(([k]) => / \(conflict \d{4}-\d{2}-\d{2} \d{4}\)(-\d+)?\.md$/.test(k)))
const toasts = (p) => p.evaluate(() => window.__toasts.map(({ run, ...t }) => t))
const domText = (p, idx) => p.evaluate(([s, idx]) => document.querySelectorAll(s)[idx]?.innerText ?? '', [PM, idx])
const writeCount = (p) => p.evaluate(() => window.__upage.writes.length)
const draftKeys = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('amadeus.unsavedDraft:')))

async function groupG(browser) {
  const p = await open(browser, '# 标题\n\n第一段。\n\n## 小节\n\n第二段。\n', '&udual')
  await typeIn(p, 0, '第一段。', 'AAA')
  await wait(1800)
  let d = await disk(p)
  record('G1 A 打字落盘 → B 回灌看得见(同窗同篇通知)', d.includes('AAA') && (await domText(p, 1)).includes('AAA'), JSON.stringify(d))

  await typeIn(p, 1, '第二段。', 'BBB')
  await wait(1800)
  d = await disk(p)
  record('G2 B 再打字:A 的字没被 B 的旧全文盖掉,A 也看得见 B 的字', d.includes('AAA') && d.includes('BBB') && (await domText(p, 0)).includes('BBB'), JSON.stringify(d))

  await typeIn(p, 0, 'AAA', 'CCC')
  await wait(1800)
  await typeIn(p, 1, 'BBB', 'DDD')
  await wait(1800)
  d = await disk(p)
  const c3 = await copies(p)
  const t3 = await toasts(p)
  record('G3 再交替一轮:全部在盘上,零冲突副本零提示', ['AAA', 'BBB', 'CCC', 'DDD'].every((x) => d.includes(x)) && c3.length === 0 && t3.length === 0, JSON.stringify({ d, copies: c3.length, toasts: t3.length }))

  // G4:插件块表面 / 模板的写口(按路径路由,落进哪个实例由 lifecycle 定 —— 那条路由是 G1-02,本组不管)
  const target = await p.evaluate(() => {
    window.__upage.lifecycle.unifiedInsertMarkdown('Unified.md', 'INSERTED', 'end')
    const eds = document.querySelectorAll('.unified-body .ProseMirror')
    return eds[0].innerText.includes('INSERTED') ? 0 : eds[1].innerText.includes('INSERTED') ? 1 : -1
  })
  await wait(1800)
  const other = target === 0 ? 1 : 0
  await typeIn(p, other, 'DDD', 'EEE')
  await wait(1800)
  d = await disk(p)
  record('G4 insertMarkdown 落进一个实例,另一个接着打字:两边内容都在盘上', target >= 0 && d.includes('INSERTED') && d.includes('EEE') && (await domText(p, target)).includes('EEE'), JSON.stringify({ target, d }))

  // G5:真并发 —— insertMarkdown 刚落进 X,100ms 内另一个实例就开始打字(X 的防抖写 800ms 后才落,那时对面正有未落盘编辑)
  const t5 = await p.evaluate(() => {
    window.__upage.lifecycle.unifiedInsertMarkdown('Unified.md', 'RACE1', 'end')
    const eds = document.querySelectorAll('.unified-body .ProseMirror')
    return eds[0].innerText.includes('RACE1') ? 0 : 1
  })
  await wait(100)
  await typeIn(p, t5 === 0 ? 1 : 0, 'EEE', 'FFF')
  await wait(3500)
  d = await disk(p)
  const c5 = await copies(p)
  const tt5 = await toasts(p)
  const bothOnDisk = d.includes('RACE1') && d.includes('FFF')
  const loserInCopy = d.includes('FFF') && c5.some(([, v]) => v.includes('RACE1')) && tt5.some((t) => t.level === 'error' && t.action)
  record('G5 真并发:两边都在盘上,或被盖的那版进了冲突副本 + error 提示(不静默丢)', bothOnDisk || loserInCopy, JSON.stringify({ bothOnDisk, loserInCopy, copies: c5.map(([k]) => k), toasts: tt5.length }))

  // G6:B 打一个字立刻关掉(卸载冲洗)
  await typeIn(p, 1, 'FFF', 'Z')
  await p.evaluate(() => window.__upage.unmountB())
  await wait(1800)
  d = await disk(p)
  const aText = await domText(p, 0)
  const allKept = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFFZ'].every((x) => d.includes(x))
  record('G6 B 带未落盘编辑被关:字落盘、A 回灌看得见、先前谁的字都没丢', allKept && aText.includes('FFFZ'), JSON.stringify({ d, aHasZ: aText.includes('FFFZ') }))

  const w0 = await writeCount(p)
  await wait(3000)
  const w1 = await writeCount(p)
  record('G7 停手 3s 写盘次数不再增长(无实例间乒乓写)', w1 === w0, JSON.stringify({ w0, w1 }))
  record('G8 全程无运行时异常', p.errs.length === 0, p.errs.slice(0, 2).join(' | '))
  await p.close()
}

async function groupC(browser) {
  // C1:本地有改动 + 盘上被悄悄改过(另一个窗口的写,externalChange 还在路上)
  {
    const p = await open(browser, '# T\n\n甲段。\n\n乙段。\n')
    await p.evaluate(() => window.__upage.vault.set('Unified.md', '# T\n\n甲段。别处写的\n\n乙段。\n'))
    await typeIn(p, 0, '乙段。', '本地')
    await wait(1800)
    const d = await disk(p)
    const c = await copies(p)
    const t = await toasts(p)
    const rejects = await p.evaluate(() => window.__upage.casRejects.length)
    record('C1 CAS 拒掉陈旧写 → 盘上那版进冲突副本 + error 提示,本地版随后落盘',
      rejects >= 1 && d.includes('乙段。本地') && c.length === 1 && c[0][1].includes('别处写的') && t.some((x) => x.level === 'error' && x.action?.label),
      JSON.stringify({ rejects, d, copies: c.map(([k, v]) => [k, v]), toasts: t.length }))
    await p.close()
  }
  // C2:本实例没有用户改动(只是编辑器把 __粗__ 规范化成 **粗**)
  {
    const p = await open(browser, '# T\n\n__粗__ 与 _斜_\n')
    const X = '# T\n\n__粗__ 与 _斜_ 别处追加\n'
    await p.evaluate((X) => window.__upage.vault.set('Unified.md', X), X)
    await p.evaluate(() => window.__upage.probe.flush()) // 规范化写:syncFromEditor 让 body ≠ 基线
    await wait(1500)
    const d = await disk(p)
    const c = await copies(p)
    // 回灌之后编辑器会把 `__粗__` 规范化写回(这是既有的回灌行为,不是本组要管的)—— 判据只看「别处那版的内容还在盘上」。
    record('C2 没有用户改动的 CAS 拒写 → 让位回灌:别处那版的内容留在盘上、零副本零提示、编辑器显示新内容',
      d.includes('别处追加') && c.length === 0 && (await toasts(p)).length === 0 && (await domText(p, 0)).includes('别处追加'), JSON.stringify({ d, copies: c.length }))
    await p.close()
  }
  // C3:陈旧且没改动的 B 被关掉
  {
    const p = await open(browser, '# T\n\n__粗__ 与 _斜_\n', '&udual')
    const X = '# T\n\n**粗** 与 *斜* 别的窗口写的\n'
    await p.evaluate((X) => window.__upage.vault.set('Unified.md', X), X)
    await p.evaluate(() => window.__upage.unmountB())
    await wait(1500)
    const d = await disk(p)
    const c = await copies(p)
    const w = await p.evaluate(() => window.__upage.writes.length)
    record('C3 陈旧且没改动的实例卸载:不写(不拿旧全文盖掉盘上新版)', d === X && c.length === 0 && w === 0, JSON.stringify({ d, copies: c.length, writes: w }))
    await p.close()
  }
}

async function groupD(browser) {
  const MD = '# T\n\npara1 AAA\n\npara2 BBB\n\npara3 CCC\n'
  const EXT = '# T\n\npara1 AAA AGENT-WROTE-THIS\n\npara2 BBB\n\npara3 CCC\n'
  const cases = [
    { label: 'D1 fire 于打字后 100ms', type: true, delay: 100 },
    { label: 'D2 fire 于打字后 600ms(防抖写之前)', type: true, delay: 600 },
    { label: 'D3 fire 于连续打字中', type: true, delay: 100, continuous: true },
  ]
  for (const k of cases) {
    const p = await open(browser, MD)
    await typeIn(p, 0, 'CCC', ' local')
    await wait(k.delay)
    await p.evaluate((t) => window.__upage.fire('Unified.md', t), EXT)
    if (k.continuous) for (let i = 0; i < 6; i++) { await p.keyboard.type('x'); await wait(250) }
    await wait(3000)
    const d = await disk(p)
    const c = await copies(p)
    const t = await toasts(p)
    const err = t.find((x) => x.level === 'error')
    record(`${k.label}:本地胜 + 冲突副本 = 外部那版 + error 提示「打开副本」`,
      d.includes('CCC local') && !d.includes('AGENT-WROTE-THIS') && c.length === 1 && c[0][1] === EXT && !!err && !!err.action?.label && err.text.includes(c[0][0].replace(/\.md$/, '')),
      JSON.stringify({ d, copies: c.map(([k2]) => k2), toast: err?.text }))
    if (k.label.startsWith('D1')) {
      // 「打开副本」= 导航门面事件(amadeusOverlays → openNote),路径正是副本
      const nav = await p.evaluate(() => new Promise((resolve) => {
        const on = (e) => { window.removeEventListener('amadeus:navigate-note', on); resolve(e.detail?.path ?? null) }
        window.addEventListener('amadeus:navigate-note', on)
        const t = window.__toasts.find((x) => x.level === 'error')
        if (!t?.run) return resolve('no-toast')
        t.run()
        setTimeout(() => resolve('timeout'), 1000)
      }))
      record('D1b 「打开副本」动作 = 导航到副本路径', nav === c[0]?.[0], JSON.stringify(nav))
    }
    await p.close()
  }
  for (const k of [{ label: 'D4 负对照:已落盘后 fire', type: true, delay: 2500 }, { label: 'D5 负对照:没有本地改动时 fire', type: false, delay: 500 }]) {
    const p = await open(browser, MD)
    if (k.type) await typeIn(p, 0, 'CCC', ' local')
    await wait(k.delay)
    await p.evaluate((t) => window.__upage.fire('Unified.md', t), EXT)
    await wait(2500)
    const d = await disk(p)
    record(`${k.label} → 照常回灌、零副本零提示`, d === EXT && (await copies(p)).length === 0 && (await toasts(p)).length === 0 && (await domText(p, 0)).includes('AGENT-WROTE-THIS'), JSON.stringify(d))
    await p.close()
  }
  // D6–D8 假冲突负对照(评审 D-03 返修 B1):盘上**根本没离开**本实例的基线,只是手上有未落盘的字时回灌读回了
  // 自己的那版 —— 绝不许生出冲突副本 / error 提示,且字照常落盘(断言盘上内容,不许靠「根本没存」蒙混过关)。
  {
    // D6 回灌事件到了、盘上内容没变(watcher 假回声 / 跨窗通知落到没动过的同路径)
    const p = await open(browser, MD)
    await typeIn(p, 0, 'CCC', ' local')
    await wait(100)
    await p.evaluate(() => window.__upage.fire('Unified.md', window.__upage.vault.get('Unified.md')))
    await wait(3000)
    const d = await disk(p)
    const c = await copies(p)
    const t = await toasts(p)
    record('D6 打字中 fire、盘上内容没变 → 零副本零提示、字照常落盘', c.length === 0 && t.length === 0 && d === MD.replace('CCC\n', 'CCC local\n'), JSON.stringify({ d, copies: c.map(([k]) => k), toasts: t.map((x) => x.text) }))
    await p.close()
  }
  {
    // D7 新建笔记的流程:标题回车改名 → 实例按新路径重挂 → 立刻接着打正文。重挂的补读等打字静默,
    // 读回的正是自己改名前写下的那版(用户实际路径里最常见的假冲突触发点)。
    const p = await open(browser, MD)
    await p.click('.amx-title-input')
    await p.keyboard.press('Meta+A')
    await p.keyboard.type('Meeting', { delay: 50 })
    await p.evaluate((s) => { window.__d7old = document.querySelector(s) }, PM)
    await p.keyboard.press('Enter')
    // 等的是**重挂后的新实例**接住焦点(旧实例在改名 IPC 窗口里还握着焦点,那几击落进退休实例是另一条既有竞速,
    // 基线同样会丢 —— D7 只验回灌的假冲突,不和它搅在一起)。
    await p.waitForFunction((s) => { const pm = document.querySelector(s); return !!pm && pm !== window.__d7old && pm.contains(document.activeElement) }, PM, { timeout: 5000 })
    await p.keyboard.type('hello body', { delay: 60 })
    await wait(3500)
    const d = await p.evaluate(() => window.__upage.vault.get('Meeting.md'))
    const c = await copies(p)
    const t = await toasts(p)
    record('D7 标题回车改名后立刻打正文 → 零副本零提示、正文落盘', c.length === 0 && t.length === 0 && typeof d === 'string' && d.startsWith('hello body') && d.includes('para3 CCC'), JSON.stringify({ d, copies: c.map(([k]) => k), toasts: t.map((x) => x.text) }))
    await p.close()
  }
  {
    // D8 在途自写:盘先落、ack 晚回(web PUT / 网络盘)。写在路上时接着打字 + 自写回声到达 → 回灌若不先等写链
    // 落定,读到的是自己刚写出去的那版、lastSaved 还是上一版,就会把它当外部改动保全。
    const p = await open(browser, MD)
    await p.evaluate(() => { window.__upage.writeLagMs = 1500 })
    await typeIn(p, 0, 'CCC', ' local')
    await wait(1000) // 防抖 800ms 已到:写已落盘、ack 还在路上
    const inflight = await p.evaluate(() => window.__upage.vault.get('Unified.md'))
    await p.keyboard.type(' more')
    await p.evaluate(() => window.__upage.fire('Unified.md', window.__upage.vault.get('Unified.md')))
    await wait(5000)
    await p.evaluate(() => { window.__upage.writeLagMs = 0 })
    const d = await disk(p)
    const c = await copies(p)
    const t = await toasts(p)
    record('D8 在途自写的回声(盘先落 ack 晚回)× 接着打字 → 零副本零提示、两段字都落盘',
      inflight.includes('CCC local') && c.length === 0 && t.length === 0 && d === MD.replace('CCC\n', 'CCC local more\n'),
      JSON.stringify({ inflight: inflight.includes('CCC local'), d, copies: c.map(([k]) => k), toasts: t.map((x) => x.text) }))
    await p.close()
  }
}

async function groupF(browser) {
  // F1–F3:写失败 → 提示 + 「未保存」条 → 退避重试 → online 补写
  {
    const p = await open(browser, '# T\n\npara1 AAA\n')
    await p.evaluate(() => { window.__upage.failWrites = 1000 })
    await typeIn(p, 0, 'AAA', ' IMPORTANT')
    await wait(1400)
    const t = await toasts(p)
    const bar = await p.evaluate(() => {
      const el = document.querySelector('.unified-page [data-save="failed"]')
      return el ? { text: el.innerText, visible: el.getBoundingClientRect().height > 0, btn: !!el.querySelector('button') } : null
    })
    record('F1 首次写失败即提示 + 页面常驻「未保存」条(带立即重试)', t.some((x) => x.level === 'warning' && /没能保存/.test(x.text)) && !!bar?.visible && /未保存/.test(bar.text) && bar.btn, JSON.stringify({ toasts: t, bar }))
    const before = await p.evaluate(() => window.__upage.failWrites)
    await wait(2600) // 首档退避 2s
    const after = await p.evaluate(() => window.__upage.failWrites)
    record('F2 失败后按退避自动重试(不等下一次击键)', after < before, JSON.stringify({ before, after }))
    await p.evaluate(() => { window.__upage.failWrites = 0; window.dispatchEvent(new Event('online')) })
    await wait(800)
    const d = await disk(p)
    const barGone = await p.evaluate(() => !document.querySelector('[data-save="failed"]'))
    record('F3 online 信号立刻补写(不等退避到点),「未保存」条消失', d.includes('IMPORTANT') && barGone, JSON.stringify({ d, barGone }))
    await p.close()
  }
  // F4:失败持续到切走(卸载冲洗也失败)→ 草稿进本机;切回 → 提示恢复、盘上不被自动覆盖;点恢复才写
  {
    const p = await open(browser, '# T\n\npara1 AAA\n')
    await p.evaluate(() => { localStorage.clear(); window.__upage.failWrites = 1000 })
    await typeIn(p, 0, 'AAA', ' IMPORTANT TEXT')
    await wait(1400)
    await p.evaluate(() => window.__upage.switchFile('Other.md', '# Other\n\nother body\n'))
    await wait(800)
    const keys = await draftKeys(p)
    await p.evaluate(() => { window.__upage.failWrites = 0 })
    await p.evaluate(() => window.__upage.switchFile('Unified.md'))
    await wait(1200)
    const d1 = await disk(p)
    const bar = await p.evaluate(() => {
      const el = document.querySelector('.unified-page [data-save="draft"]')
      return el ? { text: el.innerText, buttons: [...el.querySelectorAll('button')].map((b) => b.textContent) } : null
    })
    record('F4a 失败中切走:草稿进本机;切回出「恢复草稿」条,盘上内容没被自动覆盖', keys.length === 1 && !d1.includes('IMPORTANT') && !!bar && bar.buttons.includes('恢复草稿'), JSON.stringify({ keys, d1, bar }))
    await p.evaluate(() => [...document.querySelectorAll('[data-save="draft"] button')].find((b) => b.textContent === '恢复草稿')?.click())
    await wait(1500)
    const d2 = await disk(p)
    const keys2 = await draftKeys(p)
    const shown = (await domText(p, 0)).includes('IMPORTANT TEXT')
    record('F4b 点「恢复草稿」→ 编辑器与盘上都回来了,草稿删掉、条消失', d2.includes('IMPORTANT TEXT') && shown && keys2.length === 0 && (await p.evaluate(() => !document.querySelector('[data-save]'))), JSON.stringify({ d2, keys2, shown }))
    await p.close()
  }
  // F5:草稿与盘上内容一样(写其实成功了 / 别处恰好写成同一份,只是草稿没来得及删)→ 静默删,不打扰
  {
    const p = await open(browser, '# T\n\npara1 AAA\n')
    await p.evaluate(() => { localStorage.clear(); window.__upage.failWrites = 1000 })
    await typeIn(p, 0, 'AAA', ' SAME')
    await wait(1400)
    await p.evaluate(() => window.__upage.switchFile('Other.md', '# Other\n\nother body\n'))
    await wait(800)
    const keys0 = await draftKeys(p)
    const draftText = keys0.length ? await p.evaluate((k) => JSON.parse(localStorage.getItem(k)).text, keys0[0]) : null
    await p.evaluate((t) => { window.__upage.failWrites = 0; window.__upage.vault.set('Unified.md', t) }, draftText)
    await p.evaluate(() => window.__upage.switchFile('Unified.md'))
    await wait(1000)
    const bar = await p.evaluate(() => !!document.querySelector('[data-save="draft"]'))
    const keys = await draftKeys(p)
    record('F5 草稿 = 盘上内容 → 静默删掉、不出条', keys0.length === 1 && !!draftText?.includes('SAME') && !bar && keys.length === 0, JSON.stringify({ keys0, bar, keys }))
    await p.close()
  }
  // F7:失败时存了草稿,之后又打了字,重试成功 → 本实例存的那份旧草稿必须删掉(否则下次打开是一条带旧内容的假提示)
  {
    const p = await open(browser, '# T\n\npara1 AAA\n')
    await p.evaluate(() => { localStorage.clear(); window.__upage.failWrites = 1000 })
    await typeIn(p, 0, 'AAA', ' X1')
    await wait(1400)
    const k1 = await draftKeys(p)
    await p.keyboard.type(' X2')
    await wait(300)
    await p.evaluate(() => { window.__upage.failWrites = 0; window.dispatchEvent(new Event('online')) })
    await wait(1500)
    const d = await disk(p)
    const k2 = await draftKeys(p)
    record('F7 失败存草稿后又打字、重试成功:旧草稿删掉(不留下次打开的假提示)', k1.length === 1 && d.includes('X1 X2') && k2.length === 0, JSON.stringify({ k1, d, k2 }))
    await p.close()
  }
  // F8/F9:写失败期间用户把改动**撤回到盘上那版** —— 已经没有「未保存」可言(评审 edge E1):
  //  F8 恢复信号到了 → 条收掉、失败时存的旧草稿删掉、盘上不动;F9 还没等到重试就切走 → 草稿同样删掉,切回不提示恢复
  for (const k of [{ label: 'F8 撤回后恢复信号到达', recover: true }, { label: 'F9 撤回后没等重试就切走', recover: false }]) {
    const p = await open(browser, '# T\n\npara1 AAA\n')
    await p.evaluate(() => { localStorage.clear(); window.__upage.failWrites = 1000 })
    await typeIn(p, 0, 'AAA', ' XY')
    await wait(1400)
    const failedBar = await p.evaluate(() => !!document.querySelector('.unified-page [data-save="failed"]'))
    const k1 = await draftKeys(p)
    for (let i = 0; i < 3; i++) await p.keyboard.press('Backspace')
    await wait(600)
    if (k.recover) {
      await p.evaluate(() => { window.__upage.failWrites = 0; window.dispatchEvent(new Event('online')) })
      await wait(1500)
    }
    const barGone = await p.evaluate(() => !document.querySelector('.unified-page [data-save]'))
    await p.evaluate(() => window.__upage.switchFile('Other.md', '# Other\n\nx\n'))
    await wait(800)
    const k2 = await draftKeys(p)
    await p.evaluate(() => { window.__upage.failWrites = 0 })
    await p.evaluate(() => window.__upage.switchFile('Unified.md'))
    await wait(1200)
    const barsBack = await p.evaluate(() => [...document.querySelectorAll('.unified-page [data-save]')].map((e) => e.dataset.save))
    const d = await disk(p)
    record(`${k.label} → 「未保存」条收掉、旧草稿删掉、切回不提示恢复、盘上不动`,
      failedBar && k1.length === 1 && (!k.recover || barGone) && k2.length === 0 && barsBack.length === 0 && d === '# T\n\npara1 AAA\n',
      JSON.stringify({ failedBar, k1, barGone, k2, barsBack, d }))
    await p.close()
  }
  // F10(收口 N-4):写失败期间撤回到盘上那版,**随后外部改动到达、被回灌采纳**(本地无改动 → 照常回灌)。本地 = 盘上,
  //  没有「未保存」可言 —— 但采纳分支只换基线不收失败态:退避重试与恢复信号都因 !pending 直接返回,条永远挂着、
  //  失败时存的 XY 草稿留到下次提示恢复。时序钉死:条一出现就撤回并 fire,采纳(≈静默 700ms)远早于首档退避 2s,
  //  不给「重试先到、走 writeNow 无事出口顺手收掉」蒙混过关的机会。负对照:采纳分支摘掉 settleUnsaved() → 红。
  {
    const p = await open(browser, '# T\n\npara1 AAA\n')
    await p.evaluate(() => { localStorage.clear(); window.__upage.failWrites = 1000 })
    await typeIn(p, 0, 'AAA', ' XY')
    await p.waitForSelector('.unified-page [data-save="failed"]', { timeout: 5000 })
    const k1 = await draftKeys(p)
    for (let i = 0; i < 3; i++) await p.keyboard.press('Backspace')
    await wait(300) // markdownUpdated 防抖 200ms:pipe.body 已回到盘上那版
    await p.evaluate(() => { window.__upage.failWrites = 0 })
    const EXT = '# T\n\npara1 AAA EXTERNAL\n'
    const w0 = await writeCount(p)
    await p.evaluate((t) => window.__upage.fire('Unified.md', t), EXT)
    await p.waitForFunction(() => document.querySelector('.unified-body .ProseMirror')?.innerText.includes('EXTERNAL'), null, { timeout: 5000 }).catch(() => {})
    await wait(400)
    const r = {
      k1,
      bars: await p.evaluate(() => [...document.querySelectorAll('.unified-page [data-save]')].map((e) => e.dataset.save)),
      k2: await draftKeys(p),
      shown: (await domText(p, 0)).includes('EXTERNAL'),
      d: await disk(p),
      dw: (await writeCount(p)) - w0,
      copies: (await copies(p)).length,
    }
    await p.evaluate(() => window.__upage.switchFile('Other.md', '# Other\n\nx\n'))
    await wait(800)
    await p.evaluate(() => window.__upage.switchFile('Unified.md'))
    await wait(1200)
    r.barsBack = await p.evaluate(() => [...document.querySelectorAll('.unified-page [data-save]')].map((e) => e.dataset.save))
    record('F10 写失败后撤回、外部改动随后被回灌采纳 → 条收掉、旧草稿删掉、切回不提示恢复;盘上是外部那版、零写入零副本',
      r.k1.length === 1 && r.bars.length === 0 && r.k2.length === 0 && r.shown && r.d === EXT && r.dw === 0 && r.copies === 0 && r.barsBack.length === 0,
      JSON.stringify(r))
    await p.close()
  }
  // F11(收口 N-5):改名 IPC 窗口里又打了字 → 字按新路径补写(doRename),本实例退休;退休实例卸载冲洗过去不看
  //  retired:本地 ≠ 旧基线 → 在**旧路径**存一份草稿,writeNow 对退休实例不写、这份草稿永不删除 → 之后同名位置
  //  出现新笔记(又一篇 Untitled.md 之类)就误弹「恢复草稿」。要求:旧路径零草稿、新笔记不弹条、字在新路径上。
  //  负对照:卸载冲洗摘掉 retired 分支 → 红。
  {
    const p = await open(browser, '# T\n\npara1 AAA\n')
    await p.evaluate(() => {
      localStorage.clear()
      const orig = window.amadeus.renamePageFile
      window.amadeus.renamePageFile = (from, next) => new Promise((r) => setTimeout(() => r(orig(from, next)), 900)) // 改名 IPC 窗口
    })
    await p.click('.amx-title-input')
    await p.keyboard.press('Meta+A')
    await p.keyboard.type('Meeting', { delay: 30 })
    await p.keyboard.press('Enter')
    await wait(150) // 进了 IPC 窗口:doRename 已过 writeNow / flushAllScopes,在等 renamePageFile
    await typeIn(p, 0, 'AAA', ' INWINDOW')
    await p.waitForFunction(() => window.__upage.vault.has('Meeting.md'), null, { timeout: 5000 }).catch(() => {})
    await wait(1500) // 改名收尾 + 重挂 + 退休实例卸载冲洗
    const r = {
      keys: await draftKeys(p),
      moved: await p.evaluate(() => window.__upage.vault.get('Meeting.md') ?? null),
      oldGone: await p.evaluate(() => !window.__upage.vault.has('Unified.md')),
    }
    // 用户可见的症状:同名位置出现一篇新笔记 → 不许弹「恢复草稿」
    await p.evaluate(() => window.__upage.switchFile('Unified.md', '# Fresh\n\nnew note\n'))
    await wait(1200)
    r.bars = await p.evaluate(() => [...document.querySelectorAll('.unified-page [data-save]')].map((e) => e.dataset.save))
    r.keys2 = await draftKeys(p)
    record('F11 改名 IPC 窗口里打字:字落新路径、旧路径零草稿,同名新笔记不误弹「恢复草稿」',
      typeof r.moved === 'string' && r.moved.includes('AAA INWINDOW') && r.oldGone && r.keys.length === 0 && r.bars.length === 0 && r.keys2.length === 0,
      JSON.stringify(r))
    await p.close()
  }
  // F6:离开确认(beforeunload)只在非 Electron 宿主、且有写不进去的内容时拦
  {
    const p = await open(browser, '# T\n\npara1 AAA\n')
    const probeUnload = () => p.evaluate(() => {
      const ev = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(ev)
      return ev.defaultPrevented
    })
    const idle = await probeUnload()
    await p.evaluate(() => { window.__upage.failWrites = 1000 })
    await typeIn(p, 0, 'AAA', ' unsaved')
    await wait(1400)
    const failedWeb = await probeUnload()
    // web / 移动宿主也装了 window.tangu 垫片(webShim / mobileShim)—— 带着它也必须照拦,只有 Electron UA 才不拦。
    const failedWebShim = await p.evaluate(() => {
      window.tangu = { platform: 'web' }
      const ev = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(ev)
      delete window.tangu
      return ev.defaultPrevented
    })
    const failedElectron = await p.evaluate(() => {
      const real = navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', { value: `${real} Electron/38.0.0`, configurable: true })
      const ev = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(ev)
      delete navigator.userAgent
      return ev.defaultPrevented
    })
    record('F6 离开确认:空闲不拦 / web 写失败中拦(带 window.tangu 垫片也拦)/ Electron 永不拦',
      idle === false && failedWeb === true && failedWebShim === true && failedElectron === false, JSON.stringify({ idle, failedWeb, failedWebShim, failedElectron }))
    await p.evaluate(() => { window.__upage.failWrites = 0 })
    await p.close()
  }
}

async function groupL(browser) {
  const MD = '# T\n\npara1 AAA\n\npara2 BBB\n\npara3 CCC\n'
  for (const k of [{ label: 'L1 在途自写 ack 前撤回到旧基线再切走(卸载冲洗)', leave: true }, { label: 'L2 在途自写 ack 前撤回到旧基线、停在原页(schedule)', leave: false }]) {
    const p = await open(browser, MD)
    await p.evaluate(() => { localStorage.clear(); window.__upage.writeLagMs = 2500 })
    await typeIn(p, 0, 'CCC', ' XY')
    await p.waitForFunction(() => (window.__upage.vault.get('Unified.md') || '').includes('CCC XY'), null, { timeout: 5000 })
    for (let i = 0; i < 3; i++) await p.keyboard.press('Backspace')
    await wait(250) // markdownUpdated 防抖 200ms:pipe.body 已是撤回后的版本,在途那发的 ack 还没回
    if (k.leave) await p.evaluate(() => window.__upage.switchFile('Other.md', '# Other\n\nx\n'))
    // 第二发写(撤回)落盘那一刻(它的 ack 还在路上):卸载冲洗存的草稿必须还在 —— 第一发 ack 不许把它删掉。
    let midDrafts = null
    try {
      await p.waitForFunction(() => window.__upage.writes.filter((w) => w.path === 'Unified.md').length >= 2, null, { timeout: 6000 })
      midDrafts = await p.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('amadeus.unsavedDraft:')).map(([, v]) => JSON.parse(v).text))
    } catch { /* 第二发根本没来:下面 disk 断言会红 */ }
    await wait(3500)
    await p.evaluate(() => { window.__upage.writeLagMs = 0 })
    const d = await disk(p)
    const keys = await draftKeys(p)
    const t = await toasts(p)
    const midOk = !k.leave || (Array.isArray(midDrafts) && midDrafts.length === 1 && midDrafts[0] === MD)
    record(`${k.label} → 撤回落盘${k.leave ? '、两发写之间草稿一直在' : ''}、收尾零草稿零提示`,
      d === MD && midOk && keys.length === 0 && t.length === 0,
      JSON.stringify({ d, midDrafts, keys, toasts: t.map((x) => x.text), writes: await p.evaluate(() => window.__upage.writes.filter((w) => w.path === 'Unified.md').map((w) => w.text)) }))
    await p.close()
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  try {
    const groups = { G: groupG, C: groupC, D: groupD, F: groupF, L: groupL }
    for (const [k, fn] of Object.entries(groups)) if (!only.length || only.includes(k)) await fn(browser)
  } finally {
    await browser.close()
  }
  const ok = results.filter(Boolean).length
  console.log(`\n${ok}/${results.length} 通过`)
  process.exit(ok === results.length ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
