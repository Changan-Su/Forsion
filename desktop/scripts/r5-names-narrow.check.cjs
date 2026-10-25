/**
 * check:r5narrow —— 走查第五轮 5.15(标签名跟 Space 走)+ 5.17(880 窄窗)的真 Electron 台架。
 * 方案页:仓根 docs/ToBeImproved/走查续五_可优化点方案_2026-10-25/views.html(§2 的 5.15 / 5.17、§4 的细节)。
 * 5.16(Agent 标签条)在 check:agentprofile 里,5.18 是纯观感,看这里出的截图。
 *
 * 桩引擎 + 隔离 home;量的是 out/ 产物 —— 改了源码先 `npx electron-vite build`。
 *  A 标签名 = Space 名:收件箱 / 自动化 / 已发布(中英各一遍),英文笔记 Space 叫 Notes。
 *  B 880 × 英文:主页坞的名字最多两行、只在词间折,单个长词(Achievements)那一格按词宽放开、不截。
 *  C 880 × 英文:自动化工具栏窄于 260px 时「New automation」只留图标,悬停出 .lcl-tip 全名;宽窗下字露着、不弹提示。
 *  D 880:Tangu 过滤胶囊左右 12px;组头行尾按钮平时浮在行尾不占位(组名用满),悬停才让出右边距。
 * 截图(亮 / 暗)落 SHOT_DIR(缺省系统临时目录 forsion-r5narrow-shots),DESIGN §8:断言全绿 ≠ 看起来对,自己看。
 *
 * 用法:cd desktop && npx electron-vite build && npm run check:r5narrow
 */
const path = require('path')
const { launch, boot, enterSpace, sleep, shotDir, makeReporter } = require('./lib/uiux-electron.cjs')

const OUT = shotDir('r5narrow')
const { check, note, summary } = makeReporter()

const look = (win, mode) => win.evaluate((m) => { const r = document.documentElement; r.dataset.mode = m; r.classList.toggle('dark', m === 'dark') }, mode)
const shoot = async (win, name) => {
  for (const mode of ['light', 'dark']) {
    await look(win, mode); await sleep(250)
    await win.screenshot({ path: path.join(OUT, `${name}-${mode}.png`) })
  }
  await look(win, 'light')
}
const tabs = (win) => win.evaluate(() => [...document.querySelectorAll('.wb-tab')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => (e.querySelector('.wb-tab-name')?.textContent || '').trim()))
const setLocale = async (win, lang) => {
  await win.evaluate((l) => localStorage.setItem('tangu_locale', l), lang)
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await sleep(1500)
}
const resize = async (app, w, h) => { await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]); await sleep(400) }

async function tabNames(win, lang) {
  const want = lang === 'en' ? { inbox: 'Inbox', automation: 'Automation', public: 'Published' } : { inbox: '收件箱', automation: '自动化', public: '已发布' }
  for (const [space, name] of Object.entries(want)) {
    if (!(await enterSpace(win, space))) { note(`A ${lang} ${space} Space 不在(本构建没开)`); continue }
    await sleep(500)
    const seen = await tabs(win)
    check(`A ${lang} ${space}:主区标签叫「${name}」`, seen.includes(name), JSON.stringify(seen))
    if (space === 'public') check(`A ${lang} 发布页标题同改`, ((await win.locator('.pv-title').first().textContent().catch(() => '')) || '').trim() === name)
  }
}

