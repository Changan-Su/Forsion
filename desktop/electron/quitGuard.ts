/**
 * 退出前问一次(2026-10-18,蓬洲云网盘:还有文件在传时退出会中断)。内置包的主进程半身经 CloudHost.addQuitGuard 登记,
 * 返回非 null = 有东西还没做完;宿主在 before-quit 里第一件事问它们,有一个说「没做完」就拦下、弹「退出 / 取消」。
 * 点「退出」记下已确认,再 app.quit() 一次放行;重启 / 装更新那条路自己先问(confirmFirst),问过了 before-quit 不再问。
 * 纯逻辑零 electron 依赖(对话框、退出由调用方注入),vitest 直测。
 */
import { defineMainMessages, type MainLocale } from './mainI18n'

defineMainMessages({
  'main.quitGuard.quit': { zh: '退出', en: 'Quit' },
  'main.quitGuard.cancel': { zh: '取消', en: 'Cancel' },
})

export interface QuitBlock { message: string; detail?: string }
export type QuitGuardFn = (locale: MainLocale) => QuitBlock | null

export function createQuitGuards(deps: { locale(): MainLocale; ask(b: QuitBlock): Promise<boolean>; quit(): void; log?(m: string): void }) {
  const guards = new Set<QuitGuardFn>()
  let confirmed = false
  // 退出和重启 / 装更新共用一个在问的框:两条路同时来只弹一个,答案归最后来的那条路去执行
  let asking: Promise<boolean> | null = null
  let quitAfter = false
  /** 第一条说「没做完」的;插件那边抛错 / 给了坏值都当没事(不能因为插件坏了就退不出去)。 */
  const first = (): QuitBlock | null => {
    for (const g of guards) {
      try {
        const b = g(deps.locale())
        if (b && typeof b.message === 'string' && b.message.trim()) return { message: b.message.slice(0, 200), ...(typeof b.detail === 'string' ? { detail: b.detail.slice(0, 500) } : {}) }
      } catch (e) { deps.log?.(`[quit-guard] guard threw: ${String((e as Error)?.message || e)}`) }
    }
    return null
  }
  const ask = (b: QuitBlock): Promise<boolean> => {
    if (!asking) {
      asking = deps.ask(b).then((go) => { if (go) confirmed = true; return go }, () => false)
      void asking.then((go) => { asking = null; if (go && quitAfter) deps.quit() })
    }
    return asking
  }
  return {
    add(fn: QuitGuardFn): () => void {
      if (typeof fn !== 'function') return () => {}
      guards.add(fn)
      return () => { guards.delete(fn) }
    },
    /** before-quit 里第一件事调:true = 拦下了(调用方 preventDefault 后直接 return,别做退出收尾)。
     *  对话框开着时又按了一次退出:照样拦,不叠第二个框。 */
    intercept(): boolean {
      if (confirmed) return false
      if (asking) return true // 框还开着(不管是谁弹的):不叠第二个
      const b = first()
      if (!b) return false
      quitAfter = true
      void ask(b)
      return true
    },
    /** 自己会走到退出的路(重启、装更新):先问一次;点了「退出」就记下,后面的 before-quit 不再问。 */
    async confirmFirst(): Promise<boolean> {
      if (confirmed) return true
      if (asking) { quitAfter = false; return asking } // 退出的框正开着:点了「退出」就由重启这条路接手,别再单纯退出
      const b = first()
      if (!b) return true
      quitAfter = false
      return ask(b)
    },
    /** 重启失败、退出没成:下次退出照常再问。 */
    reset(): void { confirmed = false },
  }
}
