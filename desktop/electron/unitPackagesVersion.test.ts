/** Unit 宿主装包时的最低版本闸(unit/packages.ts versionAtLeast):与桌面插件门禁同一份版本序。 */
import { describe, expect, it } from 'vitest'
import { versionAtLeast } from '../../unit/packages'

describe('Unit versionAtLeast', () => {
  it('beta 版宿主不满足要正式版的插件;+build.N 有序;前导 v 照认', () => {
    expect(versionAtLeast('2.13.8-beta.3', '2.13.8')).toBe(false)
    expect(versionAtLeast('2.13.8', '2.13.8-beta.3')).toBe(true)
    expect(versionAtLeast('2.14.2', '2.13.8')).toBe(true)
    expect(versionAtLeast('2.13.8', '2.13.8+build.1')).toBe(false)
    expect(versionAtLeast('v2.13.8', '2.13.8')).toBe(true)
  })
  it('写法不完整照旧抛错', () => {
    expect(() => versionAtLeast('2.13', '2.13.8')).toThrow('Invalid semantic version')
    expect(() => versionAtLeast('2.13.8', 'latest')).toThrow('Invalid semantic version')
  })
})
