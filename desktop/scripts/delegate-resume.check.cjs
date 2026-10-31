/**
 * 子代理续用的真 Electron 台架。桩引擎按真引擎的事件序回放:第一轮委派 → 打开子代理面板 → 第二轮同一 subId 续用(面板开着)。
 * 断言(引擎那半由 live 场景 subresume 与 subAgentResume.test 钉):
 *  R1 第一轮收尾,子代理一行、已完成;R2 续用途中同一行回到「工作中」,不多列一行(库里那行还是已完成);
 *  R3 面板里追问已画出来;R4 第二轮写进新气泡,第一轮的回答一字不动;
 *  R5 收尾后行回到已完成;R6 关掉重开面板(读库)不重复。
 * 量的是 out/ 产物:改了源码先 `npx electron-vite build`。截图自己看,SHOT_DIR 指定目录。
 *   node ../../.claude/hooks/devlock.cjs run --vehicle=e2e --what="子代理续用台架" --eta=3 -- npm run check:delegateresume
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir, sleep, captureWindow } = require('./lib/uiux-electron.cjs')

const P = '0b6f8c2e-2a20-4c4e-9b11-0000000000a1'
const C = '0b6f8c2e-2a20-4c4e-9b11-0000000000c1'
const TURN2 = `delegate:${C}:second`
const FIRST = '重试上限在 src/net/client.ts,值是 4821。'
const ASK = '紧挨着的常量还有哪些?'
const SECOND = '还有 CONNECT_TIMEOUT_MS = 3120 和 BACKOFF_CAP_MS = 6604。'
const sub = (payload) => ({ type: 'subagent', payload: { subId: C, ...payload } })
const announce = { type: 'subchat', payload: { kind: 'subagent', id: C, sessionId: C, title: 'Worker', task: '查重试上限' } }

async function main() {
  const r = makeReporter()
  const dir = shotDir('delegate-resume')
  let projectDir = ''
  const parentRows = []
  const childRows = []
  const background = []
  const session = (id, title, extra = {}) => ({ id, title, summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: projectDir, project_name: 'Forsion', projectless: false, created_at: '2026-10-30 08:00:00', updated_at: '2026-10-30 08:00:00', ...extra })
  const ctx = await launch({
    tag: 'delegate-resume',
    fixtures: { agents: [], sessions: [] },
    stubOverride: ({ path: p, method }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: [session(P, '查 HTTP 客户端的重试上限')] }
      if (p === `/agent/sessions/${P}/background`) return { background }
      if (p === `/agent/sessions/${P}/messages`) return { messages: parentRows }
      if (p === `/agent/sessions/${C}/messages`) return { messages: childRows }
      if (p === `/agent/sessions/${P}/detail`) return { session: session(P, '查 HTTP 客户端的重试上限', { kind: 'user' }) }
      if (p === `/agent/sessions/${C}/detail`) return { session: session(C, 'Worker', { kind: 'delegate', parent_session_id: P, agent_config: { delegatedFrom: P } }) }
      return undefined
    },
  })
  projectDir = ctx.projectDir
  const { app, win, stub } = ctx
  const shot = async (name) => { await captureWindow(app, path.join(dir, `${name}.png`)) }
  const send = async (text) => {
    const box = win.locator('.t2c-ta').first()
    await box.fill(text)
    await box.press('Enter')
  }
  const rows = () => win.locator('[data-subchat-status] .t2o-desk-row')
  const panel = () => win.locator('.child-chat-panel')
  const panelText = () => panel().innerText().catch(() => '')
  const count = (hay, needle) => hay.split(needle).length - 1
  try {
    await boot(app, win, { space: 'tangu', width: 1320, height: 860 })
    await enterSpace(win, 'tangu')
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: '查 HTTP 客户端的重试上限' }).first().click()
    await win.waitForSelector('.t2c-ta', { timeout: 20_000 })

    // ── 第一轮 ──
    stub.script([announce,
      sub({ phase: 'start', sessionId: C, messageId: `delegate:${C}`, label: 'Worker', task: '查重试上限', grants: [] }),
      sub({ phase: 'token', delta: FIRST }), sub({ phase: 'done', resultChars: FIRST.length }),
      { type: 'token', payload: { delta: '查到了。' } }])
    await send('重试上限在哪?')
    await win.waitForSelector('[data-subchat-done]', { timeout: 15_000 })
    childRows.push({ id: 'cu1', role: 'user', content: '查重试上限', timestamp: 1 }, { id: `delegate:${C}`, role: 'model', content: FIRST, timestamp: 2 })
    background.push({ sessionId: C, kind: 'delegate', title: 'Worker', createdAt: '2026-10-30', runId: null, runStatus: null })
    await sleep(4500) // 等 /background 轮询把落库那行带回来
    await win.locator('[data-subchat-done]').click()
    await rows().first().click()
    await win.waitForFunction((t) => document.querySelector('.child-chat-panel')?.textContent.includes(t), FIRST, { timeout: 15_000 })
    r.check('R1 第一轮收尾:一行、已完成', await rows().count() === 1 && await win.locator('[data-subchat-status]').getByText('工作中').count() === 0)

    // ── 第二轮:面板开着时续用,同一 subId ──
    stub.script([announce,
      sub({ phase: 'start', sessionId: C, messageId: TURN2, userMessageId: 'cu2', label: 'Worker', task: ASK, grants: [] }),
      sub({ phase: 'token', delta: SECOND.slice(0, 10) }),
      { ...sub({ phase: 'token', delta: SECOND.slice(10) }), delay: 3000 }, sub({ phase: 'done', resultChars: SECOND.length }),
      { type: 'token', payload: { delta: '问到了。' } }])
    await send('再问问它紧挨着的常量。')
    await win.waitForFunction((t) => document.querySelector('.child-chat-panel')?.textContent.includes(t), SECOND.slice(0, 10), { timeout: 15_000 })
    await sleep(1000) // 摘要卡开合的过渡里有一份旧卡残影,等它走完再数
    const working = win.locator('[data-subchat-status]').getByText('工作中')
    r.check('R2 续用途中:同一行回到工作中,不多列', await working.count() === 1 && await rows().count() === 1, JSON.stringify(await rows().allInnerTexts()))
    const mid = await panelText()
    r.check('R3 面板里画出了追问', mid.includes(ASK), mid.slice(0, 200))
    await shot('resuming')
    await win.waitForFunction((t) => document.querySelector('.child-chat-panel')?.textContent.includes(t), SECOND, { timeout: 15_000 })
    const bubbles = await panel().locator('[id^="tocmsg-"]').allInnerTexts()
    const firstBubble = bubbles.find((t) => t.includes(FIRST)) || ''
    r.check('R4 第二轮在新气泡里,第一轮一字不动', bubbles.length >= 3 && !firstBubble.includes(SECOND.slice(0, 10)) && bubbles.some((t) => t.includes(SECOND) && !t.includes(FIRST)), JSON.stringify(bubbles).slice(0, 300))
    await sleep(1500)
    r.check('R5 收尾后回到已完成', await working.count() === 0)
    await shot('resumed')
    const dark = async () => { await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') }); await sleep(300); await shot('resumed-dark') }
    await dark()

    // ── 关掉重开:读库,不重复 ──
    childRows.push({ id: 'cu2', role: 'user', content: ASK, timestamp: 3 }, { id: TURN2, role: 'model', content: SECOND, timestamp: 4 })
    await panel().getByRole('button', { name: /收起|Collapse/ }).first().click()
    await sleep(500)
    if (!await rows().count()) await win.locator('[data-subchat-done]').click()
    await rows().first().click()
    await win.waitForFunction((t) => document.querySelector('.child-chat-panel')?.textContent.includes(t), SECOND, { timeout: 15_000 })
    await sleep(800)
    const reopened = (await panel().locator('[id^="tocmsg-"]').allInnerTexts()).join('\n') // 只数气泡:大纲里也有一份用户消息
    r.check('R6 重开面板:两轮各一份,不重复', count(reopened, ASK) === 1 && count(reopened, FIRST) === 1 && count(reopened, SECOND) === 1, JSON.stringify(reopened))
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
