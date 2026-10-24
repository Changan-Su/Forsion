import { describe, expect, it, vi } from 'vitest'
import { catAt, contentNeedle, debouncedSearch, hitSlices, lastTurns, posOnArrow } from './quickFind'

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

// 「对话内容」一段(10-24 借鉴 Comma §2.8):2–128 字、停手 180ms 再搜、换词 abort 上一次、命中处切片。
describe('contentNeedle', () => {
  it('不到 2 个字不搜;两个字的中文词能搜', () => {
    expect(contentNeedle('')).toBeNull()
    expect(contentNeedle(' 签 ')).toBeNull()
    expect(contentNeedle('签名')).toBe('签名')
    expect(contentNeedle('😀')).toBeNull() // 一个码点 = 一个字(UTF-16 长度是 2)
  })
  it('超过 128 字截到 128,按码点截不劈代理对', () => {
    expect([...contentNeedle('字'.repeat(300))!]).toHaveLength(128)
    const emo = contentNeedle('😀'.repeat(200))!
    expect([...emo]).toHaveLength(128)
    expect(() => encodeURIComponent(emo)).not.toThrow()
  })
})

describe('debouncedSearch', () => {
  it('停手 180ms 才搜一次,只搜最后那个词', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn(async (q: string) => [q])
      const got: string[] = []
      const s = debouncedSearch(run, (q) => got.push(q))
      s.set('签名'); vi.advanceTimersByTime(100)
      s.set('签名证'); vi.advanceTimersByTime(179)
      expect(run).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(run).toHaveBeenCalledTimes(1)
      expect(run.mock.calls[0][0]).toBe('签名证')
      await vi.runAllTimersAsync()
      expect(got).toEqual(['签名证'])
    } finally { vi.useRealTimers() }
  })
  it('换词 abort 已发出去的那次,晚到的旧结果不落地;null = 不搜', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const resolvers: Array<() => void> = []
      const run = vi.fn((q: string, signal: AbortSignal) => { signals.push(signal); return new Promise<string>((r) => resolvers.push(() => r(q))) })
      const got: string[] = []
      const s = debouncedSearch(run, (q) => got.push(q))
      s.set('第一'); vi.advanceTimersByTime(180)
      s.set('第二')
      expect(signals[0].aborted).toBe(true)
      vi.advanceTimersByTime(180)
      resolvers[0](); resolvers[1]()
      await vi.runAllTimersAsync()
      expect(got).toEqual(['第二'])
      s.set(null); vi.advanceTimersByTime(500)
      expect(run).toHaveBeenCalledTimes(2)
      expect(signals[1].aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })
})

describe('hitSlices', () => {
  const marked = (text: string, q: string) => hitSlices(text, q).map((x) => (x.hit ? `[${x.s}]` : x.s)).join('')
  it('每处命中都切出来,不分大小写,原文大小写保留', () => {
    expect(marked('Signing 证书, signing again', 'signing')).toBe('[Signing] 证书, [signing] again')
  })
  it('多个词各自命中;成对引号算一个短语', () => {
    expect(marked('安卓签名证书快过期了', '签名 过期')).toBe('安卓[签名]证书快[过期]了')
    expect(marked('release prep and prep release', '"release prep"')).toBe('[release prep] and prep release')
  })
  it('正则字符当普通字;没命中 / 空查询原样一截', () => {
    expect(marked('a+b (c) a.b', 'a+b (c)')).toBe('[a+b] [(c)] a.b')
    expect(hitSlices('abc', 'zz')).toEqual([{ s: 'abc', hit: false }])
    expect(hitSlices('abc', '  ')).toEqual([{ s: 'abc', hit: false }])
  })
})

describe('lastTurns', () => {
  it('留最后 3 轮的提问与回答,只调工具不说话的过程消息不算', () => {
    const m = (id: string, role: string, content: string | null) => ({ id, role, content })
    const msgs = [m('u1', 'user', 'q1'), m('a1', 'model', 'r1'), m('u2', 'user', 'q2'), m('t2', 'model', null), m('a2', 'model', 'r2'),
      m('u3', 'user', 'q3'), m('a3', 'model', 'r3'), m('u4', 'user', 'q4'), m('x', 'tool', 'out'), m('a4', 'model', 'r4')]
    expect(lastTurns(msgs).map((x) => x.id)).toEqual(['u2', 'a2', 'u3', 'a3', 'u4', 'a4'])
    expect(lastTurns(msgs.slice(0, 2)).map((x) => x.id)).toEqual(['u1', 'a1'])
  })
})
