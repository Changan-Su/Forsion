import { describe, expect, it } from 'vitest'
import { upgradeTanguDetailsLayout } from './tanguDetailsLayout'

describe('Tangu details layout migration', () => {
  it('preserves main tabs and replaces old right tabs in both visible and stashed layouts', () => {
    const old: any = { version: 4, sidebars: { left: { visible: true, stash: [] }, right: { visible: true, stash: [{ type: 'chat-panel', params: {} }, { type: 'memory', params: {} }, { type: 'workspace', params: { mode: 'files' } }] } },
      dockview: { panels: { main: { params: { __loc: 'main', __type: 'chat', sessionId: 'keep' } }, chat: { params: { __loc: 'right', __type: 'chat-panel' } }, memory: { params: { __loc: 'right', __type: 'memory' } }, children: { params: { __loc: 'right', __type: 'subchats' } } }, grid: { root: { data: [{ data: { views: ['main'], activeView: 'main' } }, { data: { views: ['chat', 'memory', 'children'], activeView: 'memory' } }] } } } }
    const next = upgradeTanguDetailsLayout(old)
    expect((next.dockview as any).panels.main).toEqual(old.dockview.panels.main)
    expect((next.dockview as any).grid.root.data[1].data).toEqual({ views: ['chat'], activeView: 'chat' })
    expect(next.sidebars.right.stash.map((v) => v.type)).toEqual(['tangu-details', 'workspace'])
    expect(next.sidebars.right.visible).toBe(true)
    expect(old.dockview.panels.memory).toBeDefined()
    expect(upgradeTanguDetailsLayout(next)).toEqual(next)
  })
})
