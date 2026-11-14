import { isRealUnitToken } from '@/services/unitToken'

/** 没有本页令牌时,两次整页重载之间至少隔这么久;窗内再收到 401 只报错,不再重载。 */
export const UNIT_AUTH_RELOAD_WINDOW_MS = 2 * 60_000

export interface UnitAuthErrorOptions {
  /** 本页发请求用的令牌(可能是占位值)。 */
  token: string
  /** 真令牌失效时清掉本地存的那份,重载后重新配对 / 主人访问。 */
  clearToken(): void
  reload(): void
  /** 记上次重载时刻的存储(按标签页);拿不到就不重载。 */
  storage?: Storage
  storageKey: string
  now?: () => number
}

/**
 * 设备页收到 401 时的处理。
 * - 真令牌(局域网配对 / 主人访问):清令牌、重载一次 → 进配对流(原行为)。
 * - 没有真令牌(壳注入或 Cookie):重载是唯一能做的,但凭据不在本页手里,重载未必有用 ——
 *   窗内只重载一次;存储读写失败按「不知道上次何时重载」处理,不重载。不重载时调用方照常抛出原来的失效提示。
 * 同一页里只在**真的发起了重载**之后才不再处理后面的 401(页面已经在重载了);窗内被压下的那次不算,窗口过后同一页还能再试一次。
 */
export function createUnitAuthErrorHandler(o: UnitAuthErrorOptions): () => void {
  let handled = false
  return () => {
    if (handled) return
    if (isRealUnitToken(o.token)) {
      handled = true
      o.clearToken()
      o.reload()
      return
    }
    const now = (o.now ?? Date.now)()
    try {
      if (!o.storage) return
      const last = Number(o.storage.getItem(o.storageKey) || 0)
      if (Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < UNIT_AUTH_RELOAD_WINDOW_MS) return
      o.storage.setItem(o.storageKey, String(now))
    } catch { return }
    handled = true
    o.reload()
  }
}
