/**
 * check:emptystates —— 主区空态统一(10-25 第四轮 4.1)+ Agent 运行设置一种下拉(4.3)的真 Electron 台架。
 * 方案页:仓根 docs/ToBeImproved/走查续_其他可优化点方案_2026-10-25/(§2 的 4.1 / 4.3、§4 的细节)。
 *
 * 桩引擎(lib/stub-engine.cjs)+ 隔离 home(overrideHome);量的是 out/ 产物 —— 改了源码先 `npx electron-vite build`。
 *  A Muse Space:中间那栏是公共空态「Muse 还没开」+「开启 Muse」,水平居中在中间那栏里;右栏没有两行长胶囊,
 *    是一行「未开启 · 去设置」;点「开启 Muse」→ 设置浮窗落在 Agent › 后台 Agent(ag-special)。
 *  B 收件箱:一封信都没有 → 主区「收件箱是空的」,列表不再写「暂无内容」;有信但都读过 → 主区「没有未读消息」。
 *  C 图像工作室启动台:空态带图标 +「新建项目」。D 发布管理没登录:居中空态 +「登录 Forsion」,不再是一条横幅。
 *  E 造物:同一个空态组件。F Agents:运行设置里 0 个原生 select,三个触发器同一种;审批档名字 = 输入框那套,
 *    「跟随默认」括号里写当前缺省(Medium / 替我批准)。
 * 截图(亮 / 暗)落 SHOT_DIR(缺省系统临时目录 forsion-emptystates-shots),DESIGN §8:断言全绿 ≠ 看起来对,自己看。
 *
 * 用法:cd desktop && npx electron-vite build && npm run check:emptystates
 */
const path = require('path')
const { launch, boot, enterSpace, sleep, shotDir, makeReporter } = require('./lib/uiux-electron.cjs')

const OUT = shotDir('emptystates')
const { check, note, summary } = makeReporter()

// 收件箱:按阶段换内容(第一阶段一封都没有;第二阶段一封已读的)
const inbox = { messages: [] }
const letter = (id, read) => ({ id, title: `Weekly digest ${id}`, body: 'Here is what happened this week.', sender_kind: 'server', sender_id: null, created_at: '2026-10-25 09:00:00', read_at: read ? '2026-10-25 09:05:00' : null, archived_at: null })
const stubOverride = ({ path: p, url }) => {
  if (p === '/agent/special/muse/status') return { status: { enabled: false } }
  if (p === '/agent/special/muse/library') return { root: '', files: [] }
  if (p === '/agent/inbox' && url.searchParams.get('filter') === 'archived') return { messages: [] }
  if (p === '/agent/inbox') return { messages: inbox.messages }
  if (p === '/agent/inbox/unread-count') return { count: inbox.messages.filter((m) => !m.read_at).length, latestId: inbox.messages[0]?.id ?? null }
  return undefined
}

/** 亮 / 暗:与方案页出图(r4-shoot)同一种切法。 */
const look = (win, mode) => win.evaluate((m) => { const r = document.documentElement; r.dataset.mode = m; r.classList.toggle('dark', m === 'dark') }, mode)
const shoot = async (win, name) => {
  for (const mode of ['light', 'dark']) {
    await look(win, mode); await sleep(250)
    await win.screenshot({ path: path.join(OUT, `${name}-${mode}.png`) })
  }
  await look(win, 'light')
}

/** 空态的几何:标题在容器里水平居中(±6px),整块在容器纵向范围内,标题只占一行级的高度。 */
const centred = (win, emptySel, boxSel) => win.evaluate(([e, b]) => {
  const el = document.querySelector(e), box = el && (b ? el.closest(b) || document.querySelector(b) : el.parentElement)
  if (!el || !box) return { ok: false, why: 'missing' }
  const t = el.querySelector('.empty-state-title').getBoundingClientRect(), r = box.getBoundingClientRect()
  const dx = Math.round((t.left + t.width / 2) - (r.left + r.width / 2))
  return { ok: Math.abs(dx) <= 6 && t.top > r.top && t.bottom < r.bottom, dx, top: Math.round(t.top - r.top), h: Math.round(r.height) }
}, [emptySel, boxSel])

const text = (win, sel) => win.locator(sel).first().textContent().then((s) => (s || '').trim(), () => '')

