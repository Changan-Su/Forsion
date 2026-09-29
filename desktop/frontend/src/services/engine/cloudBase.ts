/**
 * 云端 API 基址(P1-K6 S1):与**引擎基址**分家。
 *
 * 为什么要分:web / 手机的 home 引擎恰好就是云网关,于是历史代码到处拿 `backendUrl` 当云端 API 用
 * (登录态 /auth/me、额度、设备名册、Amadeus 云桥、收件箱广播……)。手机一旦把引擎切到「我的电脑」
 * (backendUrl = …/units/<id>/proxy/engine),这些云端调用就全打错地方。所以云端调用一律读 cloudApiBase。
 *
 * 形态(CLAUDE.md:`*_BASE` = 含 `/api` 的完整基址,无尾斜杠):
 *   - web / 手机 / 设备页(云中转):宿主垫片在 getConfig() 里直接给 `cloudApiBase`(= 旧 backendUrl);
 *   - 桌面:主进程只给纯源 `cloudUrl`,这里按主进程同款拼法现算 `cloudUrl 去尾斜杠 + '/api'`
 *     (el/main.ts 的 `${stored.cloudUrl.replace(/\/+$/, '')}/api/units/`、UnitSwitcher 的 tunnelPageUrl);
 *   - 都没有 → ''(调用方已按「未配置」处理)。
 * `cloudUrl` 本身的两种形态(桌面纯源 / 垫片含 /api)仍在,本模块不改它,只让读者不再猜后缀。
 *
 * 纯函数叶子模块:无运行时依赖 —— i18n.tsx、mobile/src/main.tsx 在渲染层求值之前就要用它。
 */
export function cloudApiBaseOf(c: { cloudApiBase?: unknown; cloudUrl?: unknown } | null | undefined): string {
  const explicit = typeof c?.cloudApiBase === 'string' ? c.cloudApiBase.trim() : ''
  if (explicit) return explicit.replace(/\/+$/, '')
  const origin = typeof c?.cloudUrl === 'string' ? c.cloudUrl.trim().replace(/\/+$/, '') : ''
  return origin ? `${origin}/api` : ''
}
