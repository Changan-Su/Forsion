/**
 * Resize divider 的两件事(单例 fixed DOM + document 委托,不侵入 dockview):
 * 1. tick 刻度:鼠标悬停/拖拽 dockview sash 时,在鼠标位置显示一段垂直于分界线的短把手。
 * 2. 卡缘校准:主区浮卡(content 内缩 CARD_INSET)让视觉边界偏离组缝——按 sash 两侧组的
 *    类型(浮卡/平铺)几何判定,把 data-lcl-shift 标到 sash 上,CSS 据此把 1px 中线与热区
 *    偏到卡缘(规则在 engine.css「Resize divider」段)。
 */

/** 主区浮卡的内缩量;与 engine.css 主区卡规则的 padding: 8px 保持同步。 */
const CARD_INSET = 8

const shiftOf = (sash: HTMLElement): number =>
  sash.dataset.lclShift === 'end' ? CARD_INSET : sash.dataset.lclShift === 'start' ? -CARD_INSET : 0

/** 全量校准:对每个 sash,几何匹配紧贴两侧的组,浮卡侧(tab 无图标=主区)记为线的偏移方向。 */
function calibrate(): void {
  const groups = Array.from(document.querySelectorAll('.dv-groupview'))
    .map((g) => ({ r: g.getBoundingClientRect(), papery: !g.querySelector('.wb-tab--icon') }))
    .filter((g) => g.r.width > 0 && g.r.height > 0)
  const EPS = 3
  for (const sash of document.querySelectorAll<HTMLElement>('.dv-sash')) {
    const horizontal = !!sash.closest('.dv-split-view-container.dv-horizontal')
    const r = sash.getBoundingClientRect()
    if (!r.width && !r.height) continue
    const c = horizontal ? r.left + r.width / 2 : r.top + r.height / 2
    const [sLo, sHi] = horizontal ? [r.top, r.bottom] : [r.left, r.right]
    let before: boolean | null = null // 缝前侧(左/上)组是浮卡?
    let after: boolean | null = null
    for (const g of groups) {
      const [gLo, gHi, gCrossLo, gCrossHi] = horizontal
        ? [g.r.left, g.r.right, g.r.top, g.r.bottom]
        : [g.r.top, g.r.bottom, g.r.left, g.r.right]
      if (gCrossHi <= sLo || gCrossLo >= sHi) continue // 与 sash 展向范围无重叠
      if (before === null && Math.abs(gHi - c) <= EPS) before = g.papery
      if (after === null && Math.abs(gLo - c) <= EPS) after = g.papery
    }
    // 仅一侧浮卡才偏(双浮卡=分屏,线居中等距两卡缘;双平铺=侧栏内部,线即贴边界)。
    const shift = before === false && after === true ? 'end' : before === true && after === false ? 'start' : ''
    if (shift) sash.dataset.lclShift = shift
    else delete sash.dataset.lclShift
  }
}

export function installSashAffordance(): () => void {
  const tick = document.createElement('div')
  tick.className = 'lcl-sash-tick'
  document.body.appendChild(tick)

  // 拖拽期间鼠标常在 sash rect 之外(view 尺寸有 min/max 钳制),记住按下的 sash 保持跟随。
  let activeSash: Element | null = null
  let raf = 0

  const place = (sash: HTMLElement, e: PointerEvent): void => {
    const horizontal = !!sash.closest('.dv-split-view-container.dv-horizontal') // 竖分界线(左右拖)
    const r = sash.getBoundingClientRect() // 拖拽中 sash 实时移动,rect 不能缓存
    const shift = shiftOf(sash)
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      tick.classList.add('show')
      tick.classList.toggle('h', !horizontal)
      if (horizontal) {
        tick.style.left = `${r.left + r.width / 2 + shift}px`
        tick.style.top = `${Math.min(Math.max(e.clientY, r.top), r.bottom)}px`
      } else {
        tick.style.left = `${Math.min(Math.max(e.clientX, r.left), r.right)}px`
        tick.style.top = `${r.top + r.height / 2 + shift}px`
      }
    })
  }

  const sashOf = (t: EventTarget | null): HTMLElement | null =>
    t instanceof Element ? t.closest('.dv-sash') : null

  const onMove = (e: PointerEvent): void => {
    const sash = activeSash instanceof HTMLElement ? activeSash : sashOf(e.target)
    if (sash) place(sash, e)
    else if (tick.classList.contains('show')) {
      cancelAnimationFrame(raf)
      tick.classList.remove('show')
    }
  }
  const onDown = (e: PointerEvent): void => {
    activeSash = sashOf(e.target)
  }
  const onUp = (e: PointerEvent): void => {
    if (!activeSash) return
    activeSash = null
    if (!sashOf(e.target)) {
      cancelAnimationFrame(raf)
      tick.classList.remove('show')
    }
  }

  // 布局结构变化(sash/组增删、面板拖动重排)→ 防抖全量重校准;聊天流等无关 mutation 快速滤掉。
  let calTimer = 0
  const scheduleCalibrate = (): void => {
    window.clearTimeout(calTimer)
    calTimer = window.setTimeout(calibrate, 120)
  }
  const structural = (n: Node): boolean =>
    n instanceof Element && (n.matches('.dv-sash, .dv-view, .dv-groupview') || !!n.querySelector('.dv-sash, .dv-groupview'))
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of [...m.addedNodes, ...m.removedNodes]) {
        if (structural(n)) {
          scheduleCalibrate()
          return
        }
      }
    }
  })
  mo.observe(document.body, { childList: true, subtree: true })
  scheduleCalibrate() // 挂载时 dockview 可能尚未 ready,首轮也走防抖

  document.addEventListener('pointermove', onMove, { passive: true })
  document.addEventListener('pointerdown', onDown, { passive: true })
  document.addEventListener('pointerup', onUp, { passive: true })
  return () => {
    mo.disconnect()
    window.clearTimeout(calTimer)
    cancelAnimationFrame(raf)
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerdown', onDown)
    document.removeEventListener('pointerup', onUp)
    tick.remove()
  }
}
