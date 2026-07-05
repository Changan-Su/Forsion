import { describe, it, expect } from 'vitest'
import {
  saveLayout,
  loadLayout,
  clearLayout,
  saveNamedLayout,
  loadNamedLayout,
  listNamedLayouts,
  deleteNamedLayout,
  migrateLegacyLayout,
  LAYOUT_KEY,
  LEGACY_LAYOUT_KEY,
  type KV,
} from './layoutPersist'
import { nextPanelId } from './workspaceStore'

/** 内存版 Storage stub(node 环境,无 localStorage)。 */
function memKV(): KV {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  }
}

// 模拟 Dockview api.toJSON() 形状的布局 blob。
const dockviewBlob = {
  grid: { root: { type: 'branch', data: [] }, width: 1200, height: 800, orientation: 'HORIZONTAL' },
  panels: {
    sessions: { id: 'sessions', contentComponent: 'sessions', params: { __type: 'sessions', __loc: 'left' } },
    chat: { id: 'chat', contentComponent: 'chat', params: { sessionId: 's1', __type: 'chat', __loc: 'main' } },
    files: { id: 'files', contentComponent: 'files', params: { __type: 'files', __loc: 'right' } },
  },
  activeGroup: 'g1',
}
const sampleBlob = {
  version: 4 as const,
  dockview: dockviewBlob,
  sidebars: {
    left: { visible: true, stash: [] },
    right: { visible: false, stash: [{ type: 'files', params: {} }] },
  },
}

describe('layoutPersist', () => {
  it('saveLayout → loadLayout 往返保真', () => {
    const kv = memKV()
    expect(loadLayout(kv)).toBeNull()
    saveLayout(sampleBlob, kv)
    expect(loadLayout(kv)).toEqual(sampleBlob)
    expect(loadLayout(kv)?.sidebars.right).toEqual(sampleBlob.sidebars.right)
  })

  it('分屏 id 扫描现有 panel，跳过重启前留下的编号', () => {
    expect(nextPanelId(['chat', 'chat#1', 'chat#2', 'files'], 'chat')).toBe('chat#3')
    expect(nextPanelId(['chat', 'chat#2'], 'chat')).toBe('chat#1')
  })

  it('损坏 JSON → loadLayout 返回 null,不抛', () => {
    const kv = memKV()
    kv.setItem(LAYOUT_KEY, '{ not json')
    expect(loadLayout(kv)).toBeNull()
  })

  it('v3 完整三栏可迁移到 v4 envelope', () => {
    const kv = memKV()
    kv.setItem(LEGACY_LAYOUT_KEY, JSON.stringify(dockviewBlob))
    const loaded = loadLayout(kv)
    expect(loaded?.version).toBe(4)
    expect(loaded?.dockview).toEqual(dockviewBlob)
    expect(loaded?.sidebars.left.visible).toBe(true)
  })

  it('v3 缺侧栏视为有损布局并回退默认', () => {
    const onlyMain = { ...dockviewBlob, panels: { chat: dockviewBlob.panels.chat } }
    expect(migrateLegacyLayout(onlyMain)).toBeNull()
  })

  it('clearLayout 清除', () => {
    const kv = memKV()
    saveLayout(sampleBlob, kv)
    clearLayout(kv)
    expect(loadLayout(kv)).toBeNull()
  })

  it('命名布局 增 / 取 / 列 / 删 往返', () => {
    const kv = memKV()
    expect(listNamedLayouts(kv)).toEqual({})
    saveNamedLayout('writing', sampleBlob, kv)
    saveNamedLayout('review', { ...sampleBlob, dockview: { ...dockviewBlob, activeGroup: 'g2' } }, kv)
    expect(Object.keys(listNamedLayouts(kv)).sort()).toEqual(['review', 'writing'])
    expect(loadNamedLayout('writing', kv)).toEqual(sampleBlob)
    expect(loadNamedLayout('missing', kv)).toBeNull()
    deleteNamedLayout('writing', kv)
    expect(loadNamedLayout('writing', kv)).toBeNull()
    expect(Object.keys(listNamedLayouts(kv))).toEqual(['review'])
  })
})
