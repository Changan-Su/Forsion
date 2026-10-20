/**
 * 侧栏连点不漂(真 Electron × 桩引擎 × 隔离 home)。10-20 用户实报「开关 left panel 会导致 main panel 一直向右偏移」:
 * 上一轮开合排着的 setTimeout(release) 晚到,拆掉了后一轮刚给对侧上的锁 → 补间中途对侧被挤,captureSideWidths 把挤出来的宽
 * 当成用户拖的记下 → 之后每次都按它钉、越漂越远。修在 dockviewStore 的 toggleReleases(只放一次)。
 *
 * 两侧都开着:左栏「点一下 → 隔 N ms → 再点一下」连做 4 轮,右栏宽度与存下的侧栏宽都不许变;右栏同理看左栏。
 * 需先 npm run build。用法:npm run check:sidetoggle
 */
const { launch, boot, enterSpace, makeReporter, sleep } = require('./lib/uiux-electron.cjs')

const R = makeReporter()
const widths = (win) => win.evaluate(() => {
  const w = (sel) => { const t = [...document.querySelectorAll(sel)].find((e) => e.getBoundingClientRect().width > 0); const g = t?.closest('.dv-groupview'); return g ? Math.round(g.getBoundingClientRect().width) : 0 }
  const saved = Object.keys(localStorage).filter((k) => k.startsWith('lcl.sideWidth2.')).map((k) => JSON.parse(localStorage.getItem(k) || '{}'))
  return { left: w('.wb-view--left'), right: w('.wb-view--right'), saved: saved.some((v) => v.left != null || v.right != null) }
})
const near = (a, b) => Math.abs(a - b) <= 2

async function main() {
  const ctx = await launch({ tag: 'sidetoggle' })
  const { win } = ctx
  try {
    await boot(ctx.app, win, { space: 'tangu', width: 1512, height: 950 })
    await enterSpace(win, 'tangu'); await sleep(1500)
    const edge = { left: win.locator('.dv-prefix .dv-edge-toggle').first(), right: win.locator('.dv-edge-right').first() }
    for (const s of ['left', 'right']) if ((await edge[s].getAttribute('aria-pressed')) !== 'true') { await edge[s].click(); await sleep(900) }
    const base = await widths(win)
    R.check('两侧都开着', base.left > 100 && base.right > 100, JSON.stringify(base))
    for (const [side, other] of [['left', 'right'], ['right', 'left']]) {
      for (const gap of [60, 260, 400]) {
        for (let i = 0; i < 4; i++) { await edge[side].click(); await sleep(gap); await edge[side].click(); await sleep(1000) }
        if ((await edge[side].getAttribute('aria-pressed')) !== 'true') { await edge[side].click(); await sleep(1000) } // 收起途中再点会再收一次(已知局限),摆回开着再量
        const now = await widths(win)
        R.check(`连点${side === 'left' ? '左' : '右'}栏(间隔 ${gap}ms × 4):${other === 'left' ? '左' : '右'}栏宽不变、${side === 'left' ? '左' : '右'}栏回到原宽、没记下侧栏宽`,
          near(now[other], base[other]) && near(now[side], base[side]) && !now.saved, `base=${JSON.stringify(base)} now=${JSON.stringify(now)}`)
      }
    }
  } finally {
    await ctx.close()
  }
  process.exitCode = R.summary() ? 1 : 0
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
