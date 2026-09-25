/**
 * 设置页深链的**唯一**解析点:`openSettings(target)` 的 target 落到哪个一级页 + 哪个子页。
 *
 * 为什么要单独一份:旧 `normalizeTab` 只归一一级页 —— `'forsion'` → general 之后 sub 丢了,落回第一项「连接」,
 * 而登录按钮在 g-forsion(登录失效 / 订阅过期 / `/login` 三条入口全落错页,U-02)。
 *
 * 两种写法:
 *  - 旧别名(持久化深链、插件、斜杠命令在用,永不删):见 LEGACY_TARGETS;
 *  - `${tab}/${sub}`:显式二级落点,如 `'model/m-providers'`。`/` 不与 `plugin:<id>` / `fplugin:<id>` 相交。
 * 子页存在与否由 SettingsModal 按当前端推导(activeSub):请求的 sub 在本端不存在时自然落回该页第一项。
 */

/** 允许的旧别名 → [一级页, 子页?]。一级页 id 必须是 SettingsModal 的 StaticTab。 */
export const LEGACY_TARGETS: Readonly<Record<string, readonly [string, string?]>> = {
  // 连接 / Forsion 合并进「常规」(general)
  connection: ['general', 'g-conn'],
  forsion: ['general', 'g-forsion'],
  // Agent CLI 并进 Agents 页
  'agent-clis': ['agents', 'ag-clis'],
  // 微信设置迁「通道」
  wechat: ['channels'],
}

export interface ResolvedSettingsTarget {
  tab: string
  sub?: string
}

/** 解析深链。空值 → general(调用方再按本端可用页兜底)。 */
export function resolveSettingsTarget(target: string | null | undefined): ResolvedSettingsTarget {
  if (!target) return { tab: 'general' }
  const legacy = LEGACY_TARGETS[target]
  if (legacy) return legacy[1] ? { tab: legacy[0], sub: legacy[1] } : { tab: legacy[0] }
  // 插件页的 id 可能含任意字符(含 `/`),前缀先放行,不拆。
  if (target.startsWith('plugin:') || target.startsWith('fplugin:')) return { tab: target }
  const slash = target.indexOf('/')
  if (slash > 0 && slash < target.length - 1) {
    const tab = target.slice(0, slash)
    const resolved = resolveSettingsTarget(tab)
    return { tab: resolved.tab, sub: target.slice(slash + 1) }
  }
  return { tab: target }
}
