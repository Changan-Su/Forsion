/**
 * 新同步什么时候立刻推(2026-11-06,同步频率 F2;方案页 docs/ToBeImproved/Agent设备隔离方案_2026-11-04/round2.html「同步频率」)。
 * Forsion Extend 的新同步给刚改的文件留静默期(笔记停手 5 秒、Agent 文件 30 秒)再推;宿主在三个时刻叫它别等了:
 *   - 切走窗口满 1 秒(中途又回到本应用任一窗口就不算,免得 Alt-Tab 一下就推);
 *   - 合盖 / 睡眠前;
 *   - 退出前(含重启、装更新):等它推完,最多 wait 毫秒,到点不管推没推完都放行。
 * 内置包经 CloudHost.addFlushHook 登记;钩子返回 promise = 有东西在推、退出要等,不返回 = 没有要推的。
 * 纯逻辑零 electron 依赖(谁有焦点由调用方注入),vitest 直测。
 */
export type FlushReason = 'blur' | 'suspend' | 'quit'
export type FlushHook = (reason: FlushReason) => Promise<void> | undefined | void

export function createContentFlush(deps: { focused(): boolean; log?(m: string): void; blurDelay?: number }) {
  const hooks = new Set<FlushHook>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let quitDone = false
  const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
  /** 挨个叫;插件那边抛错 / 给了坏值都当没事(不能因为插件坏了就退不出去)。 */
  const call = (reason: FlushReason): Promise<void>[] => {
    const out: Promise<void>[] = []
    for (const h of hooks) {
      try {
        const p = h(reason)
        if (p && typeof (p as Promise<void>).then === 'function') out.push(Promise.resolve(p).catch((e) => deps.log?.(`[content-flush] ${reason} failed: ${String((e as Error)?.message || e)}`)))
      } catch (e) { deps.log?.(`[content-flush] hook threw: ${String((e as Error)?.message || e)}`) }
    }
    return out
  }
  return {
    add(fn: FlushHook): () => void {
      if (typeof fn !== 'function') return () => {}
      hooks.add(fn)
      return () => { hooks.delete(fn) }
    },
    /** 某扇窗口失焦:1 秒后还没有本应用的窗口拿到焦点,才算切走了。 */
    blur(): void {
      stopTimer()
      timer = setTimeout(() => { timer = null; if (!deps.focused()) void call('blur') }, deps.blurDelay ?? 1000)
      timer.unref?.()
    },
    focus(): void { stopTimer() },
    suspend(): void { void call('suspend') },
    /** 退出前叫一次(before-quit / 重启前)。有要等的 → promise(最多 wait 毫秒,成败都放行);没有 → null,调用方照常退。
     *  一次退出只冲一次:重启那条路冲过了,紧跟着的 before-quit 不再冲。 */
    quit(wait = 5000): Promise<void> | null {
      if (quitDone) return null
      quitDone = true
      stopTimer()
      const pending = call('quit')
      if (!pending.length) return null
      return new Promise<void>((resolve) => {
        const t = setTimeout(() => { deps.log?.(`[content-flush] quit: gave up waiting after ${wait}ms`); resolve() }, wait)
        void Promise.allSettled(pending).then(() => { clearTimeout(t); resolve() })
      })
    },
    /** 重启 / 装更新没成:下次退出再冲一次。 */
    reset(): void { quitDone = false },
  }
}
