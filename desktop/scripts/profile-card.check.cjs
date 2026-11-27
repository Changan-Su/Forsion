/**
 * check:profilecard — Chat 头像资料卡(views/chat2/ProfileCard.tsx,方案 docs/ToBeImproved/聊天头像资料卡方案_2026-11-27 选 B)。
 * 真 Electron(out/)+ 桩引擎 + 隔离 home,110% 缩放(同用户 dev)。夹具:一条群聊(Xyra + Research),Xyra 带头像图,Research 只有首字母。
 *
 * 钉的是:
 *  1. 助手头像 / 名字条、你自己的头像 / 名字条都是入口(role=button,aria-expanded 跟着卡);
 *  2. 卡贴着头像开(助手在左往右开、你自己在右往左开,顶边对齐头像上 4px),内容摘自名册(名字、@id、五行、记忆条数现取);
 *  3. 「@ 它」把 `@Xyra ` 插进这个对话的输入框、卡收起;Esc / 点别处 / 再点同一个头像都收;
 *  4. 你自己的卡出「关于我」;关了「聊天头像」时名字条开卡、卡在名字条下面;
 *  5. 对话滚动时卡跟着头像走(不一滚就收)。
 * 用法:npm run check:profilecard(先 npx electron-vite build;SHOT_DIR 指定截图目录)
 */
const path = require('path')
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U

