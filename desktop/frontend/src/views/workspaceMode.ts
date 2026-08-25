/** 统一「工作区」视图的模式模型(纯函数,无 React/amadeus 依赖 → node 环境可测)。 */
export type WorkspaceMode = 'sessions' | 'files' | 'notes'

/** 扩展模式 = 内置三档 + 插件列表源(`plugin:<pid>:<srcId>`,View 基座 P2)。 */
export type WorkspaceModeEx = WorkspaceMode | `plugin:${string}`

/** 从笔记树点开的 Amadeus 文档 —— 主区 focus 它们时左栏一律回笔记树,**不分 Space**
 *  (在 Tangu Space 里点开一张图/一个 PDF 也该看见它在笔记树里的位置)。 */
const NOTE_DOC_VIEWS = new Set(['amadeus-editor', 'amadeus-drawing', 'dashboard', 'amadeus-dashboard', 'amadeus-db', 'amadeus-pdf'])

/**
 * 自动模式 = f(所在侧, 活动主视图类型, 本 Space 默认档)。
 *
 * 两级:主视图**硬规则**优先(跨 Space 一致);没有硬规则 → 落**本 Space 的默认档**
 * (`SpaceDefinition.autoWorkspaceMode`,缺省 'sessions' = 与其它 Space 一致)。
 *
 * **右栏恒为「文件」**(= 参考/附件栏,Space 不可改):所有硬规则右侧都给 files,
 * 故此前「维持上一模式」的 prev 在右栏永远等于 files —— 这里直接写死,行为不变。
 */
export function autoWorkspaceMode(
  loc: 'left' | 'right' | 'main',
  mainType: string | null,
  spaceDefault: WorkspaceMode = 'sessions',
  /** 主视图注册时声明的 workspaceSource(ViewDefinition.workspaceSource,调用方查注册表后传入;
   *  View 基座 P2 的声明式联动位)。显式声明优先于内置硬规则;右栏仍恒 files 不受它管。 */
  mainSource?: string | null,
): WorkspaceModeEx {
  if (loc !== 'right' && mainSource) return mainSource as WorkspaceModeEx
  if (mainType === 'chat') return loc === 'right' ? 'files' : 'sessions'
  if (mainType && NOTE_DOC_VIEWS.has(mainType)) return loc === 'right' ? 'files' : 'notes'
  if (mainType === 'code-studio') return 'files' // Coding Space:侧栏恒为工作区文件树(点文件 → 主区代码)
  return loc === 'right' ? 'files' : spaceDefault
}

/**
 * 路径落在哪个工作区里 —— 文件面板据此把「当前打开文件所在的工作区」置顶。
 *
 * 取**最长匹配**:工作区允许嵌套(同时加了 `~/code` 与 `~/code/forsion`),文件属于更具体的那个。
 * 分隔符两边都归一成 `/` 并要求边界对齐 —— `/a/bcd` 不算落在 `/a/bc` 里。
 * ponytail: 大小写敏感比较。Windows 上盘符/路径大小写不一致会认不出 → 退回不置顶,不是错行为;
 * 真碰上了再按平台归一。
 */
export function workspaceKeyForPath(
  workspaces: Array<{ key: string; path?: string | null }>,
  filePath: string | null | undefined,
): string | null {
  if (!filePath) return null
  const norm = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const f = norm(filePath)
  let best: { key: string; len: number } | null = null
  for (const w of workspaces) {
    const root = w.path ? norm(w.path) : ''
    if (!root || (f !== root && !f.startsWith(`${root}/`))) continue
    if (!best || root.length > best.len) best = { key: w.key, len: root.length }
  }
  return best?.key ?? null
}
