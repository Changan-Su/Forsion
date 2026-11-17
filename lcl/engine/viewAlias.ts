/**
 * 存档里的视图类型 → 它现在注册的名字(宿主给规则,LCL 不懂插件身份)。
 * 用处:插件换了运行身份(同一个包从普通安装换成商店安装,`plugin:<包 id>:x` 变成 `plugin:market-<UUID>:x`),
 * 用户存过的布局还记着旧名字 —— 不接过去,这些格子永远是「此视图暂不可用」,只能手点「恢复默认布局」。
 * 两个 store 载入存档时都过这一道(dockviewStore 的 migrateLayoutBlob、singleColumnStore 的 applySCBlob),
 * 已经摆在屏上的由 adoptViewAliases 接过去。还注册着的类型从不改名:原身份还在就是它的。
 */
import { getView } from './viewRegistry'

let rule: ((type: string) => string | null) | null = null

/** 宿主装上(或撤下)别名规则:返回新名字,或 null = 不认识。 */
export function setLayoutViewAlias(fn: ((type: string) => string | null) | null): void {
  rule = fn
}

/** 这个类型现在叫什么;null = 不改。规则抛错当不认识(布局还原不能被它带崩)。 */
export function aliasViewType(type: string): string | null {
  if (!rule || !type || getView(type)) return null
  try {
    const to = rule(type)
    return typeof to === 'string' && to && to !== type ? to : null
  } catch {
    return null
  }
}
