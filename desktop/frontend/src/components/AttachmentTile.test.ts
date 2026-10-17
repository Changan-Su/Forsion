import { describe, expect, it } from 'vitest'
import { splitName } from './AttachmentTile'

describe('splitName(附件磁贴文件名中间省略)', () => {
  it('短名不拆', () => {
    expect(splitName('a.png')).toEqual(['a.png', ''])
    expect(splitName('report12.xlsx')).toEqual(['report12.xlsx', ''])
  })
  it('长名留扩展名和它前面四个字', () => {
    expect(splitName('周报发送记录-2026年10月第三周-团队汇总版.xlsx')).toEqual(['周报发送记录-2026年10月第三周-团', '队汇总版.xlsx'])
    expect(splitName('quarterly-report-final.pdf')).toEqual(['quarterly-report-f', 'inal.pdf'])
  })
  it('没有扩展名 / 点开头', () => {
    expect(splitName('README-for-everyone')).toEqual(['README-for-ever', 'yone'])
    expect(splitName('.environment-local')).toEqual(['.environment-l', 'ocal'])
  })
  it('按码点切,不把表情劈成两半', () => {
    const [head, tail] = splitName('旅行照片😀😀😀😀合集.zip')
    expect(head + tail).toBe('旅行照片😀😀😀😀合集.zip')
    expect(tail).toBe('😀😀合集.zip')
  })
})
