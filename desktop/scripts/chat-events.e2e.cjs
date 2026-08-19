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
  id: 's1', title: '端到端会话', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/demo', project_name: 'demo',
  created_at: '2026-08-18 09:00:00', updated_at: '2026-08-18 09:00:00',
}

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
    sessions: [SESSION],
    messages: [],
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off', 'low', 'medium'] }],
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chatev-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
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
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(700)
    }
    // 打开那个会话(侧栏行)
    await win.locator('.t2s-srow', { hasText: '端到端会话' }).first().click().catch(() => {})
    await win.waitForTimeout(1200)

    // ── 场景 A:工具卡 diff(P1)+ 成本闸(H3)+ 自动压缩(H4)+ 上下文分解(H5/H8/B2)+ 思考降档(H6)
    stub.script([
      { type: 'status', payload: {
        phase: 'context_info', ctxWindow: 272_000, ctxWindowSource: 'family',
        sections: [{ k: 'persona', tokens: 900 }, { k: 'skills', tokens: 1200 }],
        files: ['/tmp/demo/AGENTS.md'], filesTruncated: false, historyCount: 4, historyTokens: 2200,
        thinkingRequested: 'medium', thinkingEffective: 'low', modelId: 'm1', // 请求档须等于会话当前档,降档提示才显示(刻意的防陈旧闸)
      } },
      { type: 'tool_call', payload: { id: 't1', name: 'edit_file', arguments: JSON.stringify({
        path: 'src/app.ts', old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 42\nconst b = 2',
      }) } },
      { type: 'tool_result', payload: { id: 't1', result: 'edited src/app.ts', elapsedMs: 12 } },
      // 同一轮里再来一次**多文件** apply_patch:A1b/A1c 靠它,且不必额外发一条消息
      //(多发一条会让悬浮侧栏收回去,后面 A6 用不了搜索框 —— 实测点 .dv-edge-left 请不回来)
      { type: 'tool_call', payload: { id: 't9', name: 'apply_patch', arguments: JSON.stringify({
        patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n baseline\n+MULTI-A\n*** Add File: c.txt\n+MULTI-C\n*** End Patch',
      }) } },
      { type: 'tool_result', payload: { id: 't9', result: 'ok', elapsedMs: 9 } },
      { type: 'usage', payload: { prompt: 1000, total: 200, costTotal: 16_500, costLimit: 20_000 } },
      { type: 'status', payload: { phase: 'compacted', savedChars: 4321, iteration: 2 } },
      { type: 'token', payload: { delta: '改好了。' } },
    ])
    await send(win, '改一下 app.ts')
    await win.waitForTimeout(600)

    // 工具卡是**两级**折叠:先展开工具组,再展开那一行,才轮到 diff(ToolGroup.tsx 的结构)
    await clickInView(win.locator('.tool-group-head').first()).catch(() => {})
    await win.waitForTimeout(500)
    await clickInView(win.locator('.tool-row-head').first()).catch(() => {})
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
    await clickInView(win.locator('.tool-row-head').nth(1)).catch(() => {})
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

    // 思考档降档标在模型药丸菜单的 Effort 当前值上(→ 生效档),得把菜单点开才看得到
    await win.locator('.model-pill-btn').first().click().catch(() => {})
    await win.waitForTimeout(700)
    const effortRow = await win.locator('.model-pill-wrap .cm-effort-value').first().textContent().catch(() => '')
    check('A5 思考档降档可见(菜单里标出 → 实际生效档)', /→/.test(effortRow || ''), `effort=${JSON.stringify(effortRow)}`)
    await win.keyboard.press('Escape').catch(() => {})
    await win.waitForTimeout(300)

    // ── 场景 A2:内容搜索失败 ≠ 无结果(Codex 真机走查提的:静默转空会让人以为库里真没有)
    stub.state.failSearch = true
    // 侧栏是悬浮边缘态,点过聊天区后会自己收回去 —— 用之前先把它请回来(否则这里 30s 超时)。
    // 点一次不一定成(动画/焦点),轮询几轮再放弃。
    // A1b 已并进 A1 的剧本,不再多发消息,侧栏理应还在;保险起见留个轻量守卫
    if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
      await win.click('.dv-edge-left').catch(() => {})
      await win.waitForTimeout(900)
    }
    const box = win.locator('.t2s-search input').first()
    await box.click()
    await box.fill('localstorage')
    await win.waitForTimeout(1500)
    const failHint = await win.locator('.t2s-hint').allTextContents().catch(() => [])
    check('A6 内容搜索失败时如实提示(不伪装成「无匹配」)',
      failHint.some((x) => /没跑成|failed/i.test(x)) && !failHint.some((x) => /^没有匹配|no result/i.test(x)),
      JSON.stringify(failHint))
    stub.state.failSearch = false
    await box.fill('')
    await win.waitForTimeout(500)

    // 把 A 场景展开的两段 diff 收回去:它们撑得页面很长,后面计划卡的按钮会被 diff 行号与悬浮输入区
    // 轮流挡住(playwright 一路重试到 30s 超时,报 "subtree intercepts pointer events")。
    // 真实用法本来也是看完 diff 就收起来。
    await clickInView(win.locator('.tool-group-head').first()).catch(() => {})
    await win.waitForTimeout(500)

    // ── 场景 B:计划卡三态(P2)—— 批准发出的必须逐字是引擎认的那串
    stub.script([
      { type: 'plan', payload: { plan: '# 实施计划\n\n1. 先写测试\n2. 再改实现' } },
      { type: 'inquiry_request', payload: { inquiryId: 'q1', question: '计划已就绪(见上方计划卡)。是否批准并退出计划模式?', options: PLAN_OPTIONS, allowFreeText: true, kind: 'plan' } },
      { type: '__hold' }, // 真引擎此刻阻塞在 requestInquiry 上,run 未结束
    ])
    await send(win, '给个计划')
    await win.waitForTimeout(900)

    const planProbe = await win.evaluate(() => {
      const card = document.querySelector('.plan-card')
      return {
        card: !!card,
        markdown: !!card?.querySelector('.plan-body h1, .plan-body ol, .plan-body li'),
        buttons: card ? card.querySelectorAll('.approval-actions .btn').length : 0,
        genericInquiry: document.querySelectorAll('.inquiry-card').length,
      }
    })
    check('B1 计划卡:markdown 正文 + 五个决策按钮', planProbe.card && planProbe.markdown && planProbe.buttons === 5, JSON.stringify(planProbe))
    check('B2 不再另起一张通用询问卡(计划询问归计划卡)', planProbe.genericInquiry === 0, JSON.stringify(planProbe))

    stub.seen.inquiries.length = 0
    await clickInView(win.locator('.plan-card .approval-actions .btn').first())
    await win.waitForTimeout(1200)
    check('B3 ⚠️「批准并开始执行」发出的是引擎逐字认的那串',
      stub.seen.inquiries[0]?.answer === PLAN_APPROVE_AUTO, JSON.stringify(stub.seen.inquiries[0]))

    // ── 场景 C:编辑后批准 —— 必须带修订标记 + 改后的全文
    stub.script([
      { type: 'plan', payload: { plan: '# 旧计划\n\n1. 随便做做' } },
      { type: 'inquiry_request', payload: { inquiryId: 'q2', question: '计划已就绪(见上方计划卡)。是否批准并退出计划模式?', options: PLAN_OPTIONS, allowFreeText: true, kind: 'plan' } },
      { type: '__hold' },
    ])
    await send(win, '再给个计划')
    await win.waitForTimeout(900)

    const cards = win.locator('.plan-card')
    const last = cards.nth(await cards.count() - 1)
    await clickInView(last.locator('.approval-actions .btn', { hasText: '编辑计划' }).first())
    await win.waitForTimeout(500)
    const ta = last.locator('textarea.plan-edit').first()
    await ta.click()
    await ta.fill('# 我改过的计划\n\n1. 先补回滚方案')
    await win.waitForTimeout(300)
    stub.seen.inquiries.length = 0
    await clickInView(last.locator('.approval-actions .btn').first())
    await win.waitForTimeout(1200)
    const ans = stub.seen.inquiries[0]?.answer || ''
    check('C1 ⚠️编辑后批准:头部仍是批准选项,后面挂修订标记 + 改后的全文',
      ans.startsWith(PLAN_APPROVE_AUTO) && ans.includes(PLAN_REVISION_MARK) && ans.includes('先补回滚方案'),
      JSON.stringify(ans.slice(0, 80)))

    // ── 场景 D:审批卡的「为什么问你」(B3)+ 工作区外写入警示仍在(台账里挂着的那条未验)
    // 三种 reason 各来一张卡,一次断完:custom-ask 要报出**命中的规则串**,escalate 与 custom-ask
    // 还必须**藏掉「总允许」**——引擎对这两种情形是静默降级为单次批准的(approvals.ts 明写),
    // 按钮照常显示就又是一处「界面说一套引擎做一套」。
    stub.script([
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
    const apv = await win.evaluate(() => [...document.querySelectorAll('.approval-card')].map((c) => ({
      why: (c.querySelector('.approval-why')?.textContent || '').trim(),
      preview: (c.querySelector('.approval-preview')?.textContent || '').trim(),
      btns: [...c.querySelectorAll('.approval-actions button')].map((b) => (b.textContent || '').trim()),
    })))
    const [ask, esc, mode] = apv.slice(-3)
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
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
