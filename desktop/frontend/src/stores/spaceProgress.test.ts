import { afterEach, describe, expect, it } from 'vitest'
import { clearSpaceProgressOf, pluginSpaceOwner, setSpaceProgress, useSpaceProgress } from './spaceProgress'

afterEach(() => { pluginSpaceOwner.clear(); useSpaceProgress.setState({ progress: {} }) })

describe('spaceProgress(ctx.app.setSpaceProgress 的底)', () => {
  it('只认插件自己带的 Space;别人的 / 内置的 → false,不画', () => {
    pluginSpaceOwner.set('forsion-penzor', 'forsion-extend')
    expect(setSpaceProgress('other-plugin', 'forsion-penzor', 0.5)).toBe(false)
    expect(setSpaceProgress('forsion-extend', 'tangu', 0.5)).toBe(false)
    expect(useSpaceProgress.getState().progress).toEqual({})
    expect(setSpaceProgress('forsion-extend', 'forsion-penzor', 0.5)).toBe(true)
    expect(useSpaceProgress.getState().progress).toEqual({ 'forsion-penzor': 0.5 })
  })

  it('夹到 0–1;null / 坏值 = 收起;同一个整百分比不重发', () => {
    pluginSpaceOwner.set('s', 'p')
    setSpaceProgress('p', 's', 7)
    expect(useSpaceProgress.getState().progress.s).toBe(1)
    const before = useSpaceProgress.getState().progress
    setSpaceProgress('p', 's', 1.001)
    expect(useSpaceProgress.getState().progress).toBe(before)
    setSpaceProgress('p', 's', Number.NaN)
    expect(useSpaceProgress.getState().progress).toEqual({})
  })

  it('插件拆掉:它的进度环一并收掉,别人的留着', () => {
    pluginSpaceOwner.set('a', 'p1')
    pluginSpaceOwner.set('b', 'p2')
    setSpaceProgress('p1', 'a', 0.3)
    setSpaceProgress('p2', 'b', 0.6)
    clearSpaceProgressOf('p1')
    expect(useSpaceProgress.getState().progress).toEqual({ b: 0.6 })
  })
})
