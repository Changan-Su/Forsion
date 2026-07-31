/** 「表变了,去看一眼」的踢门铃 —— .db 落盘后通知引擎立刻跑一次巡检。
 *
 *  为什么不是事件总线:引擎醒来后**照样自己重读磁盘做权威判定**,这里既不带行内容也不带路径。
 *  于是这条通道即使被滥用,最坏后果也只是「巡检多跑了一次」——不能伪造出一次表格变化。
 *  轮询保留作恢复路径(库外编辑、踢门铃丢了、桌面没开)。
 *
 *  节流 1.5s:连续编辑格子会连着落盘,不节流就变成每次按键一个请求。
 *  宿主未注册(云端 Web / 移动端)→ 整个函数是 no-op。 */
let kick: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

export function setAutomationKick(fn: (() => void) | null): void {
  kick = fn
}

export function kickAutomation(): void {
  if (!kick || timer) return
  timer = setTimeout(() => { timer = null; kick?.() }, 1500)
}
