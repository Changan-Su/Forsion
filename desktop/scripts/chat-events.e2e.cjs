/**
 * 聊天面「收到引擎事件后该长什么样」的整链 e2e:真 Electron × 真组件/store × 可编剧假引擎。
 * 补的是 UX 对标前四批此前只有单测+静态台架、**没有一条端到端**的那截接线:
 *   P1/B4 工具卡 diff · H3 成本闸预警 · H4 自动压缩提示 · H5/H8/B2 上下文分解 · H6 思考档降档 · P2 计划卡三态
 *
 * 每个场景 = 给桩排一份事件剧本 → 在输入框发一句 → 断言 UI。计划卡那两条还**反向断言 wire**:
 * 点「批准并开始执行」发出去的必须逐字是引擎认的那串,「编辑后批准」必须带修订标记 + 全文。
 *
 * 需先 npm run build。用法:npm run e2e:chatevents
 * 报「启动失败」= 有 dev 版 Electron 占着单实例锁,先 pkill -f "node_modules/electron/dist/Electron.app"。
 */
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.join(__dirname, '..')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
/** 本机环境让这一条区分不了新旧实现(前提不成立):不算 PASS、也不算 FAIL,单独计数、结尾点名(P1-KF 评审)。 */
function skip(name, detail) {
  results.push({ name, ok: true, skipped: true })
  console.log(`SKIP  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 's1', title: '端到端会话', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
  created_at: '2026-08-18 09:00:00', updated_at: '2026-08-18 09:00:00',
}

// P1-K3:第二个会话 —— 没订阅(没开过),只能靠引擎待批索引 GET /agent/approvals/pending 画「等你处理」点
const SESSION2 = { ...SESSION, id: 's2', title: '手机发起的远程会话', updated_at: '2026-08-18 08:00:00' }
const K3_UNIT = '6c1d7a4e-2b3f-4a5c-8d9e-0f1a2b3c4d5e'

const PLAN_APPROVE_AUTO = '批准,自动开始执行'
const PLAN_REVISION_MARK = '\n<<<REVISED_PLAN>>>\n'
const PLAN_OPTIONS = [PLAN_APPROVE_AUTO, '批准,退出计划模式(手动开始)', '需要修改(在输入框写反馈)', '拒绝,保持计划模式']

/**
 * 点之前先把目标滚到**视口中间**再点。
 * `scrollIntoViewIfNeeded()` 只保证「在视口内」,而悬浮输入区(`.composer-anchor`)是盖在底部的,
 * 贴着下沿的按钮照样点不到 —— playwright 会一路重试到 30s 超时,报 "subtree intercepts pointer events"。
 */
async function clickInView(loc) {
  await loc.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' })).catch(() => {})
  await loc.page().waitForTimeout(300)
  await loc.click()
}

/** 发一句话并等 run 走完(桩的事件流很短)。 */
async function send(win, text) {
  // ⚠️ 只认输入框自己的类。原来写成 `.t2c-ta, …, textarea` 的逗号选择器 + .first():
  // playwright 按 **DOM 顺序**取首个,于是上一幕留在编辑态的计划卡 textarea 排在前面,
  // 整条消息被打进了那张卡里(截图才看出来,断言只报「审批卡没渲染」)。
  const ta = win.locator('.t2c-ta').first()
  // 刚 reload / 刚切会话时输入框是 disabled 的,直接 click 会干等 30s 才报 not enabled
  for (let i = 0; i < 40; i++) {
    if (await ta.isEnabled().catch(() => false)) break
    await win.waitForTimeout(500)
  }
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(1800)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const stub = await startStubEngine({
    sessions: [SESSION, SESSION2],
    // 预置一条带 sketch 调用的历史消息:开场水合即走 recordToUi back-fill(F5 断言历史卡不丢)。
    messages: [{
      id: 'hm1', role: 'model', content: '历史前言。\n\n历史后记。', timestamp: 1755500000000,
      tool_calls: [{ id: 'hsk1', ui_content_offset: '历史前言。'.length, function: { name: 'sketch', arguments: JSON.stringify({ title: '历史卡', html: '<div id="hist">HISTORY-CARD</div>' }) } }],
      tool_results: [{ tool_call_id: 'hsk1', content: 'Sketch card rendered in the conversation.' }],
    }],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off', 'low', 'medium'] }],
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chatev-'))
  const app = await electron.launch({
    // -ApplePersistenceIgnoreState:强杀过的 Electron 下次启动先弹「重新打开窗口」模态框,firstWindow 等不到(台架纪律)
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    // FORSION_E2E_APPROVAL_DELIVERY:主进程 approvalDelivery 的 e2e 钩子(双闸,仅非打包):外部模式下改订桩的待批流、暴露 pending() 与真通知(场景 K3e–h)
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, FORSION_E2E_APPROVAL_DELIVERY: '1' },
  })

  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await win.waitForTimeout(1200)
    // 打开那个会话(侧栏行)。启动缺省是 Home Space(没有会话侧栏):先切 Tangu Space、侧栏切会话列表(同 chat-runstats)。
    // ⚠️ 找不到行必须抛错:点空了 send() 会从主页输入框隐式新建云端 sandbox 会话 —— A–D 照绿,
    //    E 段(审批档与「编辑规则…」只对 host 会话出)整片假红(09-27 E1/E2 就是这么红的)。
    await enterSpace(win, 'tangu')
    await win.waitForTimeout(1200)
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    const picker = win.locator('.t2sw-mode-picker').first()
    if (await picker.count().catch(() => 0)) {
      await picker.locator('.t2sw-mode-trigger').click().catch(() => {})
      await picker.locator('[data-workspace-mode="sessions"]').click().catch(() => {})
      await win.waitForTimeout(1000)
    }
    // 列表异步加载:有界等行出现;点完再确认 s1 真成了活动会话(同名行 ≠ 切过去了)
    const navFail = async (why) => {
      const shot = path.join(os.tmpdir(), 'forsion-chatev-nav-fail.png')
      await win.screenshot({ path: shot }).catch(() => {})
      throw new Error(`${why};截图 ${shot}`)
    }
    const row = win.locator(`.t2s-srow[data-sel-id="${SESSION.id}"]`).first()
    if (!(await row.waitFor({ timeout: 10_000 }).then(() => true, () => false))) await navFail('没找到会话行「端到端会话」')
    await row.click()
    if (!(await win.locator(`.t2s-srow.active[data-sel-id="${SESSION.id}"]`).first().waitFor({ timeout: 10_000 }).then(() => true, () => false))) {
      await navFail('点了会话行但 s1 没成为活动会话')
    }
    await win.waitForTimeout(1200)

    // ── 场景 A:工具卡 diff(P1)+ 成本闸(H3)+ 自动压缩(H4)+ 上下文分解(H5/H8/B2)+ 思考降档(H6)
    stub.script([
      { type: 'status', payload: {
        phase: 'context_info', ctxWindow: 272_000, ctxWindowSource: 'family',
        compactAt: 81_600, compactionEnabled: true, // 设置里把自动压缩阈值调到 30% 时引擎发的线(A4b)
        sections: [{ k: 'persona', tokens: 900 }, { k: 'skills', tokens: 1200 }],
        files: ['/tmp/demo/AGENTS.md'], filesTruncated: false, historyCount: 4, historyTokens: 2200,
        thinkingRequested: 'medium', thinkingEffective: 'low', modelId: 'm1', // 请求档须等于会话当前档,降档提示才显示(刻意的防陈旧闸)
      } },
      { type: 'tool_call', payload: { id: 't1', name: 'edit_file', arguments: JSON.stringify({
        path: 'src/app.ts', old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 42\nconst b = 2',
      }) } },
      { type: 'tool_result', payload: { id: 't1', result: 'edited src/app.ts', elapsedMs: 12 } },
      // 同一轮里再来一次**多文件** apply_patch:A1b/A1c 靠它,且不必额外发一条消息。
      { type: 'tool_call', payload: { id: 't9', name: 'apply_patch', arguments: JSON.stringify({
        patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n baseline\n+MULTI-A\n*** Add File: c.txt\n+MULTI-C\n*** End Patch',
      }) } },
      { type: 'tool_result', payload: { id: 't9', result: 'ok', elapsedMs: 9 } },
      { type: 'usage', payload: { prompt: 60_000, total: 200, costTotal: 16_500, costLimit: 20_000 } },
      { type: 'status', payload: { phase: 'compacted', savedChars: 4321, iteration: 2 } },
      // 真引擎紧跟 compacted 发的「压缩后占用」(A4c):其后本轮再没有 usage,环上的数只能来自它。
      { type: 'status', payload: { phase: 'compaction_budget', iteration: 2, beforeTokens: 60_000, afterTokens: 13_600, changed: true } },
      { type: 'token', payload: { delta: '改好了。' } },
    ])
    await send(win, '改一下 app.ts')
    await win.waitForTimeout(600)

    // 工具卡是**两级**折叠:先展开工具组,再展开那一行,才轮到 diff(ToolGroup.tsx 的结构)。
    // ⚠️ 作用域必须钉在**最后一个**工具组:开场预置的 sketch 历史消息自带一个工具组排在最前,
    //    first() 会展开历史组(F 场景加历史卡时 A1 就这么假红过)。
    const lastGroup = () => win.locator('.tool-group').last()
    await clickInView(lastGroup().locator('.tool-group-head')).catch(() => {})
    await win.waitForTimeout(500)
    await clickInView(lastGroup().locator('.tool-row-head').first()).catch(() => {})
    await win.waitForTimeout(900)
    const diffProbe = await win.evaluate(() => ({
      d2h: document.querySelectorAll('[class*="d2h-"]').length,
      ins: document.querySelectorAll('[class*="d2h-ins"], ins').length,
      raw42: document.body.innerText.includes('42'),
    }))
    check('A1 工具卡渲染真 diff(diff2html 节点存在,不是裸 JSON)', diffProbe.d2h > 0 && diffProbe.raw42,
      JSON.stringify(diffProbe))

    // A1b 多文件 apply_patch:每块必须自带文件名。单文件时 .d2h-file-header 是 display:none 的
    // (工具行标题已写了文件名),多文件再隐就变成「第二块像第一块的续篇」——08-18 真机走查报的。
    // 断言必须看**可见性**:textContent 在 display:none 下照样有,只查文本会假绿。
    // 同一个工具组里的第二行 = 那次多文件 apply_patch
    await clickInView(lastGroup().locator('.tool-row-head').nth(1)).catch(() => {})
    await win.waitForTimeout(900)
    // 按**内容**定位而不是「最后一行」:同一组里两行 diff 都展开着,位置不该成为断言的一部分。
    // 负对照并在同一次探测里 —— 同一页的单文件 diff(src/app.ts)标题必须仍然隐藏。
    let multi = { blocks: 0, names: [], single: null }
    for (let i = 0; i < 10; i++) {
      multi = await win.evaluate(() => {
        const read = (w) => {
          const h = w.querySelector('.d2h-file-header')
          const vis = !!h && getComputedStyle(h).display !== 'none' && h.getClientRects().length > 0
          return { name: (w.querySelector('.d2h-file-name')?.textContent || '').trim(), vis }
        }
        const all = [...document.querySelectorAll('.d2h-file-wrapper')].map(read)
        return {
          blocks: all.filter((x) => /a\.txt|c\.txt/.test(x.name)).length,
          names: all.filter((x) => x.vis && /a\.txt|c\.txt/.test(x.name)).map((x) => x.name),
          single: all.find((x) => /app\.ts/.test(x.name)) || null,
        }
      })
      if (multi.names.length >= 2) break
      await win.waitForTimeout(700)
    }
    check('A1b 多文件 patch:每个 diff 块显示自己的文件名(可见,非仅 DOM 存在)',
      multi.names.length === 2 &&
      multi.names.some((n) => n.includes('a.txt')) && multi.names.some((n) => n.includes('c.txt')),
      JSON.stringify(multi))
    check('A1c 负对照:同页的单文件 diff 仍不显示文件名标题(工具行已经写了)',
      !!multi.single && multi.single.vis === false, JSON.stringify(multi.single))

    const streamText = await win.evaluate(() => document.querySelector('.t2-stream')?.textContent || '')
    check('A2 成本过 80% 在流里落一条预警', /cost|成本|上限|80/i.test(streamText), `片段=${JSON.stringify(streamText.slice(-160))}`)
    check('A3 自动压缩落一条提示(带省下的量)', /压缩|compact/i.test(streamText), `片段=${JSON.stringify(streamText.slice(-160))}`)

    // 上下文环:hover 出分解浮层(窗口来源 + 分段)
    const ring = win.locator('.t2c-ctxring, [class*="ctxring"]').first()
    let ctxText = ''
    if (await ring.count().catch(() => 0)) {
      await ring.hover().catch(() => {})
      await win.waitForTimeout(800)
      ctxText = await win.locator('[class*="ctxinfo"], .t2c-ctxring-pop').first().textContent().catch(() => '')
    }
    check('A4 上下文浮层给出分解(装载文件/分段/窗口来源)',
      /AGENTS\.md|skills|persona|272|窗口/.test(ctxText || ''), `pop=${JSON.stringify((ctxText || '').slice(0, 120))}`)
    // A4b(09-20):浮层标出自动压缩线 —— 用引擎发的 compactAt(81.6k = 272k × 30%),点开后截图自查(CTXRING_SHOT)。
    await win.locator('.t2c-ctxring-btn').first().click().catch(() => {})
    await win.waitForTimeout(500)
    const popOpen = await win.locator('.t2c-ctxring.is-open .t2c-ctxring-pop').first().innerText().catch(() => '')
    check('A4b 浮层点开后有「到 81.6k tokens(30%)时自动压缩」一行', /自动压缩/.test(popOpen) && /30%/.test(popOpen) && /81\.6/.test(popOpen), `pop=${JSON.stringify(popOpen.slice(0, 160))}`)
    // A4c(09-20「压缩完进度圈不更新,发新消息才更新」):压缩后的占用当场上环,不等下一条 usage。
    check('A4c 压缩后进度环当场回落(13.6k,不是压缩前的 60.0k)', /13\.6k/.test(popOpen) && !/60\.0k/.test(popOpen), `pop=${JSON.stringify(popOpen.slice(0, 80))}`)
    await win.screenshot({ path: process.env.CTXRING_SHOT || '/tmp/ctxring-compactat.png' }).catch(() => {})
    await win.locator('.t2c-ctxring-btn').first().click().catch(() => {}) // 收起,别挡后面的场景
    await win.waitForTimeout(300)

    // 思考档降档标在模型药丸菜单的 Effort 当前值上(→ 生效档),得把菜单点开才看得到
    await win.locator('.model-pill-btn').first().click().catch(() => {})
    await win.waitForTimeout(700)
    const effortRow = await win.locator('.model-pill-wrap .cm-effort-value').first().textContent().catch(() => '')
    check('A5 思考档降档可见(菜单里标出 → 实际生效档)', /→/.test(effortRow || ''), `effort=${JSON.stringify(effortRow)}`)
    await win.keyboard.press('Escape').catch(() => {})
    await win.waitForTimeout(300)

    // 把 A 场景展开的两段 diff 收回去:它们撑得页面很长,后面计划卡的按钮会被 diff 行号与悬浮输入区
    // 轮流挡住(playwright 一路重试到 30s 超时,报 "subtree intercepts pointer events")。
    // 真实用法本来也是看完 diff 就收起来。(同样钉最后一组,别把历史 sketch 组点开。)
    await clickInView(lastGroup().locator('.tool-group-head')).catch(() => {})
    await win.waitForTimeout(500)

    // ── 场景 B:计划卡三态(P2)—— 批准发出的必须逐字是引擎认的那串
    // 计划正文留在流里的计划卡上;拍板区(五个决策按钮)在输入框上方的托盘里。
    stub.script([
      // 与真引擎同序:exit_plan_mode 本身是工具调用,tool_call 先到,再是 plan 与询问(评审 09-27:桩里不发 tool_call 会让判据只在桩里成立)
      { type: 'tool_call', payload: { id: 'tp1', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 实施计划' }) } },
      { type: 'plan', payload: { plan: '# 实施计划\n\n1. 先写测试\n2. 再改实现' } },
      { type: 'inquiry_request', payload: { inquiryId: 'q1', question: '计划已就绪(见上方计划卡)。是否批准并退出计划模式?', options: PLAN_OPTIONS, allowFreeText: true, kind: 'plan' } },
      { type: '__hold' }, // 真引擎此刻阻塞在 requestInquiry 上;桩收到回答时补发 inquiry_result + done(与真引擎同序)
    ])
    await send(win, '给个计划')
    await win.waitForTimeout(900)

    const planProbe = await win.evaluate(() => {
      const card = document.querySelector('.plan-card')
      const tray = document.querySelector('.t2c-apv [data-plan-decision]')
      return {
        card: !!card,
        markdown: !!card?.querySelector('.plan-body h1, .plan-body ol, .plan-body li'),
        cardButtons: card ? card.querySelectorAll('.approval-actions .btn').length : 0,
        pointer: !!card?.querySelector('[data-plan-pointer]'),
        trayButtons: tray ? tray.querySelectorAll('.approval-actions .btn').length : 0,
        genericInquiry: document.querySelectorAll('.inquiry-card').length,
        waitingYou: !!card?.closest('[id^="tocmsg-"]')?.querySelector('.tool-group [data-waiting-you]'),
        shimmer: !!card?.closest('[id^="tocmsg-"]')?.querySelector('.tool-group .chat-run-shimmer-text'),
      }
    })
    check('B1b 等你拍板时 exit_plan_mode 那行显示「等你回复」,不是流光装忙', !!planProbe.card && planProbe.waitingYou && !planProbe.shimmer,
      JSON.stringify({ waitingYou: planProbe.waitingYou, shimmer: planProbe.shimmer }))
    check('B1 计划卡:markdown 正文留在流里(只留一行指路),五个决策按钮在输入框上方的托盘里',
      planProbe.card && planProbe.markdown && planProbe.cardButtons === 0 && planProbe.pointer && planProbe.trayButtons === 5, JSON.stringify(planProbe))
    check('B2 不再另起一张通用询问卡(计划询问归计划卡)', planProbe.genericInquiry === 0, JSON.stringify(planProbe))
    await win.screenshot({ path: process.env.PLAN_SHOT || '/tmp/tray-plan.png' }).catch(() => {}) // 观感自查:流里正文 + 托盘拍板

    stub.seen.inquiries.length = 0
    await win.waitForTimeout(400) // 换卡冷却(ApprovalTray ARM_MS)
    await win.locator('.t2c-apv [data-plan-decision] .approval-actions .btn').first().click()
    await win.waitForTimeout(1200)
    check('B3 ⚠️「批准并开始执行」发出的是引擎逐字认的那串,且答的就是这条询问',
      stub.seen.inquiries[0]?.answer === PLAN_APPROVE_AUTO && stub.seen.inquiries[0]?.inquiryId === 'q1', JSON.stringify(stub.seen.inquiries[0]))
    await win.waitForTimeout(600)
    const planAfter = await win.evaluate(() => ({
      trayPlan: !!document.querySelector('.t2c-apv [data-plan-decision]'),
      verdict: (document.querySelector('.plan-card .plan-verdict')?.textContent || '').trim(),
    }))
    // 判据只看裁决文字:桩发完回执紧跟 done,done 会让本 run 的待办统统过期,「托盘清空」本身证明不了回执对上了
    check('B4 引擎回执到了:流里的计划卡写上「已批准」', /已批准/.test(planAfter.verdict), JSON.stringify(planAfter))

    // ── 场景 C:编辑后批准 —— 必须带修订标记 + 改后的全文(编辑框也在托盘里)
    stub.script([
      { type: 'tool_call', payload: { id: 'tp2', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# 旧计划' }) } },
      { type: 'plan', payload: { plan: '# 旧计划\n\n1. 随便做做' } },
      { type: 'inquiry_request', payload: { inquiryId: 'q2', question: '计划已就绪(见上方计划卡)。是否批准并退出计划模式?', options: PLAN_OPTIONS, allowFreeText: true, kind: 'plan' } },
      { type: '__hold' },
    ])
    await send(win, '再给个计划')
    await win.waitForTimeout(900)

    const decision = win.locator('.t2c-apv [data-plan-decision]').first()
    await win.waitForTimeout(400) // 换卡冷却
    await decision.locator('.approval-actions .btn', { hasText: '编辑计划' }).first().click()
    await win.waitForTimeout(500)
    const ta = decision.locator('textarea.plan-edit').first()
    await ta.click()
    await ta.fill('# 我改过的计划\n\n1. 先补回滚方案')
    await win.waitForTimeout(300)
    stub.seen.inquiries.length = 0
    await decision.locator('.approval-actions .btn').first().click()
    await win.waitForTimeout(1200)
    const ans = stub.seen.inquiries[0]?.answer || ''
    check('C1 ⚠️编辑后批准:头部仍是批准选项,后面挂修订标记 + 改后的全文,且答的就是这条询问',
      ans.startsWith(PLAN_APPROVE_AUTO) && ans.includes(PLAN_REVISION_MARK) && ans.includes('先补回滚方案') && stub.seen.inquiries[0]?.inquiryId === 'q2',
      JSON.stringify({ id: stub.seen.inquiries[0]?.inquiryId, ans: ans.slice(0, 80) }))
    await win.waitForTimeout(600) // 回答一到桩就收尾这条 run,托盘清空,不串进后面的场景

    // ── 场景 Q:Agent 的提问(ask_user)进托盘 —— 待答时整张在输入框上方,流里只留一行指路;答完流里留问答记录
    stub.script([
      { type: 'token', payload: { delta: '开工前确认一下。' } },
      { type: 'tool_call', payload: { id: 'ta1', name: 'ask_user', arguments: JSON.stringify({ question: '用哪个包管理器?', options: ['npm', 'pnpm'] }) } },
      { type: 'inquiry_request', payload: { inquiryId: 'qa1', question: '用哪个包管理器?', options: ['npm', 'pnpm'], allowFreeText: true } },
      { type: '__hold' },
    ])
    await send(win, '装一下依赖')
    const askProbe = await win.evaluate(() => {
      const body = document.querySelector('.t2c-apv .t2c-apv-body')
      return {
        kind: body?.getAttribute('data-tray-kind'),
        question: (body?.querySelector('.inquiry-q')?.textContent || '').trim(),
        options: body ? body.querySelectorAll('.inquiry-opts .btn').length : 0,
        streamCards: document.querySelectorAll('.t2-stream .inquiry-card').length,
        pointer: !!document.querySelector('.t2-stream [data-inquiry-pointer]'),
        waitingYou: !!document.querySelector('.t2-stream .tool-group [data-waiting-you]'),
      }
    })
    check('Q1 提问整张进托盘(问题 + 选项),流里不插待答卡、只留一行指路;ask_user 那行显示「等你回复」',
      askProbe.kind === 'inquiry' && /包管理器/.test(askProbe.question) && askProbe.options === 2 && askProbe.streamCards === 0 && askProbe.pointer && askProbe.waitingYou,
      JSON.stringify(askProbe))
    await win.screenshot({ path: process.env.ASK_SHOT || '/tmp/tray-ask.png' }).catch(() => {}) // 观感自查:提问在托盘
    stub.seen.inquiries.length = 0
    await win.locator('.t2c-apv .inquiry-opts .btn', { hasText: 'pnpm' }).first().click()
    await win.waitForTimeout(800)
    check('Q2 在托盘里点选项 → 答案送达引擎,答的就是这条询问', stub.seen.inquiries[0]?.answer === 'pnpm' && stub.seen.inquiries[0]?.inquiryId === 'qa1', JSON.stringify(stub.seen.inquiries[0]))
    await win.waitForTimeout(600)
    const askAfter = await win.evaluate(() => ({
      tray: document.querySelectorAll('[data-approval-tray]').length,
      record: (document.querySelector('.t2-stream .inquiry-card.resolved')?.textContent || '').trim(),
    }))
    // 判据只看问答记录(理由同 B4:done 会让待办过期,托盘清空本身不算数)
    check('Q3 回执后流里留下问答记录(问题 + 我的回答)', /包管理器/.test(askAfter.record) && /pnpm/.test(askAfter.record), JSON.stringify(askAfter))

    // ── 场景 F:sketch 卡(agent 在对话流里画可交互 HTML 卡片)
    // 钉四件:直播上卡(挂 tool_result 非 tool_call)/ 被引擎拒的不画 / 沙箱铁律(仅 allow-scripts
    // + 内层 CSP 真断网,在**真 Electron** 里实证而非单测纸面)/ 历史水合 back-fill 卡不丢。
    stub.script([
      { type: 'token', payload: { delta: '先看第一张。' } },
      { type: 'tool_call', payload: { id: 'sk1', name: 'sketch', arguments: JSON.stringify({
        title: '柱状图',
        html: '<div id="skp">SKETCH-LIVE</div><div id="net">NET-?</div>' +
          '<script>document.getElementById("skp").textContent+="-JS";' +
          'fetch("https://example.com").then(function(){document.getElementById("net").textContent="NET-OPEN"})' +
          '.catch(function(){document.getElementById("net").textContent="NET-BLOCKED"})</script>',
      }) } },
      { type: 'tool_result', payload: { id: 'sk1', result: 'Sketch card rendered in the conversation.' } },
      { type: 'token', payload: { delta: '第一张说明完成，接着看第二张。' } },
      { type: 'tool_call', payload: { id: 'sk2', name: 'sketch', arguments: JSON.stringify({ html: '<p>SECOND-CARD</p>' }) } },
      { type: 'tool_result', payload: { id: 'sk2', result: 'Sketch card rendered in the conversation.' } },
      { type: 'token', payload: { delta: '第二张之后是完整数据图。' } },
      // 超高卡:钉折叠闸(默认高度上限 = 右侧车道两卡的高度,超了才露展开钮)。
      // ⚠️故意写成**一张像样的真卡**而不是空白占位:观感自查那两张截图(明/暗)要能看出
      // 主题桥 + 基础排版对不对 —— 空 div 什么都验不出来。只用 --fs-* 变量,一个色值都不硬编码。
      { type: 'tool_call', payload: { id: 'sk4', name: 'sketch', arguments: JSON.stringify({
        title: '模型调用量',
        html: '<div id="tall">' +
          '<header class="fs-header"><div class="fs-eyebrow">Usage pulse · 7 days</div>' +
          '<h1 class="fs-title">桌面端承担了近一半调用</h1>' +
          '<p class="fs-subtitle">按客户端统计 · 长度 = 调用次数 · 2026-08-14 → 08-20</p></header>' +
          '<div class="fs-stat-grid"><div class="fs-stat"><div class="fs-value">2,765</div><div class="fs-label">总调用</div></div>' +
          '<div class="fs-stat"><div class="fs-value">46%</div><div class="fs-label">来自 desktop</div></div>' +
          '<div class="fs-stat"><div class="fs-value">1.2s</div><div class="fs-label">desktop P50</div></div></div>' +
          '<figure class="fs-plot" aria-label="近 7 日各端模型调用量横向条形图">' +
          [['desktop', 1284, 1], ['web', 806, 2], ['mobile', 412, 3], ['cli', 189, 4], ['channel', 74, 5]]
            .map(([n, v, s]) =>
              '<div class="fs-row" style="margin-bottom:10px">' +
              `<div style="width:62px;font-size:10.5px;font-weight:650;color:var(--fs-muted)">${n}</div>` +
              // ⚠️条宽写在**内层**:外层 flex:1 是轨道,给内层写 width:% 会被 flex 尺寸压掉(条永远满宽)
              `<div class="fs-bar-track" style="flex:1"><div class="fs-bar-fill" style="background:var(--fs-s${s});width:${Math.round((v / 1284) * 100)}%"></div></div>` +
              `<div style="width:46px;text-align:right;font-family:var(--fs-mono);font-size:11px;font-variant-numeric:tabular-nums">${v.toLocaleString('en-US')}</div>` +
              '</div>').join('') +
          '<figcaption class="fs-caption">desktop 的调用量是 mobile 的 3.1 倍；channel 仍是长尾入口。</figcaption></figure>' +
          '<div class="fs-panel" style="margin-top:18px"><table><thead><tr><th>端</th><th>P50</th><th>P95</th></tr></thead><tbody>' +
          '<tr><td>desktop</td><td>1.2s</td><td>4.8s</td></tr>' +
          '<tr><td>web</td><td>1.4s</td><td>6.1s</td></tr>' +
          '<tr><td>mobile</td><td>2.0s</td><td>9.3s</td></tr>' +
          '</tbody></table></div>' +
          '<footer class="fs-source">来源 · api_usage_logs · 失败请求已排除</footer>' +
          // 撑高到必然超过折叠上限(折叠闸要可测),同时不影响上面那段的观感
          '<div style="height:900px"></div></div>',
      }) } },
      { type: 'tool_result', payload: { id: 'sk4', result: 'Sketch card rendered in the conversation.' } },
      // 引擎尺寸闸拒掉的调用:isError=true → 不许画卡(渲染挂 tool_result 的原因)
      { type: 'tool_call', payload: { id: 'sk3', name: 'sketch', arguments: JSON.stringify({ html: '<p>REJECTED-CARD</p>' }) } },
      { type: 'tool_result', payload: { id: 'sk3', result: 'Error: html too large', isError: true } },
      { type: 'token', payload: { delta: '三张草图都画好了。' } },
    ])
    await send(win, '画两张卡')
    await win.waitForTimeout(1500)

    // 沙箱无 allow-same-origin ⇒ 页面侧 contentDocument 拿不到,卡内探针统一走 Playwright CDP frame。
    const probeFrames = async (id) => {
      for (const fr of win.frames()) {
        try {
          if (await fr.locator(`#${id}`).count()) return fr
        } catch { /* frame 可能已卸载 */ }
      }
      return null
    }
    const skProbe = await win.evaluate(() => {
      const cards = [...document.querySelectorAll('.sketch-card')]
      return {
        count: cards.length,
        titles: cards.map((c) => (c.querySelector('.sketch-card-title')?.textContent || '').trim()).filter(Boolean),
        sandboxes: cards.map((c) => c.querySelector('iframe')?.getAttribute('sandbox')),
      }
    })
    check('F1 sketch 直播上卡:本轮三张 + 历史一张,标题可选', skProbe.count === 4 && skProbe.titles.includes('柱状图'), JSON.stringify(skProbe))
    const liveOrder = await win.evaluate(() => {
      const msg = [...document.querySelectorAll('.t2-asst')].findLast((el) => el.querySelector('[data-sketch-call-id="sk1"]'))
      if (!msg) return []
      return [...msg.querySelectorAll('.t2-content, .sketch-card')].map((el) =>
        el.classList.contains('sketch-card')
          ? `sketch:${el.getAttribute('data-sketch-call-id')}`
          : `text:${(el.textContent || '').trim()}`)
    })
    check('F1b 多草图按调用位置夹在正文中间(不再统一堆到消息末尾)',
      liveOrder[0]?.includes('先看第一张') && liveOrder[1] === 'sketch:sk1' &&
      liveOrder[2]?.includes('接着看第二张') && liveOrder[3] === 'sketch:sk2' &&
      liveOrder[4]?.includes('完整数据图') && liveOrder[5] === 'sketch:sk4' &&
      liveOrder[6]?.includes('三张草图都画好了'), JSON.stringify(liveOrder))
    const fusedCard = await win.evaluate(() => {
      const card = document.querySelector('[data-sketch-call-id="sk1"]')
      if (!card) return null
      const s = getComputedStyle(card)
      return {
        border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
        borderStyle: s.borderTopStyle,
        borderColor: s.borderTopColor,
        shadow: s.boxShadow,
        cardBg: s.backgroundColor,
        pageBg: getComputedStyle(document.body).backgroundColor,
      }
    })
    const fusedFrame = await probeFrames('skp')
    const fusedInnerBg = fusedFrame
      ? await fusedFrame.evaluate(() => getComputedStyle(document.body).backgroundColor).catch(() => '')
      : ''
    check('F1c Sketch 内容面仅有淡描边,内外画布透明以透出任意 Chat View 底色',
      !!fusedCard && fusedCard.border.every((v) => v === '1px') && fusedCard.borderStyle === 'solid' &&
      fusedCard.borderColor !== 'rgba(0, 0, 0, 0)' && fusedCard.shadow === 'none' &&
      fusedCard.cardBg === 'rgba(0, 0, 0, 0)' && fusedInnerBg === 'rgba(0, 0, 0, 0)',
      JSON.stringify({ ...fusedCard, innerBg: fusedInnerBg }))
    // DESIGN.md §8 观感仪器:截整条消息而非单卡,肉眼确认卡真的夹在段落之间。
    const inlineMessage = win.locator('.t2-asst:has([data-sketch-call-id="sk1"])').last()
    await inlineMessage.scrollIntoViewIfNeeded().catch(() => {})
    await win.waitForTimeout(300)
    await inlineMessage.screenshot({ path: process.env.SKETCH_INLINE_SHOT || '/tmp/sketch-inline-order.png' }).catch(() => {})
    check('F2 ⚠️沙箱铁律:每张卡 sandbox 恒为仅 allow-scripts', skProbe.sandboxes.length === 4 && skProbe.sandboxes.every((s) => s === 'allow-scripts'), JSON.stringify(skProbe.sandboxes))
    check('F3 被引擎拒掉的 sketch(isError)不画卡', skProbe.count === 4, `count=${skProbe.count}`)

    // 卡内探针:JS 真跑 + 网络真断(内层 CSP 收口;裸 sandbox 是挡不住 fetch 的,此断言在真 Electron 里钉死)。
    let inFrame = { js: '', net: '' }
    for (let i = 0; i < 10; i++) {
      const fr = await probeFrames('skp')
      if (fr) {
        inFrame.js = (await fr.locator('#skp').textContent().catch(() => '')) || ''
        inFrame.net = (await fr.locator('#net').textContent().catch(() => '')) || ''
      }
      if (inFrame.net && inFrame.net !== 'NET-?') break
      await win.waitForTimeout(500)
    }
    check('F4 卡内 JS 可跑(交互能力在)', inFrame.js === 'SKETCH-LIVE-JS', JSON.stringify(inFrame))
    check('F4b ⚠️卡内 fetch 被内层 CSP 掐死(无网络)', inFrame.net === 'NET-BLOCKED', JSON.stringify(inFrame))

    // 高度自适应:小卡应收到内容高(≈几十px),还停在 220 初始占位=postMessage 通道断了
    const skHeights = await win.evaluate(() =>
      [...document.querySelectorAll('.sketch-frame')].map((f) => parseFloat(getComputedStyle(f).height)))
    check('F5 高度上报通道工作(小卡收窄,不停在初始占位)', skHeights.some((h) => h > 0 && h < 200), JSON.stringify(skHeights))

    // 历史水合 back-fill:开场预置的那条历史消息的卡,现在还必须在(HTML 只活在 tool_call 参数里)
    const histFr = await probeFrames('hist')
    const histCard = histFr ? (await histFr.locator('#hist').textContent().catch(() => '')) || '' : ''
    check('F6 ⚠️历史水合 back-fill:重载路径的卡不丢', histCard === 'HISTORY-CARD', JSON.stringify(histCard))
    const historyOrder = await win.evaluate(() => {
      const msg = document.querySelector('[data-sketch-call-id="hsk1"]')?.closest('.t2-asst')
      if (!msg) return []
      return [...msg.querySelectorAll('.t2-content, .sketch-card')].map((el) =>
        el.classList.contains('sketch-card') ? `sketch:${el.getAttribute('data-sketch-call-id')}` : `text:${(el.textContent || '').trim()}`)
    })
    check('F6b ⚠️历史重载仍恢复正文 → Sketch → 正文的位置',
      historyOrder[0]?.includes('历史前言') && historyOrder[1] === 'sketch:hsk1' && historyOrder[2]?.includes('历史后记'),
      JSON.stringify(historyOrder))

    // 折叠闸:1400px 的卡必须被夹到「右侧车道卡」那么高并露出展开钮;小卡一律不露钮。
    const foldProbe = await win.evaluate(() => {
      const cards = [...document.querySelectorAll('.sketch-card')]
      const tall = cards.find((c) => c.querySelector('.sketch-card-toggle'))
      const clip = tall?.querySelector('.sketch-clip')
      return {
        toggles: cards.filter((c) => c.querySelector('.sketch-card-toggle')).length,
        clipH: clip ? Math.round(clip.getBoundingClientRect().height) : 0,
        frameH: clip ? Math.round(clip.querySelector('iframe').getBoundingClientRect().height) : 0,
        faded: !!clip?.classList.contains('faded'),
      }
    })
    check('F7 折叠闸:只有超高卡露展开钮,且卡身被夹在 iframe 内容高之下',
      foldProbe.toggles === 1 && foldProbe.clipH > 100 && foldProbe.clipH < foldProbe.frameH && foldProbe.faded,
      JSON.stringify(foldProbe))

    await win.locator('.sketch-card-toggle').first().click().catch(() => {})
    await win.waitForTimeout(400)
    const openedH = await win.evaluate(() => {
      const clip = document.querySelector('.sketch-clip.open')
      return clip ? Math.round(clip.getBoundingClientRect().height) : 0
    })
    check('F8 展开后放全高(且钮还在,收得回去)', openedH > foldProbe.clipH + 200, `${foldProbe.clipH} → ${openedH}`)
    await win.locator('.sketch-card-toggle').first().click().catch(() => {})
    await win.waitForTimeout(300)

    // 主题桥:首帧变量必须已在卡内(不是换肤后才补),且换肤走 postMessage **就地改**——
    // iframe 若重载,预置的 window.__alive 会没,那说明 srcdoc 被重建了(卡内交互状态全丢)。
    const themeFr = await probeFrames('skp')
    let theme = { firstBg: '', afterBg: '', firstText: '', afterText: '', alive: '' }
    if (themeFr) {
      const firstTheme = await themeFr.evaluate(() => {
        window.__alive = 'YES'
        const s = getComputedStyle(document.documentElement)
        return {
          bg: s.getPropertyValue('--fs-bg').trim(),
          text: s.getPropertyValue('--fs-text').trim(),
        }
      }).catch(() => ({ bg: '', text: '' }))
      theme.firstBg = firstTheme.bg
      theme.firstText = firstTheme.text
      // ⚠️暗色 token 挂在 `:root.dark`(base.css),data-mode 只管 color-scheme —— 只翻 data-mode
      // 量不出颜色变化(F10 曾因此假红)。两个一起翻才是宿主真实的换肤动作。
      const prevMode = await win.evaluate(() => {
        const r = document.documentElement, p = r.getAttribute('data-mode') || ''
        const wasDark = r.classList.contains('dark')
        r.classList.toggle('dark', !wasDark)
        r.setAttribute('data-mode', wasDark ? 'light' : 'dark')
        return { mode: p, dark: wasDark }
      })
      await win.waitForTimeout(500)
      const after = await themeFr.evaluate(() => ({
        bg: getComputedStyle(document.documentElement).getPropertyValue('--fs-bg').trim(),
        text: getComputedStyle(document.documentElement).getPropertyValue('--fs-text').trim(),
        alive: window.__alive || '',
      })).catch(() => ({ bg: '', text: '', alive: '' }))
      theme.afterBg = after.bg
      theme.afterText = after.text
      theme.alive = after.alive
      // 观感自查(DESIGN.md §8)的暗色那张:趁翻过去时留一张,免得另起一轮
      const visualCard = win.locator('.sketch-card:has(.sketch-card-toggle)').first()
      await visualCard.scrollIntoViewIfNeeded().catch(() => {})
      await win.waitForTimeout(300)
      await visualCard.screenshot({ path: process.env.SKETCH_SHOT_DARK || '/tmp/sketch-cards-dark.png' }).catch(() => {})
      await win.evaluate((p) => {
        const r = document.documentElement
        r.classList.toggle('dark', p.dark)
        if (p.mode) r.setAttribute('data-mode', p.mode); else r.removeAttribute('data-mode')
      }, prevMode)
      await win.waitForTimeout(300)
    }
    check('F9 主题桥:首帧画布透明且文字 token 已在卡内(不靠换肤补)',
      theme.firstBg === 'transparent' && /\S/.test(theme.firstText), JSON.stringify(theme))
    check('F10 ⚠️换肤就地改变量,iframe 不重载(重载=卡内交互状态全丢)',
      theme.afterBg === 'transparent' && theme.afterText !== '' && theme.afterText !== theme.firstText && theme.alive === 'YES', JSON.stringify(theme))

    // 观感自查(DESIGN.md §8):几何断言全绿 ≠ 看起来对,留一张卡片实景
    const visualCard = win.locator('.sketch-card:has(.sketch-card-toggle)').first()
    await visualCard.scrollIntoViewIfNeeded().catch(() => {})
    await win.waitForTimeout(500)
    await visualCard.screenshot({ path: process.env.SKETCH_SHOT || '/tmp/sketch-cards.png' }).catch(() => {})


    // ── 场景 D:审批卡的「为什么问你」(B3)+ 工作区外写入警示仍在(台账里挂着的那条未验)
    // 三种 reason 各来一张卡,一次断完:custom-ask 要报出**命中的规则串**,escalate 与 custom-ask
    // 还必须**藏掉「总允许」**——引擎对这两种情形是静默降级为单次批准的(approvals.ts 明写),
    // 按钮照常显示就又是一处「界面说一套引擎做一套」。
    stub.script([
      // 排最前(托盘缺省展开它):D1-D5 点开的是后三张;这张只给 D6-D8(长 diff 撑破 .approval-diff 的滚动盒)
      { type: 'approval_request', payload: {
        approvalId: 'a0', name: 'write_file',
        arguments: JSON.stringify({ path: '/tmp/demo/tall.txt', content: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') }),
        preview: 'write /tmp/demo/tall.txt (60 lines)', reason: { kind: 'mode', mode: 'auto-edit' },
      } },
      { type: 'approval_request', payload: {
        approvalId: 'a1', name: 'run_bash', arguments: JSON.stringify({ command: 'npm publish' }),
        preview: '$ npm publish', reason: { kind: 'custom-ask', rule: 'run_bash:npm publish', mode: 'auto-edit' },
      } },
      { type: 'approval_request', payload: {
        approvalId: 'a2', name: 'write_file', arguments: JSON.stringify({ path: '/etc/hosts', content: 'x' }),
        preview: '⚠ 工作区外写入 · write /etc/hosts (1 chars)', reason: { kind: 'escalate', mode: 'auto-edit' },
      } },
      { type: 'approval_request', payload: {
        approvalId: 'a3', name: 'run_bash', arguments: JSON.stringify({ command: 'make build' }),
        preview: '$ make build', reason: { kind: 'mode', mode: 'auto-edit' },
      } },
      { type: '__hold' },
    ])
    await send(win, '跑几个要批准的动作')
    await win.waitForTimeout(1200)
    // 审批卡在输入框上方的托盘里攒着(一次展开一张,其余缩成行),流里只留一行指路。先断托盘本身,再逐张点开读。
    const tray = await win.evaluate(() => ({
      count: document.querySelector('[data-approval-tray]')?.getAttribute('data-approval-tray'),
      inComposer: !!document.querySelector('.composer-anchor .t2c-apv'),
      streamCards: document.querySelectorAll('.t2-stream .approval-card').length,
      pointer: document.querySelector('.t2-stream [data-approval-pointer]')?.getAttribute('data-approval-pointer'),
      rows: document.querySelectorAll('.t2c-apv-row').length,
    }))
    check('D0 四个待批审批攒进输入框上方的托盘(一张展开 + 三行排队),流里不插整张卡、只留一行指路',
      tray.count === '4' && tray.inComposer && tray.streamCards === 0 && tray.pointer === '4' && tray.rows === 3, JSON.stringify(tray))
    // 观感自查:托盘在真实悬浮输入区里的整窗实景(DESIGN §8)
    await win.screenshot({ path: process.env.TRAY_SHOT || '/tmp/approval-tray.png' }).catch(() => {})
    const openTrayCard = async (rowText) => {
      await win.locator('.t2c-apv-row', { hasText: rowText }).first().click().catch(() => {})
      await win.waitForTimeout(250)
      return win.evaluate(() => {
        const c = document.querySelector('.t2c-apv .approval-card')
        return c && {
          why: (c.querySelector('.approval-why')?.textContent || '').trim(),
          preview: (c.querySelector('.approval-preview')?.textContent || '').trim(),
          btns: [...c.querySelectorAll('.approval-actions button')].map((b) => (b.textContent || '').trim()),
        }
      })
    }
    const ask = await openTrayCard('npm publish')
    const esc = await openTrayCard('/etc/hosts')
    const mode = await openTrayCard('make build')
    const apv = [ask, esc, mode]
    check('D1 custom-ask 的卡解释「哪条规则要求问你」(带规则串)',
      !!ask && /run_bash:npm publish/.test(ask.why), JSON.stringify(ask))
    check('D2 escalate 的卡解释「要写工作区以外的文件」',
      !!esc && /工作区以外|outside the workspace/i.test(esc.why), JSON.stringify(esc?.why))
    check('D3 ⚠️「工作区外写入」警示仍在 preview 里(解释只能附加,不能顶替)',
      !!esc && esc.preview.includes('⚠ 工作区外写入'), JSON.stringify(esc?.preview))
    check('D4 mode 的卡解释「当前档位要求批准」(带生效档)',
      !!mode && mode.why.length > 0 && /自动编辑|Auto edit/i.test(mode.why), JSON.stringify(mode?.why))
    check('D5 ⚠️escalate/custom-ask 不给「总允许」(引擎对这两种就是不记),普通档给',
      !!ask && ask.btns.length === 2 && !!esc && esc.btns.length === 2 && !!mode && mode.btns.length === 3,
      JSON.stringify(apv.slice(-3).map((x) => x.btns)))

    // D6-D8(2026-09-21 实报「审批卡代码区异常显示、点不了批准」):d2h 行号格是 position:absolute,
    // 宿主不给定位祖先时它的包含块落到 .t2-chat-body —— 逃出 .approval-diff 与 .t2-stream 两层滚动盒,
    // 冻在未滚动的位置上压住别处的按钮。D6 是判别式(修前 gutter=0);D7/D8 是症状面。
    await win.locator('.t2c-apv-row', { hasText: 'tall.txt' }).first().click().catch(() => {})
    await win.waitForTimeout(700) // 换卡冷却(ApprovalTray ARM_MS)过去,按钮才接收点击
    const tall = win.locator('.t2c-apv .approval-card', { hasText: 'tall.txt' }).first()
    const gut = await tall.evaluate((card) => {
      const box = card.querySelector('.approval-diff')
      const tr = card.querySelectorAll('.d2h-diff-tbody tr')[5]
      const ln = tr.querySelector('.d2h-code-linenumber')
      box.scrollTop = 0
      const r0 = tr.getBoundingClientRect().top, g0 = ln.getBoundingClientRect().top
      box.scrollTop = 150
      const out = { scrolled: box.scrollTop, row: Math.round(tr.getBoundingClientRect().top - r0), gutter: Math.round(ln.getBoundingClientRect().top - g0) }
      box.scrollTop = 0
      const btn = card.querySelector('.approval-actions .btn.primary'), b = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      return { ...out, hitOk: btn.contains(hit), hit: hit ? `${hit.tagName}.${hit.className}` : null }
    }).catch((e) => ({ err: String(e) }))
    check('D6 ⚠️长 diff 审批卡:纵滚时行号格跟着行走(不逃出 .approval-diff)',
      gut.scrolled === 150 && gut.row === -150 && gut.gutter === gut.row, JSON.stringify(gut))
    check('D7 「批准」命中测试落在按钮上(没被行号格盖住)', !!gut.hitOk, JSON.stringify(gut))
    await tall.screenshot({ path: process.env.APPROVAL_SHOT || '/tmp/approval-tall-diff.png' }).catch(() => {})
    await tall.locator('.approval-actions .btn.primary').click({ timeout: 3000 }).catch(() => {})
    await win.waitForTimeout(500)
    check('D8 真鼠标点得到「批准」且送达引擎', stub.seen.approvals.some((a) => a.approvalId === 'a0' && a.action === 'approve'),
      JSON.stringify(stub.seen.approvals))
    // D9 换卡冷却:托盘里下一张会原地顶上来,连点两下「批准」不能把没看过的那张也批了 ——
    // 展开的卡一换,按钮先不接收点击,片刻后才生效。
    await win.locator('.t2c-apv-row').first().click().catch(() => {})
    const armingNow = await win.evaluate(() => !!document.querySelector('.t2c-apv-body.is-arming'))
    await win.waitForTimeout(700)
    const armedLater = await win.evaluate(() => !document.querySelector('.t2c-apv-body.is-arming') && !!document.querySelector('.t2c-apv .approval-actions'))
    check('D9 换卡冷却:刚换上的卡按钮先不接收点击,片刻后恢复', armingNow && armedLater, JSON.stringify({ armingNow, armedLater }))

    // ── 场景 P:挂起审批(审批托盘 run)—— 要批的调用挂起、agent 接着干活;拍板后真结果回填**原**工具卡,
    // 结局以一行通知进对话(<approval_update> 落库行,不是用户气泡、不进 ↑ 历史)。引擎那半在 tangu-agent
    // test/agentLoopParkedApprovals.test.ts + live --only parked;这里钉渲染层对这套事件的接法。
    // 先停掉场景 D 挂着的 run:run 终结,它的待批审批必须一并离开托盘(不留批不动的死卡)。
    await win.locator('.t2c-stop').first().click({ timeout: 2000 }).catch(() => {})
    await win.waitForTimeout(1500)
    const traysAfterStop = await win.evaluate(() => document.querySelectorAll('[data-approval-tray]').length)
    check('P0 上一个 run 终结后,它挂着的审批全部离开托盘', traysAfterStop === 0, `trays=${traysAfterStop}`)
    const UPDATE = '<approval_update>\nThe user has decided on tool calls that were waiting for approval:\n\n' +
      "[approved] run_bash (call pk1) — $ npm publish --dry-run\nIt has run; its output is now that call's result above.\n</approval_update>"
    stub.script([
      { type: 'token', payload: { delta: '先改 CHANGELOG,发布要你批。' } },
      { type: 'tool_call', payload: { id: 'pk1', name: 'run_bash', arguments: JSON.stringify({ command: 'npm publish --dry-run' }) } },
      { type: 'tool_result', payload: { id: 'pk1', name: 'run_bash', parked: true, result: "⏸ Waiting for the user's approval: $ npm publish --dry-run\nThis call has NOT run yet." } },
      { type: 'approval_request', payload: {
        approvalId: 'pa1', name: 'run_bash', arguments: JSON.stringify({ command: 'npm publish --dry-run' }),
        preview: '$ npm publish --dry-run', reason: { kind: 'mode', mode: 'auto-edit' }, toolCallId: 'pk1',
      } },
      { type: 'tool_call', payload: { id: 'pk2', name: 'edit_file', arguments: JSON.stringify({ path: 'CHANGELOG.md', old_string: 'a', new_string: 'b' }) } },
      { type: 'tool_result', payload: { id: 'pk2', name: 'edit_file', result: 'ok' } },
      { type: 'token', payload: { delta: 'CHANGELOG 已改好,等你批准发布。' } },
      // run 先切了一次段(空注入 = 纯切段):拍板时挂着审批的那一段已不是当前段 —— 结果事件得找回它(Codex 09-27 P1)
      { type: 'turn_boundary', payload: { finalizedAssistantId: '(unknown → 回落当前段)', finalizedContent: '先改 CHANGELOG,发布要你批。CHANGELOG 已改好,等你批准发布。', userMessages: [], newAssistantId: 'pk-mid' } },
      // ↓ 用户拍板之后引擎会发的那几条(剧本直接推进)
      { type: 'approval_result', payload: { approvalId: 'pa1', action: 'approve' }, delay: 3000 },
      { type: 'tool_result', payload: { id: 'pk1', name: 'run_bash', result: 'npm notice dry-run ok' } },
      { type: 'turn_boundary', payload: { finalizedAssistantId: 'pk-mid', finalizedContent: '', userMessages: [{ id: 'au1', content: UPDATE }], newAssistantId: 'pk-next' } },
      { type: 'token', payload: { delta: '发布演练通过。' } },
      { type: 'done', payload: { content: '发布演练通过。' } },
    ])
    await send(win, '先改 CHANGELOG 再发布')
    const mid = await win.evaluate(() => {
      const icons = [...document.querySelectorAll('.tool-group-status svg')].map((x) => String(x.getAttribute('class') || ''))
      return {
        tray: document.querySelector('[data-approval-tray]')?.textContent || '',
        pausedGroups: icons.filter((c) => /pause/.test(c)).length,
        kept: document.body.innerText.includes('等你批准发布'),
      }
    })
    check('P1 挂起的审批进托盘,它的工具卡是暂停态(不是完成对勾)', /npm publish --dry-run/.test(mid.tray) && mid.pausedGroups >= 1, JSON.stringify(mid))
    check('P2 挂起期间 agent 没停:后面的工具与正文照样流出来', mid.kept, '')
    await win.waitForTimeout(4200)
    const fin = await win.evaluate(() => {
      const icons = [...document.querySelectorAll('.tool-group-status svg')].map((x) => String(x.getAttribute('class') || ''))
      return {
        tray: document.querySelectorAll('[data-approval-tray]').length,
        pausedGroups: icons.filter((c) => /pause/.test(c)).length,
        update: document.querySelector('[data-approval-update]')?.textContent || '',
        bubble: [...document.querySelectorAll('.t2-user')].some((b) => (b.textContent || '').includes('approval_update')),
      }
    })
    check('P3 拍板后托盘清空、原工具卡不再是暂停态(真结果回填到了更早那一段)', fin.tray === 0 && fin.pausedGroups === 0, JSON.stringify(fin))
    check('P4 结局是一行通知(已批准并执行 run_bash),不是用户气泡', /已批准并执行 run_bash/.test(fin.update) && !fin.bubble, JSON.stringify(fin))
    const inputTa = win.locator('.t2c-ta').first()
    await inputTa.click().catch(() => {})
    await inputTa.fill('').catch(() => {})
    await win.keyboard.press('ArrowUp')
    await win.waitForTimeout(300)
    const recalled = await inputTa.inputValue().catch(() => '')
    check('P5 ↑ 召回拿到的是上一句真话,不是 <approval_update>', recalled === '先改 CHANGELOG 再发布', JSON.stringify(recalled))
    await win.screenshot({ path: process.env.PARKED_SHOT || '/tmp/approval-parked.png' }).catch(() => {})

    // ── 场景 K3(P1 · K3 审批送达):① 会话列表「等你处理」点来自引擎待批索引(没订阅的会话也亮);
    //    ② 远程会话的审批卡写明来源设备,另一端(这里由剧本扮演)先答 → 卡离开托盘。
    //    「在 Pixel 9 上」这句收起后缀只在渲染已收起卡片的地方可见(托盘在兑现那一刻就撤卡),由 ApprovalCard.remote.test 钉。
    const toggleDark = () => win.evaluate(() => {
      const r = document.documentElement
      const wasDark = r.classList.contains('dark')
      r.classList.toggle('dark', !wasDark)
      r.setAttribute('data-mode', wasDark ? 'light' : 'dark')
      return wasDark
    })
    stub.setPending([{ sessionId: 's2', approvals: 1, inquiries: 1, localOnly: 0, oldestAt: '2026-09-28T03:12:05.000Z', remote: true }])
    await win.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))) // 回前台立即拉(不等 20s 那一轮)
    let dot = null
    for (let i = 0; i < 20 && !dot; i++) {
      await win.waitForTimeout(300)
      dot = await win.evaluate(() => {
        const row = [...document.querySelectorAll('.t2s-srow')].find((r) => (r.textContent || '').includes('手机发起的远程会话'))
        const d = row?.querySelector('.t2s-dot')
        return d ? { cls: d.className, title: d.getAttribute('title'), n: d.getAttribute('data-attention') } : null
      })
    }
    check('K3a 没订阅的会话按引擎待批索引亮「等你处理」点(1 审批 + 1 询问 = 2)',
      !!dot && /attention/.test(dot.cls) && dot.n === '2' && /2 项等你处理/.test(dot.title || ''), JSON.stringify(dot) + ` pendingPulls=${stub.seen.pending || 0}`)
    const sidebarBox = await win.locator('.t2s-srow', { hasText: '手机发起的远程会话' }).first().boundingBox().catch(() => null)
    const clip = sidebarBox ? { x: 0, y: Math.max(0, sidebarBox.y - 90), width: Math.min(420, sidebarBox.x + sidebarBox.width + 40), height: 200 } : undefined
    await win.screenshot({ path: process.env.K3_SIDEBAR_SHOT || '/tmp/k3-sidebar-attention.png', ...(clip ? { clip } : {}) }).catch(() => {})
    await toggleDark()
    await win.waitForTimeout(400)
    await win.screenshot({ path: process.env.K3_SIDEBAR_SHOT_DARK || '/tmp/k3-sidebar-attention-dark.png', ...(clip ? { clip } : {}) }).catch(() => {})
    await toggleDark()
    stub.setPending([])
    await win.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    let cleared = false
    for (let i = 0; i < 20 && !cleared; i++) {
      await win.waitForTimeout(300)
      cleared = await win.evaluate(() => {
        const row = [...document.querySelectorAll('.t2s-srow')].find((r) => (r.textContent || '').includes('手机发起的远程会话'))
        return !!row && !row.querySelector('.t2s-dot.attention')
      })
    }
    check('K3b 索引清空(对方答掉)→ 点灭', cleared, '')

    stub.script([
      { type: 'approval_request', payload: {
        approvalId: 'k3a', name: 'run_bash', arguments: JSON.stringify({ command: 'npm run deploy' }), preview: '$ npm run deploy',
        reason: { kind: 'mode', mode: 'auto-edit' }, remote: { via: 'tunnel', callerUnit: K3_UNIT, callerKind: 'phone', callerName: 'Pixel 9' },
      } },
      // 另一端(执行设备本机 / 别的设备)先答:4s 后引擎广播 approval_result,by = 谁答的
      { type: 'approval_result', payload: { approvalId: 'k3a', action: 'approve', by: { via: 'tunnel', callerUnit: K3_UNIT, callerName: 'Pixel 9' } }, delay: 4000 },
      { type: 'token', payload: { delta: '部署完成。' } },
      { type: 'done', payload: { content: '部署完成。' } },
    ])
    await send(win, '远程会话里要批准的部署')
    const pend = await win.evaluate(() => ({
      tray: document.querySelector('[data-approval-tray]')?.getAttribute('data-approval-tray') || null,
      source: document.querySelector('.t2c-apv [data-approval-remote]')?.textContent || '',
      btns: [...document.querySelectorAll('.t2c-apv .approval-actions button')].map((b) => (b.textContent || '').trim()),
    }))
    check('K3c 远程会话的审批卡写明来源设备(K1 来源行),托盘里一张', pend.tray === '1' && pend.source.includes('Pixel 9'), JSON.stringify(pend))
    await win.screenshot({ path: process.env.K3_CARD_SHOT || '/tmp/k3-remote-card.png' }).catch(() => {})
    await toggleDark()
    await win.waitForTimeout(400)
    await win.screenshot({ path: process.env.K3_CARD_SHOT_DARK || '/tmp/k3-remote-card-dark.png' }).catch(() => {})
    await toggleDark()
    await win.waitForTimeout(3600)
    const gone = await win.evaluate(() => ({ trays: document.querySelectorAll('[data-approval-tray]').length, text: document.body.innerText.includes('部署完成') }))
    check('K3d 另一端先答(approval_result.by)→ 卡离开托盘、run 接着跑完;本端没发任何兑现请求',
      gone.trays === 0 && gone.text && !stub.seen.approvals.some((a) => a.approvalId === 'k3a'), JSON.stringify(gone))

    // ── 场景 K3e–h(主进程送达整链,评审补):桩的 /agent/approvals/stream 上架一条远程 + 一条本机待批 →
    //    主进程 approvalDelivery(钩子改订桩)只为远程那条弹**真** Electron 系统通知;在那个真通知对象上 emit('click')
    //    → main.ts openSession → approval:open → preload → bootstrap 订阅 → openSessionFromApproval:从收件箱 Space 切回 Tangu、
    //    打开那条会话;对方先答(removed)→ 通知关。缺哪一环(main.ts 闭包 / 门控 / 频道名 / 渲染层订阅)这里都红。
    const k3Pending = () => app.evaluate(() => (globalThis.__forsionE2E?.approvalDelivery.pending() || []).map((i) => i.id)).catch(() => [])
    const k3Notes = () => app.evaluate(() => (globalThis.__forsionE2E?.notifications || []).map((r) => ({ title: r.n.title, body: r.n.body, closed: r.closed }))).catch(() => [])
    const k3Now = new Date().toISOString()
    stub.pushPrompt({ id: 'apv_k3e_remote', kind: 'approval', runId: 'r-k3e', sessionId: 's2', sessionTitle: '手机发起的远程会话', tool: 'run_bash', localOnly: false,
      remote: { via: 'tunnel', callerUnit: K3_UNIT, callerKind: 'phone', callerName: 'Pixel 9' }, createdAt: k3Now })
    stub.pushPrompt({ id: 'apv_k3e_local', kind: 'approval', runId: 'r-k3e-l', sessionId: 's1', sessionTitle: '端到端会话', tool: 'write_file', localOnly: false, remote: null, createdAt: k3Now })
    let k3ids = []
    for (let i = 0; i < 40 && k3ids.length < 2; i++) { k3ids = await k3Pending(); if (k3ids.length < 2) await win.waitForTimeout(250) }
    check('K3e 主进程订到本机待批流:远程、本机两条都进了 approvalDelivery.pending()',
      k3ids.includes('apv_k3e_remote') && k3ids.includes('apv_k3e_local'), JSON.stringify(k3ids) + ` streams=${stub.seen.promptStreams || 0}`)
    const k3n = await k3Notes()
    check('K3f 只为远程那条弹系统通知:标题带调用方设备名,正文带会话名与工具名,不含命令',
      k3n.length === 1 && k3n[0].title.includes('Pixel 9') && k3n[0].body.includes('手机发起的远程会话') && k3n[0].body.includes('run_bash') && !k3n[0].closed,
      JSON.stringify(k3n))
    // P1-KF:系统通知跟**界面**语言(本台架 --lang=zh-CN = 渲染层 ② 判中文、从不写手选键),不跟主进程自己的系统语言。
    // K5 原接线只读手选键 → 在非中文系统的机器上这里弹的是英文(P1-K3 修复报告实测)。
    // ⚠️ 前提(评审 P2):主进程的系统首选语言(= mainI18n.fromSystem 的 langs[0])不是 zh*、界面也没手选中文 —— 否则旧接线
    // (手选键 → 系统语言)同样出中文,这条绿了也证明不了什么 → 文案对时记 SKIP(未判定)并点名,文案错照样 FAIL。
    const k3Sys = await app.evaluate(({ app: a }) => a.getPreferredSystemLanguages()).catch(() => null)
    const k3Ui = await win.evaluate(() => ({ lang: document.documentElement.lang, pref: localStorage.getItem('tangu_locale') })).catch(() => null)
    const k3fName = 'K3f′ 通知文案跟界面语言(中文界面 + 手选键为空):标题 =「Pixel 9 上的远程会话等你批准」,正文中文'
    const k3fOk = k3n.length === 1 && k3n[0].title === 'Pixel 9 上的远程会话等你批准' && /^「手机发起的远程会话」请求使用 run_bash。点击查看。$/.test(k3n[0].body)
    const k3fDetail = JSON.stringify({ note: k3n[0], systemLanguages: k3Sys, ui: k3Ui })
    const k3fWhyNot = !Array.isArray(k3Sys) || !k3Sys.length ? '取不到主进程的系统语言'
      : /^zh\b/i.test(String(k3Sys[0])) ? `主进程系统语言是 ${k3Sys[0]}:旧接线也回落中文`
        : k3Ui?.pref === 'zh' ? '界面手选了中文:旧接线也读得到'
          : null
    if (!k3fOk || !k3fWhyNot) check(k3fName, k3fOk, k3fDetail)
    else skip(`${k3fName} —— 未判定:${k3fWhyNot},本机上区分不了新旧实现(看 K3f″ 与 electron/uiLocaleSync.test.ts)`, k3fDetail)
    // 接线半(不挑系统语言):渲染层把**生效**语言经 ui:locale 报给了主进程 → userData/ui-locale.json 落的是 zh(K5 旧接线从不写它)。
    const k3UserData = await app.evaluate(({ app: a }) => a.getPath('userData')).catch(() => null) // 非打包版在 --user-data-dir 后面加了 -dev
    let k3Seed = null
    try { k3Seed = JSON.parse(fs.readFileSync(path.join(k3UserData, 'ui-locale.json'), 'utf8')) } catch { /* 没写 = 没报 */ }
    check('K3f″ 渲染层把生效界面语言报给了主进程(userData/ui-locale.json = zh,下次启动窗口载入前也用它)', k3Seed?.locale === 'zh', JSON.stringify({ seed: k3Seed, userData: k3UserData }))
    // 真 macOS 通知截图(DESIGN §8 / 规格 §8「需要真机」):屏幕录制权限或通知权限不在时拿到的是没有横幅的桌面 —— 人工看图判定,不据此断言。
    if (process.platform === 'darwin' && process.env.K3_NOTIF_SHOT) {
      await win.waitForTimeout(1500)
      try { execFileSync('screencapture', ['-x', process.env.K3_NOTIF_SHOT]) } catch (e) { console.log(`(screencapture 失败:${e.message})`) }
    }
    // 先离开 Tangu Space(收件箱 Space 没有聊天主区),点通知应当切回来
    const inboxSlot = win.locator('.rb-slot[data-id="space:inbox"] .rb-space').first()
    if (await inboxSlot.count().catch(() => 0)) await inboxSlot.click().catch(() => {})
    await win.waitForTimeout(1200)
    const activeS2 = () => win.evaluate(() => {
      const row = [...document.querySelectorAll('.t2s-srow.active')].find((r) => (r.textContent || '').includes('手机发起的远程会话'))
      return !!row && !!row.offsetParent
    }).catch(() => false)
    const k3Before = await activeS2()
    await app.evaluate(() => { const list = globalThis.__forsionE2E?.notifications || []; list[list.length - 1]?.n.emit('click') })
    let k3Opened = false
    for (let i = 0; i < 30 && !k3Opened; i++) { await win.waitForTimeout(300); k3Opened = await activeS2() }
    check('K3g 点系统通知 → approval:open → 切回 Tangu Space 并打开那条会话', !k3Before && k3Opened, `before=${k3Before} after=${k3Opened}`)
    await win.screenshot({ path: process.env.K3_OPENED_SHOT || '/tmp/k3-notification-opened.png' }).catch(() => {})
    stub.removePrompt('apv_k3e_remote', 'approved', { via: 'tunnel', callerUnit: K3_UNIT, callerName: 'Pixel 9' })
    let k3Closed = false
    for (let i = 0; i < 20 && !k3Closed; i++) { await win.waitForTimeout(250); k3Closed = (await k3Notes())[0]?.closed === true }
    check('K3h 对方先答(流里 removed)→ 系统通知收回', k3Closed && !(await k3Pending()).includes('apv_k3e_remote'), '')
    stub.removePrompt('apv_k3e_local', 'rejected')
    await win.locator('.t2s-srow', { hasText: '端到端会话' }).first().click().catch(() => {}) // 后面的场景在第一个会话里跑
    await win.waitForTimeout(1200)

    // ── 场景 E:custom 规则编辑器(H2)。此前这套规则只能手写 config.json。
    // 钉三件:入口只在选了 custom 时出现 / 打开时把服务端已有规则读进来 / 保存发出的 PUT 是编辑后的内容。
    await win.locator('.t2c-pill', { hasText: /批准|审批|只读|自动|替我/ }).first().click().catch(() => {})
    await win.waitForTimeout(500)
    const beforePick = await win.locator('.approval-item', { hasText: '编辑规则' }).count().catch(() => 0)
    await win.locator('.approval-item', { hasText: '自定义' }).first().click().catch(() => {})
    await win.waitForTimeout(700)
    await win.locator('.t2c-pill', { hasText: /批准|审批|自定义|替我/ }).first().click().catch(() => {})
    await win.waitForTimeout(500)
    const afterPick = await win.locator('.approval-item', { hasText: '编辑规则' }).count().catch(() => 0)
    check('E1 「编辑规则…」只在选了自定义档之后出现(没选时开它没意义)',
      beforePick === 0 && afterPick === 1, `before=${beforePick} after=${afterPick}`)

    await win.locator('.approval-item', { hasText: '编辑规则' }).first().click().catch(() => {})
    await win.waitForTimeout(900)
    // ⚠️ 必须限定在弹层内:页面上还留着前几幕的计划卡/审批卡 textarea,
    //    全局 `textarea` 的第一个是它们(E2 第一版就 fill 错了地方)。
    const loaded = await win.evaluate(() => [...document.querySelectorAll('.apvr-modal textarea')].map((x) => x.value))
    check('E2 打开时读回服务端已有规则(不是空白表单)',
      loaded.some((v) => v.includes('run_bash:npm publish')), JSON.stringify(loaded))

    await win.screenshot({ path: process.env.RULES_SHOT || '/tmp/rules-modal.png' }).catch(() => {})

    // ⭐ E2b **逐键输入**:这一条是 E3 抓不到的那类缺陷的唯一判据。
    // `fill()` 一次性设值、只发一个 input 事件,所以「每次击键都归一化」的 bug 能在 21/21 全绿下存活
    //(第一版正是如此:敲回车第二行被吞、行尾空格被 trim → `npm test` 打成 `npmtest`)。
    const typeTa = win.locator('.apvr-modal textarea').first()
    await typeTa.fill('')
    await typeTa.pressSequentially('run_bash:npm test', { delay: 12 })
    await typeTa.press('Enter')
    await typeTa.pressSequentially('web_fetch', { delay: 12 })
    const typed = await typeTa.inputValue()
    check('E2b ⭐逐键输入:回车留得住(第二条规则打得出来)、行尾空格不被吞',
      typed === 'run_bash:npm test\nweb_fetch', JSON.stringify(typed))

    // 改一条 deny 再保存
    const denyTa = win.locator('.apvr-modal textarea').first()
    await denyTa.fill('write_file:/etc/\nrun_bash:rm -rf')
    await win.locator('.apvr-modal button', { hasText: /保存|Save/ }).first().click().catch(() => {})
    await win.waitForTimeout(1000)
    const put = stub.seen.approvalRules[stub.seen.approvalRules.length - 1]
    check('E3 保存发出的 PUT 带上了编辑后的规则(一行一条,已 trim)',
      !!put && Array.isArray(put.deny) && put.deny.includes('write_file:/etc/') && put.deny.includes('run_bash:rm -rf'),
      JSON.stringify(put))
    check('E4 保存后弹层关闭', (await win.locator('.apvr-modal').count().catch(() => 0)) === 0, '')

    // ⭐ E5 读失败必须 fail-closed:表单不渲染 + 保存不可点 + 给重试。
    // 反面就是「空表单看着像从没配过」→ 用户一点保存 → PUT 全量四字段 → deny 名单整片清空落盘。
    stub.state.failApprovalRules = true
    await win.locator('.t2c-pill', { hasText: /批准|审批|自定义|替我/ }).first().click().catch(() => {})
    await win.waitForTimeout(500)
    await win.locator('.approval-item', { hasText: '编辑规则' }).first().click().catch(() => {})
    await win.waitForTimeout(1200)
    const failState = await win.evaluate(() => {
      const m = document.querySelector('.apvr-modal')
      if (!m) return null
      const btns = [...m.querySelectorAll('button')].map((b) => ({ t: (b.textContent || '').trim(), dis: b.disabled }))
      return { textareas: m.querySelectorAll('textarea').length, btns, text: m.textContent || '' }
    })
    check('E5 ⭐读失败时不渲染表单(否则空表单一保存就清空 deny 名单)',
      !!failState && failState.textareas === 0, JSON.stringify(failState && { ta: failState.textareas }))
    check('E5b 读失败时「保存」不可点,且给了重试',
      !!failState && failState.btns.some((b) => /保存|Save/.test(b.t) && b.dis) &&
      failState.btns.some((b) => /重试|Retry/.test(b.t)),
      JSON.stringify(failState?.btns))
    stub.state.failApprovalRules = false
    await win.locator('.apvr-modal button', { hasText: /取消|Cancel/ }).first().click().catch(() => {})

    await win.screenshot({ path: process.env.CHATEV_SHOT || '/tmp/chat-events.png', fullPage: false }).catch(() => {})

  } finally {
    await app.close().catch(() => {})
    stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }

  const bad = results.filter((r) => !r.ok)
  const skipped = results.filter((r) => r.skipped)
  console.log(`\n${results.length - bad.length - skipped.length}/${results.length} 通过`)
  if (skipped.length) console.log(`⚠️ ${skipped.length} 条未判定(SKIP,本机环境区分不了新旧实现,不算通过):\n${skipped.map((r) => `   - ${r.name}`).join('\n')}`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
