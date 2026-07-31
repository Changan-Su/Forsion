/** 统一「工作区」视图的模式模型(纯函数,无 React/amadeus 依赖 → node 环境可测)。 */
export type WorkspaceMode = 'sessions' | 'files' | 'notes'

/** 从笔记树点开的 Amadeus 文档 —— 主区 focus 它们时左栏一律回笔记树,**不分 Space**
 *  (在 Tangu Space 里点开一张图/一个 PDF 也该看见它在笔记树里的位置)。 */
const NOTE_DOC_VIEWS = new Set(['amadeus-editor', 'amadeus-drawing', 'amadeus-dashboard', 'amadeus-db', 'amadeus-pdf'])

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
): WorkspaceMode {
  if (mainType === 'chat') return loc === 'right' ? 'files' : 'sessions'
  if (mainType && NOTE_DOC_VIEWS.has(mainType)) return loc === 'right' ? 'files' : 'notes'
  if (mainType === 'code-studio') return 'files' // Coding Space:侧栏恒为工作区文件树(点文件 → 主区代码)
  return loc === 'right' ? 'files' : spaceDefault
}
