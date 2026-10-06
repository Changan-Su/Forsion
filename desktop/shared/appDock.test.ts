import { describe, it, expect } from 'vitest'
import { normalizeDockCandidates, normalizeDockSelection, normalizeDockWindow } from './appDock'

describe('appDock 跨 IPC 数据归一化', () => {
  it('窗口:pid / windowId 必须是正整数,其余字段夹长度、只挑认识的', () => {
    expect(normalizeDockWindow({ pid: 1, windowId: 2, app: 'Notes', title: 't', evil: 1 })).toEqual({ pid: 1, windowId: 2, app: 'Notes', title: 't' })
    expect(normalizeDockWindow({ pid: '1', windowId: 2 })).toBeUndefined()
    expect(normalizeDockWindow({ pid: 1.5, windowId: 2 })).toBeUndefined()
    expect(normalizeDockWindow(null)).toBeUndefined()
    expect(normalizeDockWindow({ pid: 1, windowId: 2, app: 'x'.repeat(500), title: '' })!.app.length).toBe(128)
  })

  it('候选:helper 的 w/h → width/height,坏条目丢掉', () => {
    expect(normalizeDockCandidates({ windows: [{ pid: 1, windowId: 2, app: 'A', title: 'a', x: 1.4, y: 2, w: 300, h: 200, bundleId: 'b' }, { pid: 0 }] }))
      .toEqual([{ pid: 1, windowId: 2, app: 'A', bundleId: 'b', title: 'a', x: 1, y: 2, width: 300, height: 200 }])
    expect(normalizeDockCandidates({})).toEqual([])
  })

  it('选区:空白文本不算有选区;选中项去空、封顶 20 条', () => {
    expect(normalizeDockSelection({ text: '  ', windowTitle: 'w' })).toEqual({ windowTitle: 'w' })
    expect(normalizeDockSelection({ text: 'hi' })).toEqual({ text: 'hi' })
    expect(normalizeDockSelection({ items: Array.from({ length: 30 }, (_, i) => (i % 2 ? `f${i}` : ' ')) }).items).toHaveLength(15)
  })
})
