/**
 * Chat 画布长直线自动折叠(方案 docs/ToBeImproved/画布直线折叠方案_2026-11-07,C 目录卡)的真 Electron 台架:
 * 桩引擎回一棵树:主线 8 轮,第 6 轮分出一支 B1(自己 4 轮)。一段超过 3 轮 → 留开头 1 + 末尾 2,中间换成目录卡。
 * 断言:主线 1–6 收起第 2–4 轮、B1 收起它的第 2 轮,分叉卡和最后两轮都在;目录卡一行一问(轮次号 + 问题),连线穿过它;
 * 点一行 = 这一段展开、选中那张、露在视野里、记进本机,原来目录卡的位置换成「收起 3 轮」;点「收起」回去;「全部展开」后重开还展开着;
 * 视图里关掉 / 打开自动折叠:正看着的那张卡在屏幕上不动;阅读栏 ↑ 翻到被收起的那一轮 = 这一段自动展开;目录卡右键 =「全部展开」。
 * 最后拍亮 / 暗 / 柔青三张,自己看。
 * 量的是 out/ 产物:改了源码先 `npm run build`。
 *   node ../.claude/hooks/devlock.cjs run --vehicle=e2e --what="画布直线折叠台架" --eta=2 -- node scripts/chat-canvas-runfold.e2e.cjs
 *   SHOT_DIR=… 指定截图目录;LANG_EN=1 拍英文
 */
const path = require('path')
const { launch, boot, enterSpace, makeReporter, shotDir } = require('./lib/uiux-electron.cjs')

const R = '7e1e0a52-0000-4000-8000-0000000000a1'
const B1 = '7e1e0a52-0000-4000-8000-0000000000b1'
const T = Date.now() - 60 * 60_000
const QS = ['下个月想去京都玩 5 天，帮我排个大致行程', '第二天想加上嵯峨野小火车', '住哪一片交通方便？', '预算大概多少？两个人', '红叶季会不会人很多？',
  '那把行程改成避开周末的版本', '把第三天换成奈良', '整理成一张表']
const AS = ['按片区排，一天一片：东山、岚山、伏见稻荷 + 宇治、市区、机动。', '小火车约 25 分钟，旺季提前一个月订座。', '首选四条河原町，带大行李就住京都站。',
  '5 天两人约 ¥1.4 万（不含机票）。', '会。清水寺和岚山 10 点后基本排队，建议 7 点前到。', '岚山和伏见挪到周二周三，周末留给宇治和市区。',
  '京都站坐近铁特急 35 分钟到奈良，半天足够。', '按天整理好了：日期 / 片区 / 交通 / 预计花费。']
const BQ = ['换个思路：整趟只住一家旅馆行吗？', '推荐三家性价比高的', '这三家哪家早餐好？', '能不能都订可取消的？']
const BA = ['行。住四条河原町一家到底，每天单程不超过 40 分钟。', '挑了三家，都在四条河原町步行 8 分钟内。', '第二家的京料理早餐评价最高。', '三家都有入住前 3 天免费取消的房型。']

function sessions(dir) {
  const base = { summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: dir, project_name: 'Forsion', projectless: false }
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = (id, title, mins, more = {}) => ({ ...base, id, title, created_at: at(mins + 60), updated_at: at(mins), ...more })
  return [row(R, '京都 5 天行程', 1), row(B1, '只住一家旅馆', 2, { parent_session_id: R, fork_message_id: 'a6', fork_session_id: R, created_at: at(20) })]
}
const msg = (id, role, mins, content) => ({ id, role, timestamp: T + mins * 60_000, content })
const rootMsgs = QS.flatMap((q, i) => [msg(`u${i + 1}`, 'user', i * 2, q), msg(`a${i + 1}`, 'model', i * 2 + 1, AS[i])])
// 分支开头复制前 6 轮(新 id、服务端时间戳),然后自己问 4 轮
const b1Msgs = [...rootMsgs.slice(0, 12).map((m, i) => ({ ...m, id: `x${i}`, timestamp: T - 3600_000 + i })),
  ...BQ.flatMap((q, i) => [msg(`c${i + 1}`, 'user', 30 + i * 2, q), msg(`d${i + 1}`, 'model', 31 + i * 2, BA[i])])]

