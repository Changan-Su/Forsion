/**
 * Ribbon 菜单 × 真 Electron(桩引擎):右键 Space 图标 / 命令图标、点两区的 ＋、右键 Ribbon 头部空白。
 * 钉住 2026-10-25 走查方案 §4.2(W-53 / W-54 / W-55):
 *   - 每一行首列是图标(svg),和会话 / 项目右键菜单一个样
 *   - 不再有「(Space 区)/(命令区)」「(Spaces)/(commands)」这类限定词,同一个菜单里没有两行同名
 *   - 菜单开着时发起它的那一格挂 data-menu-open(底色 --overlay-medium),Esc 关菜单后去掉
 * 每个组合截一张图(观感改动交付前自己看,DESIGN §8)。
 *
 * 需先在本检出 `npx electron-vite build`(量的是 out/)。
 * 用法:node scripts/ribbon-menu.check.cjs   旋钮:SHOT_DIR=<目录>  COMBOS=light-zh,dark-zh,light-en
 */
const path = require('path')
const { sleep, shotDir, makeReporter, launch, boot, captureWindow } = require('./lib/uiux-electron.cjs')

const ALL = [
  { id: 'light-zh', mode: 'light', lang: 'zh' },
  { id: 'dark-zh', mode: 'dark', lang: 'zh' },
  { id: 'light-en', mode: 'light', lang: 'en' },
]
const want = (process.env.COMBOS || '').split(',').filter(Boolean)
const COMBOS = want.length ? ALL.filter((c) => want.includes(c.id)) : ALL
const QUALIFIER = /[（(][^）)]*(区|Spaces|commands)[）)]/i

async function applyCombo(win, c) {
  await win.evaluate(([lang, mode]) => {
    localStorage.setItem('tangu_locale', lang)
    localStorage.setItem('forsion_theme_pref', mode)
    // 命令区种两条命令 + 一个收纳夹(内含一条命令):右键命令 / 收纳夹 / 收纳夹浮层行的菜单也要量到。
    localStorage.setItem('forsion_tangu_ribbon_v2', JSON.stringify({
      bottomOrder: [], commandIcons: {}, commandItems: ['quick-find', 'toggle-left'],
      folders: [{ id: 'folder:probe', name: 'Probe', zone: 'bottom', items: ['cmd:toggle-left'] }],
    }))
  }, [c.lang, c.mode])
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
  await sleep(2000)
  return win.evaluate(() => document.documentElement.dataset.mode)
}

/** 当前(非退场替身)菜单的行:首个子节点是不是 svg、文字。 */
const readMenu = (win) => win.evaluate(() => {
  const m = document.querySelector('.rb-menu:not([data-lcl-exit])')
  if (!m) return null
  return [...m.querySelectorAll(':scope > button')].map((b) => ({
    svgFirst: b.firstElementChild?.tagName.toLowerCase() === 'svg' && b.firstChild === b.firstElementChild,
    text: (b.textContent || '').trim(),
  }))
})
const openerCount = (win) => win.evaluate(() => document.querySelectorAll('.rb [data-menu-open]').length)
const hasOpen = (win, sel) => win.evaluate((s) => !!document.querySelector(s)?.hasAttribute('data-menu-open'), sel)
const bgOf = (win, sel) => win.evaluate((s) => {
  const el = document.querySelector(s)
  return el ? getComputedStyle(el).backgroundColor : null
}, sel)

async function center(win, sel) {
  return win.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, sel)
}

