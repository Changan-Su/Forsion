import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import type { ViewLocation } from './types'

type Axis = 'horizontal' | 'vertical'
type Box = { width: number; height: number }
export type RegionTree = Box & (
  | { panel: string; instance: IDockviewPanel; loc: ViewLocation }
  | { axis: Axis; children: RegionTree[] }
)
const other = (axis: Axis): Axis => axis === 'horizontal' ? 'vertical' : 'horizontal'

function branch(axis: Axis, input: Array<RegionTree | null>): RegionTree | null {
  const children = input.filter((n): n is RegionTree => !!n)
    .flatMap(n => 'axis' in n && n.axis === axis ? n.children : [n])
  if (!children.length) return null
  if (children.length === 1) return children[0]
  return { axis, children,
    width: axis === 'horizontal' ? children.reduce((sum, n) => sum + n.width, 0) : Math.max(...children.map(n => n.width)),
    height: axis === 'vertical' ? children.reduce((sum, n) => sum + n.height, 0) : Math.max(...children.map(n => n.height)),
  }
}

/** Snapshot the actual split tree, including proportions, before introducing a shell panel.
 * Group IDs may change during a native move; panel IDs and live View instances remain stable. */
export function captureRegionTree(api: DockviewApi): RegionTree | null {
  const grid = api.toJSON().grid
  if (!grid?.root) return null
  const read = (node: typeof grid.root, axis: Axis): RegionTree | null => {
    if (Array.isArray(node.data)) return branch(axis, node.data.map(n => read(n, other(axis))))
    const panel = api.getPanel(node.data.views[0])
    if (!panel) return null
    return { panel: panel.id, instance: panel, loc: panel.params?.__loc ?? 'main',
      width: panel.group.api.width, height: panel.group.api.height }
  }
  return read(grid.root, grid.orientation === 'HORIZONTAL' ? 'horizontal' : 'vertical')
}

function region(tree: RegionTree, loc: ViewLocation): RegionTree | null {
  return 'panel' in tree ? tree.loc === loc ? tree : null
    : branch(tree.axis, tree.children.map(n => region(n, loc)))
}
const first = (tree: RegionTree): string => 'panel' in tree ? tree.panel : first(tree.children[0])
const ids = (tree: RegionTree): string[] => 'panel' in tree ? [tree.panel] : tree.children.flatMap(ids)
const stillLive = (api: DockviewApi, tree: RegionTree): boolean => 'panel' in tree
  ? api.getPanel(tree.panel) === tree.instance : tree.children.every(n => stillLive(api, n))
const signature = (tree: RegionTree): string => 'panel' in tree ? tree.panel
  : `${tree.axis}(${tree.children.map(signature).join(',')})`

/** Restore internal split ratios after shell sizing has settled. Size shallow leaves first:
 * a full-height document sets its ancestor's height, then video/chat divide that height. */
export function restoreRegionProportions(api: DockviewApi, snapshot: RegionTree | null): void {
  const current = captureRegionTree(api)
  if (!current || !snapshot) return
  for (const loc of ['main', 'left', 'right', 'bottom'] as const) {
    const prev = region(snapshot, loc), now = region(current, loc)
    if (!prev || !now || !stillLive(api, prev) || signature(prev) !== signature(now)) continue
    const sizes: Array<Box & { panel: string; depth: number }> = []
    const collect = (node: RegionTree, width: number, height: number, depth: number): void => {
      if ('panel' in node) { sizes.push({ panel: node.panel, width, height, depth }); return }
      const key = node.axis === 'horizontal' ? 'width' : 'height'
      const total = node.children.reduce((sum, n) => sum + n[key], 0) || 1
      node.children.forEach(n => collect(n, key === 'width' ? width * n.width / total : width,
        key === 'height' ? height * n.height / total : height, depth + 1))
    }
    collect(prev, now.width, now.height, 0)
    sizes.sort((a, b) => a.depth - b.depth)
    for (const { panel, width, height } of sizes) api.getPanel(panel)?.group.api.setSize({ width, height })
  }
}

/** Fixed shell topology: left | ((Main | right) / bottom).
 * Each region retains its own arbitrary split subtree. No View is serialized/recreated here:
 * only public Dockview group moves are used, so editor state, drafts and media survive.
 * `before` preserves Main ratios from before Dockview temporarily split one Main leaf to add a side. */
export function alignWorkspaceRegions(api: DockviewApi, before?: RegionTree | null): boolean {
  const current = captureRegionTree(api)
  if (!current) return false
  const pick = (loc: ViewLocation): RegionTree | null => {
    const now = region(current, loc)
    const prev = before && region(before, loc)
    return now && prev && ids(now).sort().join('|') === ids(prev).sort().join('|') ? prev : now
  }
  const main = pick('main')
  if (!main) return false
  const target = branch('horizontal', [pick('left'),
    branch('vertical', [branch('horizontal', [main, pick('right')]), pick('bottom')])])!
  if (signature(current) === signature(target)) return false

  const active = api.activePanel?.id
  const fronts = api.groups.map(g => g.activePanel?.id).filter((id): id is string => !!id)
  const group = (tree: RegionTree) => api.getPanel(first(tree))!.group
  // Start a fresh outer slot, then move existing groups into it. The old slots disappear as
  // their groups leave. Insert siblings before recursing, so splits wrap the correct subtree.
  // A temporary empty anchor avoids moveTo-without-reference, which merges into a new
  // group and disposes the original group (losing group constraints and inactive tab state).
  const anchor = api.addGroup({ direction: 'right', skipSetActive: true })
  group(target).api.moveTo({ group: anchor, position: 'right', skipSetActive: true })
  const place = (node: RegionTree): void => {
    if ('panel' in node) return
    for (let i = 1; i < node.children.length; i++) {
      group(node.children[i]).api.moveTo({ group: group(node.children[i - 1]),
        position: node.axis === 'horizontal' ? 'right' : 'bottom', skipSetActive: true })
    }
    node.children.forEach(place)
  }
  place(target)
  api.removeGroup(anchor)
  restoreRegionProportions(api, target)
  for (const id of fronts) api.getPanel(id)?.api.setActive()
  if (active) api.getPanel(active)?.api.setActive()
  return true
}
