import { describe, expect, it } from 'vitest'
import { graphTopology } from './localGraph'

describe('graphTopology', () => {
  it('忽略布局坐标与节点排列,同一拓扑保持稳定', () => {
    const a = [{ path: 'A.md' }, { path: 'B.md' }, { path: 'missing', ghost: true }]
    const b = [{ path: 'missing', ghost: true }, { path: 'A.md' }, { path: 'B.md' }]
    expect(graphTopology(a, [{ a: 0, b: 1 }, { a: 0, b: 2 }])).toBe(
      graphTopology(b, [{ a: 1, b: 2 }, { a: 1, b: 0 }]),
    )
  })

  it('真实增删链接会改变指纹', () => {
    const nodes = [{ path: 'A.md' }, { path: 'B.md' }, { path: 'C.md' }]
    expect(graphTopology(nodes, [{ a: 0, b: 1 }])).not.toBe(graphTopology(nodes, [{ a: 0, b: 2 }]))
  })
})
