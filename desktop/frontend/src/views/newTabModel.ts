/** 新建标签页「打开」那一段的归属表:一个 Space 一格。纯函数,不碰任何 store(单测 newTabModel.test.ts)。 */
import type { SpaceDefinition, ViewDefinition, PersistedPanel } from '@lcl/engine'

export interface LauncherTile { space: SpaceDefinition; views: PersistedPanel[] }
type ViewMeta = Pick<ViewDefinition, 'kind' | 'idParam'>

/** 引擎的占位视图:用户把当前布局存成 Space 时,主区里可能正好开着一张空白页。 */
const PLACEHOLDERS = new Set(['launcher', 'home', 'sidebar-empty'])

/** 视图能不能从启动器直接开:entity 要带着身份参数(配方里钉死的那份文件),aux 跟着别的主视图走,占位视图不是内容,都不算。 */
export function launchable(p: PersistedPanel, def: ViewMeta | undefined): boolean {
  if (!def || def.kind === 'aux' || PLACEHOLDERS.has(p.type)) return false
  if (def.kind !== 'entity') return true
  return !!def.idParam && p.params?.[def.idParam] != null
}

/**
 * spaces 已按 Ribbon 顺序排好。每个 Space 的视图 = 它声明的启动器视图(缺省取固定在主区的)+ 所属插件注册的全部视图
 * (插件视图一律是自包含页,原先就全部列在启动器里)。滤完没有可开视图的 Space 不出格子 ——
 * Tangu / 笔记的主区是「某一条会话 / 某一篇笔记」,入口在「新建」和「最近使用」。
 * free = 所属插件没带 Space 的插件视图。
 * ponytail: 一个插件带多个 Space 时,它的视图只归到排在最前的那个;真遇到要分开的再让配方点名。
 */
export function launcherTiles(
  spaces: SpaceDefinition[],
  getView: (type: string) => ViewMeta | undefined,
  ownerOf: (spaceId: string) => string | undefined,
  pluginViewTypes: string[],
): { tiles: LauncherTile[]; free: string[] } {
  const pidOf = (type: string): string => type.split(':')[1] ?? ''
  const claimed = new Set<string>()
  const tiles: LauncherTile[] = []
  for (const space of spaces) {
    const owner = ownerOf(space.id)
    const owned = owner && !claimed.has(owner) ? pluginViewTypes.filter((t) => pidOf(t) === owner) : []
    if (owner) claimed.add(owner)
    const seen = new Set<string>()
    const cand: PersistedPanel[] = [...(space.launcherViews ?? space.pinned?.main ?? []), ...owned.map((type) => ({ type, params: {} }))]
    const views = cand.filter((p) => {
      const def = getView(p.type)
      if (!launchable(p, def)) return false
      // 同一种 entity 视图开两份不同的文件算两项(配方里并排两张多维表)
      const key = `${p.type}\n${def?.idParam ? String(p.params?.[def.idParam] ?? '') : ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    if (views.length) tiles.push({ space, views })
  }
  return { tiles, free: pluginViewTypes.filter((t) => !claimed.has(pidOf(t))) }
}
