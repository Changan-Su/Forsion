import { describe, expect, it } from 'vitest'
import { identitySig, panelFilePath } from './types'

// 「同一个 tab 里换了一个文件」必须体现在指纹上 —— mainTabs 的比对靠它,
// 导航历史/最近使用两条订阅又靠 mainTabs 的引用变化(2026-08-20 用户实报「前进后退无法识别」)。
describe('identitySig', () => {
  it('换文件 → 指纹变(pdf/db/图片/白板/插件文件同理)', () => {
    expect(identitySig({ __type: 'amadeus-pdf', pdfPath: 'a.pdf' }))
      .not.toBe(identitySig({ __type: 'amadeus-pdf', pdfPath: 'b.pdf' }))
    expect(identitySig({ notePath: 'A.md' })).not.toBe(identitySig({ notePath: 'B.md' }))
  })

  it('只认身份参数:非身份参数变了不算跳转(免得每次无关刷新都惊动订阅方)', () => {
    expect(identitySig({ pdfPath: 'a.pdf', page: 2 })).toBe(identitySig({ pdfPath: 'a.pdf', page: 9 }))
  })

  it('键序无关', () => {
    expect(identitySig({ sessionId: 's1', notePath: 'A.md' })).toBe(identitySig({ notePath: 'A.md', sessionId: 's1' }))
  })

  it('没有身份参数的视图(日历/启动器)= 空指纹', () => {
    expect(identitySig({ __type: 'calendar' })).toBe('')
  })
})

// 「这个标签是哪个文件」:侧栏对话的默认引用靠它。只认 notePath / path 时,PDF、图片这些标签在外面看来没有文件
// (2026-10-13 用户实报:侧栏对话引用不到眼前的 PDF)。
describe('panelFilePath', () => {
  it('各种文件视图都报得出自己的文件', () => {
    expect(panelFilePath({ __type: 'amadeus-editor', notePath: 'A.md' })).toBe('A.md')
    expect(panelFilePath({ __type: 'wsfile', path: '/p/README.md', name: 'README.md' })).toBe('/p/README.md')
    expect(panelFilePath({ __type: 'amadeus-pdf', pdfPath: 'docs/a.pdf', page: 3 })).toBe('docs/a.pdf')
    expect(panelFilePath({ __type: 'amadeus-plugin-file', filePath: 'docs/a.pdf' })).toBe('docs/a.pdf')
    expect(panelFilePath({ __type: 'amadeus-image', imagePath: 'img/x.png' })).toBe('img/x.png')
  })

  it('没有文件的视图 = undefined;空串不算', () => {
    expect(panelFilePath({ __type: 'calendar' })).toBeUndefined()
    expect(panelFilePath({ __type: 'chat', sessionId: 's1' })).toBeUndefined()
    expect(panelFilePath({ __type: 'amadeus-editor', notePath: '' })).toBeUndefined()
  })
})