async function main() {
  const r = makeReporter()
  const dir = shotDir('chat-canvas-runfold')
  let projectDir = ''
  const ctx = await launch({
    tag: 'chat-canvas-runfold',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: sessions(projectDir) }
      let m = /^\/agent\/sessions\/([^/]+)\/messages$/.exec(p)
      if (m && method === 'GET') return { messages: { [R]: rootMsgs, [B1]: b1Msgs }[m[1]] || [] }
      m = /^\/agent\/sessions\/([^/]+)\/asides$/.exec(p)
      if (m && method === 'GET') return { asides: [] }
      m = /^\/agent\/sessions\/([^/]+)\/detail$/.exec(p)
      if (m) { const s = sessions(projectDir).find((x) => x.id === m[1]); if (s) return { session: { ...s, kind: 'user', delegate_running: false } } }
      return undefined
    },
  })
  projectDir = ctx.projectDir
  const { win } = ctx
  win.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  const turn = (sid, mid) => win.locator(`.t2cv-turn[data-cv-node="${sid}:${mid}"]`)
  const nodes = () => win.evaluate(() => [...document.querySelectorAll('.t2cv-turn')].map((e) => e.dataset.cvNode))
  const fold = (head) => win.locator(`.t2cv-turn[data-cv-node="~run:${head}"]`)
  const screenY = (loc) => loc.evaluate((e) => Math.round(e.getBoundingClientRect().top))
  const unfoldPref = () => win.evaluate((root) => { try { return JSON.parse(localStorage.getItem('tangu.chatCanvas') || '{}')[root]?.unfold || [] } catch { return [] } }, R)
  const viewItem = async (re) => {
    await win.locator('[data-testid="cv-view"]').click()
    await win.locator('.ctx-menu').waitFor({ timeout: 5_000 })
    return win.locator('.ctx-menu .ctx-item').filter({ hasText: re }).first()
  }
  const settle = (ms = 700) => win.waitForTimeout(ms)
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1440, height: 900 })
    if (process.env.LANG_EN) await win.evaluate(() => localStorage.setItem('tangu_locale', 'en'))
    await win.evaluate(() => { localStorage.setItem('tangu.chatCanvas.hintsSeen', '3'); localStorage.removeItem('tangu.chatCanvas.autofold') })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    const row = (id) => win.locator(`.t2s-srow[data-sel-id="${id}"]`).first()
    await row(R).waitFor({ timeout: 20_000 })
    await row(R).click()
    await win.locator('#tocmsg-a8').waitFor({ timeout: 15_000 })
    const seg = win.locator('.t2-chat-col > .lcl-viewhead [data-testid="chat-canvas-seg"]')
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 8_000 })
    await fold(`${B1}:c1`).waitFor({ timeout: 8_000 })
    await settle(900)

    // ── 缺省开:两段长直线折起来 ──
    const n0 = await nodes()
    const want = [`${R}:u1`, `~run:${R}:u1`, `${R}:u5`, `${R}:u6`, `${R}:u7`, `${R}:u8`, `${B1}:c1`, `~run:${B1}:c1`, `${B1}:c3`, `${B1}:c4`]
    r.check('RF1 主线 1–6 收起第 2–4 轮、B1 收起它的第 2 轮;分叉卡(第 6 轮)和每支最后两轮都在', n0.length === want.length && want.every((k) => n0.includes(k)), JSON.stringify(n0))
    const idx = await fold(`${R}:u1`).evaluate((e) => ({
      head: e.querySelector('.t2cv-index-h b')?.textContent || '',
      rows: [...e.querySelectorAll('.t2cv-index-row')].map((b) => `${b.querySelector('i')?.textContent}|${b.querySelector('span')?.textContent}`),
      w: e.offsetWidth,
    }))
    r.check('RF2 目录卡:标「折叠了 3 轮」、一行一问(轮次号 + 问题),宽同卡片', /3/.test(idx.head) && idx.rows.length === 3 && idx.rows[0] === `2|${QS[1]}` && idx.rows[2] === `4|${QS[3]}` && idx.w === 340, JSON.stringify(idx))
    const edges = await win.evaluate(() => document.querySelectorAll('.t2cv-edges path').length)
    r.check('RF3 连线穿过目录卡(10 个节点 9 根线)', edges === 9, String(edges))
    await win.screenshot({ path: path.join(dir, 'runfold-light.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'dark'; e.classList.add('dark') })
    await settle(400)
    await win.screenshot({ path: path.join(dir, 'runfold-dark.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.mode = 'light'; e.classList.remove('dark'); e.dataset.skin = 'teal'; e.dataset.bg = 'teal' })
    await settle(400)
    await win.screenshot({ path: path.join(dir, 'runfold-teal.png') })
    await win.evaluate(() => { const e = document.documentElement; e.dataset.skin = 'cream'; e.dataset.bg = 'cream' })

    // ── 右键目录卡 ──
    // 先看全部(⇧1):主线那张目录卡在落位视野的上面
    await win.locator('.t2cv-stage').focus()
    await win.keyboard.press('Shift+Digit1')
    await settle(700)
    await fold(`${R}:u1`).locator('.t2cv-index-h b').click({ button: 'right' })
    await win.locator('.ctx-menu').waitFor({ timeout: 3_000 })
    const m = await win.locator('.ctx-menu .ctx-item').allTextContents()
    await win.keyboard.press('Escape')
    await win.locator('.ctx-menu').waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {})
    r.check('RF4 目录卡右键 =「全部展开」', m.length === 1 && /全部展开|Expand all/.test(m[0]), JSON.stringify(m))

    // ── 点一行:展开、选中、露出来、记住 ──
    await fold(`${R}:u1`).locator('.t2cv-index-row').nth(1).click()
    await turn(R, 'u3').waitFor({ timeout: 5_000 })
    await settle(900)
    const jr = await turn(R, 'u3').evaluate((e) => {
      const b = e.getBoundingClientRect(), st = e.closest('.t2cv-stage').getBoundingClientRect()
      return { sel: !!e.querySelector('.t2cv-card[data-sel]'), inView: b.top >= st.top - 1 && b.bottom <= st.bottom + 1 && b.left >= st.left - 1 && b.right <= st.right + 1 }
    })
    const pill = win.locator('[data-testid="cv-runclose"]')
    const pillTxt = (await pill.count()) ? await pill.first().textContent() : ''
    const pillOn = (await pill.count()) ? await pill.first().evaluate((e) => e.closest('.t2cv-turn')?.dataset.cvNode) : ''
    const pref1 = await unfoldPref()
    r.check('RF5 点「住哪一片」那行:这一段展开、选中那张、整张在视野里;原来目录卡的位置换成「收起 3 轮」;记进本机',
      jr.sel && jr.inView && (await fold(`${R}:u1`).count()) === 0 && /3/.test(pillTxt) && pillOn === `${R}:u2` && pref1.includes(`${R}:u1`), JSON.stringify({ jr, pillTxt, pillOn, pref1 }))
    await win.screenshot({ path: path.join(dir, 'runfold-open.png') })
    await pill.first().click()
    await fold(`${R}:u1`).waitFor({ timeout: 5_000 })
    await settle(500)
    r.check('RF6 点「收起」:目录卡回来,那几张又收进去,本机记录清掉', (await turn(R, 'u3').count()) === 0 && !(await unfoldPref()).includes(`${R}:u1`), '')

    // ── 「全部展开」后重开画布还展开着 ──
    await fold(`${B1}:c1`).locator('[data-testid="cv-runfold-open"]').click()
    await turn(B1, 'c2').waitFor({ timeout: 5_000 })
    await seg.getByRole('tab').nth(0).click()
    await win.waitForTimeout(800)
    await seg.getByRole('tab').nth(1).click()
    await win.locator('.t2cv').waitFor({ timeout: 8_000 })
    await settle(900)
    r.check('RF7 「全部展开」后切回对话再回画布:那一段还展开着', (await turn(B1, 'c2').count()) === 1 && (await fold(`${B1}:c1`).count()) === 0, '')
    await win.locator('[data-testid="cv-runclose"]').first().click()
    await fold(`${B1}:c1`).waitFor({ timeout: 5_000 })
    await settle(500)

    // ── 视图里关掉 / 打开:正看着的那张不动 ──
    const tailY0 = await screenY(turn(R, 'u8'))
    await (await viewItem(/不再自动折叠长直线|Stop auto-collapsing/)).click()
    await turn(R, 'u3').waitFor({ timeout: 5_000 })
    await settle(900)
    const tailY1 = await screenY(turn(R, 'u8'))
    const offN = (await nodes()).length
    const offPref = await win.evaluate(() => localStorage.getItem('tangu.chatCanvas.autofold'))
    await (await viewItem(/^自动折叠长直线$|^Auto-collapse long runs$/)).click()
    await fold(`${R}:u1`).waitFor({ timeout: 5_000 })
    await settle(900)
    const tailY2 = await screenY(turn(R, 'u8'))
    r.check('RF8 视图里关掉:所有卡都画出来(12 张)、记进本机;再打开又折;两次正看着的最后一张在屏幕上都不动(2px 内)',
      offN === 12 && offPref === '0' && Math.abs(tailY1 - tailY0) <= 2 && Math.abs(tailY2 - tailY0) <= 2, JSON.stringify({ offN, offPref, tailY0, tailY1, tailY2 }))

    // ── 阅读栏翻到被收起的那一轮:自动展开 ──
    await turn(R, 'u5').locator('.t2cv-q').dblclick()
    await win.locator('[data-testid="cv-read"]').waitFor({ timeout: 5_000 })
    await settle(500)
    await win.keyboard.press('ArrowUp')
    await settle(800)
    const rk = await win.locator('[data-testid="cv-read"]').getAttribute('data-cv-read')
    r.check('RF9 阅读栏从第 5 轮按 ↑ 到被收起的第 4 轮:这一段自动展开、记进本机', rk === `${R}:u4` && (await turn(R, 'u4').count()) === 1 && (await unfoldPref()).includes(`${R}:u1`), JSON.stringify({ rk }))
    await win.keyboard.press('Escape')
    console.log(`截图:${dir}`)
  } finally {
    await ctx.close()
  }
  process.exitCode = r.summary() ? 1 : 0
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
