/**
 * 版本比较 —— beta 通道的正确性全压在这里。
 * 最要紧的一条是「beta 用户必须能升回正式版」:旧实现按点切开逐段比数字,
 * `parseInt('3-beta')` = 3 会把 2.7.3-beta.1 解析成 [2,7,3,1] 反而比 2.7.3 大,
 * 于是切到测试版的人永远卡在最后一个 beta 上。这条钉死。
 */
import { describe, it, expect } from 'vitest'
import { changelogSection, isNewer, isPrerelease } from './updaterUtil'

describe('isNewer', () => {
  it('正常三段比较', () => {
    expect(isNewer('1.3.10', '1.3.9')).toBe(true)
    expect(isNewer('1.3.9', '1.3.10')).toBe(false)
    expect(isNewer('2.0.0', '1.99.99')).toBe(true)
    expect(isNewer('2.7.2', '2.7.2')).toBe(false)
  })

  it('带 v 前缀与 build 元数据都不影响', () => {
    expect(isNewer('v2.7.3', '2.7.2')).toBe(true)
    expect(isNewer('2.7.3+build.5', '2.7.3')).toBe(false) // build 元数据不参与比较
  })

  it('⚠️ 正式版比同号 prerelease 新(beta 用户能升回正式版)', () => {
    expect(isNewer('2.7.3', '2.7.3-beta.1')).toBe(true)
    expect(isNewer('2.7.3-beta.1', '2.7.3')).toBe(false)
  })

  it('prerelease 之间按标识逐段比', () => {
    expect(isNewer('2.7.3-beta.2', '2.7.3-beta.1')).toBe(true)
    expect(isNewer('2.7.3-beta.1', '2.7.3-beta.2')).toBe(false)
    expect(isNewer('2.7.3-beta.1', '2.7.3-alpha.9')).toBe(true) // 字典序 beta > alpha
    expect(isNewer('2.7.3-beta.1.1', '2.7.3-beta.1')).toBe(true) // 标识多的更新
    expect(isNewer('2.7.3-rc.1', '2.7.3-beta.9')).toBe(true)
  })

  it('数字标识优先级低于非数字标识', () => {
    expect(isNewer('2.7.3-beta', '2.7.3-1')).toBe(true)
    expect(isNewer('2.7.3-1', '2.7.3-beta')).toBe(false)
  })

  it('下一个正式版比当前 beta 新', () => {
    expect(isNewer('2.7.4', '2.7.3-beta.1')).toBe(true)
    expect(isNewer('2.8.0-beta.1', '2.7.3')).toBe(true) // 更高主版本的 beta 仍然更新
  })
})

describe('isPrerelease', () => {
  it('识别预发布', () => {
    expect(isPrerelease('2.7.3-beta.1')).toBe(true)
    expect(isPrerelease('v2.7.3-rc.1')).toBe(true)
    expect(isPrerelease('2.7.3')).toBe(false)
    expect(isPrerelease('2.7.3+build.1')).toBe(false) // build 元数据不是 prerelease
  })
})

describe('changelogSection', () => {
  const md = [
    '# Forsion 更新日志',
    '',
    '## 2.7.4 (2026-07-31)',
    '',
    '- 新功能 A',
    '- 新功能 B',
    '',
    '## 2.7.3 (2026-07-28)',
    '',
    '- 老功能',
    '',
    '## 2.7.2 (2026-07-20)',
    '',
    '- 更老',
  ].join('\n')

  it('取到指定版本那一节(不含标题行、不含下一节)', () => {
    expect(changelogSection(md, '2.7.4')).toBe('- 新功能 A\n- 新功能 B')
    expect(changelogSection(md, '2.7.3')).toBe('- 老功能')
  })

  it('最后一节取到文末', () => {
    expect(changelogSection(md, '2.7.2')).toBe('- 更老')
  })

  it('v 前缀等价', () => {
    expect(changelogSection(md, 'v2.7.4')).toBe('- 新功能 A\n- 新功能 B')
  })

  it('没有该版本 / 空节 → undefined', () => {
    expect(changelogSection(md, '9.9.9')).toBeUndefined()
    expect(changelogSection('## 1.0.0 (x)\n\n## 0.9.0 (y)\n\n- a', '1.0.0')).toBeUndefined()
  })

  it('prerelease 版本号照样能命中', () => {
    const beta = '## 2.7.4-beta.1 (2026-07-30)\n\n- beta 内容\n\n## 2.7.3 (x)\n\n- 老'
    expect(changelogSection(beta, '2.7.4-beta.1')).toBe('- beta 内容')
  })
})