;(async () => {
  const r = makeReporter()
  const dir = shotDir('ribbon-menu')
  const { app, win, close } = await launch({ tag: 'ribbon-menu' })
  try {
    await boot(app, win, { space: 'tangu', width: 1280, height: 820 })
    for (const c of COMBOS) {
      const mode = await applyCombo(win, c)
      r.check(`${c.id}: 明暗生效`, mode === c.mode, `data-mode=${mode}`)

      /** 打开一个菜单 → 断言行 / 限定词 / 重名 / 发起格 → 截图 → Esc → 断言收干净。 */
      const probe = async (name, open, openerSel, { shot = false } = {}) => {
        if (!(await open())) { r.check(`${c.id} ${name}: 打开`, false, '找不到发起的元素'); return }
        await win.waitForSelector('.rb-menu:not([data-lcl-exit])', { timeout: 3000 }).catch(() => {})
        await sleep(260) // 180ms 进场走完再量 / 拍
        const rows = await readMenu(win)
        r.check(`${c.id} ${name}: 菜单弹出`, !!rows && rows.length > 0, rows ? rows.map((x) => x.text).join(' / ') : 'null')
        if (!rows) return
        r.check(`${c.id} ${name}: 每行首列是图标`, rows.every((x) => x.svgFirst), rows.filter((x) => !x.svgFirst).map((x) => x.text).join(' / '))
        r.check(`${c.id} ${name}: 没有「(…区)」限定词`, rows.every((x) => !QUALIFIER.test(x.text)))
        r.check(`${c.id} ${name}: 没有重名行`, new Set(rows.map((x) => x.text)).size === rows.length)
        if (openerSel) {
          r.check(`${c.id} ${name}: 发起格挂 data-menu-open`, await hasOpen(win, openerSel), `全条共 ${await openerCount(win)} 处`)
          r.check(`${c.id} ${name}: 只有一处 data-menu-open`, (await openerCount(win)) === 1)
          const btnSel = openerSel.endsWith('.rb-plus') ? openerSel : `${openerSel} > .rb-btn`
          r.note(`${c.id} ${name}: 发起钮底色`, await bgOf(win, btnSel))
        } else {
          r.check(`${c.id} ${name}: 空白处发起 → 没有 data-menu-open`, (await openerCount(win)) === 0)
        }
        if (shot) r.note(`${c.id} ${name}: 截图`, await captureWindow(app, path.join(dir, `${c.id}-${name}.png`)))
        await win.keyboard.press('Escape')
        await sleep(200)
        r.check(`${c.id} ${name}: Esc 关菜单`, (await readMenu(win)) === null)
        r.check(`${c.id} ${name}: 关了之后 data-menu-open 去掉`, (await openerCount(win)) === 0)
      }

      const rightClick = (sel) => async () => {
        const p = await center(win, sel)
        if (!p) return false
        await win.mouse.click(p.x, p.y, { button: 'right' })
        return true
      }
      const leftClick = (sel) => async () => {
        const p = await center(win, sel)
        if (!p) return false
        await win.mouse.click(p.x, p.y)
        return true
      }

      const spaceId = await win.evaluate(() => [...document.querySelectorAll('.rb-top .rb-slot[data-id^="space:"]')].map((x) => x.dataset.id)[1] || null)
      if (spaceId) await probe('space-ctx', rightClick(`.rb-top .rb-slot[data-id="${spaceId}"]`), `.rb-top .rb-slot[data-id="${spaceId}"]`, { shot: true })
      else r.check(`${c.id}: 上区有 Space 格`, false)
      await probe('plus-top', leftClick('.rb-top .rb-plus'), '.rb-top .rb-plus', { shot: true })
      await probe('plus-bottom', leftClick('.rb-bottom .rb-plus'), '.rb-bottom .rb-plus')
      const cmdSel = '.rb-bottom .rb-slot[data-id="cmd:quick-find"]'
      if (await center(win, cmdSel)) await probe('cmd-ctx', rightClick(cmdSel), cmdSel, { shot: c.id === 'light-zh' })
      else r.check(`${c.id}: 命令区有种进去的命令格`, false)
      const folderSel = '.rb-bottom .rb-slot[data-id="folder:probe"]'
      if (await center(win, folderSel)) await probe('folder-ctx', rightClick(folderSel), folderSel)
      else r.check(`${c.id}: 命令区有种进去的收纳夹`, false)
      // 收纳夹浮层里的行:悬停夹图标弹浮层,指针挪进去右键那一行。菜单遮罩一盖浮层就收,发起格记在夹的槽上。
      const rowSel = '.rb-fly-row[data-id="cmd:toggle-left"]'
      await probe('fly-row-ctx', async () => {
        const f = await center(win, `${folderSel} > .rb-btn`)
        if (!f) return false
        await win.mouse.move(f.x, f.y)
        await win.waitForSelector(rowSel, { timeout: 3000 }).catch(() => {})
        const p = await center(win, rowSel)
        if (!p) return false
        await win.mouse.move(f.x + 20, f.y, { steps: 4 })
        await win.mouse.move(p.x, p.y, { steps: 6 })
        await win.mouse.click(p.x, p.y, { button: 'right' })
        return true
      }, folderSel)
      await win.mouse.move(900, 400)
      await sleep(400)
      // 两区之间的空当(组外)= 整条的合并菜单:去掉限定词后不该出现两行「新建收纳夹」。
      const gap = await win.evaluate(() => {
        const a = document.querySelector('.rb-top')?.getBoundingClientRect()
        const b = document.querySelector('.rb-bottom')?.getBoundingClientRect()
        const rb = document.querySelector('.rb')?.getBoundingClientRect()
        if (!a || !b || !rb) return null
        for (let y = a.bottom + 2; y < b.top - 2; y += 4) {
          const el = document.elementFromPoint(rb.left + rb.width / 2, y)
          if (el && el.classList.contains('rb')) return { x: rb.left + rb.width / 2, y }
        }
        return null
      })
      if (gap) await probe('root-ctx', async () => { await win.mouse.click(gap.x, gap.y, { button: 'right' }); return true }, null)
      else r.note(`${c.id}: 两区之间找不到裸露的 .rb 空白,跳过 root-ctx`)
    }
  } finally {
    await close()
  }
  console.log(`截图目录:${dir}`)
  process.exit(r.summary() ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
