/**
 * 触屏判定。目前唯一用途:浮层菜单里的搜索框**不要**在触屏上 autoFocus。
 *
 * 为什么:autoFocus 会弹起安卓软键盘,adjustResize 把可用高度压掉 ~320px,而这类菜单是
 * `position:absolute; bottom:100%` 向上弹的 —— 键盘一收一放,整块菜单在手指底下位移,
 * 那一下的 click 就落到菜单容器/背景上,条目永远收不到(实测见 scripts/menu-tap.check.cjs)。
 * 症状=「点了没反应」。手机上为两三个选项弹一次键盘本来也是负收益。
 */
export const isCoarsePointer = (): boolean => {
  try { return window.matchMedia('(pointer: coarse)').matches } catch { return false }
}
