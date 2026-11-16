/** Chat Box 底排按钮的水滴开合(2026-11-16 Chat Box 水滴方案,用户选 A;views/chat2/useCapsuleDroplet.ts)。
 *  真 Electron(out/ 构建)+ 假引擎 + 隔离 home,不冻结、1× 逐帧(rAF)采样:
 *   · 开:菜单从按钮里流出来(液体层出现、每帧至多一层)、0.9D 左右接手;
 *   · 再点同一颗 / Esc / 点空白 = 倒放:液体重新出现、胶囊跟着缩、菜单倒放完才卸;
 *   · 胶囊只缩不胀、左缘(模型胶囊是右缘)一帧不动 —— 第三轮「模式胶囊收起最后那一下和 ＋ 不连贯」;
 *   · 窄 Chat View(480–600):开着时 ＋ 原地淡出、位置留着,其余让位的按钮收完才回来;
 *   · 点了一行 = 直接收(80ms),倒放到一半又点同一颗 = 掉头停在打开;
 *   · 平移主题:胶囊照旧跟菜单进场那一对(180ms)。
 *  负对照:拿 main 的构建跑,「胶囊左缘不动」「让位的按钮收完才回来」「倒放」几条必须红。
 *  宽度:900 = 宽排;640 = 窄 Chat View(底排 480–600,排他展开);420 = compact(菜单是带标题的浮层,胶囊不撑宽)。
 *  用法:npm run build && node scripts/chatbox-droplet.e2e.cjs [--only=mode,add,model,ctx] [--widths=900,640,420] [--shots=<目录>] */
const fs = require('fs'), os = require('os'), path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')
const ROOT = path.resolve(__dirname, '..')
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3).split(',') : d }
const ONLY = arg('only', ['mode', 'add', 'model', 'ctx'])
const WIDTHS = arg('widths', ['900', '640', '420']).map(Number)
const SHOTS = arg('shots', [''])[0]
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const TRIG = { add: '.add-pill-btn', mode: '.mode-pill-btn', model: '.model-pill-btn', ctx: '.t2c-ctxring-btn',
  runloc: '.runloc-pill', project: '.project-selector:not(.runloc) > .project-pill', agent: '.compact-chat-picker' }
const PANEL = { add: '.composer-menu--add', mode: '.composer-menu--mode', model: '.composer-menu--model', ctx: '.t2c-ctxring-pop',
  runloc: '.runloc-menu', project: '.project-menu:not(.runloc-menu)', agent: '.chat-pick-pop' }
const CHIPS = ['runloc', 'project', 'agent'] // 卡片上方两颗芯片 + Agent 芯片:不撑宽,只流出 / 倒放
const fails = []
let passed = 0
function check(name, ok, detail) { if (ok) { passed++; console.log('PASS ' + name) } else { fails.push(name); console.log('FAIL ' + name + ' ' + JSON.stringify(detail).slice(0, 600)) } }

