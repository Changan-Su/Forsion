// ⌘P「对话内容」一段(10-24 借鉴 Comma §2.8;真 Electron + 桩引擎,search 由 stubOverride 回)。断言:
//  A 快速打字只搜最后那个词(停手 180ms 再搜);这一段在、片段命中处是 <mark> 且垫了底色
//  B 选中正文命中 → 右边预览最后 3 轮(第 1 轮不在)、命中处同样垫底;页脚 ⌘↵ 写「跳到这一条」;窗口窄于 760px 预览栏藏起
//  C ⌘↵ 打开会话并跳到命中那条、闪(t2JumpFlash),落在视口里;↵ 只打开会话、不闪
// 另存亮 / 暗两张截图(SHOT_DIR,缺省系统临时目录)。用法:npm run e2e:qfcontent(量的是 out/ 产物,改了源码先 npm run build)
const path = require('path')
const U = require('./lib/uiux-electron.cjs')
const { sleep } = U

const R1 = '5c1e0a52-0000-4000-8000-0000000000f1'
const R2 = '5c1e0a52-0000-4000-8000-0000000000f2'
const T = Date.now() - 3 * 60 * 60_000
const long = (n) => Array.from({ length: 40 }, (_, i) => `${i + 1}. 第 ${n} 轮第 ${i + 1} 条:打包、签名、公证、上传,每一步都写清楚。`).join('\n')
const msg = (id, role, mins, content) => ({ id, role, timestamp: T + mins * 60_000, content })
const MSGS = {
  [R1]: [
    msg('u1', 'user', 0, '第一轮:这次发版先发哪个平台?'), msg('a1', 'model', 1, `先 mac。\n\n${long(1)}`),
    msg('u2', 'user', 2, '第二轮:Windows 包谁来打?'), msg('a2', 'model', 3, `CI 打。\n\n${long(2)}`),
    msg('u3', 'user', 4, '第三轮:安卓签名证书是不是快过期了?'), msg('a3', 'model', 5, `没有,签名证书有效到 2027 年 3 月 4 日。\n\n${long(3)}`),
    msg('u4', 'user', 6, '第四轮:好,那先出安卓包。'), msg('a4', 'model', 7, `好的,开始出安卓包。\n\n${long(4)}`),
  ],
  [R2]: [msg('b1', 'user', 0, '安卓外壳要不要换签名?'), msg('b2', 'model', 1, '签名证书永不换,换了就装不上旧版。')],
}
const HITS = [
  { id: R1, title: '周五发版准备', summary: '', archived: false, updatedAt: '2026-10-21', hit: { messageId: 'u3', role: 'user', timestamp: T + 4 * 60_000, snippet: '第三轮:安卓签名证书是不是快过期了?' } },
  { id: R2, title: '安卓原生外壳', summary: '', archived: false, updatedAt: '2026-10-12', hit: { messageId: 'b2', role: 'assistant', timestamp: T + 60_000, snippet: '签名证书永不换,换了就装不上旧版。' } },
]

const rep = U.makeReporter()
const { check } = rep

