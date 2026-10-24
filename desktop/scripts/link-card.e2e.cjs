/**
 * Chat 链接预览卡 真 Electron 验收(借鉴 Comma 方案 §2.6):悬停 300ms 出卡、富卡 / 素卡、第一次打开才取、缓存、相邻接力、
 * 问不到退回素卡、只在聊天回答里出。
 *
 * 不打真 GitHub:富卡数据由假引擎的 GET /agent/link-preview 回(引擎侧真抓取在 tangu-agent 的 linkPreview.test.ts)。
 *
 * 用法:npm run build && npm run e2e:linkcard
 * 截图:os.tmpdir()/forsion-link-card-e2e/(亮 / 暗各一张富卡、一张素卡;DESIGN §8:几何全绿 ≠ 看起来对,自己看)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const electron = require('./lib/launch-electron.cjs')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { skipOnboarding } = require('./lib/skip-onboarding.cjs')

const ROOT = path.join(__dirname, '..')
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), 'forsion-link-card-e2e')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  const d = detail === undefined ? '' : `  | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d.length > 600 ? d.slice(0, 600) + '…' : d}`)
}

const PR = 'https://github.com/Changan-Su/Forsion/pull/153'
const ISSUE = 'https://github.com/Changan-Su/Forsion/issues/9'
const DOC = 'https://git.forsion.net/forsion/genesis/src/branch/main/DESIGN.md'
const SITE = 'https://example.com/guide'
const PREVIEW = { source: 'github', kind: 'pr', repo: 'Changan-Su/Forsion', number: 153, title: 'Chat: Claude-style quote tiles + jump back', state: 'merged', author: 'Changan-Su', at: `${new Date().getFullYear()}-10-23T08:00:00Z`, additions: 412, deletions: 186, changedFiles: 12, comments: 3 }

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-linkcard-'))
  const asked = []
  const at = Date.UTC(2026, 9, 24)
  const stub = await startStubEngine({
    sessions: [{ id: 'links', title: '链接卡', model_id: 'm1', archived: false, agent_config: null, project_path: null, project_name: null, created_at: '2026-10-24 12:00:00', updated_at: '2026-10-24 12:00:00' }],
    messages: [
      { id: 'u1', role: 'user', content: '看一下 #153 合了没', timestamp: at, attachments: null },
      { id: 'a1', role: 'model', content: `合了:[#153](${PR})。排版规矩见 [DESIGN.md §6](${DOC}),另外 [使用指南](${SITE}) 和 [#9](${ISSUE}) 也相关。`, timestamp: at + 1000 },
    ],
    handle: ({ path: p, url }) => {
      if (p !== '/agent/link-preview') return undefined
      const target = url.searchParams.get('url')
      asked.push(target)
      return { preview: target === PR ? PREVIEW : null }
    },
  })

  // 每种明暗各起一个全新实例(新用户目录),走同一条首启路:同一实例里改偏好再 reload 回不到会话
  const boot = async (theme) => {
    const userdata = fs.mkdtempSync(path.join(home, `userdata-${theme}-`))
    const app = await electron.launch({
      args: [`--user-data-dir=${userdata}`, '--lang=zh-CN', ROOT], cwd: ROOT,
      env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url },
    })
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1300, 900))
    await win.waitForSelector('#root')
    await win.evaluate((t) => { localStorage.setItem('forsion_default_space', 'tangu'); localStorage.setItem('forsion_theme_pref', t); localStorage.setItem('tangu_locale', 'zh') }, theme)
    await win.reload({ waitUntil: 'domcontentloaded' })
    check(`离开首启引导(${theme})`, await skipOnboarding(win))
    const view = win.locator('.t2-chat-view').first()
    await view.locator('#tocmsg-a1').waitFor({ timeout: 20000 })
    await win.locator('#tangu-splash').waitFor({ state: 'detached' }).catch(() => {})
    return { app, win, view }
  }

  let app
  try {
    let win, view
    ;({ app, win, view } = await boot('light'))
    const link = (href) => view.locator(`#tocmsg-a1 a[href="${href}"]`).first()
    const card = () => win.evaluate(() => {
      const el = document.querySelector('body > .chat-link-card')
      return el ? { text: el.textContent, open: el.hasAttribute('data-open'), rich: !!el.querySelector('.chat-link-card-rich'), state: el.querySelector('.chat-link-card-rich')?.getAttribute('data-state') ?? null } : null
    })
    const away = async () => { await win.mouse.move(2, 2); await win.waitForTimeout(400) } // 80ms 宽限 + 140ms 退场

    check('四条链接都渲成可点的网页链接', await view.locator('#tocmsg-a1 a.citelink').count() === 4)
    check('只是渲染出来不取预览(第一次打开才取)', asked.length === 0, asked)

    // ── 富卡:300ms 才出;出了才问引擎;拿到后换成富卡 ──
    await link(PR).hover()
    await win.waitForTimeout(150)
    check('悬停 150ms 还没出', (await card()) === null, await card())
    await win.waitForTimeout(450)
    const rich = await card()
    check('悬停 300ms 后出卡,问了引擎一次', !!rich?.open && asked.filter((u) => u === PR).length === 1, { rich, asked })
    check('富卡:已合并 + 仓库#编号 + 标题 + 作者 + 事实', rich?.rich && rich.state === 'merged' && /已合并/.test(rich.text) && /Changan-Su\/Forsion #153/.test(rich.text) && /quote tiles/.test(rich.text) && /\+412 −186/.test(rich.text) && /12 个文件/.test(rich.text) && /3 条评论/.test(rich.text) && /10-23/.test(rich.text), rich)
    const geo = await win.evaluate((href) => {
      const el = document.querySelector('body > .chat-link-card')
      const a = document.querySelector(`#tocmsg-a1 a[href="${href}"]`)
      if (!el || !a) return null
      const r = el.getBoundingClientRect(), c = a.getClientRects()[0]
      return { below: r.top >= c.bottom, gap: Math.round(r.top - c.bottom), inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, onBody: el.parentElement === document.body && getComputedStyle(el).position === 'fixed' }
    }, PR)
    check('卡贴在链接下方、整张在窗口里、挂在 body 上', geo?.below && geo.gap <= 12 && geo.inside && geo.onBody, geo)
    await win.screenshot({ path: path.join(SHOT_DIR, 'rich-light.png') })
    await away()
    check('移开就收', (await card()) === null)
    await link(PR).hover()
    await win.waitForTimeout(500)
    check('再悬停:直接是富卡,不再问引擎(本次运行缓存)', (await card())?.rich && asked.filter((u) => u === PR).length === 1, asked)

    // ── 接力:从富卡那条直接移到相邻的素卡链接,同一张浮层换内容,不重播 ──
    await win.evaluate(() => { window.__lc = document.querySelector('body > .chat-link-card') })
    await link(DOC).hover()
    await win.waitForTimeout(60)
    const relay = await win.evaluate(() => { const el = document.querySelector('body > .chat-link-card'); return { same: !!el && el === window.__lc, text: el?.textContent ?? '' } })
    check('相邻链接接力:同一张浮层,60ms 内就换成下一条', relay.same && /DESIGN\.md §6/.test(relay.text), relay)
    const plain = await card()
    check('素卡:链接文字 + 站名 · 路径(中段省略)', !plain?.rich && /DESIGN\.md §6/.test(plain?.text) && /Forsion Git · git\.forsion\.net\/forsion\/genesis\/…\/DESIGN\.md/.test(plain?.text), plain)
    check('素卡不问引擎', !asked.includes(DOC), asked)
    await win.screenshot({ path: path.join(SHOT_DIR, 'plain-light.png') })
    await away()

    await link(SITE).hover()
    await win.waitForTimeout(500)
    const site = await card()
    check('不认得的站:只写主机 + 路径', !site?.rich && /使用指南/.test(site?.text) && /example\.com\/guide/.test(site?.text) && !/·/.test(site?.text), site)
    await away()

    // ── 问不到(引擎回 null)→ 素卡,不报错 ──
    await link(ISSUE).hover()
    await win.waitForTimeout(700)
    const miss = await card()
    check('问不到的 issue:问了一次,照样出素卡', asked.includes(ISSUE) && !miss?.rich && /#9/.test(miss?.text) && /GitHub · github\.com\/Changan-Su\/Forsion\/issues\/9/.test(miss?.text), { miss, asked })
    await away()

    // ── 点击行为不变:按下就收,不在原处再弹 ──
    await link(SITE).hover()
    await win.waitForTimeout(500)
    await win.mouse.down(); await win.mouse.up()
    await win.waitForTimeout(300)
    check('按下链接卡就收', (await card()) === null)
    await away()

    // ── 暗色:另起一个实例 ──
    await app.close().catch(() => {})
    ;({ app, win, view } = await boot('dark'))
    const bg = await win.evaluate(() => { const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || []; return m.slice(0, 3).reduce((a, b) => a + Number(b), 0) })
    check('暗色已生效(页面底色是深的)', bg < 200, bg)
    await link(PR).hover()
    await win.waitForTimeout(700)
    check('暗色:富卡照出', (await card())?.rich)
    await win.screenshot({ path: path.join(SHOT_DIR, 'rich-dark.png') })
    await away()
    await link(DOC).hover()
    await win.waitForTimeout(500)
    await win.screenshot({ path: path.join(SHOT_DIR, 'plain-dark.png') })
  } finally {
    await app?.close().catch(() => {})
    stub.close?.()
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed. 截图:${SHOT_DIR}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