/** 页内按 rAF 采样 ms 毫秒(不冻结);采样开始后由 Playwright 做真的点击 / 按键(焦点、事件顺序都和用户一样)。 */
async function film(win, k, ms, act) {
  await win.evaluate(({ k, ms, TRIG, PANEL }) => {
    const view = document.querySelector('.t2-chat-view')
    const pill = view.querySelector(TRIG[k]) || document.querySelector(TRIG[k])
    const rect = (el) => { if (!el || el.checkVisibility?.() === false) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, t: r.top } }
    const live = () => [...document.querySelectorAll(PANEL[k])].filter((p) => !p.hasAttribute('data-lcl-exit'))
    const visiblePanel = () => live().find((p) => p.checkVisibility?.() !== false && getComputedStyle(p).visibility !== 'hidden')
    const t0 = performance.now()
    const frame = () => {
      const panel = visiblePanel()
      const layers = [...document.querySelectorAll('.lcl-droplet')].filter((l) => l.style.display !== 'none')
      const add = view.querySelector('.add-pill-wrap')
      return {
        t: Math.round(performance.now() - t0), pill: rect(pill), panel: !!panel, pouring: !!panel?.classList.contains('lcl-droplet-pouring'),
        // ctx 的浮层(宽 Chat View)一直挂着,开没开看外层 .is-open
        layers: layers.length, mounted: k === 'ctx' ? !!view.querySelector('.t2c-ctxring.is-open') || live().some((p) => !view.contains(p)) : live().length > 0,
        add: add && { l: rect(add)?.l ?? null, o: +getComputedStyle(add).opacity },
        model: rect(view.querySelector('.model-pill-wrap')), mic: rect(view.querySelector('.t2c-mic-control')),
        micO: +(view.querySelector('.t2c-mic-control') ? getComputedStyle(view.querySelector('.t2c-mic-control')).opacity : 1),
      }
    }
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    window.__film = (async () => { const out = [frame()]; while (performance.now() - t0 < ms) { await raf(); out.push(frame()) } return out })()
  }, { k, ms, TRIG, PANEL })
  const view = win.locator('.t2-chat-view').first()
  if (act === 'click') await win.locator(TRIG[k]).first().click({ noWaitAfter: true })
  else if (act === 'esc') await win.keyboard.press('Escape')
  else if (act === 'outside') { const b = await view.boundingBox(); await win.mouse.click(b.x + b.width / 2, b.y + 60) }
  else if (act === 'pick') {
    const row = win.locator(`${PANEL[k]}:not([data-lcl-exit]) button.menu-item:not(:disabled):not(.active)`).first()
    await row.click({ noWaitAfter: true })
  }
  return win.evaluate(() => window.__film)
}

