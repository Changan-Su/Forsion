/** 「用户刚打开终端」的意图(走查续七 7.2):用户入口(命令面板 / 新标签页 / 编码工作室)开终端前点一下,
 *  新挂上的终端视图取走它就拿焦点;布局恢复、后台起的终端没有这个标记,不抢焦点。
 *  单独一个小模块:终端视图是懒加载的(xterm 很大),入口那边不能为一个标记把它拉进主包。 */
let requestedAt = 0
export function requestTerminalFocus(): void { requestedAt = performance.now() }
export function takeTerminalFocus(): boolean {
  const asked = requestedAt > 0 && performance.now() - requestedAt < 3000
  requestedAt = 0
  return asked
}
