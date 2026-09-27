/**
 * 思考档位 Ultra(对标 Codex Ultra:max + 主动并行派子代理)的真 Electron 台架:真组件 / store × 可编剧假引擎。
 * 钉的是单测够不着的接线与观感:
 *   U1 本机 work 会话:滑杆第 8 格是 Ultra;U2 sandbox 会话:没有这一格(Ultra 入口只给 host 会话,云端 / chat 都是 sandbox)
 *   U3 拖到 Ultra 先弹确认框(09-27 用户要求:说清 token 代价、推荐「完全放行」、「以后不再显示」):
 *      U3e Esc 取消 → 一个 PATCH 都没发、模型菜单还开着;U3f 再拖、勾「同时切到完全放行」确认 → PATCH 审批档 full-auto 与
 *      { thinkingLevel:'max', ultra:true },菜单原地切进 Ultra(皮 + 冲击波放一次)
 *   U4 关掉菜单再开:冲击波不再放(只在「刚切进来」那一下);U4b 切进来 0.1s 内就关菜单(动画没放完)再开也不重播
 *   U5 发一句 → run 的 agent_config 带 ultra:true + max + full-auto(引擎就靠这几个键)
 *   U6 显式改回「深」→ PATCH 把 ultra 删掉(null),药丸回普通皮
 *   U7 斜杠菜单点 `/think ultra` 同样先弹确认(U10 焦点留在确认框里,不被下一帧的输入框回焦抢走);
 *      勾「以后不再显示」确认 → 切回 Ultra;U8 之后再开不弹、直接生效
 *   U9 审批档已是「完全放行」时确认框不再推荐 / 不给那个勾选项(借 U7 那一轮验)
 * 截图落 ULTRA_SHOT_DIR(缺省 /tmp/ultra-effort-shots):药丸 + 展开的滑杆,自己看。
 *
 * 需先 npm run build。用法:npm run check:ultra
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')

const ROOT = path.join(__dirname, '..')
const SHOTS = process.env.ULTRA_SHOT_DIR || path.join(os.tmpdir(), 'ultra-effort-shots')
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

const session = (id, title, extra) => ({
  id, title, summary: '', model_id: 'm1', archived: false, emoji: null, agent_config: null,
  created_at: '2026-09-27 09:00:00', updated_at: `2026-09-27 09:0${id === 'local' ? 5 : 1}:00`, ...extra,
})

async function openSession(win, title) {
  const row = win.locator('.t2s-srow, .t2o-row').filter({ hasText: title }).first()
  try {
    await row.waitFor({ timeout: 15_000 })
  } catch (e) {
    // 找不到行时留证据:截图 + 当前可见的行文本(会话列表按项目分组 / 侧栏筛选都可能把它藏起来)
    await win.screenshot({ path: path.join(SHOTS, `debug-${title}.png`) }).catch(() => {})
    const rows = await win.locator('.t2s-srow, .t2o-row').allTextContents().catch(() => [])
    console.error(`找不到会话行「${title}」,可见行:${JSON.stringify(rows.slice(0, 20))}`)
    throw e
  }
  await row.click()
  await win.waitForTimeout(1200)
}
async function openPill(win) {
  const btn = win.locator('.t2c-row .model-pill-btn').first()
  if (!(await btn.getAttribute('aria-expanded').catch(() => null) === 'true')) await btn.click()
  await win.waitForTimeout(500)
}
async function closePill(win) {
  await win.keyboard.press('Escape')
  await win.waitForTimeout(400)
}
const lastPatch = (stub, sid) => [...stub.seen.configs].reverse().find((c) => c.sessionId === sid && c.method === 'PATCH')?.config

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先跑 npm run build')
    process.exit(1)
  }
  fs.mkdirSync(SHOTS, { recursive: true })
  const stub = await startStubEngine({
    sessions: [
      session('local', '本机会话', { project_path: '/tmp/demo', project_name: 'demo' }),
      // 隔离实例没登录,云端会话不进侧栏;用「列在本机项目下、存值却是 sandbox」的会话钉同一条门控(isHost)。
      session('sandbox', '沙箱会话', { project_path: '/tmp/sandboxdemo', project_name: 'sandboxdemo' }),
    ],
    sessionConfigs: { sandbox: { execMode: 'sandbox' } },
    models: [{ id: 'm1', name: 'Stub 模型', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] }],
  })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-ultra-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
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
    // 启动落在主页 Space(输入框目标是云端项目,本来就没有 Ultra 格)—— 切到 Tangu Space 才有会话列表。
    await win.locator('[data-ribbon-id="space:tangu"], [data-id="space:tangu"]').first().click()
    await win.waitForTimeout(1500)

    // ── U2(先跑负对照):sandbox 会话没有 Ultra 格
    await openSession(win, '沙箱会话')
    await openPill(win)
    const sandboxMax = await win.locator('.cm-effort-input').first().getAttribute('max').catch(() => null)
    check('U2 sandbox 会话:滑杆只有七档(max=6),没有 Ultra 格', sandboxMax === '6', `max=${sandboxMax}`)
    await closePill(win)

    // ── U1 / U3:本机会话拖到 Ultra
    await openSession(win, '本机会话')
    await openPill(win)
    const input = win.locator('.cm-effort-input').first()
    const localMax = await input.getAttribute('max').catch(() => null)
    check('U1 本机 work 会话:滑杆第 8 格是 Ultra(max=7)', localMax === '7', `max=${localMax}`)
    const dialog = win.locator('[data-ultra-confirm] .dialog')
    const patchesBefore = stub.seen.configs.filter((c) => c.sessionId === 'local').length
    await input.focus()
    await win.keyboard.press('End')
    await win.waitForTimeout(300)
    const askShown = await dialog.count().catch(() => 0)
    const offer = await win.locator('[data-ultra-full-access]').count().catch(() => 0)
    await win.screenshot({ path: path.join(SHOTS, 'ultra-confirm.png') })
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
    const afterEsc = {
      dialog: await dialog.count().catch(() => 0),
      menuOpen: await win.locator('.cm-effort').count().catch(() => 0),
      patches: stub.seen.configs.filter((c) => c.sessionId === 'local').length - patchesBefore,
      value: await win.locator('.cm-effort-input').first().inputValue().catch(() => null),
      // 焦点还给打开它的滑杆(键盘用户接着用方向键)
      focusBack: await win.evaluate(() => !!document.activeElement?.classList.contains('cm-effort-input')),
    }
    check('U3e 拖到 Ultra 先弹确认框(带「推荐完全放行」勾选项);Esc 取消 → 不发 PATCH、滑杆没动、模型菜单还开着',
      askShown === 1 && offer === 1 && afterEsc.dialog === 0 && afterEsc.menuOpen === 1 && afterEsc.patches === 0 && afterEsc.value !== '7' && afterEsc.focusBack,
      JSON.stringify({ askShown, offer, ...afterEsc }))
    await win.locator('.cm-effort-input').first().focus()
    await win.keyboard.press('End')
    await win.waitForTimeout(300)
    await win.locator('[data-ultra-full-access] input').check()
    await win.locator('[data-ultra-confirm] .dialog-btn[data-primary]').click()
    await win.waitForTimeout(120)
    const burstSeen = await win.locator('.cm-effort-burst').count().catch(() => 0)
    const approvalPatch = stub.seen.configs.find((c) => c.sessionId === 'local' && c.method === 'PATCH' && c.config?.approvalMode === 'full-auto')
    check('U3f 勾「同时切到完全放行」确认 → PATCH 审批档 full-auto', !!approvalPatch, JSON.stringify(approvalPatch?.config))
    await win.waitForTimeout(900)
    const ui = await win.evaluate(() => ({
      effort: document.querySelector('.cm-effort')?.className || '',
      value: document.querySelector('.cm-effort-value')?.textContent || '',
      pill: document.querySelector('.t2c-row .model-pill-btn')?.className || '',
      note: document.querySelector('.cm-effort-note')?.textContent || '',
      streaks: document.querySelectorAll('.cm-effort-streaks i').length,
      burstLeft: document.querySelectorAll('.cm-effort-burst').length,
      describedBy: (() => { const el = document.querySelector('.cm-effort-input'); const id = el?.getAttribute('aria-describedby'); return !!id && document.getElementById(id)?.textContent || '' })(),
    }))
    const patch = lastPatch(stub, 'local')
    check('U3a PATCH 带 { thinkingLevel:max, ultra:true }', patch?.thinkingLevel === 'max' && patch?.ultra === true, JSON.stringify(patch))
    check('U3b 滑杆与药丸换 Ultra 皮(值「Ultra」、四路光流、说明行)',
      /is-ultra/.test(ui.effort) && ui.value.trim() === 'Ultra' && ui.streaks === 4 && ui.note.length > 0 && /is-ultra/.test(ui.pill), JSON.stringify(ui))
    check('U3c 切进 Ultra 的那一下放了冲击波,动画完就卸载', burstSeen === 1 && ui.burstLeft === 0, `seen=${burstSeen} left=${ui.burstLeft}`)
    check('U3d 滑杆经 aria-describedby 关联说明行(读屏念得到 Ultra 的作用)', ui.describedBy.length > 0 && ui.describedBy === ui.note, JSON.stringify(ui.describedBy))
    await win.screenshot({ path: path.join(SHOTS, 'ultra-menu.png') })

    // ── U4:关了再开,不再放冲击波
    await closePill(win)
    await win.locator('.t2c-row .model-pill-btn').first().screenshot({ path: path.join(SHOTS, 'ultra-pill.png') }).catch(() => {})
    await openPill(win)
    await win.waitForTimeout(60)
    const burstAgain = await win.locator('.cm-effort-burst').count().catch(() => 0)
    check('U4 重开菜单不再放冲击波(只在刚切进来时放)', burstAgain === 0, `count=${burstAgain}`)
    // U4b:先退回 Max 再切进 Ultra,冲击波还在放(<0.7s)就关菜单 → 重开不许重播
    const input2 = win.locator('.cm-effort-input').first()
    await input2.focus()
    await win.keyboard.press('ArrowLeft')
    await win.waitForTimeout(250)
    await win.keyboard.press('End')
    await win.waitForTimeout(250)
    // 还没勾「以后不再显示」:照样先弹确认,点确认后冲击波才放
    const dialogInU4b = await dialog.count().catch(() => 0)
    if (dialogInU4b) await win.locator('[data-ultra-confirm] .dialog-btn[data-primary]').click()
    await win.waitForTimeout(60)
    const midBurst = await win.locator('.cm-effort-burst').count().catch(() => 0)
    await closePill(win)
    await openPill(win)
    await win.waitForTimeout(60)
    const replay = await win.locator('.cm-effort-burst').count().catch(() => 0)
    check('U4b 动画没放完就关菜单,重开不重播', midBurst === 1 && replay === 0, `mid=${midBurst} replay=${replay} dialog=${dialogInU4b}`)
    await closePill(win)

    // ── U5:发一句,run 带 ultra
    const ta = win.locator('.t2c-ta').first()
    for (let i = 0; i < 40; i++) { if (await ta.isEnabled().catch(() => false)) break; await win.waitForTimeout(500) }
    await ta.click()
    await ta.fill('并行查一下三个模块')
    await win.keyboard.press('Enter')
    await win.waitForTimeout(1800)
    const run = stub.seen.runs[stub.seen.runs.length - 1]
    check('U5 run 的 agent_config 带 ultra:true + thinkingLevel:max + approvalMode:full-auto',
      run?.agentConfig?.ultra === true && run?.agentConfig?.thinkingLevel === 'max' && run?.agentConfig?.approvalMode === 'full-auto',
      JSON.stringify({ ultra: run?.agentConfig?.ultra, thinkingLevel: run?.agentConfig?.thinkingLevel, approvalMode: run?.agentConfig?.approvalMode }))

    // ── U6:显式改回「深」(index 4)
    await openPill(win)
    await win.locator('.cm-effort-input').first().fill('4')
    await win.waitForTimeout(500)
    const back = lastPatch(stub, 'local')
    const offUi = await win.evaluate(() => ({
      effort: document.querySelector('.cm-effort')?.className || '',
      pill: document.querySelector('.t2c-row .model-pill-btn')?.className || '',
    }))
    check('U6 改回「深」:PATCH 把 ultra 置 null(删键),Ultra 皮退掉',
      back?.thinkingLevel === 'high' && Object.prototype.hasOwnProperty.call(back || {}, 'ultra') && back.ultra === null
      && !/is-ultra/.test(offUi.effort) && !/is-ultra/.test(offUi.pill), JSON.stringify({ back, offUi }))
    await closePill(win)

    // ── U7:键盘路径 /think ultra —— 同样先弹确认;这次勾「以后不再显示」
    // 走斜杠**菜单项**(不是「/think ultra」连参数回车的键盘路径):选中项会在下一帧回焦输入框,正是要钉的那条
    await ta.click()
    await ta.fill('/think')
    await win.waitForTimeout(400)
    await win.locator('.t2c-menu-cmd', { hasText: /^\/think ultra$/ }).first().click()
    await win.waitForTimeout(300)
    const slashAsk = await dialog.count().catch(() => 0)
    // 斜杠菜单选中项会在下一帧回焦输入框 —— 弹了确认框时不许把焦点抢走(键盘输入会落到遮罩后的草稿)
    await win.waitForTimeout(200)
    const focusInDialog = await win.evaluate(() => !!document.activeElement?.closest('[data-ultra-confirm]'))
    const dialogSemantics = await win.evaluate(() => {
      const d = document.querySelector('[data-ultra-confirm] .dialog')
      const id = d?.getAttribute('aria-labelledby')
      return d?.getAttribute('role') === 'dialog' && d?.getAttribute('aria-modal') === 'true' && !!id && !!document.getElementById(id)?.textContent
    })
    const offerAgain = await win.locator('[data-ultra-full-access]').count().catch(() => 0)
    const preConfirm = lastPatch(stub, 'local')
    if (slashAsk) {
      await win.locator('[data-ultra-skip] input').check()
      await win.locator('[data-ultra-confirm] .dialog-btn[data-primary]').click()
      await win.waitForTimeout(500)
    }
    const viaSlash = lastPatch(stub, 'local')
    check('U7 `/think ultra` 先弹确认,确认后切回 Ultra', slashAsk === 1 && preConfirm?.ultra !== true && viaSlash?.ultra === true && viaSlash?.thinkingLevel === 'max',
      JSON.stringify({ slashAsk, preConfirm, viaSlash }))
    check('U9 审批档已是「完全放行」:确认框不再推荐、不给切换勾选项', offerAgain === 0, `offer=${offerAgain}`)
    check('U10 斜杠路径弹框后焦点留在确认框里;确认框带 role=dialog / aria-modal / 标题关联', focusInDialog && dialogSemantics,
      JSON.stringify({ focusInDialog, dialogSemantics }))

    // ── U8:勾过「以后不再显示」,再开 Ultra 不弹、直接生效
    await openPill(win)
    await win.locator('.cm-effort-input').first().fill('4')
    await win.waitForTimeout(400)
    await win.locator('.cm-effort-input').first().focus()
    await win.keyboard.press('End')
    await win.waitForTimeout(400)
    const noAsk = await dialog.count().catch(() => 0)
    const direct = lastPatch(stub, 'local')
    const stored = await win.evaluate(() => localStorage.getItem('forsion_ultra_confirm_off'))
    check('U8 勾过「以后不再显示」:再开 Ultra 不弹确认、直接生效(本机 localStorage 记着)', noAsk === 0 && direct?.ultra === true && stored === '1',
      JSON.stringify({ noAsk, direct, stored }))
    await closePill(win)
  } finally {
    await app.close().catch(() => {})
    stub.close?.()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed · 截图 ${SHOTS}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
