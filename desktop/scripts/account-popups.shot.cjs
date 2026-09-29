/**
 * 账号相关的三个弹出物 × 真 Electron × 假云端(scripts/lib/fake-forsion-cloud.cjs):
 *   ① 公告弹窗(Extend ≥ 0.7 画):没看过最新公告的账号一启动就弹;正文清洗过(脚本 / onerror 进不来);「知道了」后回报 seen 一次
 *   ② 左下角账号菜单:「AI 额度」点开看今日 / 本周 / 用卡 / 升级 / 去「额度与积分」
 *   ③ 用卡动画:菜单里两击用卡 → 宿主的重置卡动画;设置「额度与积分」页里用卡(Extend 经 ctx.app.showResetCardCeremony)→ 同一张
 * 逐项断言并截图(观感改动交付前自查真实截图,DESIGN §8)。
 *
 * 需先 npm run build(读 out/),且 node_modules/@forsion/extend ≥ 0.7.0。
 * 用法:node scripts/account-popups.shot.cjs [--lang=en] [--html] [--out=<目录>]   --html = 公告正文用 HTML(缺省 Markdown)
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')
const { startStubEngine } = require('./lib/stub-engine.cjs')
const { startFakeForsionCloud } = require('./lib/fake-forsion-cloud.cjs')
const { enterSpace } = require('./lib/uiux-electron.cjs')

const ROOT = path.join(__dirname, '..')
const LANG = (process.argv.find((a) => a.startsWith('--lang=')) || '--lang=zh').slice(7) === 'en' ? 'en' : 'zh'
const HTML = process.argv.includes('--html')
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6) || path.join(os.tmpdir(), 'forsion-account-popups')
const L = LANG === 'en'
  ? { quota: 'AI quota', useCard: 'Use a quota reset card', confirm: 'Click again to confirm', restored: 'Quota restored', cont: 'Continue', ok: 'Got it', page: 'Quota & points' }
  : { quota: 'AI 额度', useCard: '使用额度重置卡', confirm: '再点一次确认使用', restored: '额度已焕新', cont: '继续使用', ok: '知道了', page: '额度与积分' }

const ANNOUNCEMENT = {
  id: 'ann-2026-09-29',
  titleZh: 'Forsion 2.12 更新说明',
  titleEn: 'What’s new in Forsion 2.12',
  format: HTML ? 'html' : 'markdown',
  bodyZh: HTML
    ? '<h3 style="margin-top:0">公告功能上线</h3><p>这是一条 <b>HTML</b> 公告,<a href="https://forsion.net">打开官网</a>。</p><script>window.__pwned = 1</script><img src="x" onerror="window.__pwned = 2"><ul><li>左下角额度详情回来了</li><li>用卡有动画</li></ul>'
    : '### 这次更新\n\n- 左下角账号菜单可以**展开看额度**、直接用额度重置卡\n- 设置里用卡也有动画\n- 积分自动抵扣已下线\n\n> 有问题可以在「反馈」里告诉我们。\n\n[打开官网](https://forsion.net)',
  bodyEn: HTML
    ? '<h3 style="margin-top:0">Announcements are here</h3><p>This is an <b>HTML</b> announcement. <a href="https://forsion.net">Visit the site</a>.</p><script>window.__pwned = 1</script><img src="x" onerror="window.__pwned = 2"><ul><li>Quota details are back in the account menu</li><li>Using a card plays the animation</li></ul>'
    : '### In this update\n\n- The account menu **expands to show your quota** and lets you use a reset card\n- Using a card in Settings plays the animation too\n- Automatic points deduction has been retired\n\n> Tell us in Feedback if anything looks off.\n\n[Visit the site](https://forsion.net)',
  publishedAt: '2026-09-29T08:00:00Z',
}

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`)
}
const btn = (page, text) => page.locator('button, [role="button"]').filter({ hasText: text }).first()

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-account-popups-'))
  const stub = await startStubEngine({ models: [{ id: 'm1', name: 'Stub', provider: 'stub', contextWindow: 128_000, thinkingLevels: ['off'] }] })
  const cloud = await startFakeForsionCloud({ scenario: 'both', announcement: ANNOUNCEMENT })
  // JWT 形状:账号 id 取 payload 的 userId(shared/forsionAccount.ts)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ userId: 'u1', username: 'demo_user' })}.e2e`
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ cloudUrl: cloud.url, token }))
  const logs = []
  const pageErrors = []
  const app = await electron.launch({
    args: [`--user-data-dir=${path.join(home, 'userdata')}`, `--lang=${LANG === 'en' ? 'en-US' : 'zh-CN'}`, ROOT, '-ApplePersistenceIgnoreState', 'YES'],
    cwd: ROOT,
    env: { ...process.env, TANGU_HOME: home, TANGU_BACKEND_URL: stub.url, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 90_000,
  })
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => logs.push(String(d)))
  try {
    const win = await app.firstWindow({ timeout: 120_000 })
    win.on('pageerror', (e) => pageErrors.push(String(e?.message || e)))
    await win.waitForSelector('#root', { timeout: 30_000 })
    await win.setViewportSize({ width: 1280, height: 820 }).catch(() => {})

    // ① 公告
    const shown = await win.waitForSelector('.fx-ann[role="dialog"]', { timeout: 30_000 }).then(() => true, () => false)
    check('公告:没看过的账号一启动就弹', shown)
    if (shown) {
      await win.waitForTimeout(900) // 入场动画走完再拍
      const info = await win.evaluate(() => {
        const doc = document.querySelector('.fx-ann-doc')
        const root = doc?.shadowRoot || doc
        return {
          title: document.querySelector('.fx-ann-title')?.textContent || '',
          // shadow root 里还有一份 <style>:只取正文节点的字
          text: [...(root?.children || [])].filter((el) => el.tagName !== 'STYLE').map((el) => el.textContent).join(' ').replace(/\s+/g, ' ').slice(0, 200),
          scripts: root?.querySelectorAll('script').length ?? -1,
          onerror: root ? [...root.querySelectorAll('*')].some((el) => [...el.attributes].some((a) => /^on/i.test(a.name))) : true,
          pwned: window.__pwned ?? null,
          links: root ? [...root.querySelectorAll('a')].map((a) => a.getAttribute('href')) : [],
        }
      })
      check('公告:标题按界面语言', info.title === (LANG === 'en' ? ANNOUNCEMENT.titleEn : ANNOUNCEMENT.titleZh), info.title)
      check(`公告:${HTML ? 'HTML' : 'Markdown'} 正文渲染出来了`, /左下角|account menu|Quota details/.test(info.text), info.text)
      check('公告:正文清洗过(没有 script、没有 on* 属性、没被执行)', info.scripts === 0 && !info.onerror && info.pwned === null, JSON.stringify({ scripts: info.scripts, onerror: info.onerror, pwned: info.pwned }))
      // 卡片上面不许压着别的层(09-29 实见:启动闪屏 z 99999 淡出时 logo 压在卡片上 —— Extend 改成等闪屏退场再弹)
      const above = await win.evaluate(() => {
        const r = document.querySelector('.fx-ann').getBoundingClientRect()
        return [...document.querySelectorAll('body *')].filter((el) => {
          if (el.closest('.fx-ann-root')) return false
          const st = getComputedStyle(el)
          if (!['fixed', 'absolute'].includes(st.position) || st.visibility === 'hidden' || Number(st.opacity) === 0 || !(Number(st.zIndex) >= 1600)) return false
          const b = el.getBoundingClientRect()
          return b.width >= 40 && b.height >= 40 && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top
        }).map((el) => `${el.tagName}#${el.id}.${String(el.className).slice(0, 30)} z=${getComputedStyle(el).zIndex}`)
      })
      check('公告:弹出时卡片上没有别的层(启动闪屏已退场)', above.length === 0, above.join(', '))
      await win.screenshot({ path: path.join(OUT, `${LANG}-1-announcement${HTML ? '-html' : ''}.png`) })
      await win.locator('.fx-ann-ok').click()
      const gone = await win.waitForSelector('.fx-ann', { state: 'detached', timeout: 5_000 }).then(() => true, () => false)
      await win.waitForTimeout(500)
      const seen = cloud.requests.filter((r) => r.method === 'POST' && r.path === `/api/announcements/${ANNOUNCEMENT.id}/seen`)
      check(`公告:「${L.ok}」关掉并回报 seen 一次`, gone && seen.length === 1, `gone=${gone} seen=${seen.length}`)
    }

    // ② 账号菜单:「AI 额度」点开
    // 首启的新手引导把带 ribbon 的外壳整个 visibility:hidden 了,账号卡在 ribbon 上:跳过引导、进 Tangu(同 lib/uiux-electron boot)
    const skip = win.getByRole('button', { name: /^(Skip onboarding|跳过引导)$/ }).first()
    await skip.waitFor({ timeout: 8000 }).then(() => skip.click()).catch(() => {})
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await enterSpace(win, 'tangu')
    await win.waitForTimeout(800)
    await win.locator('.account-card:visible, .ribbon-account:visible').first().click()
    await win.waitForSelector('.account-pop', { timeout: 5_000 })
    await win.waitForTimeout(400)
    await btn(win, L.quota).click()
    const detail = await win.waitForSelector('[data-testid="account-quota-detail"]', { timeout: 5_000 }).then(() => true, () => false)
    await win.waitForTimeout(300)
    const detailText = detail ? (await win.locator('[data-testid="account-quota-detail"]').innerText()).replace(/\s+/g, ' ') : ''
    check('账号菜单:「AI 额度」点开看得到今日 / 本周 / 用卡', detail && detailText.includes(L.useCard), detailText)
    await win.screenshot({ path: path.join(OUT, `${LANG}-2-account-menu.png`) })

    // ③a 菜单里两击用卡 → 用卡动画
    // 限定在菜单里:额度低时聊天区的提醒条上也有同名的用卡按钮
    const pop = win.locator('.account-pop')
    await btn(pop, L.useCard).click()
    await btn(pop, L.confirm).click()
    const ceremony = await win.waitForSelector('.reset-ceremony[role="dialog"]', { timeout: 8_000 }).then(() => true, () => false)
    await win.waitForTimeout(3200) // 等卡片翻入、光晕、两行进度条都走完
    const cText = ceremony ? (await win.locator('.reset-ceremony').innerText()).replace(/\s+/g, ' ') : ''
    check('用卡动画:菜单里两击用卡 → 弹宿主动画', ceremony && cText.includes(L.restored), cText.slice(0, 160))
    await win.screenshot({ path: path.join(OUT, `${LANG}-3-ceremony-menu.png`) })
    if (ceremony) await btn(win, L.cont).click()
    await win.waitForSelector('.reset-ceremony', { state: 'detached', timeout: 5_000 }).catch(() => {})

    // ③b 设置「额度与积分」页里用卡 → Extend 经 ctx.app.showResetCardCeremony 弹同一张
    await win.evaluate(([n]) => window.tangu.openFloatingPanel({ id: 'settings', title: 'Settings', builtin: 'settings', params: { tab: 'forsion/fx:forsion-extend:quota', n } }), [Date.now()])
    let sp = null
    for (let i = 0; i < 80 && !sp; i++) {
      for (const w of app.windows()) if (w.url().includes('window=floating') && await w.locator('[data-plugin-settings="forsion-extend:quota"]').count().catch(() => 0)) sp = w
      if (!sp) await win.waitForTimeout(250)
    }
    check(`设置浮窗打开到「${L.page}」`, !!sp)
    if (sp) {
      sp.on('pageerror', (e) => pageErrors.push(String(e?.message || e)))
      await sp.setViewportSize({ width: 1100, height: 820 }).catch(() => {})
      const use = sp.locator('[data-plugin-settings="forsion-extend:quota"] button').filter({ hasText: LANG === 'en' ? /^Use/ : /^使用/ }).first()
      await use.click()
      await sp.locator('[data-plugin-settings="forsion-extend:quota"] button').filter({ hasText: LANG === 'en' ? /confirm/i : /确认/ }).first().click()
      const c2 = await sp.waitForSelector('.reset-ceremony[role="dialog"]', { timeout: 8_000 }).then(() => true, () => false)
      await sp.waitForTimeout(3200)
      const inline = await sp.locator('.fx-ceremony').count()
      check('用卡动画:设置页里用卡也弹宿主动画(不再只有一行对比)', c2 && inline === 0, `ceremony=${c2} inline=${inline}`)
      await sp.screenshot({ path: path.join(OUT, `${LANG}-4-ceremony-settings.png`) })
    }
    check('没有页面报错', pageErrors.length === 0, pageErrors.slice(0, 3).join(' / '))
  } catch (e) {
    check('台架本身没炸', false, String(e?.stack || e).slice(0, 400))
  } finally {
    await app.close().catch(() => {})
    await cloud.close()
    stub.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
  console.log(`\n截图 → ${OUT}`)
  process.exit(failed ? 1 : 0)
})()
