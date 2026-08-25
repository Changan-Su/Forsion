/** P0 一致性锁:fileMatch 声明表 ↔ 运行时判定(isDrawingPath/isDashboardPath 等 shared 函数)。
 *  声明表是 deep link / 嵌卡的白名单依据;运行时分派另有其主(毁档防线),两边漂移=deep link 开错视图。 */
import { describe, expect, it } from 'vitest'
import { VIEW_FILE_MATCH, extHit, fileMatchViewType } from './viewFileMatch'
import { isDrawingPath } from '@amadeus-shared/excalidraw/format'
import { isDashboardPath } from '@amadeus-shared/dashboard'

describe('viewFileMatch 声明 ↔ 运行时判定一致', () => {
  it('复合后缀:声明的每个 .excalidraw.md/.dashboard.md 样例被 shared 判定函数认领', () => {
    expect(isDrawingPath('笔记/画板.excalidraw.md')).toBe(true)
    expect(isDashboardPath('面板/总览.dashboard.md')).toBe(true)
    // 声明表与判定函数认同一批后缀
    for (const e of VIEW_FILE_MATCH['amadeus-drawing'].extensions) expect(isDrawingPath(`x${e}`)).toBe(true)
    for (const e of VIEW_FILE_MATCH['dashboard'].extensions) expect(isDashboardPath(`x${e}`)).toBe(true)
  })

  it('判定次序=毁档防线:复合后缀绝不落进裸 .md(editor)', () => {
    expect(fileMatchViewType('画板.excalidraw.md')).toBe('amadeus-drawing')
    expect(fileMatchViewType('总览.dashboard.md')).toBe('dashboard') // P3a:归画布版
    expect(fileMatchViewType('普通笔记.md')).toBe('amadeus-editor')
    // shared 判定同样不把复合后缀当笔记
    expect(isDrawingPath('普通笔记.md')).toBe(false)
    expect(isDashboardPath('普通笔记.md')).toBe(false)
  })

  it('单后缀:大小写不敏感,中文路径无碍', () => {
    expect(extHit('文档/论文.PDF', 'amadeus-pdf')).toBe(true)
    expect(extHit('库/数据.db', 'amadeus-db')).toBe(true)
    expect(fileMatchViewType('图/截图.PNG')).toBe('amadeus-image')
    expect(fileMatchViewType('归档.zip')).toBe(null)
  })

  it('.md 的 editor 兜底优先级最低(0),其余声明全部更高', () => {
    for (const [type, m] of Object.entries(VIEW_FILE_MATCH)) {
      if (type === 'amadeus-editor') expect(m.priority).toBe(0)
      else expect(m.priority).toBeGreaterThan(0)
    }
  })
})