;(async () => {
  let projectDir = ''
  const at = (m) => new Date(Date.now() - m * 60_000).toISOString().replace('T', ' ').slice(0, 19)
  const row = (id, title, m) => ({ id, title, summary: '', archived: false, model_id: 'm1', agent_config: null, project_path: projectDir, project_name: 'Forsion', projectless: false, created_at: at(m + 60), updated_at: at(m) })
  const rows = () => [row(R1, '周五发版准备', 1), row(R2, '安卓原生外壳', 30)]
  const searches = []
  const { app, win, close, projectDir: pd } = await U.launch({
    tag: 'qfcontent',
    fixtures: { agents: [], sessions: [] },
    stubOverride: async ({ path: p, method, url }) => {
      if (p === '/agent/sessions' && method === 'GET') return { sessions: rows() }
      if (p === '/agent/sessions/search') { const q = url.searchParams.get('q') || ''; searches.push(q); return { hits: q.includes('签名') ? HITS : [] } }
      const m = p.match(/^\/agent\/sessions\/([^/]+)\/(messages|asides|detail)$/)
      if (m && method === 'GET') {
        if (m[2] === 'messages') return { messages: MSGS[m[1]] || [] }
        if (m[2] === 'asides') return { asides: [] }
        const r = rows().find((x) => x.id === m[1])
        if (r) return { session: { ...r, kind: 'user', delegate_running: false } }
      }
      return undefined
    },
  })
  projectDir = pd
  const shots = U.shotDir('qfcontent')
  const openQf = async (q) => {
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P')
    await win.waitForSelector('.amx-qf-input', { timeout: 8000 })
    await win.locator('.amx-qf-input').pressSequentially(q, { delay: 40 }) // 一字一字打,间隔远小于 180ms
    await win.locator('[data-testid="qf-hit"]').nth(1).waitFor({ timeout: 8000 })
  }
  const selectHit = async (n) => { // 往下走到第 n 条正文命中
    for (let i = 0; i < 20; i++) {
      const idx = await win.evaluate(() => [...document.querySelectorAll('[data-testid="qf-hit"]')].findIndex((b) => b.classList.contains('sel')))
      if (idx === n) return true
      await win.keyboard.press('ArrowDown')
    }
    return false
  }
  try {
    await U.boot(app, win, { space: 'tangu', width: 1440, height: 900 })
    await win.locator(`.t2s-srow[data-sel-id="${R2}"]`).first().waitFor({ timeout: 20_000 }) // 会话列表到了

    // ── A ──
    await openQf('签名证书')
    await sleep(500)
    check('A1 快速打字只搜最后那个词(没有半截词的请求)', searches.length === 1 && searches[0] === '签名证书', JSON.stringify(searches))
    const sec = await win.evaluate(() => [...document.querySelectorAll('.amx-qf-sec')].map((x) => x.textContent))
    check('A2 出现「对话内容」一段', sec.includes('对话内容'), JSON.stringify(sec))
    const mk = await win.evaluate(() => {
      const m = document.querySelector('[data-testid="qf-hit"] mark')
      return m && { text: m.textContent, bg: getComputedStyle(m).backgroundColor, border: getComputedStyle(m).borderTopStyle }
    })
    check('A3 片段命中处是 <mark>,垫了底色、不画框', !!mk && mk.text === '签名证书' && !/rgba\(0, 0, 0, 0\)|transparent/.test(mk.bg) && mk.border === 'none', JSON.stringify(mk))

    // ── B ──
    await U.captureWindow(app, path.join(shots, 'qf-content-default-light.png')) // 结果刚到、还没选正文命中时的样子
    check('B0 方向键走到第一条正文命中', await selectHit(0))
    await win.waitForFunction(() => document.querySelector('[data-testid="qf-preview"] .amx-qf-pv-user'), null, { timeout: 8000 })
    const pv = await win.evaluate(() => {
      const el = document.querySelector('[data-testid="qf-preview"]')
      return { text: el.textContent, marks: el.querySelectorAll('mark').length, w: Math.round(el.getBoundingClientRect().width), foot: document.querySelector('.amx-qf-foot').textContent }
    })
    check('B1 预览栏是最后 3 轮(第二~四轮在,第一轮不在)', /第二轮/.test(pv.text) && /第四轮/.test(pv.text) && !/第一轮/.test(pv.text), pv.text.slice(0, 120))
    check('B2 预览里命中处同样垫底', pv.marks >= 2, `marks=${pv.marks} w=${pv.w}`)
    check('B3 页脚 ⌘↵ 写「跳到这一条」', /跳到这一条/.test(pv.foot), pv.foot)
    await sleep(300)
    await U.captureWindow(app, path.join(shots, 'qf-content-light.png'))
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'dark'); document.documentElement.classList.add('dark') })
    await sleep(300)
    await U.captureWindow(app, path.join(shots, 'qf-content-dark.png'))
    await win.evaluate(() => { document.documentElement.setAttribute('data-mode', 'light'); document.documentElement.classList.remove('dark') })
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setMinimumSize(600, 500); w.setContentSize(740, 800) }) // 主窗口缺省最小宽 880
    await sleep(500)
    const narrow = await win.evaluate(() => getComputedStyle(document.querySelector('[data-testid="qf-preview"]')).display)
    check('B4 窗口窄于 760px 不出预览栏', narrow === 'none', `display=${narrow} innerWidth=${await win.evaluate(() => innerWidth)}`)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await sleep(500)

    // ── C ──
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await win.waitForFunction(() => !document.querySelector('.amx-qf-input'), null, { timeout: 5000 })
    const samples = []
    for (const t of [200, 600, 1000, 2000]) {
      await sleep(t - (samples.at(-1)?.t || 0))
      samples.push({ t, ...(await win.evaluate(() => {
        const s = document.querySelector('.t2-stream'), el = document.getElementById('tocmsg-u3')
        if (!s || !el) return { missing: true }
        const r = el.getBoundingClientRect(), sr = s.getBoundingClientRect()
        return { top: Math.round(r.top - sr.top), vh: Math.round(sr.height), flash: el.getAnimations().some((a) => a.animationName === 't2JumpFlash') }
      })) })
    }
    const seen = samples.find((x) => x.flash && x.top >= 0 && x.top < x.vh - 40)
    check('C1 ⌘↵ 打开会话并跳到命中那条、闪的时候露在视口里', !!seen, samples.map((x) => (x.missing ? `${x.t}ms 缺` : `${x.t}ms top=${x.top}${x.flash ? ' ⚡' : ''}`)).join(' · '))
    check('C2 停稳后那条还在视口里(没被拽回底部)', samples.at(-1).top >= 0 && samples.at(-1).top < samples.at(-1).vh - 40, JSON.stringify(samples.at(-1)))

    await openQf('签名证书')
    check('C3 走到第二条正文命中', await selectHit(1))
    await win.keyboard.press('Enter')
    await win.locator('#tocmsg-b2').waitFor({ timeout: 8000 })
    await sleep(400)
    const flashed = await win.evaluate(() => document.querySelectorAll('.t2-jump-flash').length)
    check('C4 ↵ 只打开会话、不闪', flashed === 0, `flash=${flashed}`)
    rep.note('截图', shots)
  } finally { await close() }
  const failed = rep.results.filter((r) => !r.ok).length
  console.log(`\n${rep.results.length - failed}/${rep.results.length} passed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
