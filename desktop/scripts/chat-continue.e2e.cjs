/**
 * 失败行的「继续生成」vs「重新生成」—— 真 Electron × 真组件/store × 可编剧假引擎。
 *
 * 2026-11-10 用户反馈:报错 / 额度用完后只有一个「重试」,点了就把前面已经生成的内容删掉重来。
 * 钉住的契约:
 *  ① 这一轮有产出(正文 / 工具调用)时,失败行给「继续生成」(主)+「重新生成」,右栏失败卡同样两颗;
 *  ② 点「继续生成」:不删任何消息(seen.messagesDeleted 为空),下一个 run 的 message 是 <turn_resume> 标记,
 *     对人渲染成一条「从这里继续生成」分隔线,不是用户气泡;失败那条回答的正文原样留着;
 *  ③ 这一轮什么都没产出时,只有一颗「重试」(两者等价,不多给一个按钮)。
 *
 * 需先 npm run build。用法:npm run e2e:chatcontinue
 * 负对照:node scripts/chat-continue.e2e.cjs --nc(运行时把「继续生成」按钮藏掉,①②必须转红)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const NEGATIVE_CONTROL = process.argv.includes('--nc')
const SHOT = path.join(os.tmpdir(), 'forsion-chat-continue.png')
const SHOT_AFTER = path.join(os.tmpdir(), 'forsion-chat-continue-after.png')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const SESSION = {
  id: 'continue-s1', title: '继续生成验收', summary: '', model_id: 'm1', archived: false, emoji: null,
  agent_config: null, project_path: '/tmp/continue-demo', project_name: 'continue-demo',
  created_at: '2026-11-10 09:00:00', updated_at: '2026-11-10 09:00:00',
}
const PARTIAL = '第一部分：市场概况已经写完。第二部分：竞品分析'
const QUOTA_ERR = 'You exceeded your current quota, please check your plan and billing details.'

async function send(win, text) {
  const ta = win.locator('.t2c-ta').first()
  for (let i = 0; i < 40; i++) {
    if (await ta.isEnabled().catch(() => false)) break
    await win.waitForTimeout(500)
  }
  await ta.click()
  await ta.fill(text)
  await win.keyboard.press('Enter')
}

async function openChatSession(win) {
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await win.waitForTimeout(1000)
  await win.evaluate((names) => {
    const button = [...document.querySelectorAll('button.rb-space')]
      .find((item) => names.some((name) => (item.getAttribute('aria-label') || item.getAttribute('title') || item.textContent || '').includes(name)))
    button?.click()
  }, ['Agent', 'Tangu'])
  await win.waitForTimeout(1500)
  if (!(await win.locator('.t2s-search input').first().count().catch(() => 0))) {
    await win.click('.dv-edge-left').catch(() => {})
    await win.waitForTimeout(700)
  }
  const row = win.locator('.t2s-srow', { hasText: SESSION.title }).first()
  if (!(await row.count().catch(() => 0))) {
    const shot = path.join(os.tmpdir(), 'forsion-chat-continue-nav-fail.png')
    await win.screenshot({ path: shot })
    throw new Error(`没找到会话行;截图 ${shot}`)
  }
  await row.click()
  await win.waitForTimeout(900)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  const stub = await startStubEngine({ sessions: [SESSION], messages: [] })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-chat-continue-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
  })

  try {
    const win = await app.firstWindow()
    await win.setViewportSize({ width: 1600, height: 900 })
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await openChatSession(win)
    if (NEGATIVE_CONTROL) await win.addStyleTag({ content: '[data-testid="msg-continue"],[data-testid="tsum-continue"]{display:none!important}' })

    // 第一轮:吐了半截正文 + 调过一次工具,然后额度用完(引擎 catch 路径:error 事件带上已落库的正文)
    stub.script([
      { type: 'token', delay: 300, payload: { delta: PARTIAL } },
      { type: 'tool_call', payload: { id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: '/tmp/continue-demo/notes.md' }) } },
      { type: 'tool_result', payload: { id: 'c1', name: 'read_file', preview: 'notes', isError: false } },
      { type: 'error', delay: 200, payload: { error: QUOTA_ERR, aborted: false, content: PARTIAL } },
    ])
    await send(win, '写一份市场报告')
    await win.waitForSelector('[data-testid="msg-retry"]', { timeout: 15_000 })
    await win.waitForTimeout(500)

    const row = await win.evaluate(() => {
      const label = (sel) => document.querySelector(sel)?.textContent?.trim() || null
      const cont = document.querySelector('[data-testid="msg-continue"]')
      return {
        cont: cont && cont.offsetParent ? label('[data-testid="msg-continue"]') : null,
        contLead: !!cont?.classList.contains('lead'),
        retry: label('[data-testid="msg-retry"]'),
        retryLead: !!document.querySelector('[data-testid="msg-retry"]')?.classList.contains('lead'),
        tsumCont: (() => { const b = document.querySelector('[data-testid="tsum-continue"]'); return b && b.offsetParent ? b.textContent.trim() : null })(),
        tsumRetry: label('[data-testid="tsum-retry"]'),
      }
    })
    check('① 失败行有「继续生成」且是主按钮', row.cont === '继续生成' && row.contLead, JSON.stringify(row))
    check('① 另一颗改叫「重新生成」、退居次位', row.retry === '重新生成' && !row.retryLead, JSON.stringify(row))
    check('① 右栏失败卡同样两颗', row.tsumCont === '继续生成' && row.tsumRetry === '重新生成', JSON.stringify(row))
    if (!NEGATIVE_CONTROL) await win.screenshot({ path: SHOT })

    // 点「继续生成」→ 第二轮正常收尾
    stub.script([{ type: 'token', delay: 200, payload: { delta: '：三家主要竞品的定价与渠道对比如下。' } }, { type: 'done', payload: {} }])
    const runsBefore = stub.seen.runs.length
    const btn = win.locator('[data-testid="msg-continue"]').first()
    if (await btn.isVisible().catch(() => false)) await btn.click()
    for (let i = 0; i < 30 && stub.seen.runs.length === runsBefore; i++) await win.waitForTimeout(200)
    await win.waitForTimeout(1200)
    const sent = stub.seen.runs[runsBefore]
    check('② 发的是 <turn_resume> 标记', !!sent && String(sent.message || '').startsWith('<turn_resume>'), sent ? String(sent.message).slice(0, 60) : 'no run')
    check('② 没删任何消息', stub.seen.messagesDeleted.length === 0, JSON.stringify(stub.seen.messagesDeleted))
    const after = await win.evaluate((partial) => ({
      divider: document.querySelector('[data-turn-resume]')?.textContent?.trim() || null,
      markerBubble: [...document.querySelectorAll('.t2-user, .t2-ubub, [data-role="user"]')].some((el) => (el.textContent || '').includes('turn_resume')),
      partialKept: (document.querySelector('.t2-chat-col, #root')?.textContent || '').includes(partial),
    }), PARTIAL)
    check('② 标记画成「从这里继续生成」分隔线,不是用户气泡', after.divider === '↻ 从这里继续生成' && !after.markerBubble, JSON.stringify(after))
    check('② 失败那条回答的正文原样留着', after.partialKept, JSON.stringify(after))
    if (!NEGATIVE_CONTROL) await win.screenshot({ path: SHOT_AFTER })

    // ③ 什么都没产出就失败:只有一颗「重试」
    stub.script([{ type: 'error', delay: 200, payload: { error: 'upstream 400: bad request', aborted: false, content: '' } }])
    await send(win, '再来一个问题')
    await win.waitForSelector('[data-testid="msg-retry"]', { timeout: 15_000 })
    await win.waitForTimeout(400)
    const bare = await win.evaluate(() => ({
      cont: document.querySelectorAll('[data-testid="msg-continue"]').length,
      retry: document.querySelector('[data-testid="msg-retry"]')?.textContent?.trim() || null,
    }))
    check('③ 没产出时只有「重试」', bare.cont === 0 && bare.retry === '重试', JSON.stringify(bare))
  } finally {
    await app.close().catch(() => {})
    try { await stub.close() } catch { /* 收尾 */ }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过${NEGATIVE_CONTROL ? '(负对照:应有红)' : ''}`)
  if (!NEGATIVE_CONTROL) console.log(`截图:${SHOT}\n      ${SHOT_AFTER}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
