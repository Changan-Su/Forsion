// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerView, unregisterView } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { usePageStore } from '@amadeus/store/pageStore'
import { DeskViewPane, deskEditorReroute } from './AgentDesk'

// Agent Desk 防毁档:desk_present 可以给 amadeus-editor + 一份 .db / 插件文件类型 / 白板。格子原样挂 = 笔记编辑器存回那份文件。
// 插件文件类型:思维导图认领 .mindmap.md(真插件表,不 mock,同 deskOpen.viewRef.test.ts)
beforeAll(() => { usePluginStore.setState({ fileTypes: [{ pluginId: 'mindmap', item: { extensions: ['.mindmap.md'] } }] } as never) })
type View = Parameters<typeof deskEditorReroute>[0]
const ed = (notePath: unknown): View => ({ type: 'amadeus-editor', params: { notePath } })

describe('deskEditorReroute', () => {
  it('不是笔记的按文件改道,路径拼成库里的绝对路径', () => {
    for (const rel of ['data/tasks.db', 'maps/计划.mindmap.md', 'boards/格局.excalidraw.md', 'data/t.csv', 'site/index.html', 'papers/a.pdf']) {
      expect(deskEditorReroute(ed(rel), '/v'), rel).toEqual({ path: `/v/${rel}` })
    }
    expect(deskEditorReroute(ed('data/tasks.db'), '/v/'), '库根带尾斜杠').toEqual({ path: '/v/data/tasks.db' })
  })

  it('真笔记、别的视图、没给路径:原样挂', () => {
    expect(deskEditorReroute(ed('notes/定价调研.md'), '/v')).toBeNull()
    // 仪表盘是合法笔记(格子的文件口径也交给笔记编辑器);改道反倒落进通用预览里的 Markdown 编辑器
    expect(deskEditorReroute(ed('home.dashboard.md'), '/v')).toBeNull()
    expect(deskEditorReroute(ed(''), '/v')).toBeNull()
    expect(deskEditorReroute(ed(42), '/v')).toBeNull()
    expect(deskEditorReroute({ type: 'amadeus-editor' }, '/v')).toBeNull()
    expect(deskEditorReroute({ type: 'amadeus-db', params: { dbPath: 'data/tasks.db' } }, '/v')).toBeNull()
    expect(deskEditorReroute({ type: 'activity-log' }, '/v')).toBeNull()
    expect(deskEditorReroute(undefined, '/v')).toBeNull()
  })

  it('库还没就绪:不是笔记的照样不进编辑器(path 为空 = 挂占位)', () => {
    expect(deskEditorReroute(ed('data/tasks.db'), null)).toEqual({ path: null })
    expect(deskEditorReroute(ed('notes/a.md'), null)).toBeNull()
  })

  it('相对路径爬出库外不拼(挂占位);分隔符同编辑器:只有 Windows 库才把 \\ 当分隔符', () => {
    expect(deskEditorReroute(ed('../other/x.db'), '/v')).toEqual({ path: null })
    expect(deskEditorReroute(ed('data/../../x.db'), '/v')).toEqual({ path: null })
    expect(deskEditorReroute(ed('data\\x.db'), 'C:\\v')).toEqual({ path: 'C:\\v/data/x.db' })
    expect(deskEditorReroute(ed('data\\x.db'), '/v')).toEqual({ path: '/v/data\\x.db' })
  })

  it('绝对路径:库内按库内相对路径判(插件文件类型按库内路径认领),库外按后缀判', () => {
    expect(deskEditorReroute(ed('/v/maps/计划.mindmap.md'), '/v')).toEqual({ path: '/v/maps/计划.mindmap.md' })
    expect(deskEditorReroute(ed('/v/notes/a.md'), '/v')).toBeNull()
    expect(deskEditorReroute(ed('/elsewhere/x.db'), '/v')).toEqual({ path: '/elsewhere/x.db' })
    expect(deskEditorReroute(ed('C:\\v\\data\\x.db'), 'C:\\v')).toEqual({ path: 'C:\\v\\data\\x.db' })
  })
})

// 格子真挂了什么:注册表里放几个打桩视图,渲染 DeskViewPane 看落进哪个
describe('DeskViewPane', () => {
  const STUBS = ['amadeus-editor', 'amadeus-db', 'amadeus-drawing', 'amadeus-plugin-file']
  beforeAll(() => {
    for (const type of STUBS) {
      registerView({ type, displayName: type, factory: ({ params }) => React.createElement('i', { 'data-stub': type }, JSON.stringify(params)) })
    }
    usePageStore.setState({ vaultRoot: '/v' } as never)
  })
  afterAll(() => { for (const type of STUBS) unregisterView(type) })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // 真挂一遍(SSR 读的是 store 初值,库根恒为空):拿出 HTML 后卸掉
  const html = (view: View): string => {
    const el = document.createElement('div'); document.body.append(el)
    const root = createRoot(el)
    act(() => root.render(React.createElement(DeskViewPane, { item: { key: 'k', path: '', name: 'Agent 给的', at: 0, view } })))
    const out = el.innerHTML.replace(/&quot;/g, '"')
    act(() => root.unmount()); el.remove()
    return out
  }

  it('.db → 数据库视图,不挂笔记编辑器', () => {
    const out = html(ed('data/tasks.db'))
    expect(out).toContain('data-stub="amadeus-db"')
    expect(out).toContain('data/tasks.db')
    expect(out).not.toContain('data-stub="amadeus-editor"')
  })

  it('插件文件类型 → 插件文件视图;白板 → 只读预览', () => {
    expect(html(ed('maps/计划.mindmap.md'))).toContain('data-stub="amadeus-plugin-file"')
    const board = html(ed('boards/格局.excalidraw.md'))
    expect(board).toContain('data-stub="amadeus-drawing"')
    expect(board).toContain('"preview":true')
    expect(board).not.toContain('data-stub="amadeus-editor"')
  })

  it('真笔记照旧进笔记编辑器,Agent 给的参数原样带上', () => {
    const out = html({ type: 'amadeus-editor', params: { notePath: 'notes/a.md', extra: 1 } })
    expect(out).toContain('data-stub="amadeus-editor"')
    expect(out).toContain('"extra":1')
  })

  it('库没就绪:挂占位,不挂任何视图', () => {
    usePageStore.setState({ vaultRoot: null } as never)
    try {
      const out = html(ed('data/tasks.db'))
      expect(out).not.toContain('data-stub=')
      expect(out).toContain('tasks.db')
    } finally { usePageStore.setState({ vaultRoot: '/v' } as never) }
  })
})
