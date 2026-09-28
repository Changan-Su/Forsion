import { describe, expect, it } from 'vitest'
import { retargetWikiInner } from './wikiRetarget'

// L-02:已闭合链接里选候选 = 只换目标名。rest = 光标到 `]]` 之间的原文。
describe('retargetWikiInner', () => {
  it('光标在旧名前打字:旧名残余被替换', () => {
    expect(retargetWikiInner('Alpha', 'Beta')).toBe('Beta') // [[Be|Alpha]] → [[Beta]]
  })
  it('删光旧名后重打:没有残余', () => {
    expect(retargetWikiInner('', 'Beta')).toBe('Beta')
  })
  it('保留原别名', () => {
    expect(retargetWikiInner('|al', 'Beta')).toBe('Beta|al')
    expect(retargetWikiInner('pha|al', 'Beta')).toBe('Beta|al')
  })
  it('保留原锚点(与别名)', () => {
    expect(retargetWikiInner('#Sec', 'Beta')).toBe('Beta#Sec')
    expect(retargetWikiInner('Alpha#Sec|al', 'Beta')).toBe('Beta#Sec|al')
  })
  it('重名候选 `dir/Name|Name`:原链接无别名 → 沿用消歧别名,锚点放在别名前', () => {
    expect(retargetWikiInner('', 'a/Beta|Beta')).toBe('a/Beta|Beta')
    expect(retargetWikiInner('#Sec', 'a/Beta|Beta')).toBe('a/Beta#Sec|Beta')
  })
  it('重名候选遇到原链接自带别名 → 用户别名优先,不叠出两个 `|`', () => {
    expect(retargetWikiInner('|al', 'a/Beta|Beta')).toBe('a/Beta|al')
    expect(retargetWikiInner('Alpha#Sec|al', 'a/Beta|Beta')).toBe('a/Beta#Sec|al')
  })
})
