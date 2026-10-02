/**
 * ⌘J 开合底部面板时,主区里的 iframe 不许重载(2026-10-02 Video Studio 实测:舞台每按一次 ⌘J 黑 0.15–0.6s)。
 * 根因:收起删掉底部组 → Dockview 归一化网格 → 主区整列 DOM 摘下重挂 → 帧被卸掉重载。修法见 dockviewStore.parkBottom。
 *
 * 真 Electron + 桩引擎(lib/uiux-electron.cjs,隔离 out/ / home / user-data,不碰别人的 dev)。主区里塞一个 srcdoc 探针帧:
 *   数 load 事件 + 帧内标记(重载即丢)+ MutationObserver 记「含探针的节点被摘下」次数。
 *   1  首次展开:还没有底部组 → 新建组 → 网格重排,仍会重挂一次(NOTE,不判)
 *   2  收起 / 展开 / 收起 / 展开:每一下先断言**真的开合了**(防死键真空通过),再断言 0 重载、0 摘下、标记还在
 *   3  收起后主区回到满高(藏起来的 0 高组不留缝)+ 展开还原收起前的底部标签;截图落 SHOT_DIR 自己看
 *   4  × 关掉最后一个底部标签(closeLeaf 那条收起路径)同样不重挂 —— 底部没有可关标签时 NOTE 跳过
 *   5  reload(布局从存档恢复,藏着的组一起恢复)后首次 ⌘J 也不重挂
 *   7  恢复默认布局 → 撤销(撤销快照里带着藏着的组,走 applyLayout):组还在,⌘J 开回原标签且不重挂
 *   6  NOTE:左右栏开合(仍删组)的重载数,只记不判(放最后跑)
 *
 * 跑:npx electron-vite build && npm run check:bottomiframe
 * 负对照:撤掉 parkBottom(toggleSidebar 收起改回逐个 close)重 build,2.x 必红。
 */
const path = require('path')
const { sleep, shotDir, makeReporter, launch, boot, captureWindow } = require('./lib/uiux-electron.cjs')

const R = makeReporter()
const SETTLE = 900 // 补间 200ms + 收尾 + 180ms 释放 + 余量

const INJECT = `(() => {
  const host = [...document.querySelectorAll('.wb-view--main')].find((e) => e.getBoundingClientRect().height > 50)
  if (!host) return false
  document.getElementById('bt-probe')?.remove()
  const f = document.createElement('iframe')
  f.id = 'bt-probe'
  f.srcdoc = '<body style="margin:0;background:#c33;color:#fff;font:12px sans-serif">probe</body>'
  f.style.cssText = 'position:absolute;right:8px;bottom:8px;width:120px;height:48px;border:0;z-index:9'
  const st = window.__bt = { loads: 0, detaches: 0 }
  f.addEventListener('load', () => { st.loads++; if (st.loads === 1) try { f.contentWindow.__mark = 'alive' } catch {} })
  new MutationObserver((recs) => { for (const r of recs) for (const n of r.removedNodes) if (n === f || n.contains?.(f)) st.detaches++ })
    .observe(document.body, { childList: true, subtree: true })
  host.appendChild(f)
  return true
})()`

const STATE = `(() => {
  const f = document.getElementById('bt-probe')
  const st = window.__bt || {}
  let mark = null
  try { mark = f?.contentWindow?.__mark ?? null } catch {}
  const groupsOf = (sel) => [...new Set([...document.querySelectorAll(sel)].map((v) => v.closest('.dv-groupview')).filter(Boolean))]
  const bottomGroups = groupsOf('.wb-view--bottom')
  return {
    loads: st.loads, detaches: st.detaches, mark,
    bottomOn: !!document.querySelector('.dv-edge-bottom.is-on'),
    mainH: Math.round(f?.closest('.dv-groupview')?.getBoundingClientRect().height ?? -1),
    bottomH: Math.round(bottomGroups[0]?.getBoundingClientRect().height ?? 0),
    bottomTabs: bottomGroups.flatMap((g) => [...g.querySelectorAll('.wb-tab-name')].map((t) => t.textContent)),
    parked: [...document.querySelectorAll('.dv-view')].filter((v) => !v.classList.contains('visible') && v.querySelector('.dv-groupview')).length,
  }
})()`

