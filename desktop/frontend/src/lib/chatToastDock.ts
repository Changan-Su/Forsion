/**
 * 聊天里弹的 toast(成就 / 引导任务)挂到聊天列上(走查续六 6.5):落点是 ChatView 在 .t2-chat-col 里放的 .t2-toast-dock,
 * 位于输入卡上方 12px、与输入卡同一条中线,两张叠着放。聊天列不可见(别的视图、手机外壳)就是 null,照旧按整窗居中。
 * 调用方在每张新 toast 出现时查一次(useMemo 按 toast 的 key),用 createPortal 挂过去。
 * ponytail: toast 在场期间切走视图不跟着挪 —— 它几秒就消失。
 */
export function chatToastDock(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('.t2-toast-dock')) {
    if (el.offsetWidth > 0 && !el.closest('.mb-shell')) return el
  }
  return null
}
