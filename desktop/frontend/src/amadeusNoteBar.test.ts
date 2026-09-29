import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canUploadToNote } from './amadeusNoteBar'

// 评审 C-09:桌面顶栏「上传文件」按 activePage 门控 —— v4 统一页不设 activePage,按钮在每篇 v4 笔记上永远不显示。
describe('upload-to-note entry gate', () => {
  it('shows on a v4 note (no activePage, only the leaf path)', () => {
    expect(canUploadToNote('notes/A.md', false)).toBe(true)
  })
  it('hides when there is no note, the note is locked, or a v4 note is in source mode', () => {
    expect(canUploadToNote(null, false)).toBe(false)
    expect(canUploadToNote('notes/A.md', true)).toBe(false)
    expect(canUploadToNote('notes/A.md', false, true)).toBe(false)
  })
  // 两个入口(桌面顶栏按钮、移动端胶囊「⋯」)都必须走这一个判据:摘掉任一处改回 `activePage &&`,这里就红。
  it('is the gate of both the desktop toolbar button and the mobile capsule action', () => {
    const src = readFileSync(join(__dirname, 'amadeusViews.tsx'), 'utf8')
    expect(src.match(/canUploadToNote\(barPath, lockOn, !!unifiedRoute && mode === 'source'\)/g)?.length).toBe(2)
    const at = src.lastIndexOf("title={t('amxv.uploadToPage')}") // 桌面顶栏那颗(移动端胶囊的图标按钮在前面)
    const btn = src.slice(at - 200, at)
    expect(btn).toContain('canUploadToNote(')
  })
})