async function main() {
  const { app, win, close } = await launch({ tag: 'r5narrow', overrideHome: true })
  try {
    await boot(app, win, { space: 'tangu', width: 1512, height: 950 })
    await win.evaluate(() => document.querySelectorAll('.ach-toast').forEach((t) => t.remove()))

    // ── A 标签名 ──
    await tabNames(win, 'zh')
    await setLocale(win, 'en')
    await tabNames(win, 'en')
    const notes = await win.evaluate(() => [...document.querySelectorAll('.rb-slot[data-id="space:amadeus"] .rb-space')].map((e) => e.getAttribute('aria-label') || e.querySelector('.rb-label')?.textContent || ''))
    check('A en 笔记 Space 叫 Notes', notes.some((n) => /^Notes\b/.test(n)), JSON.stringify(notes))

    // ── C 自动化工具栏:宽窗字露着 ──
    if (await enterSpace(win, 'automation')) {
      await sleep(500)
      const btn = win.locator('.t2sw-plug-toolbar .t2sw-plug-btn').first()
      const wide = await btn.evaluate((b) => ({ bar: b.parentElement.getBoundingClientRect().width, label: !!b.querySelector('.t2sw-plug-btn-label')?.offsetParent, name: b.getAttribute('aria-label') }))
      check('C 宽窗:工具栏 ≥ 260 时「New automation」字露着', wide.bar < 260 || wide.label, JSON.stringify(wide))
    } else note('C 自动化 Space 不在(本构建没开)')

    // ── E 笔记空态提示(5.18):首列固定 26px,三行文字起点对齐 ──
    if (await enterSpace(win, 'amadeus')) {
      await sleep(800)
      const tips = await win.evaluate(() => [...document.querySelectorAll('.amx-welcome-tips li')].map((li) => {
        const r = document.createRange(); const txt = [...li.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim())
        if (!txt) return null
        r.selectNodeContents(txt); const first = li.firstElementChild.getBoundingClientRect()
        return { text: Math.round(r.getBoundingClientRect().left * 2) / 2, icon: Math.round(first.width) }
      }))
      if (tips.length) check('E 笔记空态三行提示文字起点对齐', tips.every((t) => t && t.text === tips[0].text), JSON.stringify(tips))
      else note('E 没看到笔记空态(库里已开着笔记)')
      await shoot(win, 'notes-empty-1512-en')
    }
    for (const sp of ['home', 'tangu', 'automation']) if (await enterSpace(win, sp)) { await sleep(500); await shoot(win, `${sp}-1512-en`) }

    // ── 880 窄窗 ──
    await resize(app, 880, 900)

    // B 主页坞
    if (await enterSpace(win, 'home')) {
      await sleep(600)
      const dock = await win.evaluate(() => [...document.querySelectorAll('.hp-space-row .hp-tile')].map((t) => {
        const n = t.querySelector('.hp-tile-name'); if (!n) return null
        const lh = parseFloat(getComputedStyle(n).lineHeight)
        // 每个词单独量:任何一个词比格子宽 = 被从词中间截 / 折
        const probe = document.createElement('span'); probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(n).font}`; document.body.append(probe)
        const widest = Math.max(...(n.textContent || '').trim().split(/\s+/).map((w) => { probe.textContent = w; return probe.getBoundingClientRect().width }))
        probe.remove()
        return { name: n.textContent.trim(), lines: Math.round(n.getBoundingClientRect().height / lh), clipped: n.scrollHeight > n.clientHeight + 1, widest: Math.ceil(widest), box: Math.floor(n.clientWidth), tile: Math.round(t.getBoundingClientRect().width) }
      }).filter(Boolean))
      check('B 坞上的名字最多两行、没被截', dock.length > 0 && dock.every((d) => d.lines <= 2 && !d.clipped), JSON.stringify(dock))
      check('B 没有词被从中间断(格子按最长的词放开)', dock.every((d) => d.widest <= d.box + 1), JSON.stringify(dock.filter((d) => d.widest > d.box + 1)))
      check('B 格子最窄 64px', dock.every((d) => d.tile >= 64), JSON.stringify(dock.map((d) => d.tile)))
      const long = dock.find((d) => /Achievements|Coding Studio|Image Studio/.test(d.name))
      if (long) check(`B 长名字「${long.name}」完整显示`, !long.clipped, JSON.stringify(long))
      await shoot(win, 'home-dock-880-en')
    } else note('B 主页 Space 不在')

    // C 自动化工具栏:窄
    if (await enterSpace(win, 'automation')) {
      await sleep(600)
      const btn = win.locator('.t2sw-plug-toolbar .t2sw-plug-btn').first()
      const narrow = await btn.evaluate((b) => ({ bar: b.parentElement.getBoundingClientRect().width, label: !!b.querySelector('.t2sw-plug-btn-label')?.offsetParent, icon: !!b.querySelector('.t2sw-plug-btn-ic')?.offsetParent, w: b.getBoundingClientRect().width, name: b.getAttribute('aria-label') }))
      check('C 880:工具栏窄于 260px', narrow.bar < 260, JSON.stringify(narrow))
      check('C 880:「New automation」只留图标(26px 方钮),可访问名仍是全名', !narrow.label && narrow.icon && narrow.w <= 28 && narrow.name === 'New automation', JSON.stringify(narrow))
      await btn.hover(); await sleep(700)
      const tip = ((await win.locator('.lcl-tip').last().textContent().catch(() => '')) || '').trim()
      check('C 悬停出提示「New automation」', tip === 'New automation', tip)
      await win.mouse.move(5, 5); await sleep(300)
      await shoot(win, 'automation-880-en')
    }

    // D Tangu 侧栏
    if (await enterSpace(win, 'tangu')) {
      await sleep(600)
      const caps = await win.evaluate(() => {
        const f = document.querySelector('.t2o-filters'); if (!f) return null
        const cs = getComputedStyle(f)
        return { ml: cs.marginLeft, mr: cs.marginRight, cells: [...f.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().width)) }
      })
      check('D 过滤胶囊左右边距 12px、四格平分', !!caps && caps.ml === '12px' && caps.mr === '12px' && Math.max(...caps.cells) - Math.min(...caps.cells) <= 1, JSON.stringify(caps))
      const group = win.locator('.t2o .t2s-group:has(> .t2s-group-add)').first()
      if (await group.count()) {
        await win.mouse.move(5, 5); await sleep(300)
        const idle = await group.evaluate((g) => ({ pad: getComputedStyle(g).paddingRight, pos: getComputedStyle(g.querySelector(':scope > .t2s-group-add')).position, toggleRight: Math.round(g.querySelector('.t2s-group-toggle').getBoundingClientRect().right), right: Math.round(g.getBoundingClientRect().right) }))
        check('D 平时行尾按钮不占位:组名那颗按钮用满到行尾', idle.pad === '0px' && idle.pos === 'absolute' && idle.right - idle.toggleRight <= 1, JSON.stringify(idle))
        await group.hover(); await sleep(250)
        const hot = await group.evaluate((g) => ({ pad: parseFloat(getComputedStyle(g).paddingRight), n: g.querySelectorAll(':scope > .t2s-group-add').length }))
        check('D 悬停时让出右边距(每颗 25.5px)', Math.abs(hot.pad - hot.n * 25.5) < 0.6, JSON.stringify(hot))
        await win.mouse.move(5, 5)
      } else note('D 侧栏没有带行尾按钮的组头')
      await shoot(win, 'tangu-880-en')
    }
    // 中文 880 一张:中文名五字以内,坞上一行、不受两行规则影响
    await setLocale(win, 'zh')
    if (await enterSpace(win, 'home')) { await sleep(600); await shoot(win, 'home-dock-880-zh') }
  } finally {
    await close()
  }
  process.exitCode = summary() ? 1 : 0
}

main().catch((e) => { console.error(e); process.exit(1) })
