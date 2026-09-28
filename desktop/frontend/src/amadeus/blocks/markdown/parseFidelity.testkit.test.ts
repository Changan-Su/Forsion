// @vitest-environment happy-dom
/**
 * 夹具自检:bootEditor → destroy 后进程里不许还挂着定时器。
 * milkdown 的 Timer(@milkdown/ctx timer.ts)起 3s setTimeout 后从不 clearTimeout,到点还裸调 removeEventListener ——
 * 测试文件跑完、happy-dom 拆掉全局后才响,就是 CI 里「Vitest caught N unhandled errors:removeEventListener is not defined」、
 * 4500 条全绿仍退出码 1(2026-09-28 dispatch 36436607387)。单跑该文件干净、全量才红,靠这条钉住。
 */
import { expect, it } from 'vitest'
import { bootEditor } from './parseFidelity.testkit'

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

it('destroy 后不留定时器(milkdown Timer 的 3s 超时被清掉)', async () => {
  const before = timeouts()
  const b = await bootEditor('# 标题\n\n$x^2$\n')
  await b.destroy()
  // happy-dom 自己的 AsyncTaskManager 在任务收尾时也起一个毫秒级定时器(拆环境时会清),等它落定再数;milkdown 那 10 个是 3s 的,等不掉。
  await (window as unknown as { happyDOM: { waitUntilComplete(): Promise<void> } }).happyDOM.waitUntilComplete()
  expect(timeouts() - before).toBe(0)
})
