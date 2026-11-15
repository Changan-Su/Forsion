/**
 * 设备页的「本页令牌」判定,全仓只此一处。
 *
 * 经中转打开的设备页没有自己的配对令牌:桌面壳在浏览器分区层注入 Authorization,普通浏览器走设备子域的 Cookie。
 * 但 appStore 只在 token 非空时才 connect,所以 unitShim 给连接配置塞一枚非机密占位值。
 * 占位值**绝不能当令牌发**:请求一旦自带 Authorization,中转就不再看 Cookie,整页 401。
 * 发请求的地方一律经 isRealUnitToken / unitAuthHeader,别再各写一遍字面量比较。
 */
export const UNIT_TOKEN_PLACEHOLDER = 'tunnel'

/** 是本页真正持有的令牌(局域网配对 / 主人访问拿到的),不是空串也不是占位值。 */
export function isRealUnitToken(token: string | null | undefined): token is string {
  return !!token && token !== UNIT_TOKEN_PLACEHOLDER
}

/** 真令牌 → Authorization 头;否则不带(让壳注入或 Cookie 生效)。 */
export function unitAuthHeader(token: string | null | undefined): { Authorization: string } | undefined {
  return isRealUnitToken(token) ? { Authorization: `Bearer ${token}` } : undefined
}
