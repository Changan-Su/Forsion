/** 统一工作区视图的自动模式规则 + 布局迁移(退役视图改名/主区 frame 化)。 */
import { describe, it, expect } from 'vitest'
import { autoWorkspaceMode } from './workspaceMode'
import { migrateLayoutBlob } from '@lcl/engine/dockviewStore'

describe('autoWorkspaceMode', () => {
  it('chat 主视图:左=会话,右=文件', () => {
    expect(autoWorkspaceMode('left', 'chat', 'files')).toBe('sessions')
    expect(autoWorkspaceMode('right', 'chat', 'sessions')).toBe('files')
  })
  it('编辑器主视图:左=笔记,右=文件', () => {
    expect(autoWorkspaceMode('left', 'amadeus-editor', 'sessions')).toBe('notes')
    expect(autoWorkspaceMode('right', 'amadeus-editor', 'sessions')).toBe('files')
  })
  it('⚠️Amadeus 文档家族(图/多维表/PDF)与编辑器同档 → 左=笔记,且不分 Space', () => {
    // 硬规则跨 Space 一致:在 Tangu Space(默认档 sessions)里点开一张图也该回笔记树
    expect(autoWorkspaceMode('left', 'amadeus-drawing', 'sessions')).toBe('notes')
    expect(autoWorkspaceMode('left', 'amadeus-db', 'sessions')).toBe('notes')
    expect(autoWorkspaceMode('left', 'amadeus-pdf', 'sessions')).toBe('notes')
    expect(autoWorkspaceMode('right', 'amadeus-drawing', 'sessions')).toBe('files')
  })
  it('Coding 主视图 → 两侧都是文件(点文件 → 主区代码)', () => {
    expect(autoWorkspaceMode('left', 'code-studio', 'notes')).toBe('files')
    expect(autoWorkspaceMode('right', 'code-studio', 'notes')).toBe('files')
  })
  it('⚠️无硬规则的主视图 → 落本 Space 默认档(不再是「维持上一模式」)', () => {
    expect(autoWorkspaceMode('left', 'launcher', 'notes')).toBe('notes') // Amadeus Space
    expect(autoWorkspaceMode('left', 'agents-detail', 'sessions')).toBe('sessions') // Tangu Space
    expect(autoWorkspaceMode('left', null, 'notes')).toBe('notes') // 主区空着也算
  })
  it('Space 默认档缺省 = sessions(没点名的 Space 沿用现状)', () => {
    expect(autoWorkspaceMode('left', 'launcher')).toBe('sessions')
  })
  it('⚠️右栏恒为文件:Space 默认档改不动它(右栏 = 参考/附件栏)', () => {
    expect(autoWorkspaceMode('right', 'launcher', 'notes')).toBe('files')
    expect(autoWorkspaceMode('right', null, 'notes')).toBe('files')
  })
})

describe('migrateLayoutBlob', () => {
  const blob = () => ({
    dockview: {
      panels: {
        a: { contentComponent: 'chat', params: { __loc: 'main', __type: 'chat' } },
        b: { contentComponent: 'sessions', params: { __loc: 'left', __type: 'sessions' } },
        c: { contentComponent: 'toc', params: { __loc: 'right', __type: 'toc' } },
        d: { contentComponent: 'amadeus-pages', params: { __loc: 'left', __type: 'amadeus-pages' } },
      },
    },
    sidebars: {
      left: { visible: true, stash: [{ type: 'sessions', params: {} }] },
      right: { visible: true, stash: [{ type: 'files', params: {} }, { type: 'memory', params: {} }] },
    },
  })

  it('主区 panel 组件统一为 __frame,__type 保留', () => {
    const b = blob()
    migrateLayoutBlob(b as never)
    expect(b.dockview.panels.a.contentComponent).toBe('__frame')
    expect(b.dockview.panels.a.params.__type).toBe('chat')
  })
  it('退役侧栏视图改名(sessions/toc/amadeus-pages → workspace/outline),stash 同步', () => {
    const b = blob()
    migrateLayoutBlob(b as never)
    expect(b.dockview.panels.b.params.__type).toBe('workspace')
    expect(b.dockview.panels.b.contentComponent).toBe('workspace')
    expect(b.dockview.panels.c.params.__type).toBe('outline')
    expect(b.dockview.panels.d.params.__type).toBe('workspace')
    expect(b.sidebars.left.stash[0].type).toBe('workspace')
    expect(b.sidebars.right.stash.map((v: { type: string }) => v.type)).toEqual(['workspace', 'memory'])
  })
  it('幂等:迁移两次结果一致', () => {
    const b1 = blob()
    migrateLayoutBlob(b1 as never)
    const once = JSON.stringify(b1)
    migrateLayoutBlob(b1 as never)
    expect(JSON.stringify(b1)).toBe(once)
  })
})
