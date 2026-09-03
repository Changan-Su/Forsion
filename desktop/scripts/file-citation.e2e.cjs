/**
 * 行号/标题引用条整链 e2e:真 Electron × 真组件 × 可编剧假引擎(pdf-citation.e2e 的姊妹篇)。
 * 链路 = agent 回复里写 `[[src/main.py#L150]]`(read_file 教它的形态)→ 气泡渲染成「文件名:150」
 * 引用条 → 点击在 Agent Desk 里开 WsFileView(CodeMirror),滚到那行并高亮;
 * `[[dir/笔记.md#标题]]` → 主区打开笔记并滚到该标题。
 *
 * 断言盯的是这条链上会**静默失效**的几处:
 *   F1 linkTarget 砍 `#L` / vault 懒引导 → 引用条消失或恒灰
 *   F2 高亮行存在但**没滚进视口**(几何断言全绿 ≠ 看起来对 —— 必须量视口 Y)
 *   F3 同一份文件第二条引用 → 就地跳(goto 事件),不 remount 重建 CodeMirror
 *   F5 散文 `[见 #L42]` 被兜底正则误吃成引用条
 *   F7 标题锚被 linkTarget 砍掉 → 笔记打开但永远停在文首
 *
 * 需先 npm run build。用法:npm run e2e:filecite
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 's1', title: '行号引用会话', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
  created_at: '2026-08-28 09:00:00', updated_at: '2026-08-28 09:00:00',
}

/** 轮询等 Desk 的 CodeMirror 里出现命中期望行号的高亮行(最长 20s);返回观测快照。 */
async function waitCite(win, wantFirstLine, ms = 20_000) {
  const t0 = Date.now()
  let snap = { lines: [], inView: false, editors: 0 }
  while (Date.now() - t0 < ms) {
    snap = await win.evaluate(() => {
      const desk = document.querySelector('.agent-desk')
      const marks = desk ? [...desk.querySelectorAll('.cm-citeline')] : []
      const scroller = desk ? desk.querySelector('.cm-scroller') : null
      const lines = marks.map((m) => {
        // CodeMirror 行号从 gutter 读不可靠(虚拟化),用行内容前缀标记(夹具每行自带行号词)
        return (m.textContent || '').trim().slice(0, 24)
      })
      const r = marks[0] ? marks[0].getBoundingClientRect() : null
      const sr = scroller ? scroller.getBoundingClientRect() : null
      return {
        lines,
        inView: !!(r && sr && r.bottom > sr.top && r.top < sr.bottom),
        editors: desk ? desk.querySelectorAll('.cm-editor').length : 0,
        // 落地提醒动画:类由 CodeView 挂 1.4s 后摘(留着的话行滚出再滚回是新 DOM,动画会重放)。
        // 本轮询一见到期望行号就返回,所以取样必落在窗口内,不是抢时间。
        pulse: marks[0] ? getComputedStyle(marks[0]).animationName : null,
      }
    }).catch(() => snap)
    if (snap.lines[0] && snap.lines[0].startsWith(wantFirstLine)) return snap
    await win.waitForTimeout(400)
  }
  return snap
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-filecite-'))
  const vaultDir = path.join(home, 'vault')
  fs.mkdirSync(path.join(vaultDir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(vaultDir, '笔记'), { recursive: true })
  // 200 行代码夹具:行够多,滚动才是看得出的位移;每行自带 `Lnnn` 前缀 = 断言的行身份标记。
  const pyLines = Array.from({ length: 200 }, (_, i) => `L${String(i + 1).padStart(3, '0')} = ${i + 1}  # marker line`)
  fs.writeFileSync(path.join(vaultDir, 'src', 'main.py'), pyLines.join('\n'))
  // 库外的代码文件(绝对路径锚点,用户真实场景:项目就在 vault 外)
  const hostTs = path.join(home, 'proj', 'util.ts')
  fs.mkdirSync(path.dirname(hostTs), { recursive: true })
  fs.writeFileSync(hostTs, Array.from({ length: 60 }, (_, i) => `const H${String(i + 1).padStart(3, '0')} = ${i + 1}`).join('\n'))
  // 长笔记:目标标题在很后面,滚没滚一目了然
  const mdParts = ['# 长文', '', '开头一段。', '']
  for (let s = 1; s <= 30; s++) {
    mdParts.push(`## 第${s}节`, '', `第 ${s} 节的内容,凑够行数。`, '正文再来一行。', '')
  }
  mdParts.push('## 玛瑙川', '', '这一节是引用目标。', '')
  fs.writeFileSync(path.join(vaultDir, '笔记', '长文.md'), mdParts.join('\n'))
  // csv 夹具:带行锚点开必须落 CodeMirror 原文(表格视图没有「第 N 行」)
  fs.mkdirSync(path.join(vaultDir, 'data'), { recursive: true })
  fs.writeFileSync(path.join(vaultDir, 'data', '表.csv'), ['name,value'].concat(Array.from({ length: 30 }, (_, i) => `row${String(i + 1).padStart(3, '0')},${i + 1}`)).join('\n'))
  const udDev = path.join(home, 'userdata-dev')
  fs.mkdirSync(udDev, { recursive: true })
  fs.writeFileSync(path.join(udDev, 'amadeus-config.dev.json'), JSON.stringify({ lastVault: vaultDir, localVault: vaultDir }))

  const stub = await startStubEngine({
    sessions: [SESSION],
    // 引用写进历史消息(reload 后照样水化得回来);形态齐:vault 相对/绝对路径/范围/单括号/标题/散文负对照。
    messages: [{
      id: 'hm1', role: 'model', timestamp: 1787100000000,
      content: '入口在 [[src/main.py#L150]],辅助在 [[src/main.py#L20]],范围见 [[src/main.py#L30-L34]];'
        + `库外工具 [[${hostTs}#L9]];`
        + `写丢括号的:【[${hostTs}#L3-L5]】;`
        + '散文里的 [见 #L42] 与脚注 [1] 不是引用;'
        + '数据行在 [[data/表.csv#L12]];'
        + '笔记见 [[笔记/长文.md#玛瑙川]] 一节。',
    }],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000 }],
  })
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })
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
    // ⚠️ e2e 与用户 dev 实例共用 renderer 存储(dev 模式 userData 恒为 forsion-desktop-dev),
    // 「上次 Space」是谁最后用谁说了算 —— 用户停在主页/Amadeus,这里就会开在那儿,聊天侧栏根本不存在
    // (08-28 深夜三连红的真相,失败截图= 主页 Space)。确定性切到 Tangu 聊天 Space 再断言,幂等。
    const spaceBtn = win.locator('.rb-space[title="Tangu"]').first()
    if (await spaceBtn.count().catch(() => 0)) { await spaceBtn.click().catch(() => {}); await win.waitForTimeout(1000) }
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    await win.locator('.t2s-srow', { hasText: '行号引用会话' }).first().click().catch(() => {})
    await win.waitForTimeout(1200)

    if (process.env.FILECITE_DEBUG) {
      await win.screenshot({ path: '/tmp/filecite-debug.png' })
      const dom = await win.evaluate(() => {
        const hasTxt = document.body.innerText.includes('main.py:150')
        const anyWiki = document.querySelectorAll('.wikilink').length
        const frames = document.querySelectorAll('iframe,webview').length
        const t2 = document.querySelectorAll('.t2-content').length
        const msgEl = [...document.querySelectorAll('*')].find((el) => el.childElementCount === 0 && (el.textContent || '').includes('main.py:150'))
        const chain = (el) => { const out = []; let n = el; let i = 0; while (n && i++ < 10) { out.push(`${n.tagName}.${(n.className?.toString() || '').slice(0, 50)}`); n = n.parentElement } return out }
        return { hasTxt, anyWiki, frames, t2, chain: msgEl ? chain(msgEl) : null }
      })
      console.log('DOMDBG', JSON.stringify(dom), 'windows=', app.windows().length)
    }
    try {
      await win.waitForSelector('.t2-content a.wikilink', { timeout: 30_000 })
    } catch (e) {
      // 失败取证:超时时刻的 DOM 真相 + 真屏(灰链=vault 没水化;0 链=消息没渲染;有链=可见性判定问题)
      const f = await win.evaluate(() => ({
        links: document.querySelectorAll('.t2-content a.wikilink').length,
        gray: document.querySelectorAll('.t2-content .wikilink-unresolved').length,
        t2: document.querySelectorAll('.t2-content').length,
        txt: document.body.innerText.includes('入口在'),
        srows: document.querySelectorAll('.t2s-srow').length,
      })).catch(() => null)
      console.log('FAILDBG', JSON.stringify(f))
      await win.screenshot({ path: '/tmp/filecite-fail.png' }).catch(() => {})
      throw e
    }
    await win.waitForTimeout(800)

    // F1 引用条齐:代码条显示「文件名:行」,笔记条显示「名 › 标题」;散文方括号一个都没混进来
    const chips = win.locator('.t2-content a.wikilink')
    const n = await chips.count().catch(() => 0)
    const labels = await chips.allInnerTexts().catch(() => [])
    check('F1 行号/标题引用渲染成引用条:main.py:150 | :20 | :30-34 | util.ts:9 | util.ts:3-5 | 表.csv:12 | 长文 › 玛瑙川',
      n === 7 && labels.join('|') === 'main.py:150|main.py:20|main.py:30-34|util.ts:9|util.ts:3-5|表.csv:12|长文 › 玛瑙川',
      `chips=${n} labels=${labels.join('|')}`)

    // F5 散文负对照:`[见 #L42]`/`[1]` 原样留在正文里,没被兜底正则吃掉
    const body = await win.locator('.t2-content').first().innerText().catch(() => '')
    check('F5 散文 `[见 #L42]` 与脚注 `[1]` 不是引用条(原样正文)', body.includes('[见 #L42]') && body.includes('[1]'), '')

    // F9 悬浮预览闪烁回归(用户实测打回):引用条在屏幕**底部**时,浮卡若只往上夹会盖住链接
    // → 盖住指针 → mouseleave 关卡 → 指针落回链接再弹……循环闪烁。修法 = 贴底翻转到上方。
    // 场景注入:底部放一枚同款 wikilink,真指针悬停出卡后**微动 1px**(旧版这一下就把卡关掉)。
    await win.evaluate(() => {
      const a = document.createElement('a')
      a.className = 'wikilink'
      a.setAttribute('data-wiki', '笔记/长文.md')
      a.textContent = 'hover探针'
      a.id = 'hoverprobe'
      Object.assign(a.style, { position: 'fixed', left: '600px', bottom: '40px', zIndex: 99999 })
      document.body.appendChild(a)
    })
    const hb = await win.locator('#hoverprobe').boundingBox()
    await win.mouse.move(hb.x + 20, hb.y + 8)
    await win.waitForTimeout(800) // SHOW_DELAY 400 + readPage
    await win.mouse.move(hb.x + 21, hb.y + 8)
    await win.waitForTimeout(400)
    const hp = await win.evaluate(() => {
      const card = document.querySelector('.amx-hoverprev')
      const probeEl = document.getElementById('hoverprobe')
      if (!card || !probeEl) return { card: !!card, above: false }
      const c = card.getBoundingClientRect()
      const pr = probeEl.getBoundingClientRect()
      return { card: true, above: c.bottom <= pr.top + 1 }
    })
    check('F9 底部引用条的悬浮预览翻转到上方,微动指针后仍稳定(不闪烁)', hp.card && hp.above, JSON.stringify(hp))
    await win.evaluate(() => document.getElementById('hoverprobe')?.remove())
    await win.mouse.move(200, 400)
    await win.waitForTimeout(300)

    // F2 点 vault 代码条 → Desk 开 CodeMirror,150 行高亮**且在视口里**(必须量视口 Y)
    await chips.first().click()
    await win.waitForSelector('.agent-desk.open .cm-editor', { timeout: 20_000 }).catch(() => {})
    const s1 = await waitCite(win, 'L150')
    check('F2 点引用条 → Desk 里 CodeMirror 打开,第 150 行高亮且滚进视口', s1.lines[0]?.startsWith('L150') && s1.inView,
      `first=${s1.lines[0]} inView=${s1.inView}`)
    check('F2b 落地这一次放了提醒动画(引用行自己闪一下)', /^cm-citepulse-/.test(s1.pulse || ''), `animation-name=${s1.pulse}`)

    // F3 同一份文件第二条引用 → 就地跳到 20 行(CodeMirror 不重建)
    const before = s1.editors
    await chips.nth(1).click()
    const s2 = await waitCite(win, 'L020')
    check('F3 同文件第二条引用就地跳到第 20 行(编辑器不重挂)', s2.lines[0]?.startsWith('L020') && s2.inView && s2.editors === before && before === 1,
      `first=${s2.lines[0]} inView=${s2.inView} editors=${before}→${s2.editors}`)

    // F4 范围锚 `#L30-L34` → 5 行整段高亮
    await chips.nth(2).click()
    const s3 = await waitCite(win, 'L030')
    check('F4 范围引用高亮整段(30-34 共 5 行)', s3.lines.length === 5 && s3.lines[0]?.startsWith('L030') && s3.lines[4]?.startsWith('L034') && s3.inView,
      `lines=${s3.lines.length} first=${s3.lines[0]} last=${s3.lines[4]}`)

    // 观感探针(FILECITE_SHOT=1):明暗两态各拍一张(DESIGN.md §8:观感类改动必须看真截图)
    if (process.env.FILECITE_SHOT) {
      await win.waitForTimeout(500)
      await win.screenshot({ path: '/tmp/filecite-light.png' })
      await win.evaluate(() => document.documentElement.classList.add('dark'))
      await win.waitForTimeout(600)
      await win.screenshot({ path: '/tmp/filecite-dark.png' })
      await win.evaluate(() => document.documentElement.classList.remove('dark'))
      // 动画只看末态等于没看:再点一次同一条引用重放 pulse,按相位连拍(1s:淡入 / 低谷 / 收尾)。
      // 裁到高亮行附近 —— 整窗截图里那一行只有几十像素高,肉眼分辨不出相位差。
      const clipOf = async () => win.evaluate(() => {
        const m = document.querySelector('.agent-desk .cm-citeline')
        if (!m) return null
        const r = m.getBoundingClientRect()
        return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 60), width: Math.min(700, r.width + 40), height: 140 }
      })
      for (const theme of ['light', 'dark']) {
        await win.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme)
        await chips.first().click()
        for (const [wait, tag] of [[140, 'a'], [280, 'b'], [480, 'c']]) {
          await win.waitForTimeout(wait)
          const clip = await clipOf()
          if (clip) await win.screenshot({ path: `/tmp/filecite-pulse-${theme}-${tag}.png`, clip })
        }
        await win.waitForTimeout(400)
      }
      await win.evaluate(() => document.documentElement.classList.remove('dark'))
      await win.waitForTimeout(400)
    }

    // F6a 库外文件(绝对路径锚点):照样开,第 9 行高亮
    await chips.nth(3).click()
    const s4 = await waitCite(win, 'const H009')
    check('F6a 库外代码文件按绝对路径打开并高亮第 9 行', s4.lines[0]?.startsWith('const H009') && s4.inView,
      `first=${s4.lines[0]} inView=${s4.inView}`)

    // F6b 单括号形态(模型写丢一层括号)同样点得开,范围 3-5
    await chips.nth(4).click()
    const s5 = await waitCite(win, 'const H003')
    check('F6b 单括号形态 `【[/abs/util.ts#L3-L5]】` 照样引用条 + 3 行高亮', s5.lines.length === 3 && s5.lines[0]?.startsWith('const H003') && s5.inView,
      `lines=${s5.lines.length} first=${s5.lines[0]}`)

    // F8 csv 带行锚:进 CodeMirror 原文(不是表格),第 12 行(数据 row011)高亮 —— Codex 评审:
    // read_file 对 csv 一样教 #L,点开必须有落点。
    await chips.nth(5).click()
    const s6 = await waitCite(win, 'row011')
    check('F8 csv 行引用进 CodeMirror 原文并高亮第 12 行(不落表格视图)', s6.lines[0]?.startsWith('row011') && s6.inView,
      `first=${s6.lines[0]} inView=${s6.inView}`)

    // F7 标题引用:主区打开笔记并把「玛瑙川」滚进视口(锚点没被 linkTarget 砍掉、reveal 真的动了)。
    // 轮询而非固定 sleep:openNote 要等编辑器就绪,reveal 还有自己的重试节拍(固定 sleep 在 PDF 轮假红过)。
    // 落点提醒动画挂在**补跳**那一次(见 amadeusNav),类 1.4s 后摘 —— 事后轮询会扑空。
    // 点之前先挂个 MutationObserver 把「曾经出现过」记下来,断言就与时序无关了。
    // ⚠️ 故意在**非 1× 端级缩放**下跑这一段:覆盖片是 fixed 的,rect 是视口 px 而写进 style 的长度
    // 会再乘一次 zoom —— 不反补偿就必然错位(仓库老坑)。下面的 onHeading 对齐断言就是这条的哨兵。
    await win.evaluate(() => { document.body.style.zoom = '1.25' })
    await win.waitForTimeout(300)
    await win.evaluate(() => {
      window.__flashSeen = null
      window.__flashGone = null
      new MutationObserver(() => {
        const el = document.querySelector('.am-citeflash')
        if (!el || window.__flashSeen) return
        const r = el.getBoundingClientRect()
        const hd = [...document.querySelectorAll('h1,h2,h3')].find((x) => (x.textContent || '').includes('玛瑙川'))
        const hr = hd ? hd.getBoundingClientRect() : null
        // 覆盖片必须真盖在那个标题上(只断言「出现过」的话,画在屏幕外也算过)
        window.__flashSeen = { anim: getComputedStyle(el).animationName,
          count: document.querySelectorAll('.am-citeflash').length, // 单例:连点两条不许叠加
          onHeading: !!hr && Math.abs(r.top - hr.top) < 14 && Math.abs(r.left - hr.left) < 14 && r.width > 20 }
        // fixed 的片子跟不了滚动 → 一滚就该撤。监听晚 300ms 才挂(避开 reveal 自己那次滚动),故等 450ms。
        setTimeout(() => {
          window.dispatchEvent(new Event('scroll'))
          window.__flashGone = !document.querySelector('.am-citeflash')
        }, 450)
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    })
    await chips.nth(6).click()
    let h = { found: false, top: -1, inView: false }
    let headShot = false
    const t0 = Date.now()
    while (Date.now() - t0 < 15_000) {
      h = await win.evaluate(() => {
        const hs = [...document.querySelectorAll('h1,h2,h3')].filter((x) => (x.textContent || '').includes('玛瑙川'))
        const el = hs[0]
        if (!el) return { found: false, top: -1, inView: false }
        const r = el.getBoundingClientRect()
        return { found: true, top: r.top, inView: r.top >= 0 && r.top < window.innerHeight }
      }).catch(() => h)
      // 观感探针:标题闪烁窗只有 600→2000ms,事后再查必扑空 —— 就在这个轮询里逮
      if (process.env.FILECITE_SHOT && !headShot) {
        const clip = await win.evaluate(() => {
          const el = document.querySelector('.am-citeflash')
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 24), width: Math.min(700, r.width + 240), height: 96 }
        }).catch(() => null)
        if (clip) {
          await win.screenshot({ path: '/tmp/filecite-headflash.png', clip })
          // 暗色同帧再拍一张:动画相位会往前走一点,但要看的是配色(暗色禁黄底那条纪律)
          await win.evaluate(() => document.documentElement.classList.add('dark'))
          await win.screenshot({ path: '/tmp/filecite-headflash-dark.png', clip })
          await win.evaluate(() => document.documentElement.classList.remove('dark'))
          headShot = true
        }
      }
      if (h.inView && (!process.env.FILECITE_SHOT || headShot)) break
      await win.waitForTimeout(200)
    }
    check('F7 标题引用打开笔记并滚到「玛瑙川」(标题在视口内)', h.found && h.inView, JSON.stringify(h))

    // F7b 标题落点没有常驻高亮(只是滚过去),不闪一下等于零反馈 —— 这条钉那一闪真的挂上了。
    let flash = null
    const tf = Date.now()
    while (Date.now() - tf < 6000) {
      flash = await win.evaluate(() => window.__flashSeen).catch(() => null)
      if (flash) break
      await win.waitForTimeout(150)
    }
    check('F7b 标题落点闪一下提醒:覆盖片正落在标题上(端级 zoom 1.25 下也不许偏)且全局只有一片',
      !!flash && flash.anim === 'am-citeflash' && flash.onHeading === true && flash.count === 1, JSON.stringify(flash))
    let gone = null
    const tg = Date.now()
    while (Date.now() - tg < 3000) {
      gone = await win.evaluate(() => window.__flashGone).catch(() => null)
      if (gone !== null) break
      await win.waitForTimeout(150)
    }
    check('F7c 用户一滚,落点覆盖片立刻撤掉(fixed 跟不了滚动,飘在无关正文上更糟)', gone === true, `gone=${gone}`)
    await win.evaluate(() => { document.body.style.zoom = '' })
  } finally {
    await app.close().catch(() => {})
    try { await stub.close() } catch { /* 桩关闭失败不该盖掉断言结果 */ }
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
