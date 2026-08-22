import { describe, expect, it } from 'vitest'
import { catAt, posOnArrow } from './quickFind'

// 用户给的心智模型(2026-08-20 原话):**分类就像正文后面那几个字** —— 光标是一条线,
// `1 2 3 |笔记 文件 会话`。这组用例逐字钉那条线怎么走。
const at = (start: number, len: number, end = start): { start: number; end: number; len: number } => ({ start, end, len })

describe('posOnArrow', () => {
  it('正文末尾按 → 跨进第一格;再 → 逐格右移;右边到头停住', () => {
    expect(posOnArrow(-1, 'ArrowRight', at(3, 3))).toBe(0) // 「123|」→ 笔记
    expect(posOnArrow(0, 'ArrowRight', at(3, 3))).toBe(1) // 笔记 → 文件
    expect(posOnArrow(1, 'ArrowRight', at(3, 3))).toBe(2) // 文件 → 会话
    expect(posOnArrow(2, 'ArrowRight', at(3, 3))).toBeNull() // 会话到头:停住,不绕圈
  })

  it('分类里按 ← 逐格左移,第一格再按就退回正文(用户实报的那条不对称已消失)', () => {
    expect(posOnArrow(2, 'ArrowLeft', at(3, 3))).toBe(1)
    expect(posOnArrow(1, 'ArrowLeft', at(3, 3))).toBe(0)
    expect(posOnArrow(0, 'ArrowLeft', at(3, 3))).toBe(-1) // 回正文末尾
  })

  it('⚠️ 关键:在分类里按 ← 与光标在正文哪儿无关(不必先回到正文最前面)', () => {
    expect(posOnArrow(1, 'ArrowLeft', at(3, 3))).toBe(0) // 光标在正文末尾
    expect(posOnArrow(1, 'ArrowLeft', at(0, 3))).toBe(0) // 就算在正文开头也一样
  })

  it('正文里:← 永远移光标;→ 只有顶到末尾才跨格', () => {
    expect(posOnArrow(-1, 'ArrowLeft', at(0, 3))).toBeNull()
    expect(posOnArrow(-1, 'ArrowLeft', at(2, 3))).toBeNull()
    expect(posOnArrow(-1, 'ArrowRight', at(1, 3))).toBeNull() // 还在文字中间 → 移光标
  })

  it('选中着一段字(Shift+→ 扩选)不跨格', () => {
    expect(posOnArrow(-1, 'ArrowRight', at(0, 3, 3))).toBeNull()
  })

  it('上下键/其它键不参与', () => {
    expect(posOnArrow(-1, 'ArrowDown', at(3, 3))).toBeNull()
    expect(posOnArrow(1, 'Enter', at(3, 3))).toBeNull()
  })
})

describe('catAt', () => {
  it('-1 = 正文 = 全部;0..2 依次是 笔记/文件/会话', () => {
    expect(catAt(-1)).toBe('all')
    expect(catAt(0)).toBe('note')
    expect(catAt(1)).toBe('file')
    expect(catAt(2)).toBe('session')
  })
})
