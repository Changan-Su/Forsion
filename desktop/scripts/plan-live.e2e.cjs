/**
 * **真引擎真模型** live 台架:计划卡三态(P2)+ 上下文指令文件(H5)。
 *
 * 为什么是这个形态 —— 三条路都试过了:
 *   ① 假引擎 e2e(`chat-events.e2e.cjs`):事件是我按理解手写的,**桩会撒谎**,验不了「真模型
 *      到底调不调 exit_plan_mode」;2026-08-18 那条缺陷正是桩全绿而产品是坏的。
 *   ② 自起 Electron(`live-chat.e2e.cjs`):全新 user-data-dir 必弹引导覆盖层,输入框恒 disabled,
 *      至今没送进可交互态。
 *   ③ 交给 codex computer use 点:四轮里认错窗口一次、凭据两次、进程意外死一次,
 *      而且它可能「编一个 ✅」。
 * 本脚本走第四条:**连上你手里已经跑着的那个 dev 实例**(已登录、已过引导、引擎已起),
 * 用 CDP 附上去驱动。断言是代码写的,不会替我编结论。
 *
 * 用法:
 *   1. 先起 dev(端口别用 9222,那是 Chrome 的默认调试端口,本机 Chrome 正占着):
 *        npm run dev -- -- --remote-debugging-port=9333
 *      (electron-vite 把 `-- args` 经 ELECTRON_CLI_ARGS 转交 Electron)
 *   2. npm run e2e:planlive   [-- --cdp=9333 --cwd=/tmp/forsion-acc-0818]
 *
 * ⚠️ 会真实消耗模型额度(几轮短对话)。会在 --cwd 目录里建 ZZ-ACC-* 文件并写库(dev 家目录)。
 * ⚠️ 断言基于**真模型**,故区分两种红:「UI/引擎坏了」与「这次模型没配合」——后者脚本会明说。
 */
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright-core')

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `=${d}`).split('=').slice(1).join('=')
const PORT = arg('cdp', '9333')
const CWD = arg('cwd', '/tmp/forsion-acc-0818')
const MARK = 'ZZ-ACC-EDITED'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等真模型回话:轮询直到出现目标或超时(真调用慢,给足时间)。 */
async function until(page, fn, ms, every = 1500, arg) {
  const t0 = Date.now()
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => null)
    if (v) return v
    if (Date.now() - t0 > ms) return null
    await sleep(every)
  }
}

/** 引擎侧取证:status 事件不落前端 store,催交发没发只有 dev 库知道(今晚的取证套路)。 */
function nudgeCount(sessionId) {
  const db = path.join(require('os').homedir(), '.forsion-dev/tangu/state.db')
  if (!fs.existsSync(db)) return -1
  try {
    const out = require('child_process').execFileSync('sqlite3', [db,
      `select count(*) from agent_run_events e join agent_runs r on r.id=e.run_id
       where r.session_id='${sessionId}' and e.payload like '%plan_submit_nudge%'`], { encoding: 'utf8' })
    return Number(String(out).trim())
  } catch { return -1 }
}

