import { describe, expect, it } from 'vitest'
import { CH_GOLDEN, chKeyFrom, chKeyFromHex, encryptLine, newChKeyHex, readChLine } from './computerHistoryCrypto'

/** 引擎镜像(tangu-agent/src/services/computerHistoryCrypto.test.ts)钉的是同一个字面量:两边格式一漂移,两边各红一个。 */
const GOLDEN_LINE =
  'ch1.b40ebba7.oKGio6SlpqeoqaqrnToID3/6NYpbVbfjN0rw7kCcdTL53iwIvjQE5w/bVy3wFzePjRgoHzH9aa0rQKG3KG8jO0D8OBw0MG8ywTnhko6e5gBdi4WQhI6aNsGhuN++KdbZ0NnRdYOE6IHwXILeL+JU8A=='

describe('computerHistoryCrypto', () => {
  const key = chKeyFromHex(CH_GOLDEN.keyHex)!

  it('黄金向量:同钥匙同 iv 同明文 → 逐字节相同的密文行;解回原文', () => {
    expect(key.kid).toBe('b40ebba7')
    expect(encryptLine(key, CH_GOLDEN.json, Buffer.from(CH_GOLDEN.ivHex, 'hex'))).toBe(GOLDEN_LINE)
    expect(readChLine(GOLDEN_LINE, key)).toEqual({ kind: 'enc', text: CH_GOLDEN.json })
  })

  it('随机 iv:同一行两次加密不同,密文里看不到明文的任何片段', () => {
    const a = encryptLine(key, CH_GOLDEN.json)
    const b = encryptLine(key, CH_GOLDEN.json)
    expect(a).not.toBe(b)
    for (const leak of ['Notes', 'com.apple', '"t"', '1759000000000']) expect(a.includes(leak)).toBe(false)
    expect(readChLine(a, key)).toEqual({ kind: 'enc', text: CH_GOLDEN.json })
  })

  it('读失败 ≠ 空:没钥匙 / 别的钥匙 = locked(未知);语法不对 / 认证失败 = broken(残行);{ 开头 = 明文', () => {
    const other = chKeyFromHex(newChKeyHex())!
    expect(readChLine(GOLDEN_LINE, null)).toEqual({ kind: 'locked' })
    expect(readChLine(GOLDEN_LINE, other)).toEqual({ kind: 'locked' })
    // kid 对上了、内容被改:认证失败 → 残行
    const flipped = GOLDEN_LINE.slice(0, -6) + (GOLDEN_LINE.at(-6) === 'A' ? 'B' : 'A') + GOLDEN_LINE.slice(-5)
    expect(readChLine(flipped, key)).toEqual({ kind: 'broken' })
    // 半截写入(切在 base64 里)→ 残行;切在 kid 里 / 与下一行粘在一起 → 语法不对 → 残行(不会被当成「别的钥匙」永远卡住重写)
    expect(readChLine(GOLDEN_LINE.slice(0, 60), key)).toEqual({ kind: 'broken' })
    expect(readChLine('ch1.b40e', key)).toEqual({ kind: 'broken' })
    expect(readChLine(GOLDEN_LINE.slice(0, 50) + GOLDEN_LINE, key)).toEqual({ kind: 'broken' })
    expect(readChLine('garbage', key)).toEqual({ kind: 'broken' })
    expect(readChLine('{"t":1,"kind":"app"}', key)).toEqual({ kind: 'plain', text: '{"t":1,"kind":"app"}' })
    expect(readChLine('{"t":1,"kind":"app"}', null)).toEqual({ kind: 'plain', text: '{"t":1,"kind":"app"}' })
  })

  it('钥匙:32 字节、hex 形状不对 = null(调用方当「拿不到」,不当「没有」)', () => {
    expect(chKeyFromHex('zz'.repeat(32))).toBeNull()
    expect(chKeyFromHex('ab'.repeat(31))).toBeNull()
    expect(chKeyFromHex(undefined)).toBeNull()
    expect(() => chKeyFrom(Buffer.alloc(16))).toThrow()
    expect(newChKeyHex()).toMatch(/^[0-9a-f]{64}$/)
    expect(chKeyFromHex(CH_GOLDEN.keyHex.toUpperCase())?.kid).toBe(key.kid)
  })
})
