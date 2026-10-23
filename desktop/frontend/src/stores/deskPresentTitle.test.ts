import { describe, expect, it } from 'vitest'
import { registerView } from '@lcl/engine/viewRegistry'
import { useApp } from './appStore'
import '../tangu/store/standalone' // 测试不走 activateTangu:自己装 Tangu 的 store 半身(界面热更新 3c)

// 插件自己摆上 Desk 的视图(computer-use 第一次动手时)不带 name:卡片标题要用注册的视图标题,不能露出类型名。
describe('deskPresent view title', () => {
  it('falls back to the registered display name, then to the type', () => {
    registerView({ type: 'plugin:demo:live', displayName: () => 'Controlled window', factory: () => null })
    useApp.setState({ desktopConfig: { agentDeskEnabled: true } as never })
    useApp.getState().deskPresent('s1', { views: [{ type: 'view', view: 'plugin:demo:live' }, { type: 'view', view: 'plugin:demo:missing' }] })
    const items = useApp.getState().deskBySession.s1.items
    expect(items.map((x) => x.name)).toEqual(['Controlled window', 'plugin:demo:missing'])
    useApp.getState().deskPresent('s2', { views: [{ type: 'view', view: 'plugin:demo:live', name: 'Mine' }] })
    expect(useApp.getState().deskBySession.s2.items[0].name).toBe('Mine')
  })
})