;(async () => {
  const models = [{ id: 'm1', name: 'Claude Sonnet 5.5', provider: 'stub', contextWindow: 200000 }, { id: 'm2', name: 'GPT 6 Luna', provider: 'stub', contextWindow: 400000 }]
  const stub = await startStubEngine({ models, agents: [{ slug: 'arioso', name: 'Arioso', createdBy: 'user' }], engines: [], override: ({ path: p, method }) => p === '/agent/runs' && method === 'GET' ? { runs: [] } : undefined })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chatbox-droplet-'))
  const userdata = path.join(home, 'userdata')
  for (const dir of [userdata, `${userdata}-dev`]) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({ mode: 'external', backendUrl: stub.url, token: 'e2e' }))
  }
  let app
  try {
    app = await electron.launch({ args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, TANGU_HARNESS_QUIET: '1' } })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 900))
    await win.waitForSelector('#root')
    await skipOnboarding(win)
    await win.evaluate(() => localStorage.setItem('forsion_default_space', 'tangu'))
    await win.reload({ waitUntil: 'domcontentloaded' })
    const view = win.locator('.t2-chat-view').first()
    await view.waitFor({ timeout: 40000 })
    await view.locator('.model-pill-btn:not(:disabled)').waitFor({ timeout: 40000 })
    const D = await win.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--droplet-duration')) || 420)
    const settle = () => win.waitForTimeout(D + 200)
    for (const width of WIDTHS) {
      await view.evaluate((el, width) => { el.style.flex = 'none'; el.style.width = width + 'px'; el.style.height = '760px' }, width)
      await win.waitForTimeout(300)
      const compact = await view.evaluate((el) => el.querySelector('.t2c-row')?.getAttribute('data-compact') === 'true')
      // 排他展开的容器查询按底排内容宽(.t2c-card 的 content box)
      const rowW = await view.evaluate((el) => { const c = el.querySelector('.t2c-card'); const cs = getComputedStyle(c); return Math.round(c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) })
      const tag = `${width}(底排 ${rowW}${compact ? ' compact' : ''})`
      // 先点一下输入框:窗口刚改尺寸后的第一下点击有时落空
      await view.locator('.t2c-ta').click(); await win.waitForTimeout(150)
      for (const k of ONLY) {
        if (!(await view.locator(TRIG[k]).count())) { console.log(`skip ${k}: 没有这颗按钮`); continue }
        // ① 开:流出来
        const open = await film(win, k, D + 160, 'click')
        const growEdge = k === 'model' ? 'r' : 'l'
        check(`${tag} ${k}: 开 = 液体流出(每帧至多一层)`, open.some((f) => f.layers === 1) && open.every((f) => f.layers <= 1), open.map((f) => f.layers))
        check(`${tag} ${k}: 0.9D 左右接手`, !open.at(-1).pouring && open.at(-1).layers === 0 && open.at(-1).panel, open.at(-1))
        const widens = k !== 'ctx' && !compact
        if (widens) {
          const ws = open.filter((f) => f.pill).map((f) => Math.round(f.pill.w))
          const full = open.findIndex((f) => f.pill && f.pill.w >= 223)
          // 长模型名的胶囊本来就有 200+px,到 224 只差十几 px,曲线尾巴很早就到 —— 只要求不是菜单进场那 180ms 的样子一下到位
          check(`${tag} ${k}: 胶囊跟液体同一只表撑开(${open[full]?.t}ms 到 224)`, full > 0 && open[full].t >= D * 0.3, ws)
          const edges = open.filter((f) => f.pill).map((f) => Math.round(f.pill[growEdge]))
          check(`${tag} ${k}: 开时胶囊${growEdge === 'l' ? '左' : '右'}缘不动`, Math.max(...edges) - Math.min(...edges) <= 1, edges)
        }
        if (SHOTS) await win.screenshot({ path: path.join(SHOTS, `${width}-${k}-open.png`) })
        // ② 再点同一颗 = 倒放
        const close = await film(win, k, D, 'click')
        const pour = close.filter((f) => f.pouring && f.layers === 1)
        check(`${tag} ${k}: 再点 = 倒放(液体重新出现)`, pour.length >= 3, close.map((f) => [f.t, f.pouring, f.layers]))
        const gone = close.findIndex((f) => !f.mounted)
        check(`${tag} ${k}: 倒放完才卸(${gone >= 0 ? close[gone].t : '-'}ms)`, gone > 0 && close[gone].t >= D * 0.6, close.map((f) => [f.t, f.mounted]))
        if (widens) {
          const ws = close.filter((f) => f.pill).map((f) => f.pill.w)
          check(`${tag} ${k}: 收时胶囊只缩不胀`, ws.every((w, i) => i === 0 || w <= ws[i - 1] + 0.5), ws.map(Math.round))
          const edges = close.filter((f) => f.pill).map((f) => Math.round(f.pill[growEdge]))
          check(`${tag} ${k}: 收时胶囊${growEdge === 'l' ? '左' : '右'}缘一帧不动(连最后一下)`, Math.max(...edges) - Math.min(...edges) <= 1, edges)
          const shrinkDone = close.findIndex((f, i) => i > 0 && f.pill && Math.abs(f.pill.w - close.at(-1).pill.w) < 1)
          check(`${tag} ${k}: 胶囊和液体一起收完(差 ≤ 120ms)`, gone > 0 && shrinkDone > 0 && Math.abs(close[shrinkDone].t - close[gone].t) <= 120, { shrinkDone: close[shrinkDone]?.t, gone: close[gone]?.t })
        }
        // 窄 Chat View:让位的按钮
        const narrow = !compact && rowW <= 600
        if (narrow && k !== 'ctx') {
          const addL = open.concat(close).filter((f) => f.add?.l != null).map((f) => Math.round(f.add.l))
          if (k !== 'add') {
            check(`${tag} ${k}: ＋ 原地淡出、位置一直留着`, addL.length > 0 && Math.max(...addL) - Math.min(...addL) <= 1 && open.at(-1).add.o < 0.05, { addL: [...new Set(addL)], o: open.at(-1).add.o })
          }
          if (k === 'model') {
            // 模型胶囊右缘不动、向左长:右边的麦克风和左边的 ＋ 一样原地淡出、位置留着
            const micL = open.concat(close).filter((f) => f.mic).map((f) => Math.round(f.mic.l))
            check(`${tag} ${k}: 麦克风原地淡出、位置一直留着`, micL.length > 0 && Math.max(...micL) - Math.min(...micL) <= 1 && open.at(-1).micO < 0.05, { micL: [...new Set(micL)], o: open.at(-1).micO })
          } else {
            const back = close.findIndex((f) => !!f.model)
            check(`${tag} ${k}: 让位的模型胶囊收完才回来`, open.at(-1).model === null && (back === -1 || back >= gone), { back: close[back]?.t, gone: close[gone]?.t })
          }
        }
        await settle()
        // ③ Esc 也是倒放
        await view.locator(TRIG[k]).click(); await settle()
        const esc = await film(win, k, D, 'esc')
        check(`${tag} ${k}: Esc = 倒放`, esc.some((f) => f.pouring && f.layers === 1) && !esc.at(-1).mounted, esc.map((f) => [f.t, f.pouring, f.mounted]))
        await settle()
        // ④ 倒放到一半又点同一颗 = 掉头停在打开
        await view.locator(TRIG[k]).click(); await settle()
        await film(win, k, D * 0.7 * 0.4, 'click')
        const re = await film(win, k, D + 100, 'click')
        check(`${tag} ${k}: 倒放到一半又点 = 掉头停在打开`, re.every((f) => f.mounted) && re.at(-1).panel && !re.at(-1).pouring, re.at(-1))
        // ⑤ 点了一行 = 直接收(不倒放)
        if (k === 'mode') {
          const pick = await film(win, k, 300, 'pick')
          const g = pick.findIndex((f) => !f.mounted)
          check(`${tag} ${k}: 点了一行 = 直接收`, g > 0 && pick[g].t <= 120 && !pick.some((f) => f.pouring), pick.map((f) => [f.t, f.mounted, f.pouring]))
        } else {
          await view.locator(TRIG[k]).click()
        }
        await settle()
      }
    }
    // 芯片:流出、再点倒放、点空白倒放
    await view.evaluate((el) => { el.style.width = '900px' }); await win.waitForTimeout(300)
    for (const k of CHIPS) {
      if (!(await win.locator(TRIG[k]).count())) { console.log(`skip ${k}: 没有这颗芯片`); continue }
      const tag = `芯片 ${k}`
      const open = await film(win, k, D + 160, 'click')
      check(`${tag}: 开 = 液体流出(每帧至多一层)、0.9D 左右接手`, open.some((f) => f.layers === 1) && open.every((f) => f.layers <= 1) && open.at(-1).panel && !open.at(-1).pouring, open.map((f) => [f.t, f.layers, f.panel]))
      const close = await film(win, k, D, 'click')
      const gone = close.findIndex((f) => !f.mounted)
      check(`${tag}: 再点 = 倒放、倒放完才卸`, close.some((f) => f.pouring && f.layers === 1) && gone > 0 && close[gone].t >= D * 0.6, close.map((f) => [f.t, f.pouring, f.mounted]))
      await settle()
      await win.locator(TRIG[k]).first().click(); await settle()
      const esc = await film(win, k, D, 'esc')
      check(`${tag}: Esc = 倒放`, esc.some((f) => f.pouring && f.layers === 1) && !esc.at(-1).mounted, esc.map((f) => [f.t, f.pouring, f.mounted]))
      await settle()
    }
    // 平移主题:胶囊跟菜单进场那一对(180ms 到位),不跟液滴的 420ms
    if (ONLY.includes('mode')) {
      await view.evaluate((el) => { el.style.width = '900px' }); await win.waitForTimeout(300)
      await win.evaluate(() => { document.documentElement.dataset.motionTheme = 'glide' })
      const g = await film(win, 'mode', 400, 'click')
      const full = g.findIndex((f) => f.pill && f.pill.w >= 223)
      check(`平移主题: 胶囊 ~180ms 撑开(${g[full]?.t}ms)、没有液体`, full > 0 && g[full].t <= 260 && g.every((f) => f.layers === 0), g.map((f) => [f.t, f.pill && Math.round(f.pill.w)]))
      await view.locator(TRIG.mode).click(); await settle()
      await win.evaluate(() => { delete document.documentElement.dataset.motionTheme })
    }
  } finally {
    await app?.close().catch(() => {})
    await stub.close?.()
    fs.rmSync(home, { recursive: true, force: true })
  }
  console.log(`\n${passed} passed, ${fails.length} failed`)
  if (fails.length) { console.log(fails.map((f) => ' - ' + f).join('\n')); process.exit(1) }
})().catch((e) => { console.error(e); process.exit(1) })
