export interface GraphIdentityNode { path: string; ghost?: boolean }
export interface GraphIdentityEdge { a: number; b: number }

/** 与节点当前坐标/速度/数组顺序无关的拓扑指纹。自动保存只改版本号时指纹不变,
 *  局部关系图据此沿用已经冷却的布局,不再每 800ms 从圆环重新抖一遍。 */
export function graphTopology(
  nodes: GraphIdentityNode[],
  edges: GraphIdentityEdge[],
): string {
  const id = (n: GraphIdentityNode): string => `${n.ghost ? 'g:' : ''}${n.path}`
  const ids = nodes.map(id).sort()
  const links = edges.map((e) => {
    const a = id(nodes[e.a])
    const b = id(nodes[e.b])
    return a < b ? `${a}>${b}` : `${b}>${a}`
  }).sort()
  return `${ids.join('|')}::${links.join('|')}`
}
