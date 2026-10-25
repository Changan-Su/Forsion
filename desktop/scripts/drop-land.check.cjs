/**
 * 拖动排序松手落位(借鉴 Comma 方案 2.5,LCL dropIndicator.ts 的 land / landWhenMoved):真 Electron × 桩引擎。
 *
 * 钉的是 Tangu 侧栏的项目组(div.t2s-group[data-workspace-key],手动排序 = SessionsView 缺省):
 *   1 真拖动(Playwright dragTo 走 Chromium 原生 HTML5 拖放)把排在最后的项目组拖到最前那个项目组的会话块里,顺序真的变了
 *   2 松手后第一帧:组头**看上去**还在松手处(视口上沿 ≈ 落下时指针 − 拖起时指针在组头里的位置),阴影在
 *   3 之后逐帧回到新位置:位移单调变小,~200ms 归零;展开的那块会话跟组头同一段位移
 *   4 飞完内联样式全部还回去(transition / transform / box-shadow 为空)
 *   5 减少动态效果(emulateMedia reduce):松手后第一帧就已在新位置,一帧都不飞
 *   6 截图:飞到 ~60ms 时暂停过渡拍一张,落定后再拍一张(DESIGN §8:几何全绿 ≠ 看起来对,自己看)
 * ZOOM=1.1 跑一遍界面缩放(用户 dev 常年 110%):第 2 条按视口坐标比,缩放补偿错了就对不上。
 *
 * 跑法:npx electron-vite build && npm run check:dropland(单实例锁:先退掉 dev 版 Electron;或走 devlock)。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { launch, boot, makeReporter, shotDir, captureWindow, sleep } = require('./lib/uiux-electron.cjs')

const ZOOM = Number(process.env.ZOOM || 1)
const tag = ZOOM === 1 ? '' : `-z${Math.round(ZOOM * 100)}`
const SHOTS = shotDir('dropland')
const rep = makeReporter()

const PROJECTS = ['Alpha', 'Beta', 'Gamma', 'Delta']
function fixtures(root) {
  const base = { summary: '', archived: false, model_id: 'm1', agent_config: null, projectless: false }
  const sessions = []
  PROJECTS.forEach((name, pi) => {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 3; i++) {
      sessions.push({ ...base, created_at: '2026-10-20 09:00:00', updated_at: `2026-10-20 1${pi}:${String(50 - i * 10).padStart(2, '0')}:00`, id: `dl-${name}-${i}`, title: `${name} session ${i + 1}`, project_path: dir, project_name: name })
    }
  })
  return {
    agents: [{ slug: 'xyra', name: 'Xyra', description: 'General assistant', createdBy: 'user', libraryDir: '/tmp/dropland-lib/xyra/Library' }],
    sessions,
  }
}

/** 页内采样:拖起时记指针在组头里的位置;松手后**排在落位那一帧之后**(setTimeout 0 再 rAF)逐帧记组头 / 它那块会话的视口上沿与计算样式。 */
const INSTALL_SAMPLER = () => {
  const w = window
  w.__dl = { grabY: null, dropY: null, key: null, samples: [], pausedAt: null, pauseAt: w.__dlPauseAt ?? null }
  const keyOf = (el) => el?.closest?.('.t2s-group[data-workspace-key]')?.dataset.workspaceKey ?? null
  w.addEventListener('dragstart', (e) => {
    const head = e.target.closest?.('.t2s-group[data-workspace-key]')
    if (!head) return
    w.__dl.key = keyOf(head)
    w.__dl.grabY = e.clientY - head.getBoundingClientRect().top
  }, true)
  w.addEventListener('drop', (e) => {
    const d = w.__dl
    if (!d.key) return
    d.dropY = e.clientY
    const t0 = performance.now()
    const sel = `.t2s-group[data-workspace-key="${CSS.escape(d.key)}"]`
    setTimeout(() => {
      const tick = () => {
        const head = document.querySelector(sel)
        if (!head) return
        const kids = head.nextElementSibling?.querySelector(':scope > .t2s-group-sessions') ? head.nextElementSibling : null
        const cs = getComputedStyle(head)
        const kr = kids?.getBoundingClientRect()
        // 自己的布局位置(不含 transform):offsetTop 是局部 px,换成视口用 zoom;直接比 transform 的 ty 更直观
        const m = cs.transform === 'none' ? [1, 0, 0, 1, 0, 0] : cs.transform.match(/-?[\d.e]+/g).map(Number)
        const t = performance.now() - t0
        d.samples.push({ t: Math.round(t), top: head.getBoundingClientRect().top, ty: m[5], shadow: cs.boxShadow, kidsTy: kids ? (getComputedStyle(kids).transform === 'none' ? 0 : Number(getComputedStyle(kids).transform.match(/-?[\d.e]+/g)[5])) : null, kidsTop: kr ? kr.top : null })
        if (d.pauseAt != null && d.pausedAt == null && t >= d.pauseAt) {
          const anims = [head, kids].filter(Boolean).flatMap((el) => el.getAnimations())
          for (const a of anims) a.pause()
          d.pausedAt = Math.round(t)
          return
        }
        if (t < 320) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, 0)
  }, true)
}

const order = (win) => win.evaluate(() => [...document.querySelectorAll('.t2s-side .t2s-group[data-workspace-key]')].map((e) => (e.querySelector('.t2s-group-label')?.textContent || '').trim()))
const identity = (s) => Math.abs(s.ty) < 0.5

/** 把列表里排在最后的那个**项目组**(夹具里的四个之一)拖到第一组上;系统组(默认项目 / 无项目会话)不参与。 */
async function dragLastOntoProject(win) {
  const names = await order(win)
  const last = [...names].reverse().find((n) => PROJECTS.includes(n))
  const src = win.locator('.t2s-side .t2s-group[data-workspace-key]', { has: win.locator('.t2s-group-label', { hasText: new RegExp(`^${last}$`) }) })
  rep.note('拖', `${last}(draggable=${await src.getAttribute('draggable')})`)
  // 落在排在最前的那个项目组的会话块里靠下处(组内会话行也认这一组的落点 = 顶掉它的位置):松手处离新位置七八十 px,飞行看得清
  const target = names.find((n) => PROJECTS.includes(n) && n !== last)
  const head = win.locator('.t2s-side .t2s-group[data-workspace-key]', { has: win.locator('.t2s-group-label', { hasText: new RegExp(`^${target}$`) }) })
  const sessions = head.locator('xpath=following-sibling::*[1]').locator(':scope > .t2s-group-sessions')
  const box = await sessions.boundingBox()
  await src.dragTo(sessions, { targetPosition: { x: 60, y: Math.round(box.height * 0.85) } })
  await sleep(500)
  return { ...(await win.evaluate(() => window.__dl)), last, target, slot: names.indexOf(target) }
}

;(async () => {
  const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-dropland-proj-'))
  const s = await launch({ tag: 'dropland', fixtures: fixtures(projRoot) })
  try {
    await boot(s.app, s.win, { space: 'tangu', width: 1440, height: 900 })
    const win = s.win
    if (ZOOM !== 1) {
      await win.evaluate((z) => { localStorage.setItem('forsion_ui_zoom_default_2_10_0', '1'); localStorage.setItem('forsion_ui_zoom', String(z)) }, ZOOM)
      await win.reload({ waitUntil: 'domcontentloaded' })
      await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
      await sleep(2000)
      const z = await win.evaluate(() => document.body.currentCSSZoom)
      rep.check(`界面缩放 = ${ZOOM}`, Math.abs(z - ZOOM) < 0.01, String(z))
    }
    await win.waitForFunction((n) => document.querySelectorAll('.t2s-side .t2s-group[data-workspace-key]').length >= n, PROJECTS.length, { timeout: 20_000 })
      .catch(() => {})
    // Tangu 左栏钉的是「轨道」档(按最近活动排,组不能拖);手动排序的会话档只在某处放了一个 mode = sessions(或自动档落到 sessions)的
    // 工作区视图时才有。台架把存档里的左栏改成 sessions 再重载(存档布局优先于 build())。
    await win.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        const v = localStorage.getItem(k)
        if (v && v.includes('"mode":"orbits"')) localStorage.setItem(k, v.split('"mode":"orbits"').join('"mode":"sessions"'))
      }
    })
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    const manual = await win.waitForFunction(() => document.querySelector('.t2s-side .t2s-group[data-workspace-key][draggable="true"]'), null, { timeout: 10_000 }).then(() => true, () => false)
    rep.check('左栏落到手动排序(组头 draggable)', manual)
    if (!manual) {
      await captureWindow(s.app, path.join(SHOTS, `debug-manual${tag}.png`))
      rep.note('左栏', await win.evaluate(() => [...document.querySelectorAll('.t2sw-body > *')].map((e) => e.className).join(' | ') + ' main=' + (document.querySelector('.dv-groupview .dv-active-tab')?.textContent || '')))
    }
    await sleep(600)
    const before = await order(win)
    rep.check('侧栏长出 ≥4 个项目组', PROJECTS.every((p) => before.includes(p)), JSON.stringify(before))
    // 全部展开(组底下那块会话要跟着飞)
    const expanded = await win.evaluate(() => document.querySelectorAll('.t2s-side .t2s-group-sessions').length)
    rep.note('展开着的组', String(expanded))

    // ── 1–4 正常动效 ──
    await win.evaluate(INSTALL_SAMPLER)
    const d = await dragLastOntoProject(win)
    const after = await order(win)
    rep.check('真拖动:最后那个项目组顶到了目标组的位置', after[d.slot] === d.last && after.length === before.length, `${d.last} → ${d.target} 的位置:${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    const S = d.samples
    rep.note('采样(t ms / ty px / 阴影)', S.map((x) => `${x.t}:${x.ty.toFixed(1)}`).join(' '))
    const first = S[0]
    const release = d.dropY - d.grabY
    rep.check('松手后第一帧:组头看上去还在松手处(视口上沿 ≈ 落下指针 − 拖起时指针在组头里的位置)', !!first && Math.abs(first.top - release) <= 3,
      first ? `top=${first.top.toFixed(1)} 松手处=${release.toFixed(1)} (drop ${d.dropY}, grab ${d.grabY?.toFixed(1)})` : '没有采样')
    rep.check('第一帧有明显反向位移(>40 局部 px)且带阴影', !!first && Math.abs(first.ty) > 40 && first.shadow !== 'none', first ? `ty=${first.ty.toFixed(1)} shadow=${first.shadow.slice(0, 40)}` : '')
    // 曲线同落点线(--lcl-drop-ease,前段走得快):60ms 已走完八成多,末段 ~100ms 起已不足 1px
    const mid = S.filter((x) => x.t >= 40 && x.t <= 90)
    rep.check('40–90ms 之间还在飞(非零)且比第一帧近', mid.length > 0 && mid.every((x) => !identity(x) && Math.abs(x.ty) < Math.abs(first.ty)), mid.map((x) => `${x.t}:${x.ty.toFixed(1)}`).join(' '))
    let mono = true
    for (let i = 1; i < S.length; i++) if (Math.abs(S[i].ty) > Math.abs(S[i - 1].ty) + 0.01) mono = false
    rep.check('位移单调变小(减速曲线,无回弹)', S.length > 2 && mono, `${S.length} 帧`)
    const late = S.filter((x) => x.t >= 200)
    rep.check('≥200ms 归零', late.length > 0 && late.every(identity), late.map((x) => `${x.t}:${x.ty.toFixed(1)}`).join(' '))
    const withKids = S.filter((x) => x.kidsTy != null)
    rep.check('展开的那块会话与组头同一段位移(局部 px 相同)', withKids.length > 0 && withKids.every((x) => Math.abs(x.kidsTy - x.ty) < 0.6), withKids.slice(0, 4).map((x) => `${x.ty.toFixed(1)}/${x.kidsTy.toFixed(1)}`).join(' '))
    const inline = await win.evaluate((k) => { const h = k && document.querySelector(`.t2s-group[data-workspace-key="${CSS.escape(k)}"]`); return h ? { tr: h.style.transform, tn: h.style.transition, sh: h.style.boxShadow, z: h.style.zIndex } : { missing: k } }, d.key)
    rep.check('飞完内联样式全部还回去', !inline.missing && !inline.tr && !inline.tn && !inline.sh && !inline.z, JSON.stringify(inline))
    await captureWindow(s.app, path.join(SHOTS, `landed${tag}.png`))

    // ── 6 中途截图:飞到 ~60ms 暂停过渡 ──
    // 落位的收尾计时(LAND_MS + 80 = 240ms)到点会把内联样式还回去:暂停那一轮里先扣住它,拍完再放
    await win.evaluate(() => {
      window.__dlPauseAt = 55
      const real = window.setTimeout.bind(window)
      window.__dlHeld = []
      window.__dlRealTimeout = real
      window.setTimeout = (fn, ms, ...rest) => (ms === 240 ? (window.__dlHeld.push(fn), 0) : real(fn, ms, ...rest))
    })
    await win.evaluate(INSTALL_SAMPLER)
    const dp = await dragLastOntoProject(win)
    rep.note('暂停在', `${dp.pausedAt}ms ty=${dp.samples.at(-1)?.ty.toFixed(1)}`)
    await captureWindow(s.app, path.join(SHOTS, `midflight${tag}.png`))
    await win.evaluate(() => {
      for (const a of document.getAnimations()) if (a.playState === 'paused') a.play()
      window.setTimeout = window.__dlRealTimeout
      for (const fn of window.__dlHeld.splice(0)) window.setTimeout(fn, 200)
      window.__dlPauseAt = null
    })
    await sleep(400)

    // ── 5 减少动态效果 ──
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await win.evaluate(INSTALL_SAMPLER)
    const b2 = await order(win)
    const r = await dragLastOntoProject(win)
    const a2 = await order(win)
    rep.check('减少动态效果:照样挪过去了', a2[r.slot] === r.last, `${JSON.stringify(b2)} → ${JSON.stringify(a2)}`)
    rep.check('减少动态效果:松手后第一帧就已在新位置,一帧都不飞', r.samples.length > 0 && r.samples.every(identity), r.samples.slice(0, 6).map((x) => `${x.t}:${x.ty.toFixed(1)}`).join(' '))
    await win.emulateMedia({ reducedMotion: 'no-preference' })
    rep.note('截图', SHOTS)
  } catch (e) {
    rep.check('台架跑完', false, String((e && e.stack) || e).slice(0, 800))
  } finally {
    await s.close()
    fs.rmSync(projRoot, { recursive: true, force: true })
  }
  process.exit(rep.summary() ? 1 : 0)
})()
