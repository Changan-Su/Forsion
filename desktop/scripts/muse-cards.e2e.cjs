/**
 * Muse 私聊里要点的卡与磨合期按钮(方案 Muse与Agent升级_2026-10-29)的真 Electron 台架。桩引擎扮一台 Muse 刚开起来的电脑:
 * 一条主动消息、一张插件卡、五张进卡片堆的卡(三问 / 设置变更 / 两周小结 / 功能推荐 / 规则)。
 * 断言:
 *  R1 主动消息下面有「有用 / 少来点这种」,卡片消息没有;点了发 verdict,按钮变成「记下了：这类少来」,刷新不再出现
 *  R2 插件卡留在消息里,带「不感兴趣」,不进卡片堆;卡片堆 5 张
 *  R3 围栏不进正文;待处理的卡流里一行指向对话最下面
 *  R4 三问:没选时「好了」不可点;选完发 answers;流里变回执
 *  R5 设置卡:旧值 → 新值;点「改」只传 action;回执「已改成 …」
 *  R6 小结:改一条(index + text)、删一条、「都对」,记忆跟着动由引擎单测钉
 *  R7 功能卡点「不感兴趣」发 dismiss
 *  R8 规则卡写清当 · 只在 · 做;点「改一下」发 edit,打开画布定位到建好的规则;卡片堆清空
 * 量的是 out/ 产物:改了源码先 `npx electron-vite build`。
 *   node ../.claude/hooks/devlock.cjs run --vehicle=e2e --what="Muse 卡片台架" --eta=3 -- node scripts/muse-cards.e2e.cjs
 *   SHOT_DIR=… 指定截图目录;LANG_EN=1 拍英文;DARK=1 拍深色
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir } = require('./lib/uiux-electron.cjs')

const MUSE = '5e0d7c11-7a2b-4c1e-9d10-0000000000a1'
const LIB = '/tmp/forsion-musecards-lib'
const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
const sess = { id: MUSE, title: 'Muse', summary: '', model_id: 'm1', archived: false, emoji: null, project_path: null, project_name: null, projectless: true,
  agent_config: { soloAgentSlug: 'muse', agentSlug: 'muse', execMode: 'host', cwd: LIB, preset: null }, created_at: at(600), updated_at: at(1) }
const AGENTS = [{ slug: 'muse', name: 'Muse', description: 'Background agent', createdBy: 'system', libraryDir: LIB }]
const fence = (id) => `\`\`\`forsion-muse-card\n{"id":"${id}"}\n\`\`\``
const T0 = Date.now() - 50 * 60_000
const dm = (id, n, origin, content) => ({ id, role: 'model', agent_slug: 'muse', origin, timestamp: T0 + n * 60_000, content })
const MSGS = [
  dm('p1', 1, 'proactive', '下午三点的组会材料还没打开过，要我先列个提纲吗？'),
  dm('c-plugin', 2, 'proactive:card', `这周你开了 9 份 PDF，这个插件能批注和对比。\n\n${fence('plugin')}`),
  dm('c-intro', 3, 'proactive:card', fence('intro')),
  dm('c-settings', 4, 'proactive:card', fence('settings')),
  dm('c-summary', 5, 'proactive:card', fence('summary')),
  dm('c-feature', 6, 'proactive:card', `你常问昨天看过什么。\n\n${fence('feature')}`),
  dm('c-rule', 7, 'proactive:card', `打开 Figma 时要不要提醒你先活动一下？\n\n${fence('rule')}`),
]
const RULE = { desc: '打开 Figma 时提醒我活动一下', cond: { type: 'computer.app_opened', params: { app: 'Figma' } }, cooldownHours: 2, actions: [{ type: 'remind', title: '先活动一下' }], only: { weekdays: [1, 2, 3, 4, 5] }, maxPerDay: 2 }
const card = (id, kind, payload) => ({ id, kind, key: null, payload, status: 'pending', result: null, created_at: T0, decided_at: null })
const ITEM = { id: 'better-pdf', name: 'Better PDF', author: 'Forsion', summary: '批注与对比', type: 'plugin', installSlug: 'better-pdf', latestVersion: '1.0.0', tags: [] }

async function main() {
  const r = makeReporter()
  const dir = shotDir('muse-cards')
  const cards = [
    card('plugin', 'plugin', { item: ITEM }),
    card('intro', 'intro', {}),
    card('settings', 'settings', { patch: { activeHours: { start: 9, end: 23 } }, changes: [{ field: 'activeHours', from: null, to: { start: 9, end: 23 } }, { field: 'notify', from: 'immediate', to: 'digest' }] }),
    card('summary', 'summary', { lead: '两周下来，我记住了这几条。', items: ['晚上十点以后别提工作', '日报只要三条', '论文先给提纲再给全文'] }),
    card('feature', 'feature', { feature: 'computer-history', title: '电脑历史', why: '打开后我能回答「昨天看过什么」。' }),
    card('rule', 'rule', { rule: RULE }),
  ]
  const seen = { decide: [], feedback: [] }
  const byId = (id) => cards.find((c) => c.id === id)
  const ctx = await launch({
    tag: 'muse-cards',
    fixtures: { agents: AGENTS, sessions: [] },
    stubOverride: async ({ path: p, method, url, body: readBody }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: [sess] }
      if (p === '/agent/sessions/attention') return { sessions: [] }
      if (p === `/agent/sessions/${MUSE}/config`) return { agent_config: sess.agent_config }
      if (p === `/agent/sessions/${MUSE}/messages` && method === 'GET') return { messages: MSGS }
      if (p === `/agent/sessions/${MUSE}/read`) return { ok: true }
      if (p === '/agent/runs') return { runs: [] }
      if (p === '/agent/solo/agent/muse/open') return { session: sess, created: false }
      if (p === '/agent/special/config') return { config: { historian: { enabled: false }, muse: { enabled: true, mode: 'ask' } } }
      if (p === '/agent/special/muse/status') return { status: { enabled: true, running: false, lastCycleAt: T0, sessionId: null, feedbackUntil: Date.now() + 86_400_000 } }
      if (p === '/agent/special/muse/library') return { root: LIB, files: [] }
      if (p === '/agent/special/muse/todos') return { todos: [] }
      if (p === '/agent/special/approvals') return { approvals: [] }
      if (p === '/agent/special/muse/triggers') return { triggers: [{ ...RULE, id: 'w-rule', enabled: false, lastFiredAt: null, createdAt: new Date(T0).toISOString() }] }
      if (p === '/agent/special/automation/actions') return { tools: [] }
      if (p === '/agent/special/automation/sources') return { sources: [] }
      if (p === '/agent/special/automation/executions') return { executions: [] }
      if (p === '/agent/special/automation/sessions') return { sessions: [] }
      if (p === '/agent/special/schedule') return { schedules: [] }
      if (p === '/agent/special/muse/cards') { const s = url.searchParams.get('status'); return { cards: cards.filter((c) => !s || c.status === s) } }
      let m = /^\/agent\/special\/muse\/cards\/([^/]+)$/.exec(p)
      if (m) return { card: byId(m[1]) }
      m = /^\/agent\/special\/muse\/cards\/([^/]+)\/decide$/.exec(p)
      if (m && method === 'POST') {
        const c = byId(m[1])
        const body = await readBody()
        seen.decide.push({ id: m[1], ...body })
        if (body.action === 'remove') c.payload = { ...c.payload, items: c.payload.items.filter((_, i) => i !== body.index) }
        else { c.status = body.action === 'dismiss' ? 'dismissed' : 'done'; c.result = body.action }
        return { ok: true, card: c, ...(m[1] === 'rule' ? { trigger: { id: 'w-rule' } } : {}) }
      }
      m = /^\/agent\/special\/muse\/cards\/([^/]+)\/summary-edit$/.exec(p)
      if (m && method === 'POST') {
        const c = byId(m[1]), body = await readBody()
        seen.decide.push({ id: m[1], action: 'edit', ...body })
        c.payload = { ...c.payload, items: c.payload.items.map((x, i) => (i === body.index ? body.text : x)) }
        return { ok: true, card: c }
      }
      m = /^\/agent\/special\/muse\/messages\/([^/]+)\/feedback$/.exec(p)
      if (m && method === 'POST') { seen.feedback.push({ id: m[1], ...(await readBody()) }); return { ok: true } }
      return undefined
    },
  })
  const { win } = ctx
  const last = () => seen.decide[seen.decide.length - 1] || {}
  const inCard = (kind) => `[data-pending-deck] .t2c-apv [data-muse-card="${kind}"]`
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.evaluate((en) => { if (en) localStorage.setItem('tangu_locale', 'en') }, !!process.env.LANG_EN)
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    if (process.env.DARK) await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') })
    const row = win.locator('.t2o-row', { has: win.locator('.t2o-name', { hasText: /^Muse$/ }) }).first()
    await row.waitFor({ timeout: 20_000 })
    await row.click()
    await win.locator('#tocmsg-c-feature').waitFor({ timeout: 15_000 })
    await win.waitForSelector('#tocmsg-p1 [data-muse-feedback]', { timeout: 10_000 }).catch(() => {})
    await win.waitForSelector(inCard('intro'), { timeout: 10_000 }).catch(() => {})

    const state = () => win.evaluate(() => ({
      fb: document.querySelector('#tocmsg-p1 [data-muse-feedback]')?.getAttribute('data-muse-feedback') || '',
      fbText: document.querySelector('#tocmsg-p1 [data-muse-feedback]')?.textContent || '',
      fbOnCards: !!document.querySelector('#tocmsg-c-intro [data-muse-feedback], #tocmsg-c-plugin [data-muse-feedback]'),
      leak: /forsion-muse-card/.test(document.querySelector('.t2-stream-inner')?.textContent || ''),
      deckN: document.querySelector('[data-pending-deck] .t2c-apv')?.getAttribute('data-approval-tray') || '0',
      pluginBtn: !!document.querySelector('#tocmsg-c-plugin .mk-chat-card-actions'),
      pluginInDeck: !!document.querySelector('[data-pending-deck] .mk-chat-card-actions'),
      pointer: document.querySelector('#tocmsg-c-intro [data-muse-card-line]')?.getAttribute('data-muse-card-line') || '',
    }))
    const s0 = await state()
    r.check('R1a 主动消息下面有反馈按钮,卡片消息没有', s0.fb === 'open' && !s0.fbOnCards, JSON.stringify(s0))
    r.check('R2 插件卡留在消息里,不进卡片堆;卡片堆 5 张', s0.pluginBtn && !s0.pluginInDeck && s0.deckN === '5', JSON.stringify(s0))
    await win.screenshot({ path: path.join(dir, 'plugin.png') })
    r.check('R3 围栏不进正文;待处理的卡流里一行指路', !s0.leak && s0.pointer === 'pending', JSON.stringify(s0))
    await win.screenshot({ path: path.join(dir, 'intro.png') })

    await win.locator('#tocmsg-p1 [data-muse-feedback] button').nth(1).click()
    await win.waitForSelector('#tocmsg-p1 [data-muse-feedback="down"]', { timeout: 5000 }).catch(() => {})
    const s1 = await state()
    r.check('R1b 点「少来点这种」发 down,按钮变回执', seen.feedback[0]?.id === 'p1' && seen.feedback[0]?.verdict === 'down' && /记下了：这类少来|fewer of these/.test(s1.fbText), JSON.stringify({ s1, f: seen.feedback }))

    // ── 插件卡 ──
    await win.locator('#tocmsg-c-plugin .mk-chat-card-actions button', { hasText: /不感兴趣|Not interested/ }).click()
    await win.waitForSelector('#tocmsg-c-plugin [data-muse-card-line="dismissed"]', { timeout: 5000 }).catch(() => {})
    r.check('R2b 插件卡「不感兴趣」发 dismiss,流里留回执', last().id === 'plugin' && last().action === 'dismiss' && await win.locator('#tocmsg-c-plugin [data-muse-card-line="dismissed"]').count() === 1, JSON.stringify(last()))

    // ── 三问 ──
    const q = (n) => win.locator(`${inCard('intro')} .t2-musecard-q`).nth(n).locator('button')
    const done = win.locator(`${inCard('intro')} > .t2-taskcard-actions button.primary`)
    r.check('R4a 什么都没选时「好了」不可点', await done.isDisabled())
    await q(0).nth(1).click()
    await q(1).nth(1).click()
    await q(2).nth(1).click()
    await q(2).nth(3).click()
    await win.screenshot({ path: path.join(dir, 'intro-picked.png') })
    await done.click()
    await win.waitForSelector(inCard('settings'), { timeout: 5000 }).catch(() => {})
    await win.waitForSelector('#tocmsg-c-intro [data-muse-card-line="done"]', { timeout: 5000 }).catch(() => {})
    r.check('R4b 发 answers,流里变回执,卡片堆换下一张', JSON.stringify(last().answers) === JSON.stringify({ when: 'daytime', pace: 'daily', focus: ['study', 'inbox'] }) && last().action === 'answer' && await win.locator('#tocmsg-c-intro [data-muse-card-line="done"]').count() === 1, JSON.stringify(last()))

    // ── 设置 ──
    const rows = await win.locator(`${inCard('settings')} .t2-musecard-row`).allInnerTexts()
    r.check('R5a 旧值 → 新值', /全天 → 9–23 点|All day → 9:00–23:00/.test(rows[0] || '') && /即时 → 日报|Right away → Daily digest/.test(rows[1] || ''), JSON.stringify(rows))
    await win.waitForTimeout(600) // 卡片入场过渡
    await win.screenshot({ path: path.join(dir, 'settings.png') })
    await win.locator(`${inCard('settings')} button.primary`).click()
    await win.waitForSelector(inCard('summary'), { timeout: 5000 }).catch(() => {})
    await win.waitForSelector('#tocmsg-c-settings [data-muse-card-line="done"]', { timeout: 5000 }).catch(() => {})
    const line = await win.locator('#tocmsg-c-settings [data-muse-card-line]').textContent().catch(() => '')
    r.check('R5b 点「改」只传 action,回执写新值', JSON.stringify(last()) === JSON.stringify({ id: 'settings', action: 'apply' }) && /已改成 9–23 点、日报|Changed to 9:00–23:00, Daily digest/.test(line), JSON.stringify({ last: last(), line }))

    // ── 小结 ──
    await win.waitForTimeout(600) // 卡片入场过渡
    await win.screenshot({ path: path.join(dir, 'summary.png') })
    const sRow = (n) => win.locator(`${inCard('summary')} .t2-musecard-row`).nth(n)
    await sRow(0).locator('button').first().click()
    await sRow(0).locator('input').fill('晚上十一点以后别提工作')
    await sRow(0).locator('input').press('Enter')
    await win.waitForFunction(() => !document.querySelector('[data-muse-card="summary"] input'), null, { timeout: 5000 }).catch(() => {})
    r.check('R6a 改一条发 index + text', last().action === 'edit' && last().index === 0 && last().expected === '晚上十点以后别提工作' && last().text === '晚上十一点以后别提工作', JSON.stringify(last()))
    await win.waitForFunction(() => /十一点/.test(document.querySelector('[data-muse-card="summary"]')?.textContent || ''), null, { timeout: 5000 }).catch(() => {})
    await sRow(1).locator('button').nth(1).click()
    await win.waitForFunction(() => document.querySelectorAll('[data-muse-card="summary"] .t2-musecard-row').length === 2, null, { timeout: 5000 }).catch(() => {})
    r.check('R6b 删一条发 index;卡还在', last().action === 'remove' && last().index === 1 && last().expected === '日报只要三条' && await sRow(0).count() === 1, JSON.stringify(last()))
    await win.locator(`${inCard('summary')} > .t2-taskcard-actions button.primary`).click()
    await win.waitForSelector(inCard('feature'), { timeout: 5000 }).catch(() => {})
    r.check('R6c 「都对」收起', last().action === 'ok', JSON.stringify(last()))

    // ── 功能卡 ──
    await win.waitForTimeout(600) // 卡片入场过渡
    await win.screenshot({ path: path.join(dir, 'feature.png') })
    await win.locator(`${inCard('feature')} button`).nth(1).click()
    await win.waitForSelector(inCard('rule'), { timeout: 5000 }).catch(() => {})
    r.check('R7 功能卡「不感兴趣」发 dismiss', last().id === 'feature' && last().action === 'dismiss', JSON.stringify(last()))

    // ── 规则卡 ──
    await win.waitForTimeout(600) // 卡片入场过渡
    await win.screenshot({ path: path.join(dir, 'rule.png') })
    const ruleText = await win.locator(inCard('rule')).innerText().catch(() => '')
    r.check('R8a 规则卡写清当 · 只在 · 做,三个按钮', /打开了 Figma|Opened Figma/.test(ruleText) && /工作日|Weekdays/.test(ruleText) && /直接提醒「先活动一下」|Remind you/.test(ruleText) && await win.locator(`${inCard('rule')} .t2-taskcard-actions button`).count() === 3, ruleText)
    await win.locator(`${inCard('rule')} button`, { hasText: /改一下|Change it/ }).click()
    await win.waitForSelector('.auto-canvas', { timeout: 10_000 }).catch(() => {})
    await win.waitForTimeout(600)
    await win.screenshot({ path: path.join(dir, 'rule-canvas.png') })
    r.check('R8b 「改一下」发 edit,打开画布', last().id === 'rule' && last().action === 'edit' && await win.locator('.auto-canvas').count() === 1, JSON.stringify(last()))
    r.check('R8c 卡片堆清空', byId('rule').status === 'done', JSON.stringify(byId('rule')))
    await win.screenshot({ path: path.join(dir, 'done.png') })

    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    await row.click()
    await win.waitForSelector('#tocmsg-p1 [data-muse-feedback]', { timeout: 10_000 }).catch(() => {})
    r.check('R1c 刷新后还是回执,不再出按钮', (await state()).fb === 'down', JSON.stringify(await state()))
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
