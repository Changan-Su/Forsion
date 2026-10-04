/**
 * 设置页深链的**唯一**解析点:`openSettings(target)` 的 target 落到哪个一级页 + 哪个子页。
 *
 * 为什么要单独一份:旧 `normalizeTab` 只归一一级页 —— `'forsion'` → general 之后 sub 丢了,落回第一项「连接」,
 * 而登录按钮在 g-forsion(登录失效 / 订阅过期 / `/login` 三条入口全落错页,U-02)。2026-09-28 起 Forsion 自成一级页「Forsion 云端」。
 *
 * 两种写法:
 *  - 旧别名(持久化深链、插件、斜杠命令在用,永不删):见 LEGACY_TARGETS;
 *  - `${tab}/${sub}`:显式二级落点,如 `'model/m-providers'`。`/` 不与 `plugin:<id>` / `fplugin:<id>` 相交。
 * 子页存在与否由 SettingsModal 按当前端推导(activeSub):请求的 sub 在本端不存在时自然落回该页第一项。
 */
import { SETTINGS_SEARCH_INDEX } from './settingsSearchIndex'

/** SettingsModal 的一级页 id(StaticTab 的唯一来源)。本端有没有这一页另由 SettingsModal 的 tabItems 门控。 */
export const SETTINGS_TABS = [
  'general', 'connection', 'forsion', 'model', 'mcp', 'hooks', 'skills', 'agents', 'plugins', 'amadeus-plugins', 'agent-clis', 'browser', 'channels',
  'notes', 'sync', 'spaces', 'theme', 'shortcuts', 'notifications', 'statusbar', 'permissions', 'remote-sessions', 'computer-history', 'advanced', 'developer', 'about',
] as const

/** 允许的旧别名 → [一级页, 子页?]。一级页 id 必须是 SettingsModal 的 StaticTab。 */
export const LEGACY_TARGETS: Readonly<Record<string, readonly [string, string?]>> = {
  // 连接合并进「常规」(general);Forsion 账号自成一级页(随 Extend 出现),旧的二级落点照样认
  connection: ['general', 'g-conn'],
  // 不带子页 = 落到第一个子页:Extend 自绘的「账号」(没装 Extend 0.5 时落到宿主的「同步」)
  forsion: ['forsion'],
  'general/g-forsion': ['forsion'],
  'sync/s-cloud': ['forsion', 'f-sync'],
  // Agent CLI 并进 Agents 页
  'agent-clis': ['agents', 'ag-clis'],
  // 微信设置迁「通道」
  wechat: ['channels'],
  // 引擎插件页并进统一插件页。此前靠 SettingsModal 里一个 effect 重定向,但 'plugins' 不在 tabItems 里、
  // 先被兜底成第一页,effect 永远等不到它 —— `/plugins` 一直落在「常规」。
  plugins: ['amadeus-plugins'],
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

/**
 * agent 的落点解析(run_ui_command `open-settings`)。比深链多认一层:设置搜索索引里的条目 id
 * (`voice`、`fonts`、`mirror`…)直接落到那项设置所在的子页。
 * 认不出的返回 null —— 此前未知名字静默落到第一页还回报成功,agent 以为自己打开了语音设置(反馈 6a239e58)。
 * 子页只认搜索索引与别名表里出现过的(agent 的清单里也只有这些):`model/随便写` 会被弹窗落到该页第一项,不能回报成「已打开」。
 * ponytail: 不验本端门控(设置开在独立窗口里,主窗口读不到真实落点):本端没有的页(未开开发者模式的 developer 等)仍会落到第一页。
 *           升级路径 = 把 SettingsModal 的 tabItems / subItemsByTab 门控抽成纯函数,这里与弹窗共用。
 */
export function resolveAgentSettingsTarget(target: string): ResolvedSettingsTarget | null {
  const resolved = resolveSettingsTarget(target)
  if (/^f?plugin:./.test(resolved.tab)) return resolved
  if ((SETTINGS_TABS as readonly string[]).includes(resolved.tab)) {
    const { tab, sub } = resolved
    const known = !sub
      || SETTINGS_SEARCH_INDEX.some((entry) => entry.tab === tab && entry.sub === sub)
      || Object.values(LEGACY_TARGETS).some(([t, s]) => t === tab && s === sub)
    return known ? resolved : null
  }
  const item = SETTINGS_SEARCH_INDEX.find((entry) => entry.id === target)
  return item ? { tab: item.tab, ...(item.sub ? { sub: item.sub } : {}) } : null
}

/**
 * 给 agent 的落点清单,写进 `open-settings` 的参数说明。
 * ⚠️ 引擎把命令的 description / state 各截到 300 字符、params 的 JSON 超过 2000 字符整个丢弃(tangu-agent routes/runs.ts
 *    normalizeUiCommands),所以清单只能住在 params 里,而且只列 id(不带所在页);长度由 settingsTarget.test.ts 钉住。
 *    命令的 state 是「当前值探针」、每次起 run 都会被读进目录,不适合放回执 —— 回执由 run 的返回值按次给。
 */
export function agentSettingsTargets(): string {
  const pages = SETTINGS_TABS.filter((tab) => !(tab in LEGACY_TARGETS) || LEGACY_TARGETS[tab][0] === tab)
  return `Pages: ${pages.join(', ')}. Settings: ${SETTINGS_SEARCH_INDEX.map((entry) => entry.id).join(', ')}.`
}

/** 认不出的名字按设置搜索的别名找相近项,给报错当提示(「speech」→ voice)。 */
export function suggestSettingsTargets(query: string): string[] {
  const q = query.trim().toLowerCase()
  return q ? SETTINGS_SEARCH_INDEX.filter((entry) => entry.id.includes(q) || entry.keywords.toLowerCase().includes(q)).map((entry) => entry.id).slice(0, 5) : []
}
