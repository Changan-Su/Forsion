import { describe, expect, it, vi } from 'vitest'

// 插件文件类型:思维导图认领 .mindmap.md;「默认打开方式」把 PDF 交给了插件时 .pdf 也算被认领(override)。
const claimed = { pdf: false }
vi.mock('@amadeus/plugins/pluginStore', async (orig) => ({
  ...(await orig<typeof import('@amadeus/plugins/pluginStore')>()),
  matchFileType: (p: string) => (/\.mindmap\.md$/i.test(p) || (claimed.pdf && /\.pdf$/i.test(p)) ? { extensions: [] } : undefined),
}))

const { fileViewRef } = await import('./amadeusNav')

// 11-23 Desk 标签栏互通:拆分 / 新窗口先算「会开成哪个视图」。次序必须与 openNote / openFile 一致 ——
// 插件文件类型(.mindmap.md)或 .db 开进笔记编辑器 = 毁档。
describe('fileViewRef', () => {
  it.each([
    ['boards/格局.excalidraw.md', 'amadeus-drawing', { drawingPath: 'boards/格局.excalidraw.md' }],
    ['boards/old.excalidraw', 'amadeus-drawing', { drawingPath: 'boards/old.excalidraw' }],
    ['home.dashboard.md', 'dashboard', { dashPath: 'home.dashboard.md' }],
    ['data/tasks.db', 'amadeus-db', { dbPath: 'data/tasks.db' }],
    ['papers/白皮书.pdf', 'amadeus-pdf', { pdfPath: 'papers/白皮书.pdf' }],
    ['img/logo.png', 'amadeus-image', { imagePath: 'img/logo.png' }],
    ['media/clip.mp4', 'amadeus-media', { path: 'media/clip.mp4' }],
    ['maps/计划.mindmap.md', 'amadeus-plugin-file', { filePath: 'maps/计划.mindmap.md' }],
    ['notes/定价调研.md', 'amadeus-editor', { notePath: 'notes/定价调研.md' }],
  ])('%s → %s', (path, type, params) => {
    expect(fileViewRef(path)).toEqual({ type, params })
  })

  it('本地 .html 与没人认领的类型开不成主区标签', () => {
    expect(fileViewRef('site/index.html')).toBeNull()
    expect(fileViewRef('data/table.csv')).toBeNull()
  })

  it('PDF 被插件接管时开插件视图,不进内置阅读器', () => {
    claimed.pdf = true
    try {
      expect(fileViewRef('papers/白皮书.pdf')).toEqual({ type: 'amadeus-plugin-file', params: { filePath: 'papers/白皮书.pdf' } })
    } finally { claimed.pdf = false }
  })
})
