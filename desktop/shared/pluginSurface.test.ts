import { describe, expect, it } from 'vitest'
import { acceptPluginSurface, isLoopbackHttpUrl, pluginSurfacePartitionFor, surfaceNavigationAllowed } from './pluginSurface'

describe('pluginSurface', () => {
  it('只认本机的 http(s)', () => {
    expect(isLoopbackHttpUrl('http://127.0.0.1:5173/?token=x')).toBe(true)
    expect(isLoopbackHttpUrl('http://localhost:80/')).toBe(true)
    expect(isLoopbackHttpUrl('http://[::1]:9/')).toBe(true)
    expect(isLoopbackHttpUrl('http://127.0.0.1@evil.com/')).toBe(false)
    expect(isLoopbackHttpUrl('https://example.com/')).toBe(false)
    expect(isLoopbackHttpUrl('file:///etc/passwd')).toBe(false)
    expect(isLoopbackHttpUrl('javascript:alert(1)')).toBe(false)
  })

  it('分区名插件 id 打头,插件给的名字只当后缀', () => {
    expect(pluginSurfacePartitionFor('dsh2forsion', 'persist:dsh2forsion')).toBe('persist:plugin-surface-dsh2forsion')
    expect(pluginSurfacePartitionFor('dsh2forsion', 'Work Bench!')).toBe('persist:plugin-surface-dsh2forsion-work-bench')
    expect(pluginSurfacePartitionFor('market-1F2E')).toBe('persist:plugin-surface-market-1f2e')
  })

  it('主进程只给名字对、首个地址是本机的', () => {
    expect(acceptPluginSurface('persist:plugin-surface-dsh2forsion', 'http://127.0.0.1:4000/')).toBe('persist:plugin-surface-dsh2forsion')
    expect(acceptPluginSurface('persist:plugin-surface-dsh2forsion', 'https://example.com/')).toBeNull()
    expect(acceptPluginSurface('persist:forsion-browser', 'http://127.0.0.1:4000/')).toBeNull()
    expect(acceptPluginSurface('persist:plugin-surface-../x', 'http://127.0.0.1:4000/')).toBeNull()
    expect(acceptPluginSurface(undefined, 'http://127.0.0.1:4000/')).toBeNull()
  })

  it('页面自己跳只许同源', () => {
    expect(surfaceNavigationAllowed('http://127.0.0.1:4000/a', 'http://127.0.0.1:4000/b?x=1')).toBe(true)
    expect(surfaceNavigationAllowed('http://127.0.0.1:4000/a', 'http://127.0.0.1:4001/b')).toBe(false)
    expect(surfaceNavigationAllowed('http://127.0.0.1:4000/a', 'https://github.com/')).toBe(false)
    expect(surfaceNavigationAllowed('', 'http://127.0.0.1:4000/')).toBe(true) // 首个地址的 302
    expect(surfaceNavigationAllowed('', 'https://github.com/')).toBe(false)
    expect(surfaceNavigationAllowed('https://github.com/', 'http://127.0.0.1:4000/')).toBe(false)
  })
})
