// UnifiedPage 生产组件全链仪器(spec §9 step 3 Phase A):
//  P1 只读打开不改写(外来 md 原生逐段渲染,零写盘)  P2 编辑 → 防抖落盘为**纯 md**
//  P3 空闲外部回灌 = 同实例最小差异事务(零重挂+无回声写)  P4 组合中押后+冻结保存,静默后应用
// 用法:node scripts/e2e-editor.cjs --check=unified-page
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
const PM = '.unified-body .ProseMirror' // 编辑器住 .page-view.unified-body(chrome 在兄弟 .unified-page 里)
const results = []
const record = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

async function fresh(browser) {
  const p = await browser.newPage({ locale: 'zh-CN' })
  p.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await p.goto(`${URL}?upage`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector(PM, { timeout: 20000 })
  await p.waitForTimeout(400)
  return p
}

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true })
  const p = await fresh(browser)

  // P1:只读打开不改写(spec §5.1)。等超过 800ms 防抖窗,不许有任何写。
  const p1 = await p.evaluate((s) => ({
    h1: document.querySelector(`${s} > h1`)?.textContent,
    ps: document.querySelector(s).querySelectorAll(':scope > p').length,
  }), PM)
  await p.waitForTimeout(1300)
  const p1w = await p.evaluate(() => window.__upage.writes.length)
  record('P1 外来 md 原生逐段渲染+只读打开零写盘', p1.h1 === '外来标题' && p1.ps === 2 && p1w === 0, JSON.stringify({ ...p1, writes: p1w }))

  // P2:编辑 → 防抖落盘为纯 md(无 amadeus_page/无标记),内容含新输入与原文。
  await p.evaluate((s) => {
    const el = document.querySelector(s)
    const r = document.createRange()
    r.selectNodeContents(el.querySelector(':scope > p:nth-of-type(1)'))
    const b = r.getBoundingClientRect()
    return { x: b.right - 2, y: b.top + b.height / 2 }
  }, PM).then(async (c) => {
    await p.mouse.click(c.x, c.y)
  })
  await p.keyboard.press('Enter')
  await p.keyboard.type('编辑追加段')
  await p.waitForTimeout(1400)
  const p2 = await p.evaluate(() => {
    const w = window.__upage.writes
    return { n: w.length, last: w[w.length - 1]?.text ?? '' }
  })
  record(
    'P2 编辑落盘=纯 md(零 amadeus 键/零标记)',
    p2.n >= 1 && p2.last.includes('编辑追加段') && p2.last.includes('第一段。') && !p2.last.includes('amadeus_page') && !/<!--\s*a\s/.test(p2.last),
    `writes=${p2.n}`,
  )

  // P3:空闲外部回灌 = 同实例事务(DOM 戳记不动),内容更换,且不产生回声写。
  await p.evaluate((s) => document.querySelector(s).setAttribute('data-stamp', 'S1'), PM)
  const wBefore = await p.evaluate(() => window.__upage.writes.length)
  await p.evaluate(() => window.__upage.fire('Unified.md', '# 回灌标题\n\n盘上新内容一。\n\n盘上新内容二。\n'))
  await p.waitForTimeout(1200)
  const p3 = await p.evaluate((s) => ({
    h1: document.querySelector(`${s} > h1`)?.textContent,
    stamp: document.querySelector(s)?.getAttribute('data-stamp'),
    reconciled: window.__upage.probe.reconciled,
    writes: window.__upage.writes.length,
  }), PM)
  record('P3 外部回灌=同实例事务(戳记在+无回声写)', p3.h1 === '回灌标题' && p3.stamp === 'S1' && p3.reconciled === 1 && p3.writes === wBefore, JSON.stringify(p3))

  // P4:组合中回灌押后(编辑器不动),compositionend 过静默窗(700ms)后应用;冻结期保存不落盘。
  await p.evaluate(() => {
    document.dispatchEvent(new Event('compositionstart'))
    window.__upage.fire('Unified.md', '# 组合期回灌\n\n组合甲。\n\n组合乙。\n')
  })
  await p.waitForTimeout(300)
  const during = await p.evaluate((s) => document.querySelector(`${s} > h1`)?.textContent, PM)
  record('P4a 组合中押后(内容未变)', during === '回灌标题', JSON.stringify(during))
  await p.evaluate(() => document.dispatchEvent(new Event('compositionend')))
  await p.waitForTimeout(1500)
  const p4 = await p.evaluate((s) => ({
    h1: document.querySelector(`${s} > h1`)?.textContent,
    stamp: document.querySelector(s)?.getAttribute('data-stamp'),
  }), PM)
  record('P4b 静默后应用(实例依旧没换)', p4.h1 === '组合期回灌' && p4.stamp === 'S1', JSON.stringify(p4))

  await p.close()

  // ── P5/P6:frontmatter 保全(P0 数据雷,2026-08-13 侦察发现)────────────────────
  // 带 icon/cover/tags fm 的笔记:打开不见 fm 正文;编辑落盘后 fm 逐字还在、正文更新。
  {
    const fm = '---\nicon: "📘"\ncover: assets/x.png\ntags:\n  - alpha\n---\n'
    const seed = `${fm}# 有fm标题\n\n首段。\n`
    const p5p = await browser.newPage({ locale: 'zh-CN' })
    p5p.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await p5p.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await p5p.waitForSelector(PM, { timeout: 20000 })
    await p5p.waitForTimeout(400)
    const p5view = await p5p.evaluate((s) => ({
      h1: document.querySelector(`${s} > h1`)?.textContent,
      text: document.querySelector(s)?.textContent ?? '',
      icon: document.querySelector('.amx-title-bigicon')?.textContent ?? null,
      coverImgs: document.querySelectorAll('.amx-cover img').length,
    }), PM)
    record(
      'P5a fm 不进正文 + 图标/封面 chrome 挂上',
      p5view.h1 === '有fm标题' && !p5view.text.includes('icon:') && !p5view.text.includes('tags') && p5view.icon === '📘' && p5view.coverImgs === 1,
      JSON.stringify(p5view),
    )
    await p5p.evaluate((s) => {
      const el = document.querySelector(s)
      const r = document.createRange()
      r.selectNodeContents(el.querySelector(':scope > p'))
      const b = r.getBoundingClientRect()
      return { x: b.right - 2, y: b.top + b.height / 2 }
    }, PM).then((c) => p5p.mouse.click(c.x, c.y))
    await p5p.keyboard.type('改')
    await p5p.waitForTimeout(1400)
    const p5w = await p5p.evaluate(() => {
      const w = window.__upage.writes
      return w[w.length - 1]?.text ?? '(no write)'
    })
    record(
      'P5b 编辑落盘后 fm 逐字保全',
      p5w.startsWith(fm) && p5w.includes('首段。改') && !p5w.includes('***'),
      JSON.stringify(p5w.slice(0, 90)),
    )

    // P5c(D-01,2026-09-27 评审 P0):文件头 BOM(旧版记事本等会写出)。修前 fm 正则不认 U+FEFF 而 remark 认
    // → fm 整块喂进编辑器:打开显示「属性 0」,打一个字落盘成 `***` + `tags: \[a]…-----`。要求:只读打开零写、
    // fm 不进正文且属性认得到、编辑后除新字外逐字不变(BOM 仍在字节 0;无 fm 的 BOM 也不许丢)。
    for (const [name, seed] of [
      ['bom-fm', '\uFEFF---\ntags: [a]\naliases: [x]\n---\nEDITHERE\n\npara\n'],
      ['bom-nofm', '\uFEFFEDITHERE\n\npara\n'],
    ]) {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(1300) // 越过 800ms 防抖窗:只读打开必须零写
      const o = await pg.evaluate((s) => ({
        writes: window.__upage.writes.length,
        hr: document.querySelectorAll(`${s} > hr`).length,
        text: document.querySelector(s)?.textContent ?? '',
        fm: window.__upage.probe.fmState?.().fm ?? null,
      }), PM)
      await pg.evaluate((s) => {
        const r = document.createRange()
        r.selectNodeContents(document.querySelector(s).querySelector(':scope > p'))
        const b = r.getBoundingClientRect()
        return { x: b.right - 2, y: b.top + b.height / 2 }
      }, PM).then((c) => pg.mouse.click(c.x, c.y))
      await pg.keyboard.type('Z')
      await pg.waitForTimeout(1400)
      const out = await pg.evaluate(() => window.__upage.writes.at(-1)?.text ?? null)
      const want = seed.replace('EDITHERE', 'EDITHEREZ')
      const fmOk = name === 'bom-fm' ? /^\uFEFF---\ntags: \[a\]/.test(o.fm ?? '') : o.fm === '\uFEFF'
      record(`P5c 文件头 BOM(${name}):打开零写 + fm 不进正文 + 编辑后逐字(D-01)`,
        o.writes === 0 && o.hr === 0 && !o.text.includes('tags') && fmOk && out === want,
        JSON.stringify({ writes: o.writes, hr: o.hr, fmOk, same: out === want, out: (out ?? '').slice(0, 60) }))
      await pg.close()
    }

    // P6:chrome 写 fm(设图标)→ 立即落盘,fm 增 icon 键、正文原样。
    const p6p = await browser.newPage({ locale: 'zh-CN' })
    await p6p.goto(`${URL}?upage&useed=${encodeURIComponent('# 素文件\n\n正文。\n')}`, { waitUntil: 'domcontentloaded' })
    await p6p.waitForSelector(PM, { timeout: 20000 })
    await p6p.waitForTimeout(300)
    await p6p.click('.amx-title-actions button:first-child') // ☺ 添加图标(随机 emoji)
    await p6p.waitForTimeout(600)
    const p6 = await p6p.evaluate(() => {
      const w = window.__upage.writes
      const last = w[w.length - 1]?.text ?? ''
      return { n: w.length, hasIcon: /^---\n[\s\S]*icon:[\s\S]*---\n/.test(last), body: last.includes('# 素文件') && last.includes('正文。'), bigicon: !!document.querySelector('.amx-title-bigicon') }
    })
    record('P6 设图标 → fm 落盘 + 正文原样 + 大图标上屏', p6.n >= 1 && p6.hasIcon && p6.body && p6.bigicon, JSON.stringify(p6))
    await p5p.close()
    await p6p.close()
  }

  // ── PR 系列:属性面板受控草稿(评审 2026-09-27 C-01 P0)────────────────────────────
  // 旧病:值框/键名框/坏 YAML 原文框都是 defaultValue,失焦拿挂载时的旧 DOM 值比新 prop → 外部改写
  // (或源码模式自改)之后「白点一下」就把旧值写回盘。三种来源各一组,每组断言两件事:
  // 聚焦→失焦前后写盘次数不变 **且** 框里显示的是新值。PR1b/PR4 是对照:真改了照常提交、冲突可 Esc 放弃;
  // PR5 输入法组合中的 Esc、PR6 无冲突/原文框的 Esc 都不放弃草稿(N-3)。
  {
    const openProps = async (seed) => {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(400)
      await pg.click('.amx-props-chip')
      await pg.waitForTimeout(200)
      return pg
    }
    const vals = (pg) => pg.evaluate(() => [...document.querySelectorAll('.amx-prop-row .amx-prop-input')].map((i) => i.value))
    const nWrites = (pg) => pg.evaluate(() => window.__upage.writes.length)
    const disk = (pg) => pg.evaluate(() => window.__upage.vault.get('Unified.md'))
    // 点进框(不打字)再点正文段落 = 真鼠标白点一下
    const whiteClick = async (pg, sel, idx = 0) => {
      await (await pg.$$(sel))[idx].click()
      await pg.waitForTimeout(100)
      const c = await pg.evaluate((s) => { const r = document.querySelector(`${s} p`).getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 } }, PM)
      await pg.mouse.click(c.x, c.y)
      await pg.waitForTimeout(1300)
    }
    const SEED = '---\nstatus: todo\ncount: 3\n---\n# T\n\n正文。\n'

    // PR1 外部改写(fire)后:显示新值;状态框、数字框各白点一下 → 零写入
    {
      const pg = await openProps(SEED)
      await pg.evaluate(() => window.__upage.fire('Unified.md', '---\nstatus: done\ncount: 7\n---\n# T\n\n正文。\n'))
      await pg.waitForTimeout(1200)
      const shown = await vals(pg)
      const w0 = await nWrites(pg)
      await whiteClick(pg, '.amx-prop-row .amx-prop-input', 0)
      await whiteClick(pg, '.amx-prop-row .amx-prop-input', 1)
      const after = { shown, vals: await vals(pg), dw: (await nWrites(pg)) - w0, disk: await disk(pg) }
      record('PR1 外部改写后属性框显示新值 + 聚焦再失焦零写入(状态/数字两框)',
        JSON.stringify(after.shown) === '["done","7"]' && JSON.stringify(after.vals) === '["done","7"]' && after.dw === 0 && /status: done\ncount: 7\n/.test(after.disk),
        JSON.stringify(after))
      // PR1b 对照:真打字照常提交(修法不能是「一律不写」)
      await (await pg.$$('.amx-prop-row .amx-prop-input'))[0].click()
      await pg.keyboard.press('End')
      await pg.keyboard.type('X')
      await pg.evaluate(() => document.activeElement.blur())
      await pg.waitForTimeout(800)
      const d1 = await disk(pg)
      record('PR1b 对照:打字后失焦照常落盘(且只动这一键)', /status: doneX\ncount: 7\n/.test(d1), JSON.stringify(d1))
      await pg.close()
    }

    // PR2 源码模式自改 fm 后点面板同一字段再点走 → 零写入、自己刚改的不被撤回
    {
      const pg = await openProps(SEED)
      await pg.evaluate(() => window.__upage.setEditorMode('source'))
      await pg.waitForSelector('textarea.amx-source')
      await pg.waitForTimeout(300)
      await pg.evaluate(() => { const t = document.querySelector('textarea.amx-source'); const i = t.value.indexOf('todo'); t.focus(); t.setSelectionRange(i, i + 4) })
      await pg.keyboard.type('源码改')
      await pg.waitForTimeout(1300) // 源码草稿走 800ms 防抖,基数取它落盘之后
      const w0 = await nWrites(pg)
      const shown = await vals(pg)
      await (await pg.$$('.amx-prop-row .amx-prop-input'))[0].click()
      await pg.waitForTimeout(100)
      await pg.click('textarea.amx-source', { position: { x: 50, y: 200 } })
      await pg.waitForTimeout(1300)
      const r = { shown, vals: await vals(pg), dw: (await nWrites(pg)) - w0, line: (await disk(pg)).split('\n')[1], ta: await pg.evaluate(() => document.querySelector('textarea.amx-source').value.split('\n')[1]) }
      record('PR2 源码模式自改 fm → 属性框显示新值,白点一下零写入、不撤回',
        r.shown[0] === '源码改' && r.vals[0] === '源码改' && r.dw === 0 && r.line === 'status: 源码改' && r.ta === 'status: 源码改',
        JSON.stringify(r))
      await pg.close()
    }

    // PR3 坏 YAML 原文框:外部改写后显示新原文,白点一下零写入(旧版整段写回)
    {
      const pg = await openProps('---\nstatus: [未闭合\nnote: 旧A\n---\n# 标题\n\n正文。\n')
      await pg.evaluate(() => window.__upage.fire('Unified.md', '---\nstatus: [未闭合\nnote: 外部B\n---\n# 标题\n\n正文。\n'))
      await pg.waitForTimeout(1200)
      const shown = await pg.evaluate(() => document.querySelector('.amx-props-raw')?.value ?? null)
      const w0 = await nWrites(pg)
      await whiteClick(pg, '.amx-props-raw')
      const r = { shown, dw: (await nWrites(pg)) - w0, disk: await disk(pg) }
      record('PR3 坏 YAML 原文框:外部改写后显示新原文 + 白点一下零写入',
        r.shown === 'status: [未闭合\nnote: 外部B' && r.dw === 0 && r.disk.includes('note: 外部B'),
        JSON.stringify(r))
      await pg.close()
    }

    // PR4 打字中同一字段被外部改了:草稿不被吞(本地胜)+ 冲突标记;Esc 放弃草稿 = 接受外部值,失焦零写入
    {
      const pg = await openProps(SEED)
      await (await pg.$$('.amx-prop-row .amx-prop-input'))[0].click()
      await pg.keyboard.press('End')
      await pg.keyboard.type('Y')
      await pg.evaluate(() => window.__upage.fire('Unified.md', '---\nstatus: 外部改\ncount: 3\n---\n# T\n\n正文。\n'))
      await pg.waitForTimeout(1200)
      const during = await pg.evaluate(() => { const i = document.querySelector('.amx-prop-row .amx-prop-input'); return { v: i.value, conflict: i.classList.contains('amx-prop-conflict'), title: i.title } })
      const w0 = await nWrites(pg)
      await pg.keyboard.press('Escape')
      await pg.waitForTimeout(100)
      const esc = await vals(pg)
      await pg.evaluate(() => document.activeElement.blur())
      await pg.waitForTimeout(1000)
      const r = { during, esc, dw: (await nWrites(pg)) - w0, disk: await disk(pg) }
      record('PR4 打字中外部改同字段:草稿保留+冲突标记;Esc 放弃 → 显示外部值、零写入',
        during.v === 'todoY' && during.conflict && during.title.includes('外部改') && esc[0] === '外部改' && r.dw === 0 && r.disk.includes('status: 外部改'),
        JSON.stringify(r))
      await pg.close()
    }

    // PR5 输入法组合中按 Esc(取消候选)≠ 放弃草稿(评审返修 C-01-ime-esc):已上屏的字保住,失焦照常落盘。
    // ⚠️ 合成 KeyboardEvent 的 isComposing 到不了 React,必须 CDP 真组合(同 P28)。keyCode 27/229 两种时序都跑。
    // 负对照(实跑):useFieldDraft.onEscape 摘掉组合态判断 → afterEsc 回到 'todo'、零写入,本例红。
    // 台架噪声(别追):组合中**不拦**的 CDP Esc 之后 headless 会持续派 Unidentified keydown(kc189/0),
    // about:blank 上无监听的裸 <input> 同样复现,页面关掉才停 —— CDP 产物,与本组件无关,也不影响断言。
    {
      const out = {}
      for (const kc of [27, 229]) {
        const pg = await openProps(SEED)
        const cdp = await pg.context().newCDPSession(pg)
        await (await pg.$$('.amx-prop-row .amx-prop-input'))[0].click()
        await pg.keyboard.press('End')
        await cdp.send('Input.imeSetComposition', { text: 'xiang', selectionStart: 5, selectionEnd: 5 })
        await cdp.send('Input.insertText', { text: '项目' }) // 上屏 → 草稿 todo项目
        await pg.waitForTimeout(100)
        await cdp.send('Input.imeSetComposition', { text: 'jin', selectionStart: 3, selectionEnd: 3 }) // 新一段候选未上屏
        await pg.waitForTimeout(50)
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: kc })
        await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }) // 取消候选 = 组合置空
        await pg.waitForTimeout(100)
        const afterEsc = (await vals(pg))[0]
        const w0 = await nWrites(pg)
        await pg.evaluate(() => document.activeElement.blur())
        await pg.waitForTimeout(1200)
        out[`kc${kc}`] = { afterEsc, dw: (await nWrites(pg)) - w0, line: (await disk(pg)).split('\n')[1] }
        await pg.close()
      }
      record('PR5 输入法组合中 Esc 不丢草稿:已上屏「项目」保住,失焦落盘 status: todo项目(keyCode 27/229)',
        Object.values(out).every((r) => r.afterEsc === 'todo项目' && r.dw === 1 && r.line === 'status: todo项目'),
        JSON.stringify(out))
    }

    // PR6 收口 N-3:放弃草稿不进撤销栈,所以 Esc 只在单行框**标着冲突**时放弃。
    //  a 值框没冲突:Esc 不清草稿、原样冒泡到 document(不吞),失焦照常落盘;
    //  b 坏 YAML 原文框冲突中:Esc 不清多行草稿;真 Cmd+Z 撤回到原样再失焦 → 零写入、显示别处的版本(提示文案承诺的路径);
    //    撤回到原样那一刻冲突样式/提示随之撤掉(N-6 / E5:此时失焦的结果是外部值胜出,提示不许说反)。
    // 负对照(实跑):onEscape 判据改回 `draft === null` → a 红;原文框接回 onEscape → b 红。
    {
      const pa = await openProps(SEED)
      await pa.evaluate(() => { window.__escSeen = []; document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__escSeen.push(e.defaultPrevented) }) })
      await (await pa.$$('.amx-prop-row .amx-prop-input'))[0].click()
      await pa.keyboard.press('End')
      await pa.keyboard.type('ABC')
      await pa.keyboard.press('Escape')
      await pa.waitForTimeout(100)
      const afterEsc = (await vals(pa))[0]
      const w0 = await nWrites(pa)
      await pa.evaluate(() => document.activeElement.blur())
      await pa.waitForTimeout(1200)
      const a = { afterEsc, escSeen: await pa.evaluate(() => window.__escSeen), dw: (await nWrites(pa)) - w0, line: (await disk(pa)).split('\n')[1] }
      await pa.close()

      const RAW0 = '---\nstatus: [未闭合\nnote: 旧A\n---\n# 标题\n\n正文。\n'
      const pb = await openProps(RAW0)
      await pb.click('.amx-props-raw')
      await pb.keyboard.press('Meta+ArrowDown')
      await pb.keyboard.type('\nextra: 修复中的一大段')
      await pb.evaluate(() => window.__upage.fire('Unified.md', '---\nstatus: [未闭合\nnote: 外部B\n---\n# 标题\n\n正文。\n'))
      await pb.waitForTimeout(1200)
      const raw = () => pb.evaluate(() => { const t = document.querySelector('.amx-props-raw'); return { v: t.value, conflict: t.classList.contains('amx-prop-conflict'), title: t.title } })
      const during = await raw()
      await pb.keyboard.press('Escape')
      await pb.waitForTimeout(100)
      const esc = await raw()
      for (let i = 0; i < 40 && (await raw()).v !== 'status: [未闭合\nnote: 旧A'; i++) { await pb.keyboard.press('Meta+z'); await pb.waitForTimeout(40) } // 撤销按输入分组,逐次按到回原样
      const undone = await raw()
      const w1 = await nWrites(pb)
      await pb.evaluate(() => document.activeElement.blur())
      await pb.waitForTimeout(1200)
      const b = { during, esc: esc.v, undone, dw: (await nWrites(pb)) - w1, shown: (await raw()).v, disk: await disk(pb) }
      await pb.close()
      record('PR6 Esc 只在单行框冲突时放弃:无冲突值框 Esc 留草稿+冒泡+失焦落盘;原文框冲突中 Esc 留多行草稿,Cmd+Z 撤回后失焦零写入、采用别处版本(N-3)',
        a.afterEsc === 'todoABC' && JSON.stringify(a.escSeen) === '[false]' && a.dw === 1 && a.line === 'status: todoABC' &&
          b.during.conflict && b.esc.includes('extra: 修复中的一大段') && b.undone.v === 'status: [未闭合\nnote: 旧A' && !b.undone.conflict &&
          b.dw === 0 && b.shown === 'status: [未闭合\nnote: 外部B' && b.disk.includes('note: 外部B'),
        JSON.stringify({ a, b }))
    }

    // PR7 草稿冲洗(评审 2026-09-27 C-02):值框还聚焦着就被卸载(键盘导航换篇 = switchFile)/ 窗口 beforeunload /
    //  回车离开 —— 正在打的字都要落盘。React 不给已脱离的节点派 onBlur,旧版三种都丢字。
    // 负对照:useFieldDraft 的 useLayoutEffect 冲洗摘掉 → a、b 应红;enterCommits 置 false → c 应红(同款负对照已在 amadeusProperties.draft.test 实跑)。
    {
      const pa = await openProps(SEED)
      await (await pa.$$('.amx-prop-row .amx-prop-input'))[0].click()
      await pa.keyboard.press('End')
      await pa.keyboard.type('卸载前')
      await pa.evaluate(() => window.__upage.switchFile('Other.md', '# 另一篇\n'))
      await pa.waitForTimeout(1200)
      const a = { disk: await disk(pa), other: await pa.evaluate(() => window.__upage.vault.get('Other.md')) }
      await pa.close()

      const pb = await openProps(SEED)
      await (await pb.$$('.amx-prop-row .amx-prop-input'))[0].click()
      await pb.keyboard.press('End')
      await pb.keyboard.type('退出前')
      await pb.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
      await pb.waitForTimeout(800)
      const b = { disk: await disk(pb), focused: await pb.evaluate(() => document.activeElement?.className ?? ''), shown: (await vals(pb))[0] }
      const w1 = await nWrites(pb)
      await pb.evaluate(() => document.activeElement.blur()) // 冲洗过的草稿再失焦:不重复写
      await pb.waitForTimeout(1200)
      b.dwAfterBlur = (await nWrites(pb)) - w1
      await pb.close()

      const pc = await openProps(SEED)
      await (await pc.$$('.amx-prop-row .amx-prop-input'))[0].click()
      await pc.keyboard.press('End')
      await pc.keyboard.type('回车')
      await pc.keyboard.press('Enter')
      await pc.waitForTimeout(1200)
      const c = { disk: await disk(pc), focused: await pc.evaluate(() => document.activeElement?.className ?? '') }
      await pc.close()
      record('PR7 草稿冲洗:值框聚焦中卸载(换篇)/ beforeunload / 回车离开都落盘;冲洗不踢出输入框、再失焦不重复写(C-02)',
        /^---\nstatus: todo卸载前\ncount: 3\n---\n/.test(a.disk) && a.other === '# 另一篇\n' &&
          /status: todo退出前\n/.test(b.disk) && b.focused.includes('amx-prop-input') && b.shown === 'todo退出前' && b.dwAfterBlur === 0 &&
          /status: todo回车\n/.test(c.disk) && !c.focused.includes('amx-prop-input'),
        JSON.stringify({ a, b, c }))
    }

    // PR8 行级提交(评审 2026-09-27 D-20):改一个值 → 只有那一行变,注释 / 007 / 1.10 / flow / 多行块逐字;
    //  多行值是多行框,白点零写。负对照:pageFrontmatter 行级核对恒判失败(退回整块重排)→ 应红(同款已在 pageFrontmatter.test 实跑)。
    {
      const FM8 = '---\ntitle: "Hello: world"\n# 注释\ntags: [alpha, beta]\ndesc: |\n  multi\n  line\nzip: 007\nversion: 1.10\nstatus: todo\n---\n# T\n\n正文。\n'
      const pg = await openProps(FM8)
      const w0 = await nWrites(pg)
      await whiteClick(pg, '.amx-prop-row textarea.amx-prop-input', 0)
      const dwWhite = (await nWrites(pg)) - w0
      const input = await pg.evaluateHandle(() => [...document.querySelectorAll('.amx-prop-row input.amx-prop-input')].find((i) => i.value === 'todo'))
      await input.asElement().click()
      await pg.keyboard.press('End')
      await pg.keyboard.type('X')
      await pg.evaluate(() => document.activeElement.blur())
      await pg.waitForTimeout(1200)
      const out = await disk(pg)
      await pg.close()
      record('PR8 属性面板行级提交:改 status 只动那一行(注释/007/1.10/flow/多行块逐字),多行值白点零写(D-20)',
        dwWhite === 0 && out === FM8.replace('status: todo', 'status: todoX'), JSON.stringify({ dwWhite, out }))
    }

    // PR9 C-19(评审 2026-09-27):新增属性先选类型 → 落盘为对应 YAML 类型(别的键 `007` 与正文逐字,仍是行级提交);
    //  新增后焦点在新行的值框;换篇再回来仍展开(按库记在本机);值里的 [[x]] 渲染成双链。
    //  负对照在 amadeusProperties.c19.test.ts 实跑(addProp 写 '' / 展开态回局部 state → 红)。
    {
      const FM9 = '---\nzip: 007\nrelated: "[[Beta]]"\n---\n# T\n\n正文。\n'
      const pg = await openProps(FM9)
      const addTyped = async (key, type) => {
        await pg.click('.amx-props-add')
        await pg.waitForTimeout(150)
        await pg.keyboard.type(key)
        await pg.selectOption('.amx-prop-new select', type)
        await pg.click('.amx-prop-new input.amx-prop-key')
        await pg.keyboard.press('Enter')
        await pg.waitForTimeout(400)
        return pg.evaluate(() => { const a = document.activeElement; return `${a?.closest('.amx-prop-row')?.dataset.key}|${a?.tagName}.${a?.className}|${a?.type}` })
      }
      const fN = await addTyped('n', 'number')
      await pg.keyboard.press('Meta+A')
      await pg.keyboard.type('5')
      await pg.keyboard.press('Enter')
      const fD = await addTyped('done', 'checkbox')
      await pg.waitForTimeout(1200)
      const out = await disk(pg)
      const links = await pg.evaluate(() => [...document.querySelectorAll('.amx-prop-link')].map((e) => e.textContent))
      await pg.evaluate(() => window.__upage.switchFile('Other.md', '---\nx: 1\n---\n# 另一篇\n'))
      await pg.waitForTimeout(900)
      await pg.evaluate(() => window.__upage.switchFile('Unified.md'))
      await pg.waitForSelector(PM)
      await pg.waitForTimeout(900)
      const stillOpen = await pg.evaluate(() => !!document.querySelector('.amx-props-rows'))
      await pg.close()
      record('PR9 属性新增先选类型 → n: 5 / done: false 落盘为数字 / 布尔,007 与正文逐字;焦点进值框;换篇回来仍展开;[[x]] 值成双链(C-19)',
        out === FM9.replace('related: "[[Beta]]"\n', 'related: "[[Beta]]"\nn: 5\ndone: false\n') &&
          fN.startsWith('n|INPUT.amx-prop-input') && fD === 'done|INPUT.amx-prop-check|checkbox' && JSON.stringify(links) === '["Beta"]' && stillOpen,
        JSON.stringify({ out, fN, fD, links, stillOpen }))
    }
  }

  // ── P7-P11:块交互层(blockLayer.ts:⠿/＋/菜单/块选中/拖拽)────────────────────
  {
    const seed = '# 标题\n\n段一。\n\n- 列表甲\n- 列表乙\n\n段二。\n'
    const open = async () => {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(400)
      return pg
    }
    const hoverBlock = async (pg, sel) => {
      const c = await pg.evaluate((s) => {
        const el = document.querySelector(s)
        const r = el.getBoundingClientRect()
        return { x: r.left + 30, y: r.top + Math.min(12, r.height / 2) }
      }, sel)
      await pg.mouse.move(c.x, c.y)
      await pg.waitForTimeout(350)
    }

    // P7:hover 出把手,逐节点粒度(段落与列表项各自锚定)。
    const p7 = await open()
    await hoverBlock(p7, `${PM} > p`)
    const p7a = await p7.evaluate(() => {
      const g = document.querySelector('.unified-gutter')
      return { show: g?.dataset.show, x: Math.round(g?.getBoundingClientRect().x ?? -1), y: Math.round(g?.getBoundingClientRect().y ?? -1) }
    })
    await hoverBlock(p7, `${PM} li:nth-of-type(2)`)
    const p7b = await p7.evaluate(() => {
      const g = document.querySelector('.unified-gutter')
      const li = document.querySelectorAll('.unified-body .ProseMirror li')[1]
      return {
        show: g?.dataset.show,
        x: Math.round(g?.getBoundingClientRect().x ?? -1),
        dy: Math.abs((g?.getBoundingClientRect().y ?? 0) - li.getBoundingClientRect().top),
      }
    })
    record(
      'P7 hover ⠿ 逐节点且顶层列表不被 marker gutter 推右',
      p7a.show === 'true' && p7b.show === 'true' && p7b.dy < 8 && Math.abs(p7a.x - p7b.x) <= 2,
      JSON.stringify({ p7a, p7b }),
    )

    // 只抵消当前列表自身的 marker gutter；嵌套列表与字面 Tab 段落仍是实际层级，手柄必须右移。
    const p7c = await browser.newPage({ locale: 'zh-CN' })
    await p7c.goto(`${URL}?upage&useed=${encodeURIComponent('正文\n\n- 父\n  - 子\n\n\t缩进段\n')}`, { waitUntil: 'domcontentloaded' })
    await p7c.waitForSelector(PM, { timeout: 20000 })
    await p7c.waitForTimeout(300)
    const gutterX = async (selector) => {
      await hoverBlock(p7c, selector)
      return p7c.evaluate(() => Math.round(document.querySelector('.unified-gutter')?.getBoundingClientRect().x ?? -1))
    }
    const hierarchyX = {
      plain: await gutterX(`${PM} > p:first-of-type`),
      nested: await gutterX(`${PM} > ul > li > ul > li > p`),
      tab: await gutterX(`${PM} > p[data-indent='1']`),
    }
    record(
      'P7c 嵌套列表与 Tab 段落仍保留真实层级位移',
      hierarchyX.nested >= hierarchyX.plain + 12 && hierarchyX.tab >= hierarchyX.plain + 12,
      JSON.stringify(hierarchyX),
    )
    await p7c.close()

    // P8:＋ 在下方插入新块并当场打开块选择器(新块里是 ＋ 替用户敲的 `/`,B-19);Esc 关菜单把 `/` 删掉,
    //     打字直接落进新段。
    await hoverBlock(p7, `${PM} > p`)
    await p7.click('.unified-gutter .block-add')
    await p7.waitForTimeout(250)
    const p8menu = await p7.locator('.slash-menu').count()
    await p7.keyboard.press('Escape')
    await p7.waitForTimeout(150)
    await p7.keyboard.type('新插入段')
    await p7.waitForTimeout(200)
    const p8 = await p7.evaluate((s) => {
      const ps = [...document.querySelector(s).querySelectorAll(':scope > p')].map((x) => x.textContent)
      return ps
    }, PM)
    record('P8 ＋ 插入下方新块、开 slash 菜单,Esc 清掉 `/` 后打字进新段', p8menu === 1 && p8[0] === '段一。' && p8[1] === '新插入段', JSON.stringify({ p8menu, p8 }))

    // P9:点 ⠿ → 菜单;转换为标题 2;再点 ⠿ → 删除。
    await hoverBlock(p7, `${PM} > p`) // 段一
    await p7.click('.unified-gutter .drag-handle')
    await p7.waitForSelector('.unified-block-menu', { timeout: 3000 })
    await p7.click('.unified-block-menu button:nth-of-type(3)') // 标题 2
    await p7.waitForTimeout(250)
    // structuralSource 现在是真 input（value 不进 textContent），断言仍只看正文结尾。
    const p9a = await p7.evaluate((s) => document.querySelector(`${s} > h2`)?.textContent, PM)
    await hoverBlock(p7, `${PM} > h2`)
    await p7.click('.unified-gutter .drag-handle')
    await p7.waitForSelector('.unified-block-menu', { timeout: 3000 })
    await p7.click('.unified-block-menu button.danger')
    await p7.waitForTimeout(700)
    const p9b = await p7.evaluate((s) => ({
      h2: !!document.querySelector(`${s} > h2`),
      menu: !!document.querySelector('.unified-block-menu'),
    }), PM)
    record('P9 把手菜单:转换为 H2 + 删除', !!p9a?.endsWith('段一。') && !p9b.h2 && !p9b.menu, JSON.stringify({ p9a, p9b }))

    // P10:Esc 两段(文字 → 块选中 → 回文字);列表项内 Esc 选中整个 list_item。
    // 各步之间 150ms 落定:click → PM 经 selectionchange **异步**同步选区,0ms 后立刻 Esc
    // 会作用在旧选区上(仪器时序伪症,实测 120ms 即稳;真人操作到不了这个速度)。
    const p10p = await open()
    await p10p.click(`${PM} > p`)
    await p10p.waitForTimeout(150)
    await p10p.keyboard.press('Escape')
    const p10a = await p10p.evaluate(() => !!document.querySelector('.ProseMirror-selectednode'))
    await p10p.keyboard.press('Escape')
    const p10b = await p10p.evaluate(() => !!document.querySelector('.ProseMirror-selectednode'))
    await p10p.click(`${PM} li:nth-of-type(1) p`)
    await p10p.waitForTimeout(150)
    await p10p.keyboard.press('Escape')
    const p10c = await p10p.evaluate(() => document.querySelector('.ProseMirror-selectednode')?.tagName)
    record('P10 Esc 两段 + 列表项整只选中', p10a && !p10b && p10c === 'LI', JSON.stringify({ p10a, p10b, p10c }))

    // P11:拖拽重排(synthetic HTML5 dnd):把「段一」拖到「段二」下方,顺序变化落盘。
    const p11p = await open()
    await hoverBlock(p11p, `${PM} > p`) // 段一
    const p11 = await p11p.evaluate((s) => {
      const gutter = document.querySelector('.unified-gutter')
      const drag = gutter.querySelector('.drag-handle')
      const md = (ev, target, opts) => target.dispatchEvent(new DragEvent(ev, { bubbles: true, cancelable: true, ...opts }))
      // mousedown → NodeSelection(交互层挂在 gutter 上)
      drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      const dt = new DataTransfer()
      md('dragstart', gutter, { dataTransfer: dt })
      const pm = document.querySelector(s)
      const p2 = [...pm.querySelectorAll(':scope > p')].find((x) => x.textContent === '段二。')
      const r = p2.getBoundingClientRect()
      const at = { clientX: r.left + 40, clientY: r.bottom - 2, dataTransfer: dt }
      md('dragover', pm, at)
      md('dragover', pm, at)
      const line = document.querySelector('.unified-drop-line')
      const lineShown = !!line && line.style.display !== 'none'
      md('drop', pm, at)
      md('dragend', gutter, { dataTransfer: dt })
      return { lineShown }
    }, PM)
    await p11p.waitForTimeout(1200)
    const p11b = await p11p.evaluate((s) => {
      const kids = [...document.querySelector(s).children].map((x) => `${x.tagName}:${(x.textContent ?? '').slice(0, 3)}`)
      const w = window.__upage.writes
      return { kids, last: w[w.length - 1]?.text ?? '' }
    }, PM)
    const orderOk = /段二。[\s\S]*段一。/.test(p11b.last)
    record('P11 拖拽重排:指示线 + 精确落点 + 落盘顺序', p11.lineShown && orderOk, JSON.stringify({ line: p11.lineShown, kids: p11b.kids.slice(0, 6) }))

    await p7.close()
    await p10p.close()
    await p11p.close()
  }

  // P12:标题回车 → 光标进正文首行。两个失败类要分辨:
  //  a) 名字没改:纯焦点交接(hostApi 为 null = 静默 no-op 类)
  //  b) 名字改了:doRename → onRenamed → 实例随 key 重建 → 焦点被拆(重建后必须补聚焦)
  {
    const pa = await fresh(browser)
    await pa.click('.amx-title-input')
    await pa.keyboard.press('Enter')
    await pa.waitForTimeout(300) // PM 异步 selectionchange 结算(P10 教训)
    const a = await pa.evaluate((s) => {
      const pm = document.querySelector(s)
      const ae = document.activeElement
      const sel = window.getSelection()
      return {
        inPm: !!pm && !!ae && pm.contains(ae),
        atStart: !!sel && sel.isCollapsed && !!pm && pm.contains(sel.anchorNode) &&
          (pm.textContent ?? '').startsWith((sel.anchorNode?.textContent ?? '').slice(0, sel.anchorOffset) || ''),
        anchorOffset: sel?.anchorOffset ?? -1,
      }
    }, PM)
    record('P12a 标题回车(名字不变)焦点进正文首行', a.inPm && a.anchorOffset === 0, JSON.stringify(a))
    await pa.close()

    const pb = await fresh(browser)
    await pb.click('.amx-title-input')
    await pb.keyboard.type('改名页')
    await pb.keyboard.press('Enter')
    await pb.waitForTimeout(1500) // 改名 IPC + 实例重建 + 编辑器重初始化
    const b = await pb.evaluate((s) => {
      const pm = document.querySelector(s)
      const ae = document.activeElement
      return {
        inPm: !!pm && !!ae && pm.contains(ae),
        renamed: [...window.__upage.vault.keys()].some((k) => k.includes('改名页')), // 输入追加在旧名后
        title: document.querySelector('.amx-title-input')?.value,
      }
    }, PM)
    record('P12b 标题改名回车:重建后焦点仍进正文', b.inPm && b.renamed, JSON.stringify(b))
    await pb.close()
  }

  // P13:Tab 缩进层(AFFiNE 对齐,md 可表示子集)。
  //  a 列表第二项 Tab=嵌套 / Shift-Tab=还原  b 列表后段落 Tab=收进最后一项
  //  c code_block 内 Tab=插两空格  d 无处可缩 Tab=吞掉(焦点绝不放走)
  {
    const seed = '- 甲\n- 乙\n\n尾段。\n\n```\nline\n```\n\n孤段。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const clickIn = async (sel) => {
      const c = await pg.evaluate((s) => {
        const r = document.querySelector(s).getBoundingClientRect()
        return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 }
      }, sel)
      await pg.mouse.click(c.x, c.y)
      await pg.waitForTimeout(200) // PM 异步 selectionchange 结算
    }

    await clickIn(`${PM} > ul > li:nth-of-type(2) p`)
    await pg.keyboard.press('Tab')
    await pg.waitForTimeout(150)
    const a1 = await pg.evaluate((s) => !!document.querySelector(`${s} > ul > li ul li`), PM)
    await pg.keyboard.press('Shift+Tab')
    await pg.waitForTimeout(150)
    const a2 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      return { nested: !!el.querySelector(':scope > ul > li ul li'), lis: el.querySelectorAll(':scope > ul > li').length }
    }, PM)
    record('P13a 列表项 Tab 嵌套 / Shift-Tab 还原', a1 && !a2.nested && a2.lis === 2, JSON.stringify({ a1, a2 }))

    // 2026-08-14 语义再拍板(用户否掉「段落转列表/并入列表」):段落 Tab = 整段缩进档,列表不动。
    await clickIn(`${PM} > p`) // 尾段(列表后第一个顶级段落)
    await pg.keyboard.press('Tab')
    await pg.waitForTimeout(150)
    const b13 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const p = [...el.querySelectorAll(':scope > p')].find((x) => x.textContent === '尾段。')
      return {
        di: p?.getAttribute('data-indent'),
        ml: p ? parseFloat(getComputedStyle(p).marginLeft) : -1,
        lis: el.querySelectorAll(':scope > ul > li').length,
        inLi: !!el.querySelector(':scope > ul li p') && [...el.querySelectorAll(':scope > ul li p')].some((x) => x.textContent === '尾段。'),
      }
    }, PM)
    record('P13b 列表后段落 Tab → 只缩进不并入(data-indent=1、margin 生效、列表 2 项不动)',
      b13.di === '1' && b13.ml > 0 && b13.lis === 2 && !b13.inLi, JSON.stringify(b13))

    await clickIn(`${PM} pre`)
    // 点击 pre 的坐标会落在首字后;macOS 的 End 在 contenteditable 中也不保证跳到块尾。
    // 精确把 PM 光标落在代码节点尾，再验 Tab 插入两空格。
    await pg.evaluate(() => {
      const v = window.__upage.probe.view()
      let at = -1
      v.state.doc.descendants((n, pos) => { if (n.type.name === 'code_block') at = pos + 1 + n.content.size })
      if (at >= 0) v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
      v.focus()
    })
    await pg.keyboard.press('Tab')
    await pg.waitForTimeout(150)
    // ⚠️ 读 pre.textContent 会把工具条按钮的字(语言下拉/复制/折行/行号/折叠)也算进来 ——
    //    工具条一加按钮这条断言就假红。要的是**节点文本**,走 probe 读文档。
    const c13 = await pg.evaluate((s) => {
      const v = window.__upage.probe.view()
      let text = ''
      v.state.doc.descendants((n) => { if (n.type.name === 'code_block') text = n.textContent })
      const ae = document.activeElement
      return { text, inPm: !!document.querySelector(s)?.contains(ae) }
    }, PM)
    record('P13c code_block 内 Tab 插两空格且焦点在', c13.text.includes('line  ') && c13.inPm, JSON.stringify(c13))

    // 2026-08-14 语义再拍板(用户否掉「段落转列表」):孤段 Tab = 缩进档,序列化落盘是行首字面
    // 制表符(经 toStoredMarkdown 的 entitiesToTabs);Shift-Tab 逐档退,零档吞键焦点不放走。
    await clickIn(`${PM} > p:last-of-type`) // 孤段(前兄弟是 code_block)
    await pg.keyboard.press('Tab')
    await pg.waitForTimeout(150)
    const d13 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const p = el.querySelector(':scope > p:last-of-type')
      window.__upage.probe.flush?.() // 把防抖中的序列化拉平,fmState().body 才是最新 stored 形态
      const st = window.__upage.probe.fmState?.().body // stored 形态(缩进=行首字面 \t)
      return { inPm: !!el.contains(document.activeElement), di: p?.getAttribute('data-indent'), ul: !!el.querySelector(':scope > ul:last-of-type li'), stored: typeof st === 'string' ? st : null }
    }, PM)
    record('P13d 孤段 Tab → 缩进档(不转列表、焦点不放走)', d13.inPm && d13.di === '1' && !String(d13.stored ?? '').includes('- 孤段'), JSON.stringify({ ...d13, stored: undefined }))
    record('P13d 缩进落盘 = 行首字面制表符', d13.stored === null || /\n\t孤段。/.test(d13.stored), JSON.stringify({ has: /\n\t孤段。/.test(String(d13.stored)) }))
    await pg.keyboard.press('Shift+Tab')
    await pg.waitForTimeout(150)
    const d13b = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const p = el.querySelector(':scope > p:last-of-type')
      return { p: p?.textContent, di: p?.getAttribute('data-indent') }
    }, PM)
    record('P13d Shift-Tab 退回零档(attr 摘除)', d13b.p === '孤段。' && !d13b.di, JSON.stringify(d13b))
    await pg.keyboard.press('Shift+Tab') // 零档再退:吞键
    await pg.waitForTimeout(120)
    const d13c = await pg.evaluate((s) => !!document.querySelector(s)?.contains(document.activeElement), PM)
    record('P13d 零档 Shift-Tab 吞键(焦点不逃逸)', d13c)
    await pg.close()
  }

  // K13:段落缩进档 × 回车/退格(2026-08-16 用户实报「tab 过的一行回车之后没有继续保持 tab,
  //      多 tab 了会全部一起删除」)。整张行为矩阵按 AFFiNE/Notion 对齐,逐格钉死:
  //        Tab / Shift-Tab   → 已由 P13 覆盖,这里不重复
  //        段尾回车          → 新段**继承**档位(base splitBlock 的 atEnd 分支造节点用默认 attrs,病灶在此)
  //        行中回车          → 两半都保档(base 的 node.copy() 本来就带 attrs,这条是防回归)
  //        空缩进段回车      → **仍留同档**(显式拍板:空段没有「空 bullet」那种视觉垃圾要清,
  //                            而「缩进写完一段回车就掉回顶格」是更常见的挫败;逃生口有 Shift-Tab 和行首退格)
  //        行首退格          → **逐级**降一档,绝不一次清零、绝不并进上一段
  //        0 档行首退格      → 交回 base 合并上一段(缩进层不许恒吞键把退格做死)
  //        Mod+Backspace     → 一步归零
  //        列表里            → 一格都不受影响(反向断言:防这层截胡 list 的 lift/split 语义)
  {
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent('甲段。\n\n乙段。\n')}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)

    // 精确落点:鼠标点击只能落到「大概那个字」,而档位继承/合并这些格差一个字测的就是别的东西了。
    // 选区走 probe 直驱 PM(与分栏 spike 同款),**按键仍是真键盘** —— 被测的始终是 keymap 本身。
    // off<0 = 块尾。Selection.near 是基类静态,当前选区是 Text 还是 Node 都取得到。
    const caret = (text, off) => pg.evaluate(({ text, off }) => {
      const v = window.__upage.probe.view()
      let at = null
      v.state.doc.descendants((n, p) => {
        if (at == null && n.isTextblock && n.textContent === text) at = p + 1 + (off < 0 ? n.content.size : off)
      })
      if (at == null) return false
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at))))
      v.focus()
      return true
    }, { text, off })
    const ps = () => pg.evaluate((s) => [...document.querySelectorAll(`${s} > p`)].map((p) => ({ t: p.textContent, di: p.getAttribute('data-indent') })), PM)

    // e1 段尾回车继承档位
    await caret('乙段。', -1)
    await pg.keyboard.press('Tab')
    await pg.keyboard.press('Tab')
    await pg.waitForTimeout(120)
    await pg.keyboard.press('Enter')
    await pg.keyboard.type('丙丁')
    await pg.waitForTimeout(200)
    const e1 = await ps()
    record('K13e1 段尾回车 → 新段继承缩进档(2 档,且原段不动)',
      e1.length === 3 && e1[1].t === '乙段。' && e1[1].di === '2' && e1[2].t === '丙丁' && e1[2].di === '2' && !e1[0].di, JSON.stringify(e1))

    // e2 行中回车两半都保档
    await caret('丙丁', 1)
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(200)
    const e2 = await ps()
    record('K13e2 行中回车 → 两半都保档',
      e2.length === 4 && e2[2].t === '丙' && e2[2].di === '2' && e2[3].t === '丁' && e2[3].di === '2', JSON.stringify(e2))

    // e3 空缩进段回车仍留同档
    await caret('丁', -1)
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(150)
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(200)
    const e3 = await ps()
    record('K13e3 空缩进段回车 → 仍留同档(不掉回顶格)',
      e3.length === 6 && e3[4].t === '' && e3[4].di === '2' && e3[5].t === '' && e3[5].di === '2', JSON.stringify(e3))

    // e4 行首退格逐级降档,绝不一次清零、绝不合并
    await caret('丁', 0)
    await pg.keyboard.press('Backspace')
    await pg.waitForTimeout(150)
    const e4a = await ps()
    await pg.keyboard.press('Backspace')
    await pg.waitForTimeout(150)
    const e4b = await ps()
    record('K13e4 行首退格 → 逐级降档(2→1→0),段落既不合并也不清零',
      e4a.length === 6 && e4a[3].t === '丁' && e4a[3].di === '1' &&
      e4b.length === 6 && e4b[3].t === '丁' && !e4b[3].di, JSON.stringify({ e4a: e4a[3], e4b: e4b[3], n: e4b.length }))

    // e5 0 档行首退格 = 交回 base 合并上一段(缩进层不许把退格做死)
    await pg.keyboard.press('Backspace')
    await pg.waitForTimeout(200)
    const e5 = await ps()
    record('K13e5 0 档行首退格 → 合并上一段(退格没被吞死)',
      e5.length === 5 && e5[2].t === '丙丁', JSON.stringify(e5))

    // e6 Mod+Backspace 一步归零
    await caret('乙段。', 0)
    await pg.keyboard.press(process.platform === 'darwin' ? 'Meta+Backspace' : 'Control+Backspace')
    await pg.waitForTimeout(200)
    const e6 = await ps()
    record('K13e6 Mod+Backspace → 一步归零(段落仍在)', e6[1].t === '乙段。' && !e6[1].di, JSON.stringify(e6[1]))

    // e7 继承来的档位真的落盘(行首字面制表符 ×2,经 indentIo 的 entitiesToTabs)
    await caret('乙段。', -1)
    await pg.keyboard.press('Tab')
    await pg.keyboard.press('Tab')
    await pg.waitForTimeout(120)
    await pg.keyboard.press('Enter')
    await pg.keyboard.type('戊')
    await pg.waitForTimeout(200)
    const e7 = await pg.evaluate(() => {
      window.__upage.probe.flush?.()
      const b = window.__upage.probe.fmState?.().body
      return typeof b === 'string' ? b : null
    })
    // ⚠️ 不许写成 `e7 === null || ...`:probe 取不到值时那条恒真,落盘坏掉照样绿。取不到 = 红。
    record('K13e7 继承的档位落盘 = 行首两枚字面制表符', typeof e7 === 'string' && /\n\t\t戊/.test(e7), JSON.stringify({ got: typeof e7, has: /\n\t\t戊/.test(String(e7)) }))
    await pg.close()
  }

  // K14:列表里一格都不受影响 —— 缩进层截胡 list 语义是这轮最可能的回归面,单开一页反向断言。
  {
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent('- 甲\n- 乙\n')}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const caret = (text, off) => pg.evaluate(({ text, off }) => {
      const v = window.__upage.probe.view()
      let at = null
      v.state.doc.descendants((n, p) => {
        if (at == null && n.isTextblock && n.textContent === text) at = p + 1 + (off < 0 ? n.content.size : off)
      })
      if (at == null) return false
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.near(v.state.doc.resolve(at))))
      v.focus()
      return true
    }, { text, off })

    await caret('甲', -1)
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(200)
    const f1 = await pg.evaluate((s) => document.querySelectorAll(`${s} li`).length, PM)
    record('K14 列表项尾回车 → 仍是拆出新项(缩进层没截胡)', f1 === 3, JSON.stringify({ lis: f1 }))

    await caret('乙', 0)
    await pg.keyboard.press('Backspace')
    await pg.waitForTimeout(180)
    const f2 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      return {
        lis: el.querySelectorAll('li').length,
        source: el.querySelectorAll('.amx-struct-prefix').length,
        literal: [...el.querySelectorAll(':scope > p')].find((p) => p.textContent.includes('乙'))?.textContent ?? null,
        offset: getSelection()?.anchorOffset ?? null,
        active: document.activeElement?.classList.contains('ProseMirror'),
      }
    }, PM)
    record('K14 列表项行首退格 → 立即还原字面 “-” 且光标可继续编辑(缩进层没截胡)',
      f2.source === 0 && f2.lis === 2 && f2.literal === '-乙' && f2.offset === 1 && f2.active,
      JSON.stringify(f2))
    await pg.close()
  }

  // P14:块级嵌入层(embedLayer.tsx 装饰 widget)。
  //  a 裸 URL 段落 → 书签卡;`![[缺失]]` → 跨笔记嵌入壳(harness resolveEmbed 恒 null → 嵌入丢失)
  //  b 点击 </> → 嵌入让位露源码(当前唯一编辑入口)  c Esc 块选中 + Delete 删嵌入 + 撤销还原
  {
    const seed = '首段。\n\nhttps://example.com/x\n\n![[不存在的笔记]]\n\n尾段。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(600)
    const a14 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const embeds = [...el.querySelectorAll('.unified-embed')]
      return {
        n: embeds.length,
        bookmark: embeds.some((e) => e.textContent?.includes('example.com')),
        missing: embeds.some((e) => e.textContent?.includes('嵌入丢失')),
      }
    }, PM)
    record('P14a 书签卡+跨笔记嵌入壳上屏', a14.n === 2 && a14.bookmark && a14.missing, JSON.stringify(a14))

    // b:显式点击 </> → widget 让位,源码露出。
    await pg.evaluate(() => {
      const card = [...document.querySelectorAll('.unified-embed')].find((e) => e.textContent?.includes('example.com'))
      card.querySelector('.amx-src-btn').click()
    })
    await pg.waitForTimeout(300)
    const b14 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      const embeds = el.querySelectorAll('.unified-embed').length
      const urlVisible = [...el.querySelectorAll(':scope > p')].some((p) =>
        p.textContent?.includes('https://example.com/x') && !p.querySelector('.wikilink-src-hidden'))
      return { embeds, urlVisible }
    }, PM)
    record('P14b 点击嵌入 </> → 露源码', b14.embeds === 1 && b14.urlVisible, JSON.stringify(b14))

    // c:Esc 选中该块 → Delete 删除 → 撤销还原(装饰路径对原生编辑零干扰)。
    await pg.keyboard.press('Escape')
    await pg.waitForTimeout(150)
    await pg.keyboard.press('Delete')
    await pg.waitForTimeout(250)
    const c14a = await pg.evaluate((s) => document.querySelector(s).textContent?.includes('example.com'), PM)
    await pg.keyboard.press('Meta+z')
    await pg.waitForTimeout(250)
    const c14b = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      return { back: el.textContent?.includes('example.com') || el.querySelectorAll('.unified-embed').length === 2 }
    }, PM)
    record('P14c Esc+Delete 删嵌入 + 撤销还原', c14a === false && c14b.back === true, JSON.stringify({ c14a, ...c14b }))
    await pg.close()
  }

  // P14d:裸 `.md` 目标 = **跨笔记嵌入**,不是「📄 打开 ↗」的文件卡(2026-08-20 用户实报
  // 「md 笔记无法渲染」:FILE_EXT_RE 把 .md 也当文件后缀吃掉了)。复合后缀 `.x.md` 仍归文件面。
  {
    // ⚠️ 首块不能放嵌入:挂载时光标就在首块,装饰会让位露源码(那是编辑入口,不是 bug)。
    const seed = '首段。\n\n![[某笔记.md]]\n\n![[子夹/另一篇.md]]\n\n![[图.excalidraw.md]]\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(700)
    const d14 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      return {
        notes: [...el.querySelectorAll('.embed-body')].length, // 跨笔记嵌入壳(harness 恒「嵌入丢失」)
        fileCards: [...el.querySelectorAll('.embed-file')].map((e) => e.textContent),
      }
    }, PM)
    record('P14d 裸 .md 走跨笔记嵌入(不落文件卡);.excalidraw.md 仍归画板面',
      d14.notes === 2 && d14.fileCards.length === 0, JSON.stringify(d14))
    await pg.close()
  }

  // P14e:Obsidian 行内语法实况(I-17,拍板 #11)。`==高亮==` / `%%注释%%` 是纯文本 + 装饰(obsidianInline.ts):
  //   光标不在那处 → 定界符 / 整条注释藏起来(注释留一枚徽章);光标碰到 → 露源码可编辑。<kbd>/<sub>/<sup> 是可编辑 mark
  //   (不再是开合两个 contenteditable=false 原子)。行内代码与 `===` 不误伤;打开零写盘;⌘⇧H 切换 `==`。
  {
    const seed = '# T\n\nhl: x ==高亮== y\n\ncmt: 文字 %%注释%% 结尾\n\n%%\n多行注释\n%%\n\nkbd: 按 <kbd>Cmd</kbd> 与 H<sub>2</sub>O x<sup>2</sup>\n\ncode: `==不是==` 与 a === b\n\n末段文字\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(500)
    /** 段落可见文字(innerText 不含 display:none)+ 各装饰 / 标签计数。 */
    const look = () => pg.evaluate((s) => {
      const ps = [...document.querySelector(s).querySelectorAll(':scope > p')]
      const txt = (k) => (ps.find((p) => p.textContent.startsWith(k)) || { innerText: '' }).innerText
      return {
        hl: txt('hl:'), cmt: txt('cmt:'), code: txt('code:'),
        hlText: [...document.querySelectorAll(s + ' .amx-obs-hl')].map((e) => e.textContent),
        delims: document.querySelectorAll(s + ' .amx-obs-delim').length,
        badges: document.querySelectorAll(s + ' .amx-obs-cmt-badge').length,
        multiHidden: !ps.some((p) => p.innerText.includes('多行注释')),
        kbd: [...document.querySelectorAll(s + ' kbd')].map((e) => e.textContent).join(','),
        sub: document.querySelectorAll(s + ' sub').length, sup: document.querySelectorAll(s + ' sup').length,
        atoms: document.querySelectorAll(s + ' [data-type="html"]').length,
      }
    }, PM)
    const caretIn = (needle, off) => pg.evaluate(([needle, off]) => {
      const v = window.__upage.probe.view()
      let at = -1
      v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes(needle)) at = pos + n.text.indexOf(needle) + off; return at < 0 })
      let proto = Object.getPrototypeOf(v.state.selection)
      while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
      v.focus()
      const TS = proto.constructor.near(v.state.doc.resolve(at)).constructor // Selection.near 给的是 TextSelection
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, at)))
    }, [needle, off])
    const a = await look()
    const w0 = await pg.evaluate(() => window.__upage.writes.length)
    // b:光标进高亮 → 定界符露出
    await caretIn('高亮', 1)
    await pg.waitForTimeout(150)
    const b = await look()
    // c:点注释徽章 → 光标进注释、源码露出
    const badge = await pg.evaluate((s) => { const e = document.querySelector(s + ' .amx-obs-cmt-badge'); const r = e?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null }, PM)
    if (badge) await pg.mouse.click(badge.x, badge.y)
    await pg.waitForTimeout(150)
    const c = await look()
    const w1 = await pg.evaluate(() => window.__upage.writes.length)
    // d:<kbd> 里打字 = 可编辑 mark
    await caretIn('Cmd', 2)
    await pg.keyboard.type('X')
    // e:⌘⇧H 包成 `==末段==`,再按一次摘掉
    const selectWord = () => pg.evaluate(() => {
      const v = window.__upage.probe.view()
      let at = -1
      v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('末段')) at = pos + n.text.indexOf('末段'); return at < 0 })
      let proto = Object.getPrototypeOf(v.state.selection)
      while (Object.getPrototypeOf(proto) && Object.getPrototypeOf(proto) !== Object.prototype) proto = Object.getPrototypeOf(proto)
      v.focus()
      const TS = proto.constructor.near(v.state.doc.resolve(at)).constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, at, at + 2)))
    })
    await selectWord()
    await pg.keyboard.press('Meta+Shift+h')
    await pg.waitForTimeout(1400)
    const md1 = await pg.evaluate(() => window.__upage.writes.at(-1)?.text ?? '')
    await pg.keyboard.press('Meta+Shift+h')
    await pg.waitForTimeout(1400)
    const md2 = await pg.evaluate(() => window.__upage.writes.at(-1)?.text ?? '')
    record('P14e Obsidian 行内语法实况:==/%% 离开渲染、光标进入露源码;kbd/sub/sup 可编辑;代码与 === 不误伤;⌘⇧H 切换',
      a.hl === 'hl: x 高亮 y' && a.hlText.join() === '高亮' && a.delims === 0 && a.badges === 2 && a.multiHidden && !a.cmt.includes('注释') &&
        a.code.includes('==不是==') && a.code.includes('a === b') &&
        a.kbd === 'Cmd' && a.sub === 1 && a.sup === 1 && a.atoms === 0 &&
        b.delims === 2 && b.hl.includes('==高亮==') &&
        c.cmt.includes('%%注释%%') && c.badges === 1 && w0 === 0 && w1 === 0 &&
        md1.includes('<kbd>CmXd</kbd>') && md1.includes('\n==末段==文字\n') && md2.includes('\n末段文字\n') && md2.includes('hl: x ==高亮== y') && md2.includes('%%\n多行注释\n%%'),
      JSON.stringify({ a, b: { hl: b.hl, delims: b.delims }, c: { cmt: c.cmt, badges: c.badges }, w0, w1, md1: md1.slice(-80), md2: md2.slice(-40) }))
    await pg.close()
  }

  // P15:真实鼠标路径下把手可达(真机回归 2026-08-13 第4振:把手悬在 .milkdown 左缘之外,
  // hover 追踪挂 container 的话指针一穿越容器边界 mouseleave 就藏把手 —— 必须挂 pane 级
  // .unified-body。合成事件直打 gutter 的其余检查绕过了这条路径,只有真 mouse.move 能抓)。
  {
    const pg = await fresh(browser)
    const start = await pg.evaluate((s) => {
      const b = document.querySelector(s).querySelector(':scope > p').getBoundingClientRect()
      return { x: b.left + 40, y: b.top + b.height / 2 }
    }, PM)
    await pg.mouse.move(start.x, start.y, { steps: 4 })
    await pg.waitForTimeout(250)
    const g = await pg.evaluate(() => {
      const el = document.querySelector('.unified-gutter')
      const b = el?.getBoundingClientRect()
      return el?.dataset.show === 'true' && b ? { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 } : null
    })
    let alive = !!g
    let died = ''
    if (g) {
      const N = 16
      for (let i = 1; alive && i <= N; i++) {
        await pg.mouse.move(start.x + ((g.x - start.x) * i) / N, start.y + ((g.y - start.y) * i) / N)
        await pg.waitForTimeout(20)
        alive = await pg.evaluate(() => document.querySelector('.unified-gutter')?.dataset.show === 'true')
        if (!alive) died = `第${i}/${N}步消失`
      }
    }
    record('P15 真鼠标移向把手全程不消失(pane 级 hover 追踪)', alive, g ? died || '到手仍在' : '把手没出现')
    await pg.close()
  }

  // P16:源码模式 textarea 自动撑高(真机第5振:.amx-source overflow:hidden + 定高 60vh,
  // unified 首版漏带 v3 的 grow → 长文尾部被裁掉且滚不到,「粘贴图片后源码后面的内容不显示」)。
  {
    const seed = Array.from({ length: 60 }, (_, i) => `长文段${i + 1}。`).join('\n\n') + '\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    await pg.evaluate(() => window.__upage.setEditorMode('source'))
    await pg.waitForSelector('.amx-source', { timeout: 5000 })
    await pg.waitForTimeout(300)
    const p16 = await pg.evaluate(() => {
      const ta = document.querySelector('.amx-source')
      return {
        hasTail: ta.value.includes('长文段60。'),
        clientH: ta.clientHeight,
        scrollH: ta.scrollHeight,
        grown: ta.clientHeight >= ta.scrollHeight - 2, // 撑到全高=无内部裁切,滚动交给外层
      }
    })
    record('P16 源码模式长文自动撑高(尾部不被 60vh 裁掉)', p16.hasTail && p16.grown, JSON.stringify(p16))
    await pg.close()
  }

  // P17:编辑区**左侧余白**(pane 内、view.dom 盒外)与块同水平线 hover → 把手照出(AFFiNE 同款,
  // 2026-08-14 追加:x 钳到编辑区边缘重试)。
  {
    const pg = await fresh(browser)
    const c = await pg.evaluate((s) => {
      const pm = document.querySelector(s)
      const p2 = pm.querySelectorAll(':scope > p')[1]
      const pr = pm.getBoundingClientRect()
      const rootR = pm.closest('.unified-body').getBoundingClientRect()
      const r = p2.getBoundingClientRect()
      // 余白测试点须仍在 .unified-body 内(hover 追踪挂 root;harness 壳窄,余白只有 ~40px)
      return { x: Math.max(rootR.left + 4, pr.left - 45), y: r.top + r.height / 2, blockY: r.top }
    }, PM)
    await pg.mouse.move(c.x, c.y, { steps: 3 })
    await pg.waitForTimeout(250)
    const p17 = await pg.evaluate((blockY) => {
      const g = document.querySelector('.unified-gutter')
      const gr = g?.getBoundingClientRect()
      return { show: g?.dataset.show, dy: gr ? Math.abs(gr.top - blockY) : 999 }
    }, c.blockY)
    record('P17 编辑区左余白同水平线 hover 出把手(锚对行)', p17.show === 'true' && p17.dy < 20, JSON.stringify(p17))
    await pg.close()
  }

  // P18:标题小节折叠(AFFiNE 同款,会话内纯装饰):把手折叠钮 → 小节(含子小节)隐藏、
  // 同级后文不受累、**零写盘**;折叠标题行首常驻展开钮点击还原。
  {
    const seed = '# 甲\n\n甲一。\n\n## 乙\n\n乙一。\n\n# 丙\n\n丙一。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const h = await pg.evaluate((s) => {
      const el = document.querySelector(`${s} h1`)
      const r = el.getBoundingClientRect()
      return { x: r.left + 15, y: r.top + r.height / 2 }
    }, PM)
    await pg.mouse.move(h.x, h.y, { steps: 3 })
    await pg.waitForTimeout(300)
    const wBefore = await pg.evaluate(() => window.__upage.writes.length)
    const a18 = await pg.evaluate(() => {
      const fold = document.querySelector('.unified-gutter .block-fold')
      if (!fold || fold.style.display === 'none') return { err: 'no fold btn' }
      fold.click()
      return {}
    })
    await pg.waitForTimeout(1200)
    const b18 = await pg.evaluate((s) => {
      const pm = document.querySelector(s)
      const vis = (t) => {
        const el = [...pm.querySelectorAll('p, h1, h2')].find((x) => x.textContent.includes(t))
        return el ? el.offsetParent !== null : null
      }
      return {
        writes: window.__upage.writes.length,
        jia1: vis('甲一'), yi: vis('乙'), yi1: vis('乙一'), bing: vis('丙'), bing1: vis('丙一'),
        foldedClass: !!pm.querySelector('h1.amx-heading-folded'),
        caret: !!pm.querySelector('.amx-fold-caret'),
      }
    }, PM)
    // 光标守卫(Codex P1):折叠态从标题 ArrowDown 打字,绝不许落进 display:none 的隐藏段落。
    const hc = await pg.evaluate((s) => {
      const r = document.querySelector(`${s} h1`).getBoundingClientRect()
      return { x: r.left + 200, y: r.top + r.height / 2 }
    }, PM)
    await pg.mouse.click(hc.x, hc.y)
    await pg.keyboard.press('ArrowDown')
    await pg.keyboard.press('ArrowDown')
    await pg.keyboard.type('X')
    await pg.waitForTimeout(150)
    const d18 = await pg.evaluate((s) => {
      const pm = document.querySelector(s)
      const xEl = [...pm.querySelectorAll('p, h1, h2')].find((e) => e.textContent.includes('X'))
      return {
        xVisible: xEl ? xEl.offsetParent !== null : false,
        hiddenClean: ![...pm.querySelectorAll('.amx-fold-hidden')].some((e) => e.textContent.includes('X')),
      }
    }, PM)
    await pg.evaluate(() => {
      const c = document.querySelector('.amx-fold-caret')
      c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
    await pg.waitForTimeout(250)
    const c18 = await pg.evaluate((s) => {
      const pm = document.querySelector(s)
      const vis = (t) => {
        const el = [...pm.querySelectorAll('p, h2')].find((x) => x.textContent.includes(t))
        return el ? el.offsetParent !== null : null
      }
      return { jia1: vis('甲一'), yi1: vis('乙一'), caretGone: !pm.querySelector('.amx-fold-caret') }
    }, PM)
    record(
      'P18 标题折叠:小节(含子级)隐藏+同级不受累+零写盘;光标不入隐藏区;常驻钮展开还原',
      !a18.err && b18.writes === wBefore && b18.jia1 === false && b18.yi1 === false && b18.bing === true && b18.bing1 === true &&
        b18.foldedClass && b18.caret && d18.xVisible && d18.hiddenClean && c18.jia1 === true && c18.yi1 === true && c18.caretGone,
      JSON.stringify({ a18, b18, d18, c18 }),
    )
    await pg.close()
  }

  // P18b:**卡内**标题的折叠(2026-08-20 用户报「各级别标题还是没能折叠」)。真因两条叠加:
  //   ① headingFold 原本只按 doc 的直接子节点找标题 index → 卡内标题一律判不出是标题;
  //   ② 卡的**首块**按「首子归外壳」把手锚在卡上 → 折叠钮问的是卡不是标题(修①之后卡内 H2
  //      出钮、卡内首行 H1 仍不出钮,就是这一格之差)。所以断言必须同时覆盖首块与非首块。
  // 反向哨兵:折卡内小节绝不许连累卡外的同名层级(小节边界只在自己容器内算)。
  {
    const seed = [
      '---', 'amadeus_schema: amadeus.page/4',
      'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"k1","x":40,"y":40,"w":300}]}',
      '---', '', '# 顶层甲', '', '顶层甲一。', '', '## 顶层乙', '', '顶层乙一。', '',
      '<!-- a k1 -->', '# 卡内甲', '', '卡内甲一。', '', '## 卡内乙', '', '卡内乙一。', '<!-- /a k1 -->', '',
    ].join('\n')
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(500)
    /** 把手悬到某个标题上,回折叠钮出不出来。 */
    const hoverFold = async (text) => {
      const h = await pg.evaluate(({ s, t }) => {
        const el = [...document.querySelectorAll(`${s} h1, ${s} h2`)].find((x) => x.textContent.includes(t))
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + 15, y: r.top + r.height / 2 }
      }, { s: PM, t: text })
      if (!h) return null
      await pg.mouse.move(h.x - 60, h.y - 40, { steps: 2 })
      await pg.mouse.move(h.x, h.y, { steps: 4 })
      await pg.waitForTimeout(320)
      return await pg.evaluate(() => {
        const f = document.querySelector('.unified-gutter .block-fold')
        return !!f && f.style.display !== 'none'
      })
    }
    const vis = (t) => pg.evaluate(({ s, t }) => {
      const el = [...document.querySelectorAll(`${s} h1, ${s} h2, ${s} p`)].find((x) => x.textContent.includes(t))
      return el ? el.offsetParent !== null : null
    }, { s: PM, t })
    const btn = {
      top: await hoverFold('顶层甲'),
      cardFirst: await hoverFold('卡内甲'), // 卡的首块 = 「首子归外壳」那一格
      cardMid: await hoverFold('卡内乙'),
    }
    await hoverFold('卡内甲')
    const wBefore = await pg.evaluate(() => window.__upage.writes.length)
    await pg.evaluate(() => document.querySelector('.unified-gutter .block-fold')?.click())
    await pg.waitForTimeout(400)
    const folded = {
      卡内甲一: await vis('卡内甲一'), 卡内乙: await vis('卡内乙'),
      顶层乙: await vis('顶层乙'), 顶层甲一: await vis('顶层甲一'),
      caret: await pg.evaluate(() => !!document.querySelector('.amx-fold-caret')),
      writes: await pg.evaluate(() => window.__upage.writes.length),
    }
    // 常驻展开钮:widget 在标题内容首,它拿标题前位时**不能写死 before(1)**(卡内标题 depth=2)
    await pg.evaluate(() => document.querySelector('.amx-fold-caret')
      ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })))
    await pg.waitForTimeout(300)
    const back = { 卡内甲一: await vis('卡内甲一'), caretGone: await pg.evaluate(() => !document.querySelector('.amx-fold-caret')) }
    record(
      'P18b 卡内标题同样能折:首块/非首块都出钮;折的只是卡内小节(卡外不受累)+零写盘;展开钮还原',
      btn.top === true && btn.cardFirst === true && btn.cardMid === true &&
        folded.卡内甲一 === false && folded.卡内乙 === false && folded.顶层乙 === true && folded.顶层甲一 === true &&
        folded.caret && folded.writes === wBefore && back.卡内甲一 === true && back.caretGone,
      JSON.stringify({ btn, folded, back }),
    )
    await pg.close()
  }

  // P18c:复制到**外部应用**的纯文本不许带锚(用户 2026-08-20 实报:复制一张卡,末尾跟着一行
  // `<!-- /a xxxx -->` 贴进微信)。真因:剥锚正则是 08-19 闭合锚改版**之前**写的,只剥开标记。
  // 反向哨兵(Codex 2026-08-20 medium):「收回卡片」留下的惰性锚是**合法正文字面**,切片里没有
  // 卡/分栏节点时一个字都不许动 —— 无差别正则会把用户自己写的那一行悄悄吞掉。
  // 走 PM 自己的 serializeForClipboard(= Cmd+C 的同一条路),不碰浏览器剪贴板权限。
  {
    const seed = [
      '---', 'amadeus_schema: amadeus.page/4',
      'amadeus_canvas: {"v":1,"mode":"doc","main":{"x":0,"y":0,"w":720},"cards":[{"ref":"kc","x":40,"y":40,"w":300}]}',
      '---', '', '# 标题甲', '', '<!-- /a kold -->', '', '上面那行是收回卡片留下的惰性锚字面。', '',
      '<!-- a kc -->', '卡内一句。', '<!-- /a kc -->', '',
    ].join('\n')
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(500)
    const clip = await pg.evaluate(() => {
      const view = window.__upage.probe.view()
      // TextSelection 不是全局:从当前选区(装载后恒是文本选区)的构造器上取,再 between 两端。
      const TS = view.state.selection.constructor
      const text = (from, to) => {
        view.dispatch(view.state.tr.setSelection(TS.between(view.state.doc.resolve(from), view.state.doc.resolve(to))))
        return view.serializeForClipboard(view.state.selection.content()).text
      }
      // 全选(含卡)→ 生成的锚必须一个都不剩
      const all = text(0, view.state.doc.content.size)
      // 只选「标题 + 惰性锚那两段」(切片里没有卡)→ 用户的字面锚必须原样活着
      let stop = -1
      view.state.doc.forEach((n, off) => { if (stop < 0 && n.type.name === 'amadeusCanvasCard') stop = off })
      const part = text(0, stop > 0 ? stop - 1 : view.state.doc.content.size)
      return { all, part }
    })
    await pg.close()
    record('P18c 复制到外部:切片里有卡 → 生成的开合锚都剥干净;切片里没有卡 → 用户的惰性锚字面一个字不动',
      !clip.all.includes('<!-- a kc -->') && !clip.all.includes('<!-- /a kc -->') && clip.all.includes('卡内一句。')
        && clip.part.includes('<!-- /a kold -->') && clip.part.includes('标题甲'),
      JSON.stringify(clip))
  }

  // P19:slash 菜单接进统一实例。此前 unified 只传了 slashOpsRef(为的是行内工具栏),没传
  // onSlashPick → 菜单渲染条件 `slash && onSlashPick` 恒 false,打 '/' 永远不弹(spec Phase B 长尾)。
  // 三幕:整块型插入(代码块,'/query' 不留残渣)/ 前缀型原地转换(不新建块)/「模板」在列。
  // (模板曾被 UNIFIED_HIDDEN_SLASH 屏蔽;2026-08-21 UnifiedPage.applySlash 接上
  //  `amadeus:template-picker` 带 v4Path 的宿主路由后移出屏蔽集,见 MarkdownBlock.tsx 那张集合的注释。)
  {
    const seed = '# 标题\n\n首段。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const clickEndOfP = async () => {
      const c = await pg.evaluate((s) => {
        const el = [...document.querySelector(s).querySelectorAll(':scope > p')].find((x) => x.textContent.includes('首段'))
        const r = el.getBoundingClientRect()
        return { x: r.right - 2, y: r.top + r.height / 2 }
      }, PM)
      await pg.mouse.click(c.x, c.y)
    }
    // 幕一:文末另起一段打 '/code' → Enter 插入代码块。
    await clickEndOfP()
    await pg.keyboard.press('Enter')
    await pg.keyboard.type('/code')
    await pg.waitForTimeout(300)
    const a19 = await pg.evaluate(() => {
      const m = document.querySelector('.slash-menu')
      return { open: !!m, first: m?.querySelector('[role="menuitem"] .slash-label')?.textContent ?? '' }
    })
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(400)
    const b19 = await pg.evaluate((s) => {
      const pm = document.querySelector(s)
      return { pre: pm.querySelectorAll('pre').length, text: pm.textContent, menu: !!document.querySelector('.slash-menu') }
    }, PM)
    // 幕二:前缀型(标题 2)= 原地转换,不新建块。'/' 前必须是空白才触发(词中 '/' 是路径,不弹)。
    await clickEndOfP()
    await pg.keyboard.type(' /h2')
    await pg.waitForTimeout(300)
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(300)
    const c19 = await pg.evaluate((s) => {
      const pm = document.querySelector(s)
      const h2 = [...pm.querySelectorAll('h2')].find((x) => x.textContent.includes('首段'))
      return { h2: !!h2, residue: pm.textContent.includes('/h2'), ps: pm.querySelectorAll(':scope > p').length }
    }, PM)
    // 幕三:空段落打 '/' 浏览全部项 —— 「模板」「数据库」都得在列(模板走宿主选择器路由,见段首注)。
    // 上一幕把最后一个段落变成 H2,DOM Range 的 fallback 会落到 pre 工具条里;
    // 直接用 PM 事务准备空段落,这幕只检验 slash 目录本身。
    await pg.evaluate(() => {
      const v = window.__upage.probe.view()
      const end = v.state.doc.content.size
      const tr = v.state.tr.insert(end, v.state.schema.nodes.paragraph.create())
      tr.setSelection(v.state.selection.constructor.create(tr.doc, end + 1))
      v.dispatch(tr)
      v.focus()
    })
    await pg.keyboard.type('/')
    await pg.waitForTimeout(300)
    const d19 = await pg.evaluate(() => {
      const labels = [...document.querySelectorAll('.slash-menu [role="menuitem"] .slash-label')].map((e) => e.textContent)
      return { n: labels.length, hasTemplate: labels.includes('模板'), hasDb: labels.includes('数据库') }
    })
    record(
      'P19 slash 菜单接进统一实例:整块插入无残渣 + 前缀型原地转换 + 模板/数据库在列',
      a19.open && a19.first === '代码块' && b19.pre >= 1 && !b19.text.includes('/code') && !b19.menu &&
        c19.h2 && !c19.residue && d19.n > 10 && d19.hasTemplate && d19.hasDb,
      JSON.stringify({ a19, b19: { ...b19, text: undefined }, c19, d19 }),
    )
    await pg.close()
  }

  // P20:页内查找。2026-09-03 从「PM 装饰 + blockId 计数」整个换成壳级 DOM 扫描 + CSS 自定义高亮
  //  —— 用户实报三条:大多数 View 没有查找、Amadeus 卡片没有、画布没有。这里钉住换实现后**必须
  //  成立**的四件事,前三条各对应一条实报:
  //   a. 正文跨段命中 + x/y 计数 + Enter 下一条 + Esc 收干净(老 P20 的全部内容,不许退化);
  //   b. **跨行内标记**命中(`苹**果**` = 文本节点 + <strong> 两段)。老实现按 textblock 的
  //      textContent 匹配所以能中;逐个 text node indexOf 会**静默**少一半命中 —— 这条是本轮
  //      最容易悄悄丢掉的行为,必须有负对照(见 b2:故意只数单节点命中会数不足);
  //   c. **嵌入卡**(`![[Embedded]]`)里的字算命中。卡片是独立 createRoot 的 React 树,不在本篇
  //      PM 文档里 —— 老实现结构上永远够不着,这条从 0 到 1;
  //   d. 命中不跨块:`二号\n苹果` 这种跨段串不该有命中(拼串时块边界插了 '\n')。
  //  ⚠️ 断言看的是 CSS.highlights,不再是 .amx-find-hit 元素 —— 新实现刻意不往 React/PM 管的
  //     DOM 里插节点(插了 PM 当场判外部改动)。
  {
    const seed = '# 查找页\n\n苹果一号。\n\n香蕉。\n\n苹**果**二号,苹果三号。\n\n![[Embedded]]\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(600) // 嵌入卡是异步读盘 + 独立 createRoot,要等它挂上
    await pg.evaluate(() => window.__openFind())
    await pg.waitForTimeout(200)
    const barOpen = await pg.evaluate(() => !!document.querySelector('.amx-findbar input'))
    await pg.keyboard.type('苹果')
    await pg.waitForTimeout(350)
    /** 高亮命中数 + 当前命中所在段落文字。CSS.highlights 里存的是 Range,取 startContainer 回溯。 */
    const readHits = () =>
      pg.evaluate(() => {
        const all = [...(CSS.highlights.get('amx-find') ?? [])]
        const cur = [...(CSS.highlights.get('amx-find-active') ?? [])][0]
        const textOf = (r) => r?.startContainer?.parentElement?.closest('p,li,h1,h2,h3')?.textContent ?? ''
        return {
          hits: all.length,
          active: cur ? 1 : 0,
          count: document.querySelector('.amx-findbar-count')?.textContent ?? '',
          activeIn: textOf(cur),
          // b2 负对照:单个 text node 内部能数到的命中。跨 <strong> 那条不在其中 → 必须 < hits。
          singleNode: all.filter((r) => r.startContainer === r.endContainer).length,
          // c:命中里有没有落在嵌入卡(.amx-uembed / 卡片容器)内的
          inEmbed: all.filter((r) => !!r.startContainer?.parentElement?.closest('.embed-body')).length,
        }
      })
    const a20 = await readHits()
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(250)
    const b20 = await readHits()
    // c:嵌入卡里的字算命中。卡片是 Decoration.widget + createRoot 的独立 React 树,不在本篇 PM
    //    文档里 —— 老的 PM 装饰实现结构上永远够不着它,这条是本轮从 0 到 1 的那半。
    const typeQuery = async (q) => {
      await pg.evaluate((v) => {
        const inp = document.querySelector('.amx-findbar input')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(inp, v)
        inp.dispatchEvent(new Event('input', { bubbles: true }))
      }, q)
      await pg.waitForTimeout(300)
    }
    await typeQuery('被嵌入')
    const e20 = await readHits()

    // d:跨块串不该命中
    await typeQuery('香蕉苹果')
    const d20 = await pg.evaluate(() => ({
      hits: [...(CSS.highlights.get('amx-find') ?? [])].length,
      count: document.querySelector('.amx-findbar-count')?.textContent ?? '',
    }))
    await pg.keyboard.press('Escape')
    await pg.waitForTimeout(250)
    const c20 = await pg.evaluate(() => ({
      bar: !!document.querySelector('.amx-findbar'),
      hits: [...(CSS.highlights.get('amx-find') ?? [])].length,
    }))
    record(
      'P20 页内查找:跨段 + 跨行内标记 + 嵌入卡 + 不跨块 + Enter 下一条 + Esc 收干净',
      barOpen &&
        a20.hits === 3 && a20.active === 1 && a20.count === '1/3' && a20.activeIn.includes('苹果一号') &&
        a20.singleNode < a20.hits && // 负对照:确实有一条是跨节点拼出来的
        b20.count === '2/3' && b20.activeIn.includes('二号') &&
        e20.hits === 2 && e20.inEmbed === 2 && // c:两段嵌入正文都命中,且都在卡片里
        d20.hits === 0 && d20.count === '0' &&
        !c20.bar && c20.hits === 0,
      JSON.stringify({ barOpen, a20, b20, e20, d20, c20 }),
    )
    await pg.close()
  }

  // P20b:页内查找替换(C-18)。UnifiedPage 注册 replace provider(所见即所得 → PM 事务;源码模式 → textarea 镜像 +
  //  execCommand)。钉:单行选区预填查找词;大小写 / 正则开关改计数;替换当前后跳到下一条;全部替换 = 一步撤销;
  //  嵌入卡里的命中查得到但不可替换;源码模式也能查能换、落盘带新文、原生撤销能撤回。
  //  源码模式命中只算镜像里那一条、且真画在 textarea 上(C-05「幻影命中」:扫到 textarea 子文字节点 → 1/1 无高亮;
  //  负对照:findInPage 的 TEXTAREA 排除摘掉 → hits=2 红,已实跑)。
  {
    const seed = '# 替换页\n\napple 一号,Apple 二号。\n\n苹**果**三号,苹果四号,苹果五号。\n\n![[Embedded]]\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(600)
    const q = (v) => pg.evaluate((v) => {
      const inp = document.querySelector('.amx-findbar input')
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, v)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    }, v).then(() => pg.waitForTimeout(300))
    const r = (v) => pg.evaluate((v) => {
      const inp = document.querySelector('.amx-findbar-replace')
      if (!inp) return
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, v)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    }, v).then(() => pg.waitForTimeout(100))
    const st = () => pg.evaluate(() => {
      const all = [...(CSS.highlights.get('amx-find') ?? [])]
      const acts = [...document.querySelectorAll('.amx-findbar-act')]
      return {
        count: document.querySelector('.amx-findbar-count')?.textContent ?? '',
        hits: all.length,
        inMirror: all.filter((x) => !!x.startContainer.parentElement?.closest('.amx-find-mirror')).length,
        canReplace: acts.length === 2 && acts.every((b) => !b.disabled),
        rows: document.querySelectorAll('.amx-findbar-row').length,
      }
    })
    const lastMd = () => pg.evaluate(() => window.__upage.writes.at(-1)?.text ?? '')
    const pressOpt = (i) => pg.evaluate((i) => document.querySelectorAll('.amx-findbar-opt')[i]?.click(), i).then(() => pg.waitForTimeout(250))
    const act = (i) => pg.evaluate((i) => document.querySelectorAll('.amx-findbar-act')[i]?.click(), i).then(() => pg.waitForTimeout(250))
    // a:单行选区预填
    await pg.evaluate(() => {
      const v = window.__upage.probe.view()
      let at = -1
      v.state.doc.descendants((n, pos) => { if (at < 0 && n.isText && n.text.includes('二号')) at = pos + n.text.indexOf('二号'); return at < 0 })
      const S = Object.getPrototypeOf(Object.getPrototypeOf(v.state.selection)).constructor
      const TS = S.near(v.state.doc.resolve(at)).constructor
      v.focus()
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, at, at + 2)))
    })
    await pg.waitForTimeout(100)
    await pg.evaluate(() => window.__openFind())
    await pg.waitForTimeout(300)
    const a = { prefill: await pg.inputValue('.amx-findbar input'), ...(await st()) }
    // b:大小写
    await q('apple')
    const b1 = await st()
    await pressOpt(0)
    const b2 = await st()
    await pressOpt(0)
    // c:正则 + 替换当前(`$1` 展开)→ 跳到下一条;全部替换;一步撤销
    await pressOpt(1)
    await q('苹(.)')
    const c1 = await st()
    await pg.evaluate(() => document.querySelector('.amx-findbar-expand')?.click())
    await pg.waitForTimeout(150)
    await r('梨$1')
    await act(0)
    const c2 = await st()
    await act(1)
    await pg.waitForTimeout(1300)
    const c3 = { ...(await st()), md: await lastMd() }
    await pg.evaluate(() => window.__upage.probe.view().focus())
    await pg.keyboard.press('Meta+z')
    await pg.waitForTimeout(1300)
    const c4 = await lastMd()
    // e:嵌入卡里的命中:查得到、不可替换
    await pg.evaluate(() => document.querySelector('.amx-findbar input').focus())
    await pressOpt(1)
    await q('被嵌入')
    const e1 = await st()
    // f:源码模式:镜像里查、替换落盘、原生撤销
    await pg.evaluate(() => window.__upage.setEditorMode('source'))
    await pg.waitForSelector('.amx-source', { timeout: 5000 })
    await pg.waitForTimeout(400)
    await q('二号')
    const f1 = await st()
    // C-05「幻影命中」:源码模式曾显示 1/1 却无高亮不滚动(扫到了 textarea 的子文字节点,零尺寸)。命中必须真画在 textarea 上。
    f1.visible = await pg.evaluate(() => {
      const r = [...(CSS.highlights.get('amx-find') ?? [])][0]
      if (!r) return false
      const b = r.getBoundingClientRect(), ta = document.querySelector('.amx-source').getBoundingClientRect()
      return b.width > 0 && b.height > 0 && b.top >= ta.top - 1 && b.bottom <= ta.bottom + 1 && b.left >= ta.left - 1 && b.right <= ta.right + 1
    })
    await r('贰号')
    await act(1)
    await pg.waitForTimeout(1300)
    const f2 = { ta: await pg.evaluate(() => document.querySelector('.amx-source').value), md: await lastMd(), ...(await st()) }
    await pg.evaluate(() => document.querySelector('.amx-source').focus())
    await pg.keyboard.press('Meta+z')
    await pg.waitForTimeout(1300)
    const f3 = { ta: await pg.evaluate(() => document.querySelector('.amx-source').value), md: await lastMd() }
    if (process.argv.includes('--shot')) {
      await pg.evaluate(() => window.__upage.setEditorMode('wysiwyg'))
      await pg.waitForTimeout(400)
    }
    record('P20b 页内查找替换:选区预填 + 大小写 / 正则 + 替换当前跳下一条 + 全部替换一步撤销 + 嵌入不可换 + 源码模式能换能撤',
      a.prefill === '二号' && a.count === '1/1' &&
        b1.count === '1/2' && b2.count === '1/1' &&
        c1.count === '1/3' && c2.count === '1/2' && c3.count === '0' && c3.hits === 0 &&
        c3.md.includes('梨果四号,梨果五号') && !c3.md.includes('苹果') &&
        c4.includes('苹果四号,苹果五号') && !c4.includes('梨果四号') &&
        e1.hits === 2 && !e1.canReplace &&
        f1.hits === 1 && f1.inMirror === 1 && f1.visible && f1.canReplace &&
        f2.ta.includes('Apple 贰号') && f2.md.includes('Apple 贰号') && f2.hits === 0 &&
        f3.ta.includes('Apple 二号') && f3.md.includes('Apple 二号'),
      JSON.stringify({ a, b1: b1.count, b2: b2.count, c1: c1.count, c2: c2.count, c3: { count: c3.count, hits: c3.hits, md: c3.md.slice(0, 80) }, c4: c4.slice(0, 80), e1, f1, f2: { ...f2, ta: f2.ta.slice(0, 60), md: f2.md.slice(0, 60) }, f3: { ta: f3.ta.slice(0, 60), md: f3.md.slice(0, 60) } }))
    await pg.close()
  }

  // P20c:查找条收起后的焦点(评审 C-17:Esc / × 关掉后焦点掉到 body,直接打字无效、光标也不在命中处)。
  //  a. Esc:选区落在当前命中上、焦点回正文,接着打字就在命中处;
  //  b. 点 ×:焦点回到开条前的地方,光标原位不动;
  //  c. 源码模式 Esc:焦点回 textarea,选区 = 命中(textarea 的命中在镜像上,偏移映射回 textarea)。
  //  负对照:closeFindBar 的 restoreFocus 摘掉 → 三条全红(已实跑)。
  {
    const seed = '# 焦点页\n\n苹果一号。\n\n香蕉。\n\n苹果二号在这里。\n\n末段。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(500)
    const clickEnd = async (text) => {
      const at = await pg.evaluate(([s, t]) => {
        const p = [...document.querySelectorAll(s + ' > p')].find((x) => x.textContent.includes(t))
        const r = document.createRange(); r.selectNodeContents(p); const b = r.getBoundingClientRect()
        return { x: b.right - 1, y: b.top + b.height / 2 }
      }, [PM, text])
      await pg.mouse.click(at.x, at.y)
      await pg.waitForTimeout(150)
    }
    const pmSel = () => pg.evaluate(() => {
      const v = window.__upage.probe.view()
      const { from, to } = v.state.selection
      return { focused: document.activeElement === v.dom, text: v.state.doc.textBetween(from, to), para: v.state.selection.$from.parent.textContent, head: v.state.selection.head }
    })
    const openAndType = async (q) => {
      await pg.evaluate(() => window.__openFind())
      await pg.waitForTimeout(200)
      await pg.keyboard.type(q)
      await pg.waitForTimeout(350)
    }
    // a
    await clickEnd('末段')
    await openAndType('苹果')
    await pg.keyboard.press('Enter') // → 第 2 条
    await pg.waitForTimeout(200)
    await pg.keyboard.press('Escape')
    await pg.waitForTimeout(200)
    const a = await pmSel()
    await pg.keyboard.type('梨')
    await pg.waitForTimeout(200)
    a.after = await pg.evaluate(() => window.__upage.probe.view().state.doc.textContent)
    // b
    await clickEnd('香蕉')
    const b0 = await pmSel()
    await openAndType('末段')
    await pg.click('.amx-findbar button[aria-label="关闭（Esc）"]')
    await pg.waitForTimeout(200)
    const b = await pmSel()
    b.before = b0.head
    // c
    await pg.evaluate(() => window.__upage.setEditorMode('source'))
    await pg.waitForSelector('.amx-source', { timeout: 5000 })
    await pg.waitForTimeout(300)
    await pg.evaluate(() => { const t = document.querySelector('.amx-source'); t.focus(); t.setSelectionRange(0, 0) })
    await openAndType('香蕉')
    await pg.keyboard.press('Escape')
    await pg.waitForTimeout(200)
    const c = await pg.evaluate(() => {
      const t = document.querySelector('.amx-source')
      return { focused: document.activeElement === t, sel: t.value.slice(t.selectionStart, t.selectionEnd) }
    })
    record('P20c 查找条收起:Esc → 选区落在当前命中、接着打字就在命中处;× → 焦点回原处光标不动;源码模式 Esc → textarea 选中命中(C-17)',
      a.focused && a.text === '苹果' && a.para.includes('二号') && a.after.includes('梨二号在这里') && a.after.includes('苹果一号') &&
        b.focused && b.head === b.before && b.text === '' &&
        c.focused && c.sel === '香蕉',
      JSON.stringify({ a, b, c }))
    await pg.close()
  }

  // P20d:状态栏计数的 v4 接缝(评审 C-22:按原始 md 计数 —— 链接地址、表格竖线、`- [ ]` 全算进去,156 vs 可见约 25;
  //  没有词数、没有选区计数)。走生产 lifecycle.unifiedStats(状态栏 WordCountItem 读的就是它):
  //  全文只数可见文字;选中一段 → 另给选区的数,且计数版本号跟着选区变(状态栏据此刷新),折叠选区 → 选区数消失。
  //  负对照:statsNow 改回数 pipe.body 原文 → 全文字数红(已实跑)。
  {
    const seed = '# Hello **world**\n\n看 [这篇文章](https://example.com/a/very/long/path?utm_source=x) 吧。\n\n![[Embedded]]\n\n- [ ] 待办一项\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForFunction(() => !!(window.__upage && window.__upage.lifecycle), null, { timeout: 20000 })
    await pg.waitForTimeout(500)
    const stats = () => pg.evaluate(() => ({ st: window.__upage.lifecycle.unifiedStats('Unified.md'), ver: window.__upage.lifecycle.unifiedStatsVer() }))
    const a = await stats()
    // 选中「这篇文章」四个字(真键盘:点到「看」后,Shift+→ 走过空格与四个字)
    const at = await pg.evaluate((s) => {
      const p = [...document.querySelectorAll(s + ' > p')].find((x) => x.textContent.includes('这篇文章'))
      const t = p.firstChild; const r = document.createRange(); r.setStart(t, 1); r.setEnd(t, 1); const b = r.getBoundingClientRect()
      return { x: b.left, y: b.top + b.height / 2 }
    }, PM)
    await pg.mouse.click(at.x, at.y)
    await pg.waitForTimeout(150)
    await pg.keyboard.press('ArrowRight')
    for (let i = 0; i < 4; i++) await pg.keyboard.press('Shift+ArrowRight')
    await pg.waitForTimeout(150)
    const b = await stats()
    await pg.keyboard.press('ArrowRight')
    await pg.waitForTimeout(150)
    const c = await stats()
    record('P20d 计数只数可见文字(Hello world / 看这篇文章吧。/ 待办一项 / a b 1 2 = 25 字 16 词);选区另计且随选区刷新(C-22)',
      a.st && a.st.all.chars === 25 && a.st.all.words === 16 && a.st.sel === null &&
        b.st && b.st.sel && b.st.sel.chars === 4 && b.st.sel.words === 4 && b.ver > a.ver &&
        c.st && c.st.sel === null && c.ver > b.ver,
      JSON.stringify({ a, b, c }))
    await pg.close()
  }

  // P21:跨块文字拖选按真实字符范围呈现;块内选字也仍是原生高亮。
  {
    const seed = '甲段落文字。\n\n乙段落文字。\n\n丙段落文字。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const box = await pg.evaluate((s) => {
      const ps = [...document.querySelector(s).querySelectorAll(':scope > p')]
      const r1 = ps[0].getBoundingClientRect(), r2 = ps[1].getBoundingClientRect(), r3 = ps[2].getBoundingClientRect()
      return {
        x1: r1.left + 10, y1: r1.top + r1.height / 2,
        x2: r2.left + r2.width / 2, y2: r2.top + r2.height / 2,
        x3: r3.left + 20, y3: r3.top + r3.height / 2,
      }
    }, PM)
    await pg.mouse.move(box.x1, box.y1)
    await pg.mouse.down()
    await pg.mouse.move(box.x2, box.y2, { steps: 8 })
    await pg.mouse.up()
    await pg.waitForTimeout(250)
    const a21 = await pg.evaluate((s) => ({
      marked: document.querySelectorAll(`${s} .amx-block-selected`).length,
      flag: document.querySelector(s)?.getAttribute('data-blocksel'),
      selected: window.getSelection()?.toString() ?? '',
    }), PM)
    // 块内选字 → 不接管(仍是原生文字高亮)。⚠️ 必须点到**别的**段落:点回拖拽终点那一格,
    // Chromium 会按连击处理(等于双击),选区不落单块 —— 探针实测过,是仪器坑不是行为错。
    await pg.mouse.click(box.x3, box.y3)
    await pg.keyboard.press('Shift+ArrowRight')
    await pg.waitForTimeout(250)
    const b21 = await pg.evaluate((s) => ({
      marked: document.querySelectorAll(`${s} .amx-block-selected`).length,
      flag: document.querySelector(s)?.getAttribute('data-blocksel'),
      sel: (window.getSelection()?.toString() ?? '').length,
    }), PM)
    record(
      'P21 跨块拖字=真实字符范围(块内选字仍原生)',
      a21.marked === 0 && !a21.flag && a21.selected.includes('段落文字。') && a21.selected.includes('乙段落文字。') &&
        b21.marked === 0 && !b21.flag && b21.sel > 0,
      JSON.stringify({ a21, b21 }),
    )
    await pg.close()
  }

  // P22:Mod+A 三级递进全选(AFFiNE 对齐)。PM 原生只有「整篇」一级 —— 整页一实例之后,
  // 想全选本段却会把全文一起吞掉(块世界里每块一实例时不存在这问题)。
  {
    const seed = '- 甲项\n- 乙项\n\n尾段。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const c = await pg.evaluate((s) => {
      const li = [...document.querySelector(s).querySelectorAll('li')][0]
      const r = li.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, PM)
    await pg.mouse.click(c.x, c.y)
    await pg.waitForTimeout(200) // click→PM 选区经 selectionchange 异步落定,0ms 接键盘=打在旧选区上
    const selText = () => pg.evaluate(() => {
      const v = window.__upage.probe.view()
      const { from, to } = v.state.selection
      return v.state.doc.textBetween(from, to, '')
    })
    const tiers = []
    for (let i = 0; i < 3; i++) {
      await pg.keyboard.press('Meta+a')
      await pg.waitForTimeout(150)
      tiers.push(await selText())
    }
    record(
      'P22 Mod+A 三级:本块文字 → 整只列表 → 整篇',
      tiers[0] === '甲项' && tiers[1] === '甲项乙项' && tiers[2].includes('尾段'),
      JSON.stringify(tiers),
    )
    await pg.close()
  }

  // P23:键盘搬块 Mod-Alt-↑/↓。v3 块世界有 keys.moveDir,统一实例的 ArrowUp/Down 分支整条
  // `if (unified) return false` 让给了原生 → 键盘搬块在 v4 页面上直接消失,只剩鼠标拖 ⠿。
  {
    const seed = '段甲。\n\n段乙。\n\n段丙。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const c = await pg.evaluate((s) => {
      const p = [...document.querySelector(s).querySelectorAll(':scope > p')].find((x) => x.textContent === '段乙。')
      const r = p.getBoundingClientRect()
      return { x: r.left + 12, y: r.top + r.height / 2 }
    }, PM)
    await pg.mouse.click(c.x, c.y)
    await pg.waitForTimeout(200) // 同上:不等这一下,第一次按键恒落空(实测两次)
    await pg.keyboard.press('Meta+Alt+ArrowUp')
    await pg.waitForTimeout(250)
    const a23 = await pg.evaluate((s) => {
      const v = window.__upage.probe.view()
      const $f = v.state.doc.resolve(v.state.selection.from)
      return {
        order: [...document.querySelector(s).querySelectorAll(':scope > p')].map((x) => x.textContent).join('|'),
        caretIn: $f.parent.textContent,
      }
    }, PM)
    await pg.keyboard.press('Meta+Shift+ArrowDown') // 另一套绑定,搬回去
    await pg.waitForTimeout(250)
    const b23 = await pg.evaluate((s) =>
      [...document.querySelector(s).querySelectorAll(':scope > p')].map((x) => x.textContent).join('|'), PM)
    // 列表项里搬的是**这一项**,不是整只列表(AFFiNE 项级;爬到顶层会把整个列表搬走)。
    const pg2 = await browser.newPage({ locale: 'zh-CN' })
    pg2.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg2.goto(`${URL}?upage&useed=${encodeURIComponent('- 甲项\n- 乙项\n- 丙项\n\n尾段。\n')}`, { waitUntil: 'domcontentloaded' })
    await pg2.waitForSelector(PM, { timeout: 20000 })
    await pg2.waitForTimeout(400)
    const li = await pg2.evaluate((s) => {
      const el = [...document.querySelector(s).querySelectorAll('li')].find((x) => x.textContent.includes('乙项'))
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, PM)
    await pg2.mouse.click(li.x, li.y)
    await pg2.waitForTimeout(200)
    await pg2.keyboard.press('Meta+Alt+ArrowUp')
    await pg2.waitForTimeout(250)
    const c23 = await pg2.evaluate((s) => ({
      lis: [...document.querySelector(s).querySelectorAll('li')].map((x) => x.textContent).join('|'),
      tail: [...document.querySelector(s).querySelectorAll(':scope > p')].map((x) => x.textContent).join('|'),
    }), PM)
    await pg2.close()
    record(
      'P23 Mod-Alt-↑/↓ 搬块(Mod-Shift 同绑),光标跟着走;列表里搬的是单项',
      a23.order === '段乙。|段甲。|段丙。' && a23.caretIn === '段乙。' && b23 === '段甲。|段乙。|段丙。' &&
        c23.lis === '乙项|甲项|丙项' && c23.tail === '尾段。',
      JSON.stringify({ a23, b23, c23 }),
    )
    await pg.close()
  }

  // P24:链接两条 —— ① 打完 `[文字](地址)` 当场成链接(commonmark 预设没有这条行内规则,
  // 整页一实例后不会再有「序列化→重解析」把它救活);② 选中文字上粘 URL = 加链接不覆盖文字。
  {
    const seed = '正文一段。\n\n关键词在这里。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const c1 = await pg.evaluate((s) => {
      const p = [...document.querySelector(s).querySelectorAll(':scope > p')].find((x) => x.textContent === '正文一段。')
      const r = p.getBoundingClientRect()
      return { x: r.right - 2, y: r.top + r.height / 2 }
    }, PM)
    await pg.mouse.click(c1.x, c1.y)
    await pg.keyboard.press('Enter')
    await pg.keyboard.type('[官网](example.com/a)')
    await pg.waitForTimeout(250)
    const a24 = await pg.evaluate((s) => {
      const a = document.querySelector(`${s} a[href]`)
      return { href: a?.getAttribute('href') ?? '', text: a?.textContent ?? '', raw: document.querySelector(s).textContent.includes('](') }
    }, PM)
    // ② 选中「关键词」三个字 → 粘 URL。
    const b24 = await pg.evaluate((s) => {
      const v = window.__upage.probe.view()
      let at = -1
      v.state.doc.descendants((n, pos) => {
        if (n.isText && n.text.includes('关键词')) at = pos + n.text.indexOf('关键词')
        return true
      })
      if (at < 0) return { err: 'no target' }
      const TS = v.state.selection.constructor
      v.dispatch(v.state.tr.setSelection(TS.create(v.state.doc, at, at + 3)))
      v.focus()
      const dt = new DataTransfer()
      dt.setData('text/plain', 'https://forsion.test/x')
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(ev, 'clipboardData', { value: dt })
      document.querySelector(s).dispatchEvent(ev)
      return {}
    }, PM)
    await pg.waitForTimeout(250)
    const c24 = await pg.evaluate((s) => {
      const links = [...document.querySelectorAll(`${s} a[href]`)].map((a) => `${a.textContent}=>${a.getAttribute('href')}`)
      return { links, text: document.querySelector(s).textContent }
    }, PM)
    record(
      'P24 链接:`[文字](地址)` 即时成链 + 选中粘 URL 只加链接不覆盖文字',
      a24.href === 'https://example.com/a' && a24.text === '官网' && !a24.raw && !b24.err &&
        c24.links.includes('关键词=>https://forsion.test/x') && c24.text.includes('关键词在这里。'),
      JSON.stringify({ a24, c24 }),
    )
    await pg.close()
  }

  // P25:空块提示(AFFiNE 对齐)。样式 `.is-empty::before{content:attr(data-placeholder)}` 早就在
  // styles.css 里,但**没人挂过这两个属性** —— 新用户完全不知道有 '/' 这回事。只提示光标所在的
  // 空块;标题报自己的级别;引用/callout 内恒不提示。
  {
    const seed = '首段。\n\n> 引用里\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    // ⚠️ 光标定位走 probe 而不是 click+End:mac 上 End 是「文档尾」不是「行尾」,
    //    键盘定位会把光标送进引用块里(实测两次结果不同)。本关要验的是提示逻辑,不是键位映射。
    const caretToEndOf = async (txt) => pg.evaluate(({ t }) => {
      const v = window.__upage.probe.view()
      let at = -1
      v.state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent === t) at = pos + 1 + n.content.size })
      if (at < 0) return false
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
      v.focus()
      return true
    }, { t: txt })
    await caretToEndOf('首段。')
    await pg.keyboard.press('Enter') // 空段落 → 该出提示
    await pg.waitForTimeout(200)
    const a25 = await pg.evaluate((s) => {
      const el = document.querySelector(`${s} .is-empty`)
      return { n: document.querySelectorAll(`${s} .is-empty`).length, hint: el?.getAttribute('data-placeholder') ?? '' }
    }, PM)
    await pg.keyboard.type('## ') // 空标题 → 提示换成级别
    await pg.waitForTimeout(200)
    const b25 = await pg.evaluate((s) => document.querySelector(`${s} .is-empty`)?.getAttribute('data-placeholder') ?? '', PM)
    await pg.keyboard.type('有字了')
    await pg.waitForTimeout(200)
    const c25 = await pg.evaluate((s) => document.querySelectorAll(`${s} .is-empty`).length, PM)
    // 引用块内的空行:恒不提示。
    await caretToEndOf('引用里')
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(200)
    const d25 = await pg.evaluate((s) => document.querySelectorAll(`${s} .is-empty`).length, PM)
    record(
      'P25 空块提示:正文提示斜杠 / 标题报级别 / 有字即收 / 引用内不提示',
      a25.n === 1 && a25.hint.includes('/') && b25 === '标题 2' && c25 === 0 && d25 === 0,
      JSON.stringify({ a25, b25, c25, d25 }),
    )
    await pg.close()
  }

  // P25b:空块提示的焦点门控(评审 K-23)。装饰跟着选区走、不看焦点:失焦后空段仍挂着「输入 '/'」;空 H2 反过来 ——
  //  聚焦时行首是 `## ` 前缀 input,提示被收掉,失焦后前缀收回它才露出「标题 2」。现在:只有聚焦的空块有提示,
  //  标题的提示画在前缀之后(::after)。量的是**渲染出来的伪元素内容**,不是属性。
  //  负对照:摘掉 styles.css 的两条 K-23 规则 → 失焦两项与 H2 聚焦项全红(已实跑)。
  {
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent('首段。\n')}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const at = await pg.evaluate((s) => { const p = document.querySelector(s + ' > p'); const r = document.createRange(); r.selectNodeContents(p); const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 } }, PM)
    await pg.mouse.click(at.x, at.y)
    await pg.waitForTimeout(150)
    const ph = () => pg.evaluate((s) => {
      const el = document.querySelector(`${s} .is-empty`)
      if (!el) return null
      const c = (k) => { const v = getComputedStyle(el, k).content; return v === 'none' || v === 'normal' ? '' : v.replace(/^"|"$/g, '') }
      return { tag: el.tagName, before: c('::before'), after: c('::after') }
    }, PM)
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(150)
    const a = await ph()
    await pg.click('.amx-title-input')
    await pg.waitForTimeout(150)
    const b = await ph()
    await pg.mouse.click(at.x, at.y + 30) // 回到空段(首段下一行)
    await pg.waitForTimeout(150)
    await pg.keyboard.type('## ')
    await pg.waitForTimeout(250)
    const c = await ph()
    await pg.click('.amx-title-input')
    await pg.waitForTimeout(200)
    const d = await ph()
    record('P25b 空块提示只给聚焦的空块:失焦即收;空标题聚焦时提示画在 `## ` 之后,失焦不再露出(K-23)',
      a?.tag === 'P' && a.before.includes('/') && b?.tag === 'P' && b.before === '' && b.after === '' &&
        c?.tag === 'H2' && c.before === '' && c.after === '标题 2' && d?.tag === 'H2' && d.before === '' && d.after === '',
      JSON.stringify({ a, b, c, d }))
    await pg.close()
  }

  // P26:多块选中的**语义面**本来就由 PM 原生给了(Shift+方向键跨块扩展、整批删除、整批复制),
  // 缺的一直只是「看起来不像块选中」。这一关把「语义 + 呈现」一起钉住,免得日后有人另造一套
  // 块选区 store —— 单实例里没有块 id 可挂,那条路是死的。
  {
    const seed = '段甲。\n\n段乙。\n\n段丙。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    // ⚠️ 选区走 probe 精确设:mac 的 Home/End 是文档级不是行级(Shift+End 会一路选到文末,
    //    实测 3 块全中)。本关验的是「文字选区按字符呈现 + 顶满整块时整批删除」。
    await pg.evaluate(() => {
      const v = window.__upage.probe.view()
      const a = 1 // 首段内容起点
      const b = v.state.doc.child(0).nodeSize + v.state.doc.child(1).nodeSize - 1 // 第二段内容末尾
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, a, b)))
      v.focus()
    })
    await pg.waitForTimeout(200)
    const a26 = await pg.evaluate((s) => ({
      marked: document.querySelectorAll(`${s} .amx-block-selected`).length,
      flag: document.querySelector(s)?.getAttribute('data-blocksel'),
    }), PM)
    await pg.keyboard.press('Backspace')
    await pg.waitForTimeout(200)
    const b26 = await pg.evaluate((s) => ({
      text: document.querySelector(s).textContent,
      marked: document.querySelectorAll(`${s} .amx-block-selected`).length,
    }), PM)
    record(
      'P26 跨块文字选区不整块着色,顶满整块仍整批删除',
      a26.marked === 0 && !a26.flag && !b26.text.includes('段甲') && !b26.text.includes('段乙') &&
        b26.text.includes('段丙') && b26.marked === 0,
      JSON.stringify({ a26, b26 }),
    )
    await pg.close()
  }

  // P27:行内格式键位补齐(AFFiNE 六件套)。commonmark/gfm 预设只给了 Mod-B / Mod-I / Mod-E
  // 与 Mod-Alt-X;下划线(自有 mark)、Mod-Shift-S 删除线、Mod-K 链接三个一直没有键位。
  {
    const seed = '一段可选的文字。\n'
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    const selectAll = () => pg.evaluate(() => {
      const v = window.__upage.probe.view()
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 1, v.state.doc.child(0).nodeSize - 1)))
      v.focus()
    })
    await selectAll()
    await pg.keyboard.press('Meta+u')
    await pg.waitForTimeout(200)
    await selectAll()
    await pg.keyboard.press('Meta+Shift+s')
    await pg.waitForTimeout(200)
    const a27 = await pg.evaluate((s) => {
      const el = document.querySelector(s)
      return { u: !!el.querySelector('u'), del: !!(el.querySelector('del') || el.querySelector('s')) }
    }, PM)
    record('P27 Mod-U 下划线 + Mod-Shift-S 删除线', a27.u && a27.del, JSON.stringify(a27))
    await pg.close()
  }

  // P28:完整性批评者查出来的三条真缺口(2026-08-14):
  //  a 全角【【 → 半角 [[(AFFiNE 触发键表就含 '【【';中文输入法下打 `[` 得先切英文键盘)
  //  b 标题栏 IME 守卫(拼音选词的 Enter 会当场跳进正文、候选词也丢了;正文侧由 PM 自己挡)
  //  c 标题栏吞 Tab(与 blockLayer「编辑器内按 Tab 绝不把焦点放走」同口径,标题此前漏了)
  {
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent('首段。\n')}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(400)
    await pg.evaluate((s) => {
      const v = window.__upage.probe.view()
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, v.state.doc.child(0).nodeSize - 1)))
      v.focus()
      void s
    }, PM)
    await pg.waitForTimeout(150)
    await pg.keyboard.type('【【')
    await pg.waitForTimeout(250)
    const a28 = await pg.evaluate((s) => ({
      text: document.querySelector(s).textContent,
      full: document.querySelector(s).textContent.includes('【【'),
    }), PM)
    // b/c:标题栏。IME 组合中的 Enter 用真 composition 事件模拟。
    const title = '.amx-title-input'
    await pg.click(title)
    await pg.waitForTimeout(150)
    // ⚠️ 合成 KeyboardEvent 的 isComposing 到不了 React(实测:合成 Enter 仍被 handler 当普通 Enter),
    //    必须用 CDP 起一次**真**输入法组合,再发真 Enter —— 这才是用户拼音选词走的那条路。
    const cdp = await pg.context().newCDPSession(pg)
    await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
    await pg.keyboard.press('Enter')
    await pg.waitForTimeout(250)
    const b28a = await pg.evaluate((sel) => document.activeElement === document.querySelector(sel), title)
    // 负对照不在这里做:「不在组合中的 Enter 要跳进正文」由 **P12a** 覆盖(同一套件里已绿)。
    // 想在本关内联负对照就得先把组合真正提交掉 —— imeSetComposition('') 不结束组合,
    // 第二发 Enter 照样被守卫吞掉,量到的是仪器自己没收尾,不是行为错(实测两次)。
    const c28 = await pg.evaluate((sel) => {
      const el = document.querySelector(sel)
      el.focus()
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      el.dispatchEvent(ev)
      return { prevented: ev.defaultPrevented }
    }, title)
    record(
      'P28 全角【【→[[ + 标题栏 IME 守卫(真 CDP 组合;负对照见 P12a) + 标题栏吞 Tab',
      a28.text.includes('[[') && !a28.full && b28a && c28.prevented,
      JSON.stringify({ a28, b28a, c28 }),
    )
    await pg.close()
  }

  // ── K 系列:unified 键盘层(unified/keyboard.ts,2026-08-14 逐条对齐 AFFiNE doc 模式)。────
  // 这四族此前全部落回 PM base + commonmark preset 的通用实现,不认我们的折叠/callout/嵌入。
  {
    const openSeed = async (seed) => {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(400)
      return pg
    }
    /** 光标精确落到某段文字的首/末(probe 直设:mac 的 Home/End 是文档级,键盘定位不可靠)。 */
    const caret = (pg, text, where) => pg.evaluate(({ t, w }) => {
      const v = window.__upage.probe.view()
      let at = -1
      v.state.doc.descendants((n, pos) => {
        if (n.isTextblock && n.textContent === t) at = w === 'start' ? pos + 1 : pos + 1 + n.content.size
      })
      if (at < 0) return false
      v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
      v.focus()
      return true
    }, { t: text, w: where })
    const tops = (pg) => pg.evaluate((s) => {
      const v = window.__upage.probe.view()
      const out = []
      v.state.doc.forEach((n) => out.push(`${n.type.name}:${n.textContent.slice(0, 12)}`))
      void s
      return out.join(' | ')
    }, PM)

    // K1 折叠态标题回车:先展开,再把新正文紧跟标题插入(此前会插进 display:none,看着像没反应)
    {
      const pg = await openSeed('# 甲\n\n甲一。\n\n甲二。\n\n# 乙\n')
      const h = await pg.evaluate((s) => {
        const el = document.querySelector(`${s} h1`)
        const r = el.getBoundingClientRect()
        return { x: r.left + 15, y: r.top + r.height / 2 }
      }, PM)
      await pg.mouse.move(h.x, h.y, { steps: 3 })
      await pg.waitForTimeout(300)
      await pg.evaluate(() => document.querySelector('.unified-gutter .block-fold')?.click())
      await pg.waitForTimeout(300)
      await caret(pg, '甲', 'end')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Enter')
      await pg.keyboard.type('新正文')
      await pg.waitForTimeout(250)
      const k1 = await pg.evaluate((s) => {
        const pm = document.querySelector(s)
        const el = [...pm.querySelectorAll('h1,h2,p')].find((x) => x.textContent.includes('新正文'))
        return { order: [...pm.children].map((c) => c.textContent.replace(/^#+\s*/, '').slice(0, 4)).join('|'), visible: el ? el.offsetParent !== null : false, tag: el?.tagName ?? '' }
      }, PM)
      record('K1 折叠态标题回车:先展开,新正文紧跟标题且可见',
        k1.visible && k1.tag === 'P' && k1.order.indexOf('新正') < k1.order.indexOf('甲一'),
        JSON.stringify(k1))
      await pg.close()
    }

    // K2 行首退格删掉渲染边界空格后立即还原字面源码，之后 Backspace 继续删普通字符。
    {
      const pg = await openSeed('段前。\n\n## 标题文字\n')
      await caret(pg, '标题文字', 'start')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Backspace')
      await pg.waitForTimeout(150)
      const a = await tops(pg)
      const aState = await pg.evaluate(() => ({
        source: document.querySelectorAll('.amx-struct-prefix').length,
        offset: getSelection()?.anchorOffset ?? null,
        active: document.activeElement?.classList.contains('ProseMirror'),
      }))
      await pg.keyboard.press('Backspace')
      await pg.waitForTimeout(200)
      const b = await tops(pg)
      const bOffset = await pg.evaluate(() => getSelection()?.anchorOffset ?? null)
      record('K2 标题边界退格立即还原字面源码，后续逐字符删除',
        a === 'paragraph:段前。 | paragraph:##标题文字' && aState.source === 0
          && aState.offset === 2 && aState.active && b === 'paragraph:段前。 | paragraph:#标题文字'
          && bOffset === 1,
        JSON.stringify({ a, aState, b, bOffset }))
      await pg.close()
    }

    // K3 列表项删掉边界空格后立即变成字面 `-`；Mod+退格仍保留原来的列表反缩进快捷语义。
    {
      const pg = await openSeed('引子。\n\n- 甲项\n- 乙项\n')
      await caret(pg, '乙项', 'start')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Backspace')
      await pg.waitForTimeout(120)
      const source = await pg.evaluate(() => ({
        inputs: document.querySelectorAll('.amx-struct-prefix').length,
        offset: getSelection()?.anchorOffset ?? null,
        active: document.activeElement?.classList.contains('ProseMirror'),
      }))
      const k3 = await tops(pg)
      record('K3 列表边界退格立即就地转为字面普通文本',
        source.inputs === 0 && source.offset === 1 && source.active
          && k3 === 'paragraph:引子。 | bullet_list:甲项 | paragraph:-乙项', JSON.stringify({ source, k3 }))
      await pg.close()
    }
    {
      const pg = await openSeed('- 甲\n    - 乙\n        - 丙\n')
      await caret(pg, '丙', 'start')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Meta+Backspace')
      await pg.waitForTimeout(300)
      const k10 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const $f = v.state.selection.$from
        let d = 0
        for (let i = $f.depth; i >= 1; i--) if ($f.node(i).type.name === 'list_item') d++
        return { nest: d, text: $f.parent.textContent }
      })
      record('K10 Mod+退格:列表项一路反缩进到顶层(仍在列表里,不脱出)', k10.nest === 1 && k10.text === '丙', JSON.stringify(k10))
      await pg.close()
    }

    // K4 前一块是代码块时行首退格 = 只选中它;K6 块尾 Delete 撞代码块 = 只选中
    {
      const pg = await openSeed('```js\ncode\n```\n\n后段。\n')
      await caret(pg, '后段。', 'start')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Backspace')
      await pg.waitForTimeout(200)
      const k4 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const sel = v.state.selection
        return { node: sel.node?.type?.name ?? '', tops: v.state.doc.childCount }
      })
      record('K4 行首退格撞代码块:只选中不合并', k4.node === 'code_block' && k4.tops === 2, JSON.stringify(k4))
      await pg.close()
    }
    {
      const pg = await openSeed('前段。\n\n```js\ncode\n```\n')
      await caret(pg, '前段。', 'end')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Delete')
      await pg.waitForTimeout(200)
      const k6 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        return { node: v.state.selection.node?.type?.name ?? '', tops: v.state.doc.childCount }
      })
      record('K6 块尾 Delete 撞代码块:只选中不吞', k6.node === 'code_block' && k6.tops === 2, JSON.stringify(k6))
      await pg.close()
    }

    // K5 空列表项回车:列表就地拆两半、空段落留在原位(base 会把它丢到整个列表之后)
    {
      const pg = await openSeed('- 甲\n- \n- 丙\n')
      await caret(pg, '', 'end')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Enter')
      await pg.keyboard.type('中段')
      await pg.waitForTimeout(250)
      const k5 = await tops(pg)
      record('K5 中间空列表项回车:原地变段落,列表就地拆两半',
        k5 === 'bullet_list:甲 | paragraph:中段 | bullet_list:丙', k5)
      await pg.close()
    }

    // K8 Mod+Enter:段落里不拆分文本,直接在下方新建空段并聚焦
    {
      const pg = await openSeed('一二三四。\n')
      await caret(pg, '一二三四。', 'start')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 3)))
      })
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Meta+Enter')
      await pg.keyboard.type('新段')
      await pg.waitForTimeout(250)
      const k8 = await tops(pg)
      record('K8 Mod+Enter:不拆文本,下方新建空段', k8 === 'paragraph:一二三四。 | paragraph:新段', k8)
      await pg.close()
    }

    // K9 回车也跑一遍块级 markdown 规则(`#` 后直接回车 = 变标题,不换行)
    {
      const pg = await openSeed('起始段。\n')
      await caret(pg, '起始段。', 'end')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Enter')
      await pg.keyboard.type('##')
      await pg.keyboard.press('Enter')
      await pg.keyboard.type('二级')
      await pg.waitForTimeout(250)
      const k9 = await tops(pg)
      record('K9 `##` 后回车 = 变标题不换行', k9 === 'paragraph:起始段。 | heading:二级', k9)
      await pg.close()
    }

    // K11 引用/callout 的 `> ` 也遵循同一套边界语义：空格一删，立即脱壳成字面 `>`。
    {
      const pg = await openSeed('> [!note] 标记\n>\n> 次段内容\n')
      await caret(pg, '次段内容', 'start')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Backspace')
      await pg.waitForTimeout(120)
      const aState = await pg.evaluate(() => ({
        source: document.querySelectorAll('.amx-struct-prefix').length,
        offset: getSelection()?.anchorOffset ?? null,
        active: document.activeElement?.classList.contains('ProseMirror'),
      }))
      const a = await tops(pg)
      await caret(pg, '[!note] 标记', 'start')
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Backspace')
      await pg.waitForTimeout(120)
      const b = await pg.evaluate(() => ({
        source: document.querySelectorAll('.amx-struct-prefix').length,
        top: window.__upage.probe.view().state.doc.firstChild?.type?.name ?? '',
        offset: getSelection()?.anchorOffset ?? null,
      }))
      const afterFirst = await tops(pg)
      record('K11 引用边界退格立即还原字面文本，非首段与首段均不困在 input',
        aState.source === 0 && aState.offset === 1 && aState.active
          && a === 'blockquote:[!note] 标记 | paragraph:>次段内容'
          && b.source === 0 && b.top === 'paragraph' && b.offset === 1
          && afterFirst === 'paragraph:>[!note] 标记 | paragraph:>次段内容',
        JSON.stringify({ aState, a, b, afterFirst }))
      await pg.close()
    }

    // K12 有子项的列表项行中回车:右半成为第一个子项(AFFiNE 语义,PM 默认是同级兄弟)
    {
      const pg = await openSeed('- 甲乙\n    - 子项\n')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        let at = -1
        v.state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent === '甲乙') at = pos + 2 })
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
        v.focus()
      })
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Enter')
      await pg.waitForTimeout(250)
      const k12 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const list = v.state.doc.child(0)
        const item = list.child(0)
        const kids = []
        if (item.childCount > 1) item.child(1).forEach((li) => kids.push(li.textContent))
        return { head: item.child(0).textContent, kids: kids.join('|'), items: list.childCount }
      })
      record('K12 有子项的列表项行中回车:右半降为**第一个**子项(与原有子项并列,不是套在它上面)',
        k12.head === '甲' && k12.kids === '乙|子项' && k12.items === 1, JSON.stringify(k12))
      await pg.close()
    }
  }

  // ── M 系列:块选区能力(仍是原生跨块 TextSelection 模型,不另造选区对象)。────────────
  {
    const openSeed = async (seed) => {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(400)
      return pg
    }
    // M1 空白处框选:从正文两侧留白按下拖过两块 → 整块淡底 + 原生跨块选区
    {
      const pg = await openSeed('段甲。\n\n段乙。\n\n段丙。\n')
      const box = await pg.evaluate((s) => {
        const pm = document.querySelector(s)
        const ps = [...pm.querySelectorAll(':scope > p')]
        const r1 = ps[0].getBoundingClientRect(), r2 = ps[1].getBoundingClientRect()
        const host = pm.getBoundingClientRect()
        return { x1: host.left + 2, y1: r1.top - 4, x2: r2.right - 4, y2: r2.bottom - 2 }
      }, PM)
      await pg.mouse.move(box.x1, box.y1)
      await pg.mouse.down()
      await pg.mouse.move(box.x2, box.y2, { steps: 10 })
      await pg.waitForTimeout(120)
      const during = await pg.evaluate(() => !!document.querySelector('.amx-marquee'))
      await pg.mouse.up()
      await pg.waitForTimeout(200)
      const m1 = await pg.evaluate((s) => ({
        marked: document.querySelectorAll(`${s} .amx-block-selected`).length,
        texts: [...document.querySelectorAll(`${s} .amx-block-selected`)].map((e) => e.textContent).join('|'),
        gone: !document.querySelector('.amx-marquee'),
      }), PM)
      record('M1 空白处框选多块:框在、松手即收、选中两块', during && m1.marked === 2 && m1.texts === '段甲。|段乙。' && m1.gone,
        JSON.stringify({ during, ...m1 }))
      await pg.close()
    }
    // M2 多块选中时从 ⠿ 拖起:整批搬走(此前 mousedown 会把多选收敛成单块)
    {
      const pg = await openSeed('段甲。\n\n段乙。\n\n段丙。\n')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const b = v.state.doc.child(0).nodeSize + v.state.doc.child(1).nodeSize - 1
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 1, b)))
        v.focus()
      })
      const c = await pg.evaluate((s) => {
        const p = [...document.querySelector(s).querySelectorAll(':scope > p')][0]
        const r = p.getBoundingClientRect()
        return { x: r.left + 20, y: r.top + r.height / 2 }
      }, PM)
      await pg.mouse.move(c.x, c.y)
      await pg.waitForTimeout(350)
      const m2 = await pg.evaluate((s) => {
        const md = (type, el, init) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }))
        const gutter = document.querySelector('.unified-gutter')
        if (gutter?.dataset.show !== 'true') return { err: 'no gutter' }
        gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        const v = window.__upage.probe.view()
        // 判据要看「还是不是跨块文字选区」——NodeSelection 也满足 from!==to,拿它当判据会假绿
        const sel0 = v.state.selection
        const kept = sel0.constructor.name.includes('TextSelection') && !sel0.$from.sameParent(sel0.$to)
        const dt = new DataTransfer()
        md('dragstart', gutter, { dataTransfer: dt })
        const dragging = !!v.dragging
        const pm = document.querySelector(s)
        const target = [...pm.querySelectorAll(':scope > p')].find((x) => x.textContent === '段丙。')
        const r = target.getBoundingClientRect()
        const at = { clientX: r.left + r.width / 2, clientY: r.bottom - 2, dataTransfer: dt }
        md('dragover', pm, at); md('dragover', pm, at); md('drop', pm, at); md('dragend', gutter, { dataTransfer: dt })
        return { kept, dragging }
      }, PM)
      await pg.waitForTimeout(400)
      const order = await pg.evaluate((s) => [...document.querySelector(s).querySelectorAll(':scope > p')].map((x) => x.textContent).join('|'), PM)
      record('M2 多块选中从 ⠿ 拖起 = 整批搬走(选区不被收敛成单块)',
        !m2.err && m2.kept && m2.dragging && order === '段丙。|段甲。|段乙。', JSON.stringify({ m2, order }))
      await pg.close()
    }
    // M3 跨块选区下 ⠿ 菜单的复制/删除作用于整批
    {
      const pg = await openSeed('段甲。\n\n段乙。\n\n段丙。\n')
      const selectTwo = () => pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const b = v.state.doc.child(0).nodeSize + v.state.doc.child(1).nodeSize - 1
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 1, b)))
        v.focus()
      })
      await selectTwo()
      const openMenu = async () => {
        const c = await pg.evaluate((s) => {
          const p = [...document.querySelector(s).querySelectorAll(':scope > p')][0]
          const r = p.getBoundingClientRect()
          return { x: r.left + 20, y: r.top + r.height / 2 }
        }, PM)
        await pg.mouse.move(c.x, c.y)
        await pg.waitForTimeout(350)
        await pg.evaluate(() => document.querySelector('.unified-gutter .drag-handle')?.click())
        await pg.waitForTimeout(250)
      }
      await openMenu()
      await pg.evaluate(() => {
        const btn = [...document.querySelectorAll('.unified-block-menu button')].find((b) => b.textContent.includes('复制块'))
        btn?.click()
      })
      await pg.waitForTimeout(300)
      const dup = await pg.evaluate((s) => [...document.querySelector(s).querySelectorAll(':scope > p')].map((x) => x.textContent).join('|'), PM)
      record('M3 跨块选区 ⠿ 菜单「复制块」= 整批复制', dup === '段甲。|段乙。|段甲。|段乙。|段丙。', dup)
      await pg.close()
    }
    // M4 跨块选区整体 Tab 缩进 / Shift-Tab 还原
    {
      const pg = await openSeed('- 甲\n- 乙\n- 丙\n')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const list = v.state.doc.child(0)
        // 选第 2、3 项:首项永远无处可缩(PM 结构使然,不是 bug),拿它当被试是仪器设计错误
        const a = 1 + list.child(0).nodeSize + 2
        const b = 1 + list.child(0).nodeSize + list.child(1).nodeSize + list.child(2).nodeSize - 1
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, a, b)))
        v.focus()
      })
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Tab')
      await pg.waitForTimeout(200)
      const m4 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const out = []
        v.state.doc.descendants((n, pos) => { if (n.type.name === 'list_item') out.push(`${v.state.doc.resolve(pos).depth}:${n.textContent.slice(0, 2)}`) })
        return out.join('|')
      })
      record('M4 跨块选区整体 Tab:被覆盖的列表项一起缩进', /1:甲/.test(m4) && /3:乙/.test(m4) && /3:丙/.test(m4), m4)
      await pg.close()
    }
    // M5 转换矩阵补项:代码块(跨块选区 = 合并成一个)与公式
    {
      const pg = await openSeed('第一句。\n\n第二句。\n')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const b = v.state.doc.child(0).nodeSize + v.state.doc.child(1).nodeSize - 1
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 1, b)))
        v.focus()
      })
      await pg.waitForTimeout(300)
      const opened = await pg.evaluate(() => {
        const btn = document.querySelector('.inline-toolbar .itb-turn')
        btn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        return !!btn
      })
      await pg.waitForTimeout(250)
      const picked = await pg.evaluate(() => {
        const it = [...document.querySelectorAll('.itb-panel .itb-menu-item')].find((b) => b.textContent.trim() === '代码块')
        if (!it) return false
        it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        return true
      })
      await pg.waitForTimeout(350)
      const m5 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        return { tops: v.state.doc.childCount, first: v.state.doc.child(0).type.name, text: v.state.doc.child(0).textContent }
      })
      record('M5 跨块选区转代码块 = 合并成一个(不是逐块转)',
        opened && picked && m5.tops === 1 && m5.first === 'code_block' && m5.text.includes('第一句') && m5.text.includes('第二句'),
        JSON.stringify({ opened, picked, ...m5 }))
      await pg.close()
    }
  }

  // ── L 系列:列表项折叠(unified/listFold.ts,与标题小节折叠同一套会话态取舍)。────────
  {
    const openSeed = async (seed) => {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(400)
      return pg
    }
    const hoverLi = async (pg, text) => {
      const c = await pg.evaluate(({ s, t }) => {
        const el = [...document.querySelector(s).querySelectorAll('li')].find((x) => x.textContent.startsWith(t))
        const r = el.getBoundingClientRect()
        return { x: r.left + 12, y: r.top + 10 }
      }, { s: PM, t: text })
      await pg.mouse.move(c.x, c.y, { steps: 3 })
      await pg.waitForTimeout(320)
    }
    // L1 有子项的项才给折叠钮;折起 = 子项隐藏 + 常驻箭头 + 零写盘;再点展开还原
    {
      const pg = await openSeed('- 甲\n    - 甲一\n    - 甲二\n- 乙\n')
      await hoverLi(pg, '乙')
      const noBtn = await pg.evaluate(() => {
        const f = document.querySelector('.unified-gutter .block-fold')
        return !f || f.style.display === 'none'
      })
      await hoverLi(pg, '甲')
      const wBefore = await pg.evaluate(() => window.__upage.writes.length)
      const hasBtn = await pg.evaluate(() => {
        const f = document.querySelector('.unified-gutter .block-fold')
        if (!f || f.style.display === 'none') return false
        f.click()
        return true
      })
      await pg.waitForTimeout(1200)
      const l1 = await pg.evaluate((s) => {
        const pm = document.querySelector(s)
        const vis = (t) => {
          const el = [...pm.querySelectorAll('li')].find((x) => x.textContent.trim().startsWith(t))
          return el ? el.offsetParent !== null : null
        }
        return {
          writes: window.__upage.writes.length,
          jia1: vis('甲一'), yi: vis('乙'),
          foldedClass: !!pm.querySelector('li.amx-listitem-folded'),
          caret: !!pm.querySelector('.amx-fold-caret'),
        }
      }, PM)
      await pg.evaluate(() => {
        const c = document.querySelector('.amx-fold-caret')
        c?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      })
      await pg.waitForTimeout(300)
      const back = await pg.evaluate((s) => {
        const el = [...document.querySelector(s).querySelectorAll('li')].find((x) => x.textContent.trim().startsWith('甲一'))
        return el ? el.offsetParent !== null : null
      }, PM)
      record('L1 列表项折叠:无子项不给钮 / 折起藏子项+常驻箭头 / 零写盘 / 展开还原',
        noBtn && hasBtn && l1.writes === wBefore && l1.jia1 === false && l1.yi === true && l1.foldedClass && l1.caret && back === true,
        JSON.stringify({ noBtn, hasBtn, ...l1, back }))
      await pg.close()
    }
    // L2 折叠态回车:只拆同级兄弟,子项留在原项里(展开态那条是「右半降为第一个子项」,见 K12)
    {
      const pg = await openSeed('- 甲乙\n    - 子项\n')
      await hoverLi(pg, '甲乙')
      await pg.evaluate(() => document.querySelector('.unified-gutter .block-fold')?.click())
      await pg.waitForTimeout(300)
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        let at = -1
        v.state.doc.descendants((n, pos) => { if (n.isTextblock && n.textContent === '甲乙') at = pos + 2 })
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
        v.focus()
      })
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Enter')
      await pg.waitForTimeout(250)
      const l2 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const list = v.state.doc.child(0)
        const first = list.child(0)
        return {
          items: list.childCount,
          firstHead: first.child(0).textContent,
          firstKids: first.childCount > 1 ? first.child(1).textContent : '',
          second: list.childCount > 1 ? list.child(1).textContent : '',
        }
      })
      record('L2 折叠态列表项回车:只拆同级兄弟,子项留在原项里',
        l2.items === 2 && l2.firstHead === '甲' && l2.firstKids === '子项' && l2.second === '乙',
        JSON.stringify(l2))
      await pg.close()
    }
  }

  // ── D 系列:拖拽落点精细化 + 把手视觉。────────────────────────────────────────
  {
    const openSeed = async (seed) => {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(400)
      return pg
    }
    // D1 拖到列表项**右缘** → 变成它的子项。两条路都要成立:
    //  · 首项的把手锚在整只列表上(P7 的「首子归外壳」),这一格由 prosemirror-drop-indicator
    //    自带的缩进落点兜住;
    //  · 非首项能解析成 list_item,走本层显式的 childRef → executeMoveIntoList。
    //  判据只看**落地形状**,不查具体是哪条路画的指示线(两条路的线是两个同类名元素,查元素会看错)。
    {
      const pg = await openSeed('- 甲项\n- 乙项\n\n游离段。\n')
      const c = await pg.evaluate((s) => {
        const p = [...document.querySelector(s).querySelectorAll(':scope > p')].find((x) => x.textContent === '游离段。')
        const r = p.getBoundingClientRect()
        return { x: r.left + 20, y: r.top + r.height / 2 }
      }, PM)
      await pg.mouse.move(c.x, c.y)
      await pg.waitForTimeout(350)
      const d1 = await pg.evaluate((s) => {
        const md = (type, el, init) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }))
        const gutter = document.querySelector('.unified-gutter')
        if (gutter?.dataset.show !== 'true') return { err: 'no gutter' }
        gutter.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        const dt = new DataTransfer()
        md('dragstart', gutter, { dataTransfer: dt })
        const pm = document.querySelector(s)
        const li = [...pm.querySelectorAll('li')].find((x) => x.textContent.startsWith('乙项'))
        const r = li.getBoundingClientRect()
        const at = { clientX: r.left + 60, clientY: r.bottom - 3, dataTransfer: dt }
        md('dragover', pm, at); md('dragover', pm, at)
        md('drop', pm, at); md('dragend', gutter, { dataTransfer: dt })
        return {}
      }, PM)
      await pg.waitForTimeout(400)
      const shape = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const out = []
        v.state.doc.descendants((n, pos) => { if (n.type.name === 'list_item') out.push(`${v.state.doc.resolve(pos).depth}:${n.textContent.slice(0, 5)}`) })
        return { items: out.join('|'), tops: v.state.doc.childCount }
      })
      record('D1 拖到列表项右缘 = 放进去当子项',
        !d1.err && shape.tops === 1 && /1:乙项游离段/.test(shape.items) && /3:游离段。/.test(shape.items),
        JSON.stringify({ d1, shape }))
      await pg.close()
    }
    // D2 落回原处 = no-op(不产生空事务/空撤销步);把手按下出高亮矩形
    {
      const pg = await openSeed('段甲。\n\n段乙。\n')
      const c = await pg.evaluate((s) => {
        const p = [...document.querySelector(s).querySelectorAll(':scope > p')][0]
        const r = p.getBoundingClientRect()
        return { x: r.left + 20, y: r.top + r.height / 2 }
      }, PM)
      await pg.mouse.move(c.x, c.y)
      await pg.waitForTimeout(350)
      const pressed = await pg.evaluate((s) => {
        const gutter = document.querySelector('.unified-gutter')
        gutter?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
        const rect = document.querySelector('.unified-press-rect')
        if (!rect || rect.style.display !== 'block') return { shown: false }
        // ⚠️ 只断「display:block」是假绿(2026-08-15 Codex 评审):这框是 position:absolute,
        //    包含块=.milkdown,坐标算错会画到十万八千里外而这条断言照样绿。量真几何:
        //    它应该外扩 4px 罩住块本身。
        const el = [...document.querySelector(s).querySelectorAll(':scope > p')][0]
        const b = el.getBoundingClientRect()
        const r = rect.getBoundingClientRect()
        return { shown: true, dx: r.left - (b.left - 4), dy: r.top - (b.top - 4) }
      }, PM)
      await pg.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
      await pg.waitForTimeout(100)
      const gone = await pg.evaluate(() => {
        const rect = document.querySelector('.unified-press-rect')
        return !rect || rect.style.display === 'none'
      })
      const aligned = !!pressed.shown && Math.abs(pressed.dx) <= 2 && Math.abs(pressed.dy) <= 2
      record('D2 按下把手出外扩高亮矩形(罩住块,±2px)、松手即收', aligned && gone, JSON.stringify({ pressed, gone }))
      await pg.close()
    }
    // D2b/D2c 长块 hover 抓手必须内嵌块高，上下各留 8px。修前高度虽然取了 blockH-16，
    // 但仍围绕“首行 24px 槽”居中生长：多行引用会伸到块上方，图片越高偏得越离谱。
    const grownHandle = async (pg, targetSelector) => {
      const at = await pg.evaluate((sel) => {
        const el = document.querySelector(sel)
        const r = el?.getBoundingClientRect()
        return r ? { x: r.left + Math.min(40, r.width / 2), y: r.top + 12 } : null
      }, targetSelector)
      if (!at) return null
      await pg.mouse.move(at.x, at.y)
      await pg.waitForTimeout(260)
      const handleAt = await pg.evaluate(() => {
        const h = document.querySelector('.unified-gutter .drag-handle')?.getBoundingClientRect()
        return h ? { x: h.left + h.width / 2, y: h.top + 12 } : null
      })
      if (!handleAt) return null
      await pg.mouse.move(handleAt.x, handleAt.y)
      await pg.waitForTimeout(360)
      return pg.evaluate((sel) => {
        const target = document.querySelector(sel)
        const handle = document.querySelector('.unified-gutter .drag-handle')
        if (!target || !handle) return null
        const t = target.getBoundingClientRect()
        const h = handle.getBoundingClientRect()
        return { top: h.top - (t.top + 8), bottom: h.bottom - (t.bottom - 8), hh: h.height, th: t.height }
      }, targetSelector)
    }
    {
      const pg = await openSeed('> 第一行。\n>\n> 第二行。\n>\n> 第三行。\n')
      const g = await grownHandle(pg, `${PM} > blockquote`)
      record('D2b 多行块 hover 长抓手：上下沿均缩进 8px，不再围绕首行向上漂',
        !!g && g.hh > 24 && Math.abs(g.top) <= 2 && Math.abs(g.bottom) <= 2, JSON.stringify(g))
      await pg.close()
    }
    {
      const pg = await openSeed('![](https://example.test/tall.png)\n')
      await pg.evaluate((s) => {
        const img = document.querySelector(`${s} img`)
        if (img) Object.assign(img.style, { display: 'block', width: '320px', height: '240px' })
      }, PM)
      await pg.waitForTimeout(100)
      // 量 .wiki-inline-img-wrap 而不是裸 img:blockLayer.visualBlockElement 的几何契约就是这个
      // 「可见媒体盒」,而 img 自带 0.4em(=6px)上下 margin(styles.css 的 `.ProseMirror img`),
      // margin 算在 wrap 盒内 —— 拿裸 img 量会平白差出 6px,把「缩进 8px」误报成 2px。
      const g = await grownHandle(pg, `${PM} .wiki-inline-img-wrap`)
      record('D2c 图片块 hover 长抓手：上下沿均缩进 8px，高图片不再把抓手顶出块外',
        !!g && g.hh > 200 && Math.abs(g.top) <= 2 && Math.abs(g.bottom) <= 2, JSON.stringify(g))
      await pg.close()
    }
  }

  // ── C 系列(代码块工具条):行号 / 折叠八行 / 语言最近使用。三者都是会话视图态,零写盘。──
  {
    const pg = await browser.newPage({ locale: 'zh-CN' })
    pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
    const code = '```js\n' + Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n') + '\n```\n'
    await pg.goto(`${URL}?upage&useed=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector(PM, { timeout: 20000 })
    await pg.waitForTimeout(500)
    const wBefore = await pg.evaluate(() => window.__upage.writes.length)
    const click = (label) => pg.evaluate((t) => {
      const b = [...document.querySelectorAll('.amx-code-tools .amx-code-btn')].find((x) => x.textContent.trim() === t)
      if (!b || b.disabled) return false
      b.click()
      return true
    }, label)
    const okNo = await click('行号')
    await pg.waitForTimeout(300)
    const a = await pg.evaluate((s) => {
      const pre = document.querySelector(`${s} .amx-code`)
      const nums = pre?.querySelector('.amx-code-nums')
      return { cls: !!pre?.classList.contains('amx-code-lineno'), lines: nums ? nums.textContent.split('\n').length : 0, last: nums ? nums.textContent.trim().split('\n').pop() : '' }
    }, PM)
    const okFold = await click('折叠')
    await pg.waitForTimeout(300)
    const b = await pg.evaluate((s) => {
      const pre = document.querySelector(`${s} .amx-code`)
      return { collapsed: !!pre?.classList.contains('amx-code-collapsed'), clipped: pre ? pre.scrollHeight > pre.clientHeight + 4 : false }
    }, PM)
    const writes = await pg.evaluate(() => window.__upage.writes.length)
    record('C1 代码块:行号真画出来 / 折叠限高八行 / 全程零写盘',
      okNo && a.cls && a.lines === 12 && a.last === '12' && okFold && b.collapsed && b.clipped && writes === wBefore,
      JSON.stringify({ okNo, ...a, okFold, ...b, writes, wBefore }))
    await pg.close()
  }

  // ── U 系列:粘贴/上传/零散项。────────────────────────────────────────────────
  {
    const openSeed = async (seed) => {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(400)
      return pg
    }
    // U1 ```lang + 空格 → 代码块(带语言),行尾余文切成下面一个新段落(不被吞)
    {
      const pg = await openSeed('起始。\n')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, v.state.doc.child(0).nodeSize - 1)))
        v.focus()
      })
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Enter')
      await pg.keyboard.type('```py')
      await pg.keyboard.type('尾巴')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const $f = v.state.selection.$from
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, $f.start() + 5)))
      })
      await pg.keyboard.press(' ')
      await pg.waitForTimeout(300)
      const u1 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const kinds = []
        v.state.doc.forEach((n) => kinds.push(`${n.type.name}:${n.attrs?.language ?? ''}:${n.textContent}`))
        return kinds.join(' | ')
      })
      const kinds = u1.split(' | ')
      record('U1 ```py + 空格 = 代码块(带语言)+ 行尾余文切成下一段',
        kinds.some((k) => k.startsWith('code_block:py:') && !k.includes('尾巴')) &&
          kinds.some((k) => k.startsWith('paragraph:') && k.includes('尾巴')), u1)
      await pg.close()
    }
    // U2 上传占位块:先出现「上传中」,拿到路径后替换成嵌入行(桩:立即 resolve)
    {
      const pg = await openSeed('正文。\n')
      await pg.evaluate(() => {
        window.amadeus.saveAttachment = () => new Promise((res) => setTimeout(() =>
          res({ pageRel: 'attachments/A.pdf', base: 'A.pdf', abs: '/tmp/A.pdf' }), 250))
      })
      await pg.evaluate((s) => {
        const dt = new DataTransfer()
        dt.items.add(new File([new Uint8Array([1, 2, 3])], 'A.pdf', { type: 'application/pdf' }))
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(ev, 'clipboardData', { value: dt })
        document.querySelector(s).dispatchEvent(ev)
      }, PM)
      await pg.waitForTimeout(120)
      const during = await pg.evaluate((s) => document.querySelector(s).textContent.includes('上传中'), PM)
      await pg.waitForTimeout(600)
      const after = await pg.evaluate((s) => {
        const t = document.querySelector(s).textContent
        return { placeholder: t.includes('上传中'), embedded: /A\.pdf/.test(t) }
      }, PM)
      record('U2 上传先出占位块,拿到路径后替换成嵌入行', during && !after.placeholder && after.embedded,
        JSON.stringify({ during, ...after }))
      await pg.close()
    }
    // U3 双击图片开大图;Esc 关。
    // ⚠️ 必须给坏图一个盒子 + **真鼠标双击**:handler(UnifiedPage onDbl)按 elementFromPoint
    // 取命中(2026-08-28 起,防两击间 DOM 重建把 target 派到公共祖先)——example.test 加载失败
    // 的 img 是 0×0,合成 dispatchEvent 不带坐标打不中,真手势也无从点起,shown 恒 false。
    {
      const pg = await openSeed('![](https://example.test/x.png)\n')
      await pg.waitForTimeout(300)
      const opened = await pg.evaluate((s) => {
        const img = document.querySelector(`${s} img`)
        if (!img) return 'no-img'
        Object.assign(img.style, { display: 'block', width: '320px', height: '240px' })
        return 'ok'
      }, PM)
      await pg.waitForTimeout(100)
      // 最多两趟(每趟现取坐标):首击会触发图片选中/widget 重建,负载高时布局未稳、二击偶发落空
      // (全量跑实测 1 红)。第二趟等于「已选中的图上再双击」—— 也是真实用户流,两趟全空才算红。
      let shown = false
      for (let att = 0; att < 2 && !shown && opened === 'ok'; att++) {
        const c = await pg.evaluate((s) => {
          const r = document.querySelector(`${s} img`).getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }, PM)
        await pg.mouse.dblclick(c.x, c.y)
        await pg.waitForTimeout(250)
        shown = await pg.evaluate(() => !!document.querySelector('.amx-lightbox img'))
      }
      await pg.keyboard.press('Escape')
      await pg.waitForTimeout(200)
      const closed = await pg.evaluate(() => !document.querySelector('.amx-lightbox'))
      record('U3 双击图片开大图 + Esc 关', opened === 'ok' && shown && closed, JSON.stringify({ opened, shown, closed }))
      await pg.close()
    }
    // U4 点正文**右侧**空白 = 光标送到该行行尾(此前什么都不发生)。
    // ⚠️ 左侧那条空白在我们的布局里整条是 ⠿ 把手泳道(hover 即出,里面还有 ＋ 按钮),
    //    点它是「插入新段」而不是「点空白」—— 这是布局决定的天花板,不是漏做:AFFiNE 靠 96px
    //    侧边留白把手感和把手分开,我们的把手就贴在正文左缘外侧。故本关只验右侧。
    {
      const pg = await openSeed('一二三四五。\n\n第二段。\n')
      const box = await pg.evaluate((s) => {
        const pm = document.querySelector(s)
        const p = [...pm.querySelectorAll(':scope > p')][0]
        const r = p.getBoundingClientRect()
        const host = pm.getBoundingClientRect()
        return { rightX: host.right + 12, y: r.top + r.height / 2 }
      }, PM)
      // 先把光标放到第二段,证明右侧点击是**移动**光标而不是恰好没动
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, v.state.doc.content.size - 1)))
        v.focus()
      })
      await pg.waitForTimeout(150)
      await pg.mouse.click(box.rightX, box.y)
      await pg.waitForTimeout(250)
      const u4 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const $f = v.state.selection.$from
        return { off: $f.parentOffset, size: $f.parent.content.size, text: $f.parent.textContent, tops: v.state.doc.childCount }
      })
      record('U4 点正文右侧空白 → 光标落该行行尾(不新增块)',
        u4.text === '一二三四五。' && u4.off === u4.size && u4.tops === 2, JSON.stringify(u4))
      await pg.close()
    }
  }

  // ── N 系列:行内层(链接卡片 / 全覆盖激活态 / 符号键包裹)。──────────────────────
  {
    const openSeed = async (seed) => {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(400)
      return pg
    }
    // N1 链接悬停卡片:500ms 才出、移开 250ms 才收;「移除链接」留文字
    {
      const pg = await openSeed('看看 [官网](https://example.com/a) 这个。\n')
      const box = await pg.evaluate((s) => {
        const a = document.querySelector(`${s} a[href]`)
        const r = a.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }, PM)
      await pg.mouse.move(box.x, box.y)
      await pg.waitForTimeout(200)
      const early = await pg.evaluate(() => !!document.querySelector('.amx-linkcard'))
      await pg.waitForTimeout(500)
      const shown = await pg.evaluate(() => {
        const c = document.querySelector('.amx-linkcard')
        return { open: !!c, host: c?.querySelector('.amx-linkcard-host')?.textContent ?? '' }
      })
      const removed = await pg.evaluate(() => {
        const b = [...document.querySelectorAll('.amx-linkcard button')].find((x) => x.textContent === '移除链接')
        if (!b) return false
        b.click()
        return true
      })
      await pg.waitForTimeout(300)
      const after = await pg.evaluate((s) => ({
        links: document.querySelectorAll(`${s} a[href]`).length,
        text: document.querySelector(s).textContent,
      }), PM)
      record('N1 链接卡片:500ms 才出 + 主机名 + 移除链接留文字',
        !early && shown.open && shown.host === 'example.com' && removed && after.links === 0 && after.text.includes('官网'),
        JSON.stringify({ early, ...shown, removed, ...after }))
      await pg.close()
    }
    // N2 行内格式按钮的**全覆盖**激活判定:半句加粗时不点亮
    {
      const pg = await openSeed('**粗的**加普通\n')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 1, v.state.doc.child(0).nodeSize - 1)))
        v.focus()
      })
      await pg.waitForTimeout(300)
      const half = await pg.evaluate(() => {
        const b = document.querySelector('.inline-toolbar [data-act="bold"]')
        return b ? b.className.includes('on') : null
      })
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        // 「粗的」= 2 个字 → 加粗片段正好是 [1,3);拿 1..4 会多吃一个普通字,那是半覆盖
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 1, 3)))
        v.focus()
      })
      await pg.waitForTimeout(300)
      const full = await pg.evaluate(() => {
        const b = document.querySelector('.inline-toolbar [data-act="bold"]')
        return b ? b.className.includes('on') : null
      })
      record('N2 加粗按钮:半覆盖不点亮 / 全覆盖才点亮', half === false && full === true, JSON.stringify({ half, full }))
      await pg.close()
    }
    // N3 有选区时按成对符号 = 包裹而不是替换
    {
      const pg = await openSeed('关键词在这里。\n')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, 1, 4)))
        v.focus()
      })
      await pg.waitForTimeout(150)
      await pg.keyboard.type('(')
      await pg.waitForTimeout(200)
      const n3 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const sel = v.state.selection
        return { text: v.state.doc.child(0).textContent, selText: v.state.doc.textBetween(sel.from, sel.to, '') }
      })
      record('N3 有选区按 ( = 包裹选中文字并保持选中', n3.text === '(关键词)在这里。' && n3.selText === '关键词', JSON.stringify(n3))
      await pg.close()
    }
  }

  // ── R 系列:Opus 终审查出的缺陷回归关(每条都对应一个实测触发路径)。────────────────
  {
    const openSeed = async (seed) => {
      const pg = await browser.newPage({ locale: 'zh-CN' })
      pg.on('pageerror', (e) => console.log('[pageerror]', e.message))
      await pg.goto(`${URL}?upage&useed=${encodeURIComponent(seed)}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector(PM, { timeout: 20000 })
      await pg.waitForTimeout(400)
      return pg
    }
    // R1(P0)表格空单元格行首退格:**不许**把整只表格删掉。
    // 病因:顶层块深度(table)≠ 光标所在文本块深度(cell 内的段落),旧代码按顶层深度算删除范围。
    {
      const pg = await openSeed('```js\ncode\n```\n\n| 甲 | 乙 |\n| --- | --- |\n|  |  |\n')
      const ok = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        let at = -1
        v.state.doc.descendants((n, pos) => {
          if (at < 0 && n.isTextblock && n.textContent === '' && v.state.doc.resolve(pos).depth >= 3) at = pos + 1
        })
        if (at < 0) return false
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
        v.focus()
        return true
      })
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Backspace')
      await pg.waitForTimeout(250)
      const r1 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const kinds = []
        v.state.doc.forEach((n) => kinds.push(n.type.name))
        return kinds.join('|')
      })
      record('R1 表格空单元格行首退格不删整只表格(P0 回归)', ok && /table/.test(r1), JSON.stringify({ ok, r1 }))
      await pg.close()
    }
    // R2 折叠顺序 ≠ 文档顺序时,折叠标题上回车的新正文仍紧跟该标题(K1 同款),
    // 不误跳到先折的乙标题下面。
    {
      const pg = await openSeed('# 甲\n\n甲一。\n\n# 乙\n\n乙一。\n')
      const foldAt = async (title) => {
        const c = await pg.evaluate(({ s, t }) => {
          const el = [...document.querySelector(s).querySelectorAll('h1')].find((x) => x.textContent.includes(t))
          const r = el.getBoundingClientRect()
          return { x: r.left + 15, y: r.top + r.height / 2 }
        }, { s: PM, t: title })
        await pg.mouse.move(c.x, c.y, { steps: 3 })
        await pg.waitForTimeout(340)
        await pg.evaluate(() => document.querySelector('.unified-gutter .block-fold')?.click())
        await pg.waitForTimeout(280)
      }
      await foldAt('乙') // 先折乙、再折甲 → folded 数组顺序与文档顺序相反
      await foldAt('甲')
      await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        let at = -1
        v.state.doc.descendants((n, pos) => { if (n.type.name === 'heading' && n.textContent === '甲') at = pos + 1 + n.content.size })
        v.dispatch(v.state.tr.setSelection(v.state.selection.constructor.create(v.state.doc, at)))
        v.focus()
      })
      await pg.waitForTimeout(150)
      await pg.keyboard.press('Enter')
      await pg.keyboard.type('新节')
      await pg.waitForTimeout(250)
      const r2 = await pg.evaluate(() => {
        const v = window.__upage.probe.view()
        const out = []
        v.state.doc.forEach((n) => out.push(n.textContent))
        return out.join('|')
      })
      record('R2 先折乙再折甲:甲上回车的新正文紧跟甲标题,仍在乙之前',
        r2.indexOf('新节') > r2.indexOf('甲|') && r2.indexOf('新节') < r2.indexOf('甲一') &&
          r2.indexOf('新节') < r2.indexOf('乙|'), r2)
      await pg.close()
    }
    // R3 链接卡片「删除」= 连文字一起删,且不抛异常(旧实现走 schema.text('') 必炸 RangeError)
    {
      const pg = await openSeed('前 [官网](https://example.com/a) 后\n')
      let boom = null
      pg.on('pageerror', (e) => { boom = e.message })
      const box = await pg.evaluate((s) => {
        const a = document.querySelector(`${s} a[href]`)
        const r = a.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }, PM)
      await pg.mouse.move(box.x, box.y)
      await pg.waitForTimeout(700)
      const clicked = await pg.evaluate(() => {
        const b = [...document.querySelectorAll('.amx-linkcard button')].find((x) => x.textContent === '删除')
        if (!b) return false
        b.click()
        return true
      })
      await pg.waitForTimeout(300)
      const r3 = await pg.evaluate((s) => ({
        text: document.querySelector(s).textContent,
        links: document.querySelectorAll(`${s} a[href]`).length,
      }), PM)
      record('R3 链接卡片「删除」连文字一起删且不抛异常',
        clicked && !boom && r3.links === 0 && !r3.text.includes('官网'), JSON.stringify({ clicked, boom, ...r3 }))
      await pg.close()
    }
  }

  await browser.close()
  const pass = results.filter(Boolean).length
  console.log(`\n${pass}/${results.length} 通过`)
  process.exit(results.every(Boolean) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