async function main() {
  const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`)
  const ctx = browser.contexts()[0]
  const page = ctx.pages().find((p) => /localhost:\d+/.test(p.url())) || ctx.pages()[0]
  if (!page) throw new Error('CDP 上没有页面 —— dev 起了吗?')
  await page.bringToFront().catch(() => {})

  // 网络取证:回答询问是一次 HTTP。第一版只看 UI,「点了但没送达」和「点击本身失败」分不开。
  const net = []
  page.on('response', (r) => {
    if (/inquir/i.test(r.url())) net.push({ status: r.status(), url: r.url().slice(-60) })
  })
  page.on('requestfailed', (r) => {
    if (/inquir/i.test(r.url())) net.push({ status: 'FAILED', err: r.failure()?.errorText, url: r.url().slice(-60) })
  })

  // 前置自检:确认连的是本轮工作树的 dev(不是安装版:它没有这些接缝)
  const marker = await page.evaluate(() => ({
    hasStore: !!window.__forsionStore?.getState,
    title: document.title,
  }))
  check('L0 连上的是工作树 dev(store 接缝在)', marker.hasStore, JSON.stringify(marker))
  if (!marker.hasStore) { await browser.close(); process.exit(1) }

  // 先把**聊天面板**摆到前台再建会话:dev 重启会恢复上次的 tab(实测恢复成了别人留下的笔记),
  // 这时新建会话只改 store,不会抢占活动面板 —— 消息压根不进 DOM,看起来就像「计划卡没出现」。
  // 分类按钮的类名跨版本会变,按文本点最稳。
  // --reuse:复用当前活动会话里**已经挂着**的那张计划卡(上一次跑到一半留下的 pending 询问)。
  // 真模型一轮要几分钟且真花额度;调试点击路径时不该每次都重新问一遍模型。
  const REUSE = process.argv.includes('--reuse')

  // ⚠️ 别拿 `.t2s-srow` 存不存在当判据:侧栏切到「笔记」时那些行也是 .t2s-srow(通用行类),
  //    看着像有会话、其实一条都点不出聊天面板。必须先把分类切到「会话」。
  // ⚠️ 这段只为**新建流程**铺路;--reuse 下跑它会把你刚切好的会话挤掉(点第一行 = 换 activeId)。
  if (!REUSE) {
    const seg = page.locator('.t2sw-seg', { hasText: '会话' }).first()
    if (await seg.count().catch(() => 0)) {
      await seg.click().catch(() => {})
      await page.waitForTimeout(1200)
    }
    const anyRow = page.locator('.t2s-srow').first()
    if (await anyRow.count().catch(() => 0)) {
      await anyRow.click().catch(() => {})   // 打开任一会话 → 活动面板变成聊天
      await page.waitForTimeout(1800)
    }
    check('L0b 聊天面板在前台(否则新会话的消息不进 DOM)',
      !!(await page.locator('.t2-stream, .t2c-ta').first().count().catch(() => 0)), '')
  }

  fs.mkdirSync(CWD, { recursive: true })
  const aTxt = path.join(CWD, 'a.txt')
  // --reuse 时别动基线:那张待决计划卡是针对**当前** a.txt 内容提的
  if (!REUSE) fs.writeFileSync(aTxt, 'baseline\n')

  let sid
  if (REUSE) {
    sid = await page.evaluate(() => window.__forsionStore.getState().activeId)
    check('L1 复用当前会话里待决的那张计划卡', !!sid, `sid=${sid}`)
  } else {
    // 走**真实 UI 路径**建会话:侧栏工作区分组上的「＋」(`.t2s-group-add`,title 里带工作区名)。
    // ⚠️ 别用 store.createInWorkspace:它只改 activeId,**不开 tab**(开 tab 在 UI 层 —— store
    //    不能 import sessionNav,会成环)。结果是会话建好了、消息却压根不进 DOM,
    //    看起来跟「计划卡没出现」一模一样。08-18 在这上面白烧了两轮真模型。
    const before = await page.evaluate(() => window.__forsionStore.getState().activeId)
    // 必须走侧栏的「新建会话」(`.t2s-special-title` = sidebar.newChat)——只有它经 `openNewChat()`
    // **真的开一个 tab**。工作区分组行上的「＋」和 store.createInWorkspace 都只改 activeId:
    // 多标签下 activeId ≠ 可见面板的会话,于是消息进了 store 却不进 DOM,长得和「计划卡没出现」一样。
    const newBtn = page.locator('.t2s-special-title', { hasText: /新建会话|New chat/i }).first()
    await newBtn.waitFor({ state: 'visible', timeout: 15_000 })
    await newBtn.click()
    sid = await until(page, (prev) => {
      const id = window.__forsionStore.getState().activeId
      return id && id !== prev ? id : null
    }, 30_000, 800, before)
    check('L1 新建会话并真的开出 tab(走侧栏「新建会话」)', !!sid && sid !== before, `sid=${sid}`)
    if (!sid) { await browser.close(); process.exit(1) }

    // openNewChat 落在默认工作区 → 把 cwd/执行档补成本轮要测的那套
    await page.evaluate(({ s, cwd }) => window.__forsionStore.getState()
      .setExecConfig({ execMode: 'host', approvalMode: 'full-auto', cwd }, s), { s: sid, cwd: CWD })
    await sleep(800)
    await page.evaluate((s) => window.__forsionStore.getState().setSessionPlanMode(true, s), sid)
    await sleep(1500)
    const cfg = await page.evaluate((s) => window.__forsionStore.getState().configBySession?.[s], sid)
    // macOS 的 /tmp 是指向 /private/tmp 的软链,回来的 cwd 带 /private 前缀 —— 归一再比
    const same = (a, b) => String(a || '').replace(/^\/private/, '') === String(b || '').replace(/^\/private/, '')
    check('L2 计划模式与工作目录都落到了会话配置', !!cfg && cfg.planMode === true && same(cfg.cwd, CWD), JSON.stringify(cfg))

    await page.evaluate((s) => window.__forsionStore.getState()
      .send('Give me a short plan to append one line to a.txt.', undefined, undefined, undefined, undefined, s), sid)
  }

  // ── ⭐ 计划卡(真模型 + 引擎 <plan_submit_check> 兜底)
  // ⚠️ **必须按会话+消息定位,不能全局 querySelector('.plan-card')**:
  //   桌面是多标签的,DOM 上可能同时挂着别的会话的卡,而 `answerInquiry` 是按 `activeId` 去
  //   `messagesBySession` 里找消息的 —— 两边指的不是同一个会话时,答案就发给了别人。
  //   08-18 实测:全局选择器点一次「批准」,引擎侧 resolve 掉的是**另一个会话**的询问。
  //   另外并行会话可能把这个 dev 切到它自己的 tab(聊天面板整个不在 DOM 里),
  //   那种情况要报「UI 不在这个会话」,不能报成「计划卡没出现」——两者的修法完全不同。
  const found = await until(page, (s) => {
    const st = window.__forsionStore.getState()
    const msgs = st.messagesBySession?.[s] || []
    const m = msgs.find((x) => x.planProposal && (x.inquiries || []).some((q) => q.kind === 'plan' && q.status === 'pending'))
    if (!m) return null
    const root = document.getElementById(`tocmsg-${m.id}`)
    const card = root?.querySelector('.plan-card')
    const btns = [...(card?.querySelectorAll('.approval-actions button') || [])].map((b) => (b.textContent || '').trim())
    return { mid: m.id, inDom: !!root, btns, body: (card?.querySelector('.plan-body')?.textContent || '').slice(0, 120) }
  }, REUSE ? 15_000 : 300_000, 1500, sid) // 被催一次的那轮要跑两遍模型,180s 不够(实测)
  const plan = found && found.btns.length >= 3 ? found : null
  check('L3 ⭐ 计划卡出现(五按钮 + markdown 正文)', !!plan && plan.btns.length === 5,
    plan ? JSON.stringify(plan) : (found
      ? (found.inDom ? `消息在 DOM 但没有决策按钮:${JSON.stringify(found)}`
        : `⚠️ 该会话的消息压根不在 DOM —— UI 多半停在别的 tab(并行测试/用户切走了),不是计划卡的问题`)
      : '引擎没给出待决的计划询问'))
  const MSG = found?.mid

  // 无论成败都记一次:成功时说明兜底有没有参与(模型第一次就提交 = 0 次也是好结果)
  const nudged = nudgeCount(sid)
  console.log(`  ↳ 引擎催交事件 plan_submit_nudge = ${nudged} 次` + (plan
    ? (nudged > 0 ? '(兜底起作用了)' : '(模型第一次就提交,没用上兜底)')
    : (nudged > 0 ? '(兜底发了模型仍不提交 → 需要桌面侧手动提交入口)' : '(兜底没发 → 查 planMode 是否真到了引擎)')))

  // ── ⭐ 编辑后批准:执行的必须是我改的那版
  // ⚠️ 这段**刻意不 catch**:第一版把 click 包在 catch(()=>{}) 里,点击全部失败却报了 PASS
  //    (引擎侧事件停在 inquiry_request、根本没有 inquiry_result 才戳穿)。吞异常的断言比没断言更坏。
  let edited = false
  if (plan) {
    // 同上:锁定到那条消息里的卡,别用全局选择器(否则可能点到别的会话的卡)
    const btns = page.locator(`#tocmsg-${MSG} .plan-card .approval-actions button`)
    const editBtn = btns.filter({ hasText: /编辑/ }).first()
    await editBtn.waitFor({ state: 'visible', timeout: 15_000 })
    await editBtn.click()
    const ta = page.locator(`#tocmsg-${MSG} textarea.plan-edit`).first() // textarea 自身带这个类,不是它的子元素
    await ta.waitFor({ state: 'visible', timeout: 10_000 })
    await ta.fill(`Append exactly one line to a.txt: ${MARK}`)
    const typed = await ta.inputValue()
    check('L4a 编辑态文本框收下了我改的内容', typed.includes(MARK), JSON.stringify(typed.slice(0, 80)))
    // 编辑后首个按钮文案会变成「按我改的批准并执行」——顺带钉住这个提示
    const okBtn = btns.first()
    const label = (await okBtn.textContent() || '').trim()
    check('L4b 编辑后主按钮文案变成「按我改的…」(界面明示执行的是改过那版)', /按我改的|edited/i.test(label), JSON.stringify(label))
    await okBtn.click()
    edited = true
  }
  check('L4 「编辑计划」能进编辑态并提交', edited, edited ? '' : '没找到编辑按钮/文本框')

  // 引擎侧回执:点击有没有真送达(第一版就是死在这一步却报了绿)
  // 回执也只认这条消息自己的:全局查会读到别的会话残留的「已批准」= 假绿(栽过一次)
  const answered = !edited ? null : await until(page, (mid) => {
    const c = document.getElementById(`tocmsg-${mid}`)?.querySelector('.plan-verdict')
    return c ? c.textContent.trim() : null
  }, 30_000, 1000, MSG)
  if (edited) check('L4c 点击真送达引擎(卡上出现回执)', !!answered,
    (answered || '30s 内没有回执') + ` | 询问相关请求=${JSON.stringify(net)}`)

  if (edited) {
    let disk = ''
    for (let i = 0; i < 80; i++) {
      disk = fs.existsSync(aTxt) ? fs.readFileSync(aTxt, 'utf8') : ''
      if (disk.includes(MARK)) break
      await sleep(1500)
    }
    check(`L5 ⭐ 执行的是**我改的那版**(a.txt 出现 ${MARK})`, disk.includes(MARK), JSON.stringify(disk.slice(0, 120)))

    const plansDir = path.join(CWD, '.tangu/plans')
    const files = fs.existsSync(plansDir) ? fs.readdirSync(plansDir).filter((f) => f.startsWith('plan-')) : []
    const latest = files.map((f) => path.join(plansDir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
    const archived = latest ? fs.readFileSync(latest, 'utf8') : ''
    check('L6 ⭐ 存档存的是改过的那版(不是模型原稿)', !!archived && archived.includes(MARK),
      latest ? `${path.basename(latest)}: ${JSON.stringify(archived.slice(0, 100))}` : '没有 .tangu/plans 存档')
  }

  // ── 上下文浮层:装载的指令文件(有 AGENTS.md 时列出来)
  const ctxInfo = await page.evaluate((sid) => {
    const i = window.__forsionStore.getState().ctxInfoBySession?.[sid]
    return i ? { files: i.files || [], window: i.ctxWindow, source: i.ctxWindowSource, secs: (i.sections || []).length } : null
  }, sid).catch(() => null)
  const hasAgents = fs.existsSync(path.join(CWD, 'AGENTS.md'))
  check('L7 真引擎的 context_info 喂得饱 UI(窗口来源 + 分段)',
    !!ctxInfo && !!ctxInfo.source && ctxInfo.secs > 0, JSON.stringify(ctxInfo))
  check(`L8 指令文件${hasAgents ? '被列出' : '(工作区没有,跳过)'}`,
    !hasAgents || (!!ctxInfo && ctxInfo.files.some((f) => /AGENTS\.md/i.test(f))), JSON.stringify(ctxInfo?.files))

  await page.screenshot({ path: process.env.LIVE_SHOT || '/tmp/plan-live.png' }).catch(() => {})
  await browser.close().catch(() => {})

  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过  | 截图 ${process.env.LIVE_SHOT || '/tmp/plan-live.png'}`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
