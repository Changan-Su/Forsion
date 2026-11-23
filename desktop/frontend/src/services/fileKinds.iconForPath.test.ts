import { describe, expect, it } from 'vitest'
import { BookOpen, Database, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, FileAudio, LayoutDashboard, PenTool } from 'lucide-react'
import { iconForPath } from './fileKinds'

// 11-23 Desk 标签栏互通方案 ③:名字胶囊 / 库外文件标签按种类给图标。原来 iconForFile('', 名字) 让图片、白板、PDF 都落成一张纸。
describe('iconForPath', () => {
  const rows: Array<[string, unknown]> = [
    ['notes/定价调研.md', FileText],
    ['boards/竞品格局.excalidraw.md', PenTool],
    ['boards/old.excalidraw', PenTool],
    ['home.dashboard.md', LayoutDashboard],
    ['data/tasks.db', Database],
    ['papers/竞品白皮书.pdf', BookOpen],
    ['/Users/x/proj/logo.png', FileImage],
    ['C:\\proj\\shot.JPG', FileImage],
    ['/tmp/clip.mp4', FileVideo],
    ['/tmp/memo.m4a', FileAudio],
    ['/Users/x/proj/data.csv', FileSpreadsheet],
    ['/Users/x/proj/fetch.ts', FileCode],
    ['/Users/x/proj/README', FileText],
  ]
  it.each(rows)('%s', (path, icon) => {
    expect(iconForPath(path)).toBe(icon)
  })
})
