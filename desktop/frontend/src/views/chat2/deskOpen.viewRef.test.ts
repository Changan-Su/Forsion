import { beforeAll, describe, expect, it } from 'vitest'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { deskItemFile, deskViewRef } from './deskOpen'

// 插件文件类型:思维导图认领 .mindmap.md(真插件表,不 mock)
beforeAll(() => { usePluginStore.setState({ fileTypes: [{ pluginId: 'mindmap', item: { extensions: ['.mindmap.md'] } }] } as never) })
type Item = Parameters<typeof deskViewRef>[0]
const item = (x: Partial<Item>): Item => ({ key: 'k', path: '', name: '', at: 0, ...x } as Item)

// 11-23 Desk 标签栏互通:拆分 / 新窗口 / 拖出去先算「这一样在主区开成什么」。Codex 评审抓到的几条钉在这里。
describe('deskViewRef', () => {
  it('Agent 直接给的笔记编辑器指着 .db / 插件文件类型:按文件重新分派,不进笔记编辑器', () => {
    expect(deskViewRef(item({ view: { type: 'amadeus-editor', params: { notePath: 'data/tasks.db' } } }), null))
      .toEqual({ type: 'amadeus-db', params: { dbPath: 'data/tasks.db' } })
    expect(deskViewRef(item({ view: { type: 'amadeus-editor', params: { notePath: 'maps/计划.mindmap.md' } } }), null))
      .toEqual({ type: 'amadeus-plugin-file', params: { filePath: 'maps/计划.mindmap.md' } })
    expect(deskViewRef(item({ view: { type: 'amadeus-editor', params: { notePath: 'notes/a.md' } } }), null))
      .toEqual({ type: 'amadeus-editor', params: { notePath: 'notes/a.md' } })
    // 认不出主区视图的(.csv):不给拆分 / 新窗口
    expect(deskViewRef(item({ view: { type: 'amadeus-editor', params: { notePath: 'data/t.csv' } } }), null)).toBeNull()
  })

  it('库内文件按「打开」的分派;库外 / 开不成标签的 = 通用预览', () => {
    expect(deskViewRef(item({ path: '/v/notes/a.md', name: 'a.md' }), 'notes/a.md')).toEqual({ type: 'amadeus-editor', params: { notePath: 'notes/a.md' } })
    expect(deskViewRef(item({ path: '/v/site/i.html', name: 'i.html' }), 'site/i.html')).toEqual({ type: 'wsfile', params: { path: '/v/site/i.html', name: 'i.html' } })
    expect(deskViewRef(item({ path: '/p/fetch.ts', name: 'fetch.ts' }), null)).toEqual({ type: 'wsfile', params: { path: '/p/fetch.ts', name: 'fetch.ts' } })
  })

  it('直播格、插件结果卡没有主区对应物', () => {
    expect(deskViewRef(item({ path: '/p/a.md', live: { toolId: 't' } as never }), null)).toBeNull()
    expect(deskViewRef(item({ tool: { callId: 'c' } as never }), null)).toBeNull()
  })
})

describe('deskItemFile', () => {
  it('网页引用的 URL 不算文件(图标走浏览器视图的地球,拖进输入框不带引用)', () => {
    const web = item({ path: 'https://beta.example.com/pricing', view: { type: 'browser', params: { url: 'https://beta.example.com/pricing#:~:text=x', path: 'https://beta.example.com/pricing' } } })
    expect(deskItemFile(web)).toBe('')
  })
  it('视图参数里的文件键', () => {
    expect(deskItemFile(item({ view: { type: 'amadeus-pdf', params: { pdfPath: 'papers/w.pdf', page: 1 } } }))).toBe('papers/w.pdf')
    expect(deskItemFile(item({ view: { type: 'wsfile', params: { path: '/p/fetch.ts', line: 4 } } }))).toBe('/p/fetch.ts')
    expect(deskItemFile(item({ view: { type: 'activity-log' } }))).toBe('')
  })
})