async function main() {
  const { app, win, close } = await launch({ tag: 'emptystates', overrideHome: true, stubOverride })
  const floating = () => app.windows().filter((x) => !x.isClosed() && x.url().includes('window=floating')).pop()
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 })
    await win.evaluate(() => document.querySelectorAll('.ach-toast').forEach((t) => t.remove()))

    // ── A Muse ──
    check('A 进入 Muse Space', await enterSpace(win, 'muse'))
    const museEmpty = '[data-muse-space="empty"] .muse-lib-preview .empty-state[data-state="off"]'
    await win.locator(museEmpty).waitFor({ timeout: 15_000 }).catch(() => {})
    check('A 中间那栏:公共空态「Muse 还没开」', (await text(win, `${museEmpty} .empty-state-title`)) === 'Muse 还没开', await text(win, `${museEmpty} .empty-state-title`))
    check('A 空态只有一颗主按钮「开启 Muse」', (await win.locator(`${museEmpty} .empty-state-action`).count()) === 1 && (await text(win, `${museEmpty} .empty-state-action`)) === '开启 Muse')
    const ma = await centred(win, museEmpty, '.muse-lib-preview')
    check('A 空态在中间那栏里水平居中', ma.ok, JSON.stringify(ma))
    const off = win.locator('.muse-off-line').first()
    await off.waitFor({ timeout: 10_000 }).catch(() => {})
    const offBox = await off.boundingBox().catch(() => null)
    check('A 右栏:一行「未开启 · 去设置」', (await text(win, '.muse-off-line')).replace(/\s+/g, ' ') === '未开启 · 去设置' && !!offBox && offBox.height < 26, offBox ? `h=${Math.round(offBox.height)}` : 'missing')
    check('A 右栏:没有「未开启」长胶囊', (await win.locator('.conn-pill[data-state="disabled"]').count()) === 0)
    await shoot(win, 'muse')
    await win.locator(`${museEmpty} .empty-state-action`).click()
    let fl = null
    for (let i = 0; i < 60 && !fl; i++) { const f = floating(); if (f && await f.locator('.settings-sub[data-settings-sub="ag-special"]').count().catch(() => 0)) fl = f; else await sleep(250) }
    check('A「开启 Muse」打开设置 › 后台 Agent', !!fl)
    if (fl) { await fl.close().catch(() => {}); await sleep(400) }

    // ── B 收件箱:一封都没有 ──
    check('B 进入收件箱', await enterSpace(win, 'inbox'))
    const ibxEmpty = '.ibx-reader .empty-state'
    await win.locator(`${ibxEmpty}[data-state="empty"]`).waitFor({ timeout: 10_000 }).catch(() => {})
    check('B 一封都没有 → 主区「收件箱是空的」', (await text(win, `${ibxEmpty} .empty-state-title`)) === '收件箱是空的', await text(win, `${ibxEmpty} .empty-state-title`))
    check('B 不再自相矛盾:没有「选择一封消息开始阅读」', !(await win.locator('.ibx-reader').first().textContent()).includes('选择一封消息开始阅读'))
    check('B 列表不再重复「暂无内容」', (await win.locator('.t2sw-empty').filter({ hasText: '暂无内容' }).count()) === 0)
    const ib = await centred(win, `${ibxEmpty}`, '.ibx-reader')
    check('B 空态在阅读面板里水平居中', ib.ok, JSON.stringify(ib))
    await shoot(win, 'inbox-empty')

    // ── B' 有信但都读过 ──
    inbox.messages = [letter('m1', true)]
    await win.reload({ waitUntil: 'domcontentloaded' }); await win.waitForSelector('.dv-groupview', { timeout: 30_000 }); await sleep(1800)
    await enterSpace(win, 'inbox')
    await win.locator(`${ibxEmpty}[data-state="caught-up"]`).waitFor({ timeout: 10_000 }).catch(() => {})
    check('B\' 有信都读过 → 「没有未读消息」+ 选一封读', (await text(win, `${ibxEmpty} .empty-state-title`)) === '没有未读消息' && (await text(win, `${ibxEmpty} .empty-state-line`)) === '选择一封消息开始阅读', await text(win, ibxEmpty))
    inbox.messages = []

    // ── C 图像工作室 ──
    if (await enterSpace(win, 'image-studio')) {
      const ims = '.ims-launch .empty-state[data-state="empty"]'
      await win.locator(ims).waitFor({ timeout: 10_000 }).catch(() => {})
      check('C 图像工作室:图标 + 标题 +「新建项目」', (await win.locator(`${ims} .empty-state-icon`).count()) === 1 && (await text(win, `${ims} [data-action="new-project"]`)) === '新建项目')
      const ic = await centred(win, ims, '.csl-catalog')
      check('C 空态在启动台里水平居中', ic.ok, JSON.stringify(ic))
      await shoot(win, 'image-studio')
    } else note('C 图像工作室 Space 不在(本构建没开)')

    // ── D 发布管理 ──
    if (await enterSpace(win, 'public')) {
      const pv = '.pv .empty-state[data-state="signed-out"]'
      await win.locator(pv).waitFor({ timeout: 10_000 }).catch(() => {})
      check('D 发布管理没登录:居中空态', (await text(win, `${pv} .empty-state-title`)) === '登录后，这里列出你发布过的东西', await text(win, `${pv} .empty-state-title`))
      const hasLogin = await win.evaluate(() => !!window.tangu?.forsionLogin)
      check('D 按钮「登录 Forsion」(有登录桥时)', !hasLogin || (await text(win, `${pv} [data-action="sign-in"]`)) === '登录 Forsion', `forsionLogin=${hasLogin}`)
      const pc = await centred(win, pv, '.pv')
      check('D 空态在页面里水平居中', pc.ok, JSON.stringify(pc))
      await shoot(win, 'public')
    } else note('D 发布管理 Space 不在(本构建没开)')

    // ── E 造物 ──
    if (await enterSpace(win, 'artificial')) {
      await win.locator('.empty-state[data-state="empty"]').first().waitFor({ timeout: 10_000 }).catch(() => {})
      check('E 造物:同一个空态组件', (await win.locator('.art-inner .empty-state[data-state="empty"]').count()) === 1)
    } else note('E 造物 Space 不在(本构建没开)')

    // ── F Agents 运行设置 ──
    check('F 进入 Agents', await enterSpace(win, 'agents'))
    const run = win.locator('[data-agent-profile] .profile-config-group').first()
    await run.waitFor({ timeout: 15_000 }).catch(() => {})
    check('F 运行设置:0 个原生 select', (await run.locator('select').count()) === 0)
    check('F 三个下拉同一种触发器', (await run.locator('.profile-model-trigger').count()) === 3)
    check('F 思考档位「跟随默认（Medium）」', (await text(run, '[data-profile-field="thinking"] .profile-model-trigger')) === '跟随默认（Medium）')
    await run.locator('[data-profile-field="approval"] .profile-model-trigger').click()
    const opts = (await run.locator('[data-profile-field="approval"] [role="option"]').allTextContents()).map((s) => s.trim())
    check('F 审批档名字 = 输入框那套', JSON.stringify(opts) === JSON.stringify(['跟随默认（替我批准）', '询问我批准', '替我批准', '完全放行', '自定义（config.json）']), JSON.stringify(opts))
    check('F 不再有「只读 / 自动编辑 / 完全自动」', !opts.some((o) => /只读|自动编辑|完全自动/.test(o)))
    await win.keyboard.press('ArrowDown')
    const focused = await win.evaluate(() => document.activeElement?.textContent?.trim())
    check('F 键盘:展开后 ↓ 移到下一项', focused === '询问我批准', focused)
    await win.keyboard.press('Escape')
    check('F Esc 收起', (await run.locator('[role="listbox"]').count()) === 0)
    await win.evaluate(() => { const c = document.querySelector('[data-agent-profile] .agent-profile-content'); if (c) c.scrollTop = 0 })
    await win.mouse.move(1490, 900)
    await shoot(win, 'agent-run-settings')
    await run.locator('[data-profile-field="thinking"] .profile-model-trigger').click()
    await win.evaluate(() => { const c = document.querySelector('[data-agent-profile] .agent-profile-content'); if (c) c.scrollTop = 0 })
    await shoot(win, 'agent-run-settings-open')
    await win.keyboard.press('Escape')
  } finally {
    await close()
  }
  console.log(`截图:${OUT}`)
  if (summary()) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
