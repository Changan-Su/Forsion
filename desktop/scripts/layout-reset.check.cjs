/**
 * 「恢复本 Space 默认布局」的兜底(09-25 UI/UX 评审 U-06)—— 打真 App(out/ 构建产物 + 隔离家目录)。
 *
 *  A 开两张新标签 + 翻转右栏开合 → 点右上角「恢复默认布局」→ 布局确实被重置(标签变了)
 *  B 右上角出现「已恢复…」通知,带「撤销」动作钮
 *  C 点「撤销」→ 标签列表与三侧开合**逐项**回到重置前(一次性 / 换 Space 作废由 lcl 单测 layoutResetUndo.test 锁)
 *  E 右上角浮钮组压着的那条标签头让出了浮钮组宽度(.dv-under-edge + padding-right),任何 tab 都不再被钮盖住
 *  F 左 / 右 / 底部三枚开合钮都带 aria-pressed,且与实际开合一致
 *  G 通知总开关关着也照样给「撤销」:它是那次操作的回执,不是一条普通通知(Codex 第一轮 C-2)
 *  H 恢复后用户先新开了一张标签 → 撤销入口当场收回(不然再点会把重置前的快照灌回、吞掉新标签;Codex 第一轮 C-1)
 *  I 恢复后只拖了左侧栏的分隔线 → 撤销入口还在,点了照样逐项复原(侧栏宽度不算「改了布局」;Codex 第三轮 H1-3)。
 *    在收件箱 Space 里做:它的默认布局带一条可自由拖宽的左栏(主页的默认布局没有侧栏)。
 *    拖主区分屏线作废撤销那半只能在默认布局里造出分屏 = 结构先变,由 lcl 单测 layoutResetUndo ⑦ 锁
 *  J 撤销提示到期自己消失:指针不在通知上(悬停会暂停计时),6.5 秒时仍在、约 8 秒后收走(不超过 10.5 秒;Codex 第三轮 R2-g-4)
 *
 * 需要先在本目录 `npx electron-vite build`(读 out/)。跑:npm run check:layoutreset
 * ⚠️ 独立 --user-data-dir + TANGU_HOME:不碰开发者自己的实例与 ~/.forsion。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || ''
if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true })
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}

/** 布局指纹:每个组的标签名(按组在屏幕上的位置排)+ 三侧开合。 */
const snapshot = (win) => win.evaluate(() => {
  const groups = [...document.querySelectorAll('.dv-groupview')]
    .map((g) => {
      const r = g.getBoundingClientRect()
      return {
        x: Math.round(r.left), y: Math.round(r.top),
        tabs: [...g.querySelectorAll('.wb-tab')].map((t) => t.getAttribute('title') || t.textContent || '').filter(Boolean),
      }
    })
    .filter((g) => g.tabs.length)
    .sort((a, b) => a.x - b.x || a.y - b.y)
  const pressed = (sel) => document.querySelector(sel)?.getAttribute('aria-pressed')
  return {
    tabs: groups.map((g) => g.tabs.join(',')).join(' | '),
    mainTabCount: document.querySelectorAll('.wb-tab-name').length,
    left: pressed('.dv-prefix .dv-edge-toggle'),
    right: pressed('.dv-edge-right'),
    bottom: pressed('.dv-edge-bottom'),
    leftPanel: !!document.querySelector('.wb-tab--left'),
  }
})

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out/main/main.js'))) {
    console.error('缺 out/main/main.js —— 先在本目录跑 npx electron-vite build')
    process.exit(1)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-layoutreset-'))
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, '--lang=zh-CN', ROOT],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: 'http://127.0.0.1:1', ELECTRON_ENABLE_LOGGING: '1' },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.waitForTimeout(2500)
    for (const label of ['跳过引导', 'Skip']) {
      const b = win.locator(`text=${label}`).first()
      if (await b.count().catch(() => 0)) { await b.click().catch(() => {}); break }
    }
    await win.waitForSelector('.dv-edge-reset', { timeout: 30_000 })
    await win.waitForTimeout(1500)

    // F 先验开合钮的 aria-pressed 与实际一致(初始态)
    const f0 = await snapshot(win)
    check('F 左 / 右 / 底部开合钮都带 aria-pressed', [f0.left, f0.right, f0.bottom].every((v) => v === 'true' || v === 'false'), `left=${f0.left} right=${f0.right} bottom=${f0.bottom}`)

    // 造一个「用户自己的布局」:两张新标签 + 翻转右栏开合
    for (let i = 0; i < 2; i++) { await win.click('.dv-new-tab'); await win.waitForTimeout(350) }
    const r0 = (await snapshot(win)).right // 启动期 Space 布局还会异步沉降一次,开合基线就地取
    await win.click('.dv-edge-right')
    await win.waitForTimeout(700)
    const before = await snapshot(win)
    check('前置:造出的布局与默认不同(多两张标签、右栏开合翻转),右栏钮 aria-pressed 跟着翻', before.mainTabCount >= 3 && before.right !== r0, JSON.stringify(before))

    // E 浮钮组压着的标签头让位
    const edge = await win.evaluate(() => {
      const er = document.querySelector('.dv-edge-actions').getBoundingClientRect()
      const covered = [...document.querySelectorAll('.dv-tab')].filter((t) => {
        const r = t.getBoundingClientRect()
        return r.width > 0 && r.top < er.bottom && r.bottom > er.top && r.right > er.left + 1 && r.left < er.right
      }).length
      const under = [...document.querySelectorAll('.dv-tabs-and-actions-container.dv-under-edge')]
      const pad = under.map((el) => parseFloat(getComputedStyle(el).paddingRight))
      return { covered, under: under.length, pad, w: er.width }
    })
    check('E 浮钮组压着的那条标签头打了 .dv-under-edge 且右内边距 ≥ 浮钮组宽', edge.under >= 1 && edge.pad.every((p) => p >= edge.w), JSON.stringify(edge))
    check('E 没有任何 tab 被浮钮组盖住', edge.covered === 0, `covered=${edge.covered}`)

    // A 重置
    await win.click('.dv-edge-reset')
    await win.waitForTimeout(900)
    const reset = await snapshot(win)
    check('A 恢复默认布局确实重置了(标签变了)', reset.tabs !== before.tabs && reset.mainTabCount < before.mainTabCount, JSON.stringify(reset))

    // B 通知带撤销
    // 按内容认那张卡,不按位置:隔离家目录下「在线同步失败:未登录」之类的卡可能先到、排在最上面。
    const card = win.locator('.ntf').filter({ hasText: /恢复/ }).first()
    const action = card.locator('.ntf-action').first()
    const hasAction = (await action.count()) > 0
    const ntfText = hasAction ? await card.innerText() : ''
    check('B 右上角通知「已恢复…」带撤销钮', hasAction && /恢复/.test(ntfText) && /撤销/.test(ntfText), ntfText.replace(/\s+/g, ' '))
    // B2 撤销提示停留约 8 秒(info 缺省 5 秒,来不及反应):6 秒时仍在。指针先挪开 —— 悬停在通知上会暂停计时,测不出东西。
    await win.mouse.move(400, 500)
    await win.waitForTimeout(6000)
    check('B2 撤销提示 6 秒后仍在(durationMs≈8s,不按 info 的 5s 消失)', (await card.count()) > 0 && (await action.count()) > 0)
    if (SHOT_DIR) await win.screenshot({ path: path.join(SHOT_DIR, 'layoutreset-toast.png') })

    // C 撤销 → 逐项复原
    if (hasAction) await action.click()
    await win.waitForTimeout(900)
    const undone = await snapshot(win)
    check('C 撤销后标签列表逐项复原', undone.tabs === before.tabs, `before=${before.tabs}\n      after =${undone.tabs}`)
    const keys = ['left', 'right', 'bottom', 'leftPanel', 'mainTabCount']
    check('C 撤销后三侧开合(及 aria-pressed)逐项复原', keys.every((k) => undone[k] === before[k]), keys.map((k) => `${k}:${before[k]}→${undone[k]}`).join(' '))
    if (SHOT_DIR) await win.screenshot({ path: path.join(SHOT_DIR, 'layoutreset-undone.png') })

    // G 关掉通知总开关(与设置页同一份偏好)后重载,再恢复默认布局:撤销提示照样出现
    await win.evaluate(() => localStorage.setItem('forsion.ntf.prefs', JSON.stringify({ enabled: false, osEnabled: false, events: {} })))
    await win.reload()
    await win.waitForSelector('.dv-edge-reset', { timeout: 30_000 })
    await win.waitForTimeout(1500)
    for (let i = 0; i < 2; i++) { await win.click('.dv-new-tab'); await win.waitForTimeout(350) }
    await win.click('.dv-edge-reset')
    await win.waitForTimeout(900)
    const card2 = win.locator('.ntf').filter({ hasText: /恢复/ }).first()
    check('G 通知总开关关着,「已恢复 · 撤销」仍出现', (await card2.count()) > 0 && (await card2.locator('.ntf-action').count()) > 0)

    // H 撤销提示还挂着时先新开一张标签:提示当场收回,新标签留着
    const afterReset = await snapshot(win)
    await win.mouse.move(400, 500)
    await win.click('.dv-new-tab')
    await win.waitForTimeout(1200)
    const afterNew = await snapshot(win)
    check('H 重置后改了布局(新开标签)→ 撤销提示收回', (await card2.count()) === 0, `mainTabCount:${afterReset.mainTabCount}→${afterNew.mainTabCount}`)
    check('H 新开的标签还在(没被旧快照吞掉)', afterNew.mainTabCount === afterReset.mainTabCount + 1, `${afterReset.mainTabCount}→${afterNew.mainTabCount}`)

    // I 重置后只拖左侧栏的分隔线:撤销仍有效(收件箱 Space:默认布局带可拖宽的左栏)
    await win.evaluate(() => { localStorage.setItem('forsion_default_space', 'inbox'); localStorage.removeItem('forsion_tangu_session_mode') })
    await win.reload()
    await win.waitForSelector('.dv-edge-reset', { timeout: 30_000 })
    await win.waitForTimeout(2000)
    check('I 前置:已落在收件箱 Space', (await win.evaluate(() => localStorage.getItem('forsion_tangu_active_space'))) === 'inbox')
    for (let i = 0; i < 2; i++) { await win.click('.dv-new-tab'); await win.waitForTimeout(350) }
    const beforeI = await snapshot(win)
    await win.click('.dv-edge-reset')
    await win.waitForTimeout(1500) // 过了重置自己的沉降(钉侧栏宽的双 raf 等)
    const card3 = win.locator('.ntf').filter({ hasText: /恢复/ }).first()
    /** 最左那个组(左侧栏)的右沿,与压在那条线上的竖向 sash 中心。 */
    const leftSash = () => win.evaluate(() => {
      const groups = [...document.querySelectorAll('.dv-groupview')].map((g) => g.getBoundingClientRect()).filter((r) => r.width > 0)
      if (!groups.length) return null
      const left = groups.reduce((a, b) => (b.left < a.left ? b : a))
      const sash = [...document.querySelectorAll('.dv-sash')].map((el) => el.getBoundingClientRect())
        .find((r) => r.width > 0 && r.width < 12 && r.height > 100 && Math.abs((r.left + r.right) / 2 - left.right) <= 6)
      return sash ? { x: (sash.left + sash.right) / 2, y: sash.top + sash.height / 2, width: left.width } : { width: left.width }
    })
    const s0 = await leftSash()
    if (s0 && s0.x !== undefined) {
      await win.mouse.move(s0.x, s0.y)
      await win.mouse.down()
      for (let dx = 10; dx <= 60; dx += 10) { await win.mouse.move(s0.x + dx, s0.y); await win.waitForTimeout(30) }
      await win.mouse.up()
    }
    await win.mouse.move(400, 500)
    await win.waitForTimeout(700)
    const s1 = await leftSash()
    check('I 前置:左侧栏分隔线真的被拖动了(宽度变了 ≥30px)', !!(s0 && s1 && s0.x !== undefined && Math.abs(s1.width - s0.width) >= 30), JSON.stringify({ s0, s1 }))
    check('I 只拖左侧栏宽:撤销提示仍在', (await card3.count()) > 0 && (await card3.locator('.ntf-action').count()) > 0)
    if (SHOT_DIR) await win.screenshot({ path: path.join(SHOT_DIR, 'layoutreset-sidedrag.png') })
    if (await card3.locator('.ntf-action').count()) await card3.locator('.ntf-action').first().click()
    await win.waitForTimeout(900)
    const undoneI = await snapshot(win)
    check('I 拖过侧栏后点撤销:标签列表逐项复原', undoneI.tabs === beforeI.tabs, `before=${beforeI.tabs}\n      after =${undoneI.tabs}`)

    // J 到期消失(约 8 秒):计时期间指针不在通知上
    await win.click('.dv-edge-reset')
    const shownAt = Date.now()
    await win.mouse.move(400, 500)
    const card4 = win.locator('.ntf').filter({ hasText: /恢复/ }).first()
    await card4.waitFor({ timeout: 3000 }).catch(() => {})
    const hovered = () => card4.evaluate((el) => el.matches(':hover')).catch(() => false)
    check('J 前置:撤销提示出现,且指针不在它上面(悬停会暂停计时)', (await card4.count()) > 0 && !(await hovered()))
    await win.waitForTimeout(Math.max(0, 6500 - (Date.now() - shownAt)))
    check('J 6.5 秒时撤销提示仍在', (await card4.count()) > 0 && !(await hovered()))
    let goneAt = 0
    while (Date.now() - shownAt < 10_500) {
      if ((await card4.count()) === 0) { goneAt = Date.now() - shownAt; break }
      await win.waitForTimeout(100)
    }
    check('J 撤销提示约 8 秒后自己收走(≤10.5 秒)', goneAt > 6500 && goneAt <= 10_500, `goneAt=${goneAt}ms`)
  } finally {
    await app.close().catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
  const bad = results.filter((r) => !r.ok)
  console.log(bad.length ? `\n${bad.length} 项失败` : `\n${results.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