const SHOTS = U.shotDir('profilecard')
const base = { archived: false, model_id: 'm1', created_at: '2026-11-27 09:00:00', updated_at: '2026-11-27 11:40:00', projectless: true, project_path: null, project_name: null, summary: '' }
const group = { ...base, id: 'pc-group', title: 'Interview notes', agent_config: { groupChat: true, groupAgents: ['xyra', 'research'], execMode: 'host', agentSlug: 'xyra' } }
const agentRow = (slug, name, description, extra = {}) => ({ slug, name, description, tools: [], model: '', thinkingLevel: '', maxIterations: null, approvalMode: '', systemPrompt: '', soul: '', createdBy: 'user', libraryDir: `/tmp/pc-lib/${slug}/Library`, ...extra })
const agents = [
  agentRow('xyra', 'Xyra', 'Everyday assistant', { avatar: 'avatar.png', enabledSkillIds: ['local:writing', 'local:web', 'local:pdf'], thinkingLevel: 'medium', cloudSync: true }),
  agentRow('research', 'Research', 'Checks sources'),
]
const long = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}: a long enough line so the transcript can scroll a bit.`).join('\n\n')
const messages = [
  { id: 'u1', session_id: group.id, role: 'user', content: 'Sort this week\'s six interviews into three findings.', timestamp: 1 },
  { id: 'a1', session_id: group.id, role: 'model', agent_slug: 'xyra', content: `Sure. I will ask Research to group the quotes.\n\n${long}`, timestamp: 2 },
  { id: 'a2', session_id: group.id, role: 'model', agent_slug: 'research', content: 'Quotes are grouped into four themes.', timestamp: 3 },
]
// 1×1 的 PNG 当 Xyra 的头像(只要是张图)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

;(async () => {
  const rep = U.makeReporter()
  const { app, win, close } = await U.launch({
    tag: 'profilecard',
    fixtures: { agents, sessions: [group] },
    messages,
    stubOverride: ({ path: p }) => {
      if (p === '/agent/agents/xyra/avatar') return { __buffer: PNG, contentType: 'image/png' }
      if (/^\/agent\/agents\/[^/]+\/avatar$/.test(p)) return { __code: 404, body: { error: 'none' } }
      if (p === '/agent/agents/xyra/memory') return { version: 'v1', content: '', updatedAt: 1, tombstones: [], entries: [1, 2, 3].map((n) => ({ id: `m${n}`, content: `fact ${n}`, source: { kind: 'manual' }, evidenceIds: [], createdAt: n, updatedAt: n })) }
      return undefined
    },
  })
  const cardBox = () => win.evaluate(() => { const c = document.querySelector('.pc-card'); if (!c) return null; const r = c.getBoundingClientRect(); const cs = getComputedStyle(c); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, text: c.textContent, hidden: c.hasAttribute('data-anchor-hidden'), opacity: +cs.opacity, pe: cs.pointerEvents } })
  // 真看得见、点得到:DOM 里有卡不算数(头一版锚点被头像自己的 overflow 裁掉,卡一直透明、点穿到正文)
  const shown = (c) => !!c && !c.hidden && c.opacity > 0.9 && c.pe !== 'none'
  // 页面缩放走 webContents.setZoomFactor,Playwright 的 boundingBox 与 getBoundingClientRect 口径未必一致:位置一律在页内量
  const rectOf = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })
  const avatarOf = (name) => win.locator('.t2-asst').filter({ has: win.locator('.t2-name', { hasText: new RegExp(`^${name}`, 'i') }) }).first().locator('.t2-avatar')
  const waitGone = async () => { for (let i = 0; i < 30; i++) { if (!(await win.locator('.pc-card').count())) return true; await sleep(100) } return false }
  try {
    await U.boot(app, win, { space: 'tangu', width: 1280, height: 820 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.1))
    await sleep(600)
    await win.locator('.t2s-srow, .t2o-row').filter({ hasText: 'Interview notes' }).first().click()
    await win.waitForSelector('.t2-asst', { timeout: 15000 })
    await sleep(1200)

    // 1. 入口
    const entries = await win.evaluate(() => ({
      asst: document.querySelectorAll('.t2-asst > .t2-avatar[data-profile][role="button"]').length,
      names: document.querySelectorAll('.t2-name-hit[data-profile]').length,
      user: document.querySelectorAll('.t2-user-avatar[data-profile]').length + document.querySelectorAll('.t2-username[data-profile]').length,
    }))
    rep.check('助手头像 / 名字条、你的头像 / 名字条都是入口', entries.asst === 2 && entries.names === 2 && entries.user === 2, JSON.stringify(entries))

    // 2. Xyra 的卡:位置 + 内容
    const xa = avatarOf('Xyra')
    await xa.scrollIntoViewIfNeeded()
    await xa.click()
    await win.waitForSelector('.pc-card', { timeout: 3000 })
    await sleep(700) // 液滴流完
    const av = await rectOf(xa)
    const c1 = await cardBox()
    rep.check('卡看得见、点得到', shown(c1), c1 && `hidden=${c1.hidden} opacity=${c1.opacity} pointer-events=${c1.pe}`)
    rep.check('卡在头像右边开', !!c1 && c1.left >= av.x + av.width && c1.left - (av.x + av.width) < 20, c1 && `card.left=${c1.left.toFixed(1)} avatar.right=${(av.x + av.width).toFixed(1)}`)
    rep.check('卡顶对齐头像上方一点', !!c1 && Math.abs(c1.top - (av.y - 4)) < 3, c1 && `card.top=${c1.top.toFixed(1)} avatar.top=${av.y.toFixed(1)}`)
    rep.check('头像 aria-expanded=true', (await xa.getAttribute('aria-expanded')) === 'true')
    const rows = await win.evaluate(() => [...document.querySelectorAll('.pc-card .pc-row')].map((r) => r.getAttribute('data-row')))
    rep.check('五行齐(简介 / 模型 / 技能 / 记忆 / 来源)', JSON.stringify(rows) === JSON.stringify(['about', 'model', 'skills', 'memory', 'source']), JSON.stringify(rows))
    rep.check('名字 + @id + 记忆条数(现取)', /Xyra/.test(c1.text) && /@xyra/.test(c1.text) && /3 条|Own · 3/.test(c1.text), c1.text.slice(0, 160))
    const acts = await win.evaluate(() => [...document.querySelectorAll('.pc-card .pc-acts button')].map((b) => b.getAttribute('data-act')))
    rep.check('动作:私聊 / @ 它 / 资料', JSON.stringify(acts) === JSON.stringify(['dm', 'at', 'profile']), JSON.stringify(acts))
    await win.screenshot({ path: path.join(SHOTS, 'agent-light.png') })

    // 5. 滚动跟随:往回滚一小段(头像往下挪、仍在可见区)→ 卡跟着挪、照样看得见;滚到头像出框 → 卡淡出但不收;滚回来 → 卡回来
    const top0 = await win.evaluate(() => document.querySelector('.t2-stream')?.scrollTop ?? 0)
    const dy = top0 >= 40 ? -40 : 40
    await win.evaluate((d) => { const s = document.querySelector('.t2-stream'); if (s) s.scrollTop += d }, dy)
    await sleep(400)
    const av2 = await rectOf(xa)
    const c2 = await cardBox()
    rep.check('对话滚动时卡跟着头像走、照样看得见', shown(c2) && Math.abs((c2.top - c1.top) - (av2.y - av.y)) < 3 && Math.abs(av2.y - av.y) > 20, c2 && `Δcard=${(c2.top - c1.top).toFixed(1)} Δavatar=${(av2.y - av.y).toFixed(1)} hidden=${c2.hidden}`)
    await win.evaluate(() => { const s = document.querySelector('.t2-stream'); if (s) s.scrollTop = s.scrollHeight })
    await sleep(400)
    const c2b = await cardBox()
    const avOut = await rectOf(xa)
    rep.check('头像滚出可见区:卡淡出、不收', !!c2b && c2b.hidden, c2b ? `hidden=${c2b.hidden} avatar.top=${avOut.y.toFixed(1)}` : '卡没了')
    await win.evaluate((t) => { const s = document.querySelector('.t2-stream'); if (s) s.scrollTop = t }, top0)
    await sleep(400)
    rep.check('滚回来卡又出现', shown(await cardBox()))

    // 3a. 再点同一个头像 = 收
    await xa.click()
    rep.check('再点同一个头像收起', await waitGone())

    // 3b. @ 它 → 输入框
    await xa.click()
    await win.waitForSelector('.pc-card [data-act="at"]', { timeout: 3000 })
    await win.locator('.pc-card [data-act="at"]').click()
    await sleep(500)
    const draft = await win.evaluate(() => document.querySelector('[data-mention-target] textarea')?.value || '')
    rep.check('「@ 它」把 @Xyra 插进输入框', /@Xyra /.test(draft), JSON.stringify(draft))
    rep.check('「@ 它」之后卡收起', await waitGone())

    // 3c. Research(只有首字母)+ Esc 收
    const ra = avatarOf('Research')
    await ra.click()
    await win.waitForSelector('.pc-card', { timeout: 3000 })
    await sleep(500)
    const c3 = await cardBox()
    rep.check('Research 的卡看得见', shown(c3))
    rep.check('Research 的卡', /Research/.test(c3.text) && /@research/.test(c3.text), c3.text.slice(0, 120))
    await win.keyboard.press('Escape')
    rep.check('Esc 收起', await waitGone())

    // 3d. 键盘:头像上按 Enter 开卡、焦点进卡;Esc 收卡、焦点回头像
    await ra.focus()
    await win.keyboard.press('Enter')
    await win.waitForSelector('.pc-card', { timeout: 3000 })
    await sleep(300)
    rep.check('键盘 Enter 开卡、焦点进卡', await win.evaluate(() => !!document.querySelector('.pc-card')?.contains(document.activeElement)))
    await win.keyboard.press('Escape')
    await waitGone()
    rep.check('Esc 收卡后焦点回到头像', await ra.evaluate((el) => document.activeElement === el))

    // 4a. 你自己的卡:往左开,有「关于我」
    const ua = win.locator('.t2-user-avatar').first()
    await ua.click()
    await win.waitForSelector('.pc-card', { timeout: 3000 })
    await sleep(600)
    const ub = await rectOf(ua)
    const c4 = await cardBox()
    rep.check('你自己的卡看得见', shown(c4))
    rep.check('你自己的卡在头像左边开', c4.right <= ub.x + 0.5 && ub.x - c4.right < 20, `card.right=${c4.right.toFixed(1)} avatar.left=${ub.x.toFixed(1)}`)
    rep.check('你自己的卡有「关于我」', (await win.locator('.pc-card [data-act="about-me"]').count()) === 1)
    await win.screenshot({ path: path.join(SHOTS, 'me-light.png') })
    // 点别处收
    // 点对话区左侧空白(顶上那条是窗口拖拽区,Electron 不把指针事件发给页面,点那里收不了卡 —— 和别的菜单一样)
    const sh = await rectOf(win.locator('.t2-stream'))
    await win.locator('.t2-stream').click({ position: { x: 12, y: Math.round(sh.height / 2) } })
    rep.check('点别处收起', await waitGone())

    // 深色一张
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'dark'); document.documentElement.classList.add('dark') })
    await xa.click(); await win.waitForSelector('.pc-card'); await sleep(700)
    await win.screenshot({ path: path.join(SHOTS, 'agent-dark.png') })
    await win.keyboard.press('Escape'); await waitGone()
    await win.evaluate(() => { document.documentElement.removeAttribute('data-mode'); document.documentElement.classList.remove('dark') })

    // 4b. 关了「聊天头像」:名字条开卡,卡在名字条下面
    await win.evaluate(() => { localStorage.setItem('forsion_chat_avatars', '0'); document.documentElement.dataset.chatAvatars = 'off' })
    await sleep(300)
    const nameHit = win.locator('.t2-asst .t2-name-hit').first()
    await nameHit.click()
    await win.waitForSelector('.pc-card', { timeout: 3000 })
    await sleep(600)
    const nb = await rectOf(nameHit)
    const c5 = await cardBox()
    rep.check('名字条开的卡看得见', shown(c5))
    rep.check('关头像时名字条开卡、卡在名字条下面', c5.top >= nb.y + nb.height && c5.top - (nb.y + nb.height) < 12 && Math.abs(c5.left - nb.x) < 3, `card=(${c5.left.toFixed(1)},${c5.top.toFixed(1)}) name.bottom=${(nb.y + nb.height).toFixed(1)} name.left=${nb.x.toFixed(1)}`)
    await win.screenshot({ path: path.join(SHOTS, 'avatars-off.png') })
    await win.keyboard.press('Escape'); await waitGone()
    await win.evaluate(() => { localStorage.removeItem('forsion_chat_avatars'); delete document.documentElement.dataset.chatAvatars })

    // 「资料」→ Agents 里 Xyra 的资料页
    await xa.click(); await win.waitForSelector('.pc-card [data-act="profile"]')
    await win.locator('.pc-card [data-act="profile"]').click()
    const opened = await win.waitForSelector('[data-agent-profile="xyra"]', { timeout: 8000 }).then(() => true, () => false)
    rep.check('「资料」打开 Xyra 的资料页', opened)
  } catch (e) {
    console.error(e)
    rep.check('脚本跑完', false, String(e && e.message || e))
  } finally {
    await close()
  }
  console.log('截图 →', SHOTS)
  process.exit(rep.summary() ? 1 : 0)
})()
