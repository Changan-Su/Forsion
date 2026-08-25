/** 统一工作区视图的自动模式规则 + 布局迁移(退役视图改名/主区 frame 化)。 */
import { describe, it, expect } from 'vitest'
import { autoWorkspaceMode, workspaceKeyForPath } from './workspaceMode'
import { migrateLayoutBlob } from '@lcl/engine/dockviewStore'
import { ROOTLESS_WORKSPACE_KEY, cloudProjectKey, sessionWorkspaceKey } from '../types'

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
  it('P2 声明位:主视图声明 workspaceSource → 左栏用它,优先于硬规则;右栏仍恒文件', () => {
    expect(autoWorkspaceMode('left', 'plugin:bluebird:video', 'sessions', 'plugin:bluebird:favorites')).toBe('plugin:bluebird:favorites')
    // 声明也可以指内置模式(非插件 view 未来同样能用)
    expect(autoWorkspaceMode('left', 'chat', 'sessions', 'notes')).toBe('notes')
    // 右栏 = 参考栏,不受声明管
    expect(autoWorkspaceMode('right', 'plugin:bluebird:video', 'sessions', 'plugin:bluebird:favorites')).toBe('files')
    // 无声明(undefined/null)→ 原路不变
    expect(autoWorkspaceMode('left', 'chat', 'sessions', null)).toBe('sessions')
  })
  it('Space 默认档缺省 = sessions(没点名的 Space 沿用现状)', () => {
    expect(autoWorkspaceMode('left', 'launcher')).toBe('sessions')
  })
  it('⚠️右栏恒为文件:Space 默认档改不动它(右栏 = 参考/附件栏)', () => {
    expect(autoWorkspaceMode('right', 'launcher', 'notes')).toBe('files')
    expect(autoWorkspaceMode('right', null, 'notes')).toBe('files')
  })
})

describe('workspaceKeyForPath', () => {
  const ws = [
    { key: 'a', path: '/home/me/code' },
    { key: 'b', path: '/home/me/code/forsion' }, // 嵌套在 a 里
    { key: 'c', path: '/home/me/docs/' }, // 尾斜杠
    { key: 'cloud', path: null }, // 云端 Project 没有磁盘路径
  ]
  it('嵌套工作区取最长匹配', () => {
    expect(workspaceKeyForPath(ws, '/home/me/code/forsion/src/x.ts')).toBe('b')
    expect(workspaceKeyForPath(ws, '/home/me/code/other/x.ts')).toBe('a')
  })
  it('⚠️边界必须对齐:/a/bcd 不算落在 /a/bc 里', () => {
    expect(workspaceKeyForPath([{ key: 'x', path: '/a/bc' }], '/a/bcd/f.ts')).toBeNull()
  })
  it('工作区根目录自身算命中;尾斜杠与反斜杠都归一', () => {
    expect(workspaceKeyForPath(ws, '/home/me/code')).toBe('a')
    expect(workspaceKeyForPath(ws, '/home/me/docs/n.md')).toBe('c')
    expect(workspaceKeyForPath([{ key: 'w', path: 'C:\\p\\ws' }], 'C:\\p\\ws\\a\\b.txt')).toBe('w')
  })
  it('认不出来 → null(面板退回按「进入的工作区」置顶)', () => {
    expect(workspaceKeyForPath(ws, '/tmp/x.ts')).toBeNull()
    expect(workspaceKeyForPath(ws, null)).toBeNull()
  })
})

describe('sessionWorkspaceKey', () => {
  it('无根会话有独立分组,不混进历史默认 Cloud Project', () => {
    expect(sessionWorkspaceKey({ projectless: true, project_path: null, project_name: null })).toBe(ROOTLESS_WORKSPACE_KEY)
    expect(sessionWorkspaceKey({ project_path: null, project_name: null })).toBe(cloudProjectKey(null))
  })
  it('本地路径仍优先于 Cloud Project 名', () => {
    expect(sessionWorkspaceKey({ project_path: '/work', project_name: 'Tangu' })).toBe('/work')
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
