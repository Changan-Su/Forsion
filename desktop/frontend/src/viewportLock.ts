/**
 * 视口滚动锁:把「整个界面被顶上去、且滚不回来」这件事一次性钉死。
 *
 * 病(用户 2026-08-28 实报「回到 Tangu 就莫名突出来一块,把页面往上顶」):
 * 本应用是固定视口的桌面壳,**页面本身从来不该滚动**。但 `body { overflow: hidden }` 会传播到视口,
 * 而视口即使是 hidden 也**仍然是个可被程序化滚动的容器** —— 浏览器给焦点元素做 `scrollIntoView`
 * 时就会把整个界面滚上去,而且没有滚动条能滚回来,只能重启应用。
 * 触发条件 = body 里有任何东西撑出视口一点点(用户会话里的 PDF 阅读器 / portal 到 body 的浮层就够),
 * 界面缩放 ≠ 1 时尤其容易凑出来。实测该用户 `--uiz=1.2`、`.shell` 的 top = **-27**
 * (顶上 27px 被切、底下空出 27px —— 那就是他说的「突出来一块」)。
 *
 * ⚠️**CSS 挡不住,别再试了**(2026-08-28 已逐个实测):
 *   · `body { overflow: clip }` → 传播到视口后照样可滚(scrollTop 写进 36)
 *   · `html { overflow: clip }` → 同上,视口的 clip 被当作 hidden
 * 唯一有效的是把滚动**弹回去**。代价可以忽略:本应用没有任何一处需要滚动页面本身。
 *
 * 仪器:npm run check:shellnoscroll 的 E。
 */

let installed = false

/** 装一次:视口一旦被滚起来就立刻归零。幂等。 */
export function installViewportLock(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const snap = (): void => {
    // 读一次再判:无谓的 scrollTo 会让某些输入法/触控板的惯性滚动一直重入。
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
  }
  // scroll 事件在滚动**发生后**才来 —— 这是兜底,不是预防:那一帧的位移用户基本看不见,
  // 而它能覆盖所有触发源(scrollIntoView / 焦点 / 惯性 / 第三方脚本),不必逐个去堵。
  window.addEventListener('scroll', snap, { passive: true })
  snap() // 装的时候可能已经歪了(启动期的自动聚焦)
}
