import { afterEach, describe, expect, it } from 'vitest'
import { clearSpaceProgressOf, pluginSpaceOwner, setSpaceDot, setSpaceProgress, useSpaceProgress } from './spaceProgress'

afterEach(() => { pluginSpaceOwner.clear(); useSpaceProgress.setState({ progress: {}, dot: {} }) })

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

  it('插件拆掉:它的进度环和红点一并收掉,别人的留着', () => {
    pluginSpaceOwner.set('a', 'p1')
    pluginSpaceOwner.set('b', 'p2')
    setSpaceProgress('p1', 'a', 0.3)
    setSpaceProgress('p2', 'b', 0.6)
    setSpaceDot('p1', 'a', true)
    setSpaceDot('p2', 'b', true)
    clearSpaceProgressOf('p1')
    expect(useSpaceProgress.getState().progress).toEqual({ b: 0.6 })
    expect(useSpaceProgress.getState().dot).toEqual({ b: true })
  })

  it('红点:只认自己的 Space;挂上 / 收起;没变不重发', () => {
    pluginSpaceOwner.set('server-admin', 'server-admin-plugin')
    expect(setSpaceDot('other', 'server-admin', true)).toBe(false)
    expect(setSpaceDot('server-admin-plugin', 'inbox', true)).toBe(false)
    expect(useSpaceProgress.getState().dot).toEqual({})
    expect(setSpaceDot('server-admin-plugin', 'server-admin', true)).toBe(true)
    const on = useSpaceProgress.getState().dot
    expect(on).toEqual({ 'server-admin': true })
    setSpaceDot('server-admin-plugin', 'server-admin', 1)
    expect(useSpaceProgress.getState().dot).toBe(on)
    setSpaceDot('server-admin-plugin', 'server-admin', false)
    expect(useSpaceProgress.getState().dot).toEqual({})
  })
})