async function main() {
  const { app, win, close } = await launch({ tag: 'bottom-iframe' })
  const shots = shotDir('bottom-iframe')
  const state = () => win.evaluate(STATE)
  const inject = async () => {
    const ok = await win.evaluate(INJECT)
    for (let i = 0; i < 40 && (await state()).loads < 1; i++) await sleep(50)
    return ok
  }
  /** 按一下 ⌘J,断言开合真的发生了,再记这一下的重载 / 摘下增量。 */
  const toggle = async (label, wantOn, judge = true) => {
    const before = await state()
    await win.keyboard.press('Meta+J')
    await sleep(SETTLE)
    const after = await state()
    const dl = after.loads - before.loads, dd = after.detaches - before.detaches
    R.check(`${label}:⌘J 真的${wantOn ? '展开' : '收起'}了`, after.bottomOn === wantOn && (wantOn ? after.bottomH > 100 : after.bottomH === 0),
      `bottomOn=${after.bottomOn} bottomH=${after.bottomH} mainH ${before.mainH}→${after.mainH}`)
    const detail = `load +${dl}  摘下 +${dd}  mark=${after.mark}`
    if (judge) R.check(`${label}:主区探针帧没重载、没被摘下`, dl === 0 && dd === 0 && after.mark === 'alive', detail)
    else R.note(`${label}`, detail)
    return after
  }

  try {
    await boot(app, win)
    await win.waitForSelector('#tangu-splash', { state: 'detached', timeout: 15_000 }).catch(() => {})
    R.check('前置:探针帧挂进主区并加载', await inject() && (await state()).loads === 1)
    let s = await state()
    if (s.bottomOn) { R.note('前置', 'Space 默认开着底部,先收一次'); await toggle('前置收起', false, false); await inject() }
    const fullH = (await state()).mainH

    // 1 首次展开:新建组 = 网格重排,预期仍重挂一次(这份布局里只此一次 —— 之后组被藏着、随布局存档)
    await toggle('1 首次展开', true, false)
    await inject() // 首次那下若重载了,换个新探针重新数
    // 2 往返两轮
    const tabsOpen = (await state()).bottomTabs
    s = await toggle('2.1 收起', false)
    R.check('3 收起后主区回到满高(藏着的组不留缝)', Math.abs(s.mainH - fullH) <= 2, `mainH=${s.mainH} 满高=${fullH} parked=${s.parked}`)
    await captureWindow(app, path.join(shots, '1-collapsed.png'))
    s = await toggle('2.2 展开', true)
    R.check('3 展开还原收起前的底部标签', JSON.stringify(s.bottomTabs) === JSON.stringify(tabsOpen), `${JSON.stringify(tabsOpen)} → ${JSON.stringify(s.bottomTabs)}`)
    await captureWindow(app, path.join(shots, '2-expanded.png'))
    await toggle('2.3 收起', false)
    await toggle('2.4 展开', true)

    // 4 × 关掉最后一个底部标签 = 收起面板(closeLeaf)
    const closeBtn = win.locator('.dv-groupview:has(.wb-view--bottom) .wb-tab-close')
    if (await closeBtn.count() === 1) {
      const b = await state()
      await win.locator('.dv-groupview:has(.wb-view--bottom) .dv-tab').first().hover() // 单标签组的 × 只在悬停时可点
      await closeBtn.click()
      await sleep(SETTLE)
      const a = await state()
      R.check('4 × 关最后一个底部标签:面板收起', !a.bottomOn, `bottomOn=${a.bottomOn}`)
      R.check('4 × 关最后一个底部标签:主区探针帧没重载、没被摘下', a.loads === b.loads && a.detaches === b.detaches && a.mark === 'alive', `load +${a.loads - b.loads} 摘下 +${a.detaches - b.detaches}`)
      await toggle('4 之后再展开', true)
    } else R.note('4 × 路径', `底部可关标签数 = ${await closeBtn.count()},跳过(占位标签不可关)`)
    await toggle('5 前收起', false)

    // 5 reload:布局从存档恢复,藏着的组一起回来
    await sleep(400) // 存档防抖 100ms
    await win.reload({ waitUntil: 'domcontentloaded' })
    await win.waitForSelector('.dv-groupview', { timeout: 30_000 })
    await sleep(2000)
    R.check('5 reload 后:探针帧重新挂上', await inject() && (await state()).loads === 1, `parked=${(await state()).parked}`)
    await toggle('5 reload 后首次展开', true)
    await toggle('5 reload 后收起', false)

    // 7 恢复默认布局 → 撤销:撤销快照(信封)里带着藏起来的空组,经 applyLayout 还原后 ⌘J 照样开回原内容、不重挂
    const parkedBefore = (await state()).parked
    await win.locator('.dv-edge-reset').first().click()
    await sleep(700)
    await win.getByRole('button', { name: /^(撤销|Undo)$/ }).first().click()
    await sleep(SETTLE)
    s = await state()
    R.check('7 撤销后底部仍收着、藏着的组还在', !s.bottomOn && s.parked === parkedBefore, `bottomOn=${s.bottomOn} parked ${parkedBefore}→${s.parked}`)
    R.check('7 撤销后:探针帧重新挂上', await inject())
    s = await toggle('7 撤销后展开', true)
    R.check('7 撤销后展开还原收起前的底部标签', JSON.stringify(s.bottomTabs) === JSON.stringify(tabsOpen), JSON.stringify(s.bottomTabs))
    await toggle('7 撤销后收起', false)

    // 6 左右栏:仍删组,只记不判
    for (const [name, sel] of [['右栏', '.dv-edge-right'], ['左栏', '.dv-prefix .dv-edge-toggle']]) {
      for (const phase of ['收', '开']) {
        const b = await state()
        await win.locator(sel).first().click().catch(() => {})
        await sleep(SETTLE)
        const a = await state()
        const on = await win.evaluate((s) => document.querySelector(s)?.classList.contains('is-on'), sel)
        R.note(`6 ${name}${phase}(仍删组,不判)`, `is-on=${on}  load +${a.loads - b.loads}  摘下 +${a.detaches - b.detaches}`)
      }
    }
    console.log(`截图:${shots}`)
  } finally {
    await close()
  }
  process.exit(R.summary() ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
