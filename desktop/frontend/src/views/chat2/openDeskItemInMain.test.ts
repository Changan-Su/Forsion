// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 「在主区打开」的视图条目(Human Desk 那张卡在主区找不到标签时在这里开、Agent Desk ⋯ 的新标签页兜底):
// Agent 给成笔记编辑器的 .db / 插件文件 / 白板也按文件重新分派(同格子 DeskViewPane,#848),原样 openView('amadeus-editor') = 毁档。
const nav = vi.hoisted(() => ({ openFile: vi.fn(), openNote: vi.fn() }))
vi.mock('../../amadeusNav', async (orig) => ({ ...(await orig<typeof import('../../amadeusNav')>()), openFile: nav.openFile, openNote: nav.openNote }))

import { useWorkspace } from '@lcl/engine'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { openDeskItemInMain } from './AgentDesk'

const openView = vi.fn()
beforeAll(() => {
  usePluginStore.setState({ fileTypes: [{ pluginId: 'mindmap', item: { extensions: ['.mindmap.md'] } }] } as never)
  useWorkspace.setState({ openView } as never)
})
beforeEach(() => { nav.openFile.mockReset(); nav.openNote.mockReset(); openView.mockReset() })

const viewItem = (notePath: string) => ({ key: 'k', path: '', name: 'Agent 给的', at: 0, view: { type: 'amadeus-editor', params: { notePath } } })
const editorOpened = (): boolean => openView.mock.calls.some((c) => c[0] === 'amadeus-editor') || nav.openNote.mock.calls.length > 0

describe('openDeskItemInMain:Agent 给成笔记编辑器的视图条目', () => {
  it('库里不是笔记的:按那份文件开(Amadeus 的打开),不进笔记编辑器', () => {
    for (const rel of ['数据/任务.db', 'boards/草图.excalidraw.md', 'maps/计划.mindmap.md']) {
      nav.openFile.mockReset(); nav.openNote.mockReset(); openView.mockReset()
      openDeskItemInMain(viewItem(rel), '/v')
      expect(nav.openFile, rel).toHaveBeenCalledWith(rel)
      expect(editorOpened(), rel).toBe(false)
    }
  })

  it('库外的绝对路径:通用预览标签(wsfile)', () => {
    openDeskItemInMain(viewItem('/elsewhere/x.db'), '/v')
    expect(openView).toHaveBeenCalledWith('wsfile', { path: '/elsewhere/x.db', name: 'Agent 给的' }, 'main', { newTab: true })
    expect(editorOpened()).toBe(false)
  })

  it('拼不出路径(库没就绪 / 爬出库外):什么都不开', () => {
    openDeskItemInMain(viewItem('数据/任务.db'), null)
    openDeskItemInMain(viewItem('../other/x.db'), '/v')
    expect(openView).not.toHaveBeenCalled()
    expect(nav.openFile).not.toHaveBeenCalled()
    expect(nav.openNote).not.toHaveBeenCalled()
  })

  it('真笔记、别的视图:照旧原样开(对照)', () => {
    openDeskItemInMain(viewItem('notes/会议.md'), '/v')
    expect(openView).toHaveBeenCalledWith('amadeus-editor', { notePath: 'notes/会议.md' }, 'main', { newTab: true })
    openView.mockReset()
    openDeskItemInMain({ key: 'k2', path: '', name: '活动', at: 0, view: { type: 'activity-log', params: {} } }, '/v')
    expect(openView).toHaveBeenCalledWith('activity-log', {}, 'main', { newTab: true })
  })
})
