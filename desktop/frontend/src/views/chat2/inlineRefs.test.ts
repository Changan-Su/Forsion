import { describe, expect, it } from 'vitest'
import { expandRuns, findRuns, inlineRun, plainRuns, runName, runTouching, trimDraftEnd, RUN_LEAD, RUN_TAIL } from './inlineRefs'

const known = (names: string[]) => (n: string): boolean => names.includes(n)

describe('行内引用段', () => {
  it('写进去再找出来;名字里带空格和中文', () => {
    const text = `把 ${inlineRun('Linear – Pricing')} 整理进 ${inlineRun('竞品对比.numbers')}`
    const runs = findRuns(text, known(['Linear – Pricing', '竞品对比.numbers']))
    expect(runs.map((r) => r.name)).toEqual(['Linear – Pricing', '竞品对比.numbers'])
    expect(text.slice(runs[0].start, runs[0].end)).toBe(inlineRun('Linear – Pricing'))
  })
  it('不认得的名字、被改坏的段都不算', () => {
    const run = inlineRun('a.ts')
    expect(findRuns(`x ${run}`, known([]))).toEqual([])
    expect(findRuns(`x ${run.slice(0, -1)}`, known(['a.ts']))).toEqual([]) // 少了尾部边界
    expect(findRuns(`x ${run.slice(1)}`, known(['a.ts']))).toEqual([])     // 少了一个前导空格
    expect(findRuns('普通文字', known(['a.ts']))).toEqual([])
  })
  it('名字里的边界字符和换行被换掉,段不会被自己拆坏', () => {
    const name = runName(`a${RUN_TAIL}b\nc${RUN_LEAD}d`)
    expect(name).toBe('a b c d')
    expect(findRuns(inlineRun(name), known([name]))).toHaveLength(1)
  })
  it('退格看左边、Delete 看右边;段外不动', () => {
    const text = `ab${inlineRun('X')}cd`
    const runs = findRuns(text, known(['X']))
    const { start, end } = runs[0]
    expect(runTouching(runs, end, 'back')).toBe(runs[0])
    expect(runTouching(runs, start, 'back')).toBeUndefined()
    expect(runTouching(runs, start, 'fwd')).toBe(runs[0])
    expect(runTouching(runs, end, 'fwd')).toBeUndefined()
    expect(runTouching(runs, start + 2, 'back')).toBe(runs[0]) // 光标落在段里
    expect(runTouching(runs, end + 1, 'back')).toBeUndefined()
  })
  it('发送时换成 token,记下用掉了哪些名字;对不上的原样留下', () => {
    const text = `把 ${inlineRun('A')} 和 ${inlineRun('B')} 和 ${inlineRun('A')}`
    const r = expandRuns(text, (n) => (n === 'A' ? '[[app://com.a|A]]' : undefined))
    expect(r.text).toBe(`把 [[app://com.a|A]] 和 ${inlineRun('B')} 和 [[app://com.a|A]]`)
    expect([...r.used]).toEqual(['A'])
    expect(expandRuns('没有段', () => 'x')).toEqual({ text: '没有段', used: new Set() })
  })
  it('摘掉引用:段还原成普通文字,别的段不动', () => {
    const text = `看 ${inlineRun('A')} 和 ${inlineRun('B')}`
    expect(plainRuns(text, 'A')).toBe(`看 A 和 ${inlineRun('B')}`)
  })
  it('⚠️ 两种边界空格会被 String.trim 吃掉:调用方必须先 expandRuns 再 trim', () => {
    expect(inlineRun('A').trim()).toBe('A')
  })
})

describe('评审补的三条', () => {
  it('名字归一化是幂等的:第 80 个字正好是空格、名字里有表情都一样', () => {
    for (const name of ['a'.repeat(79) + ' suffix', 'a'.repeat(79) + '😀xx', '  两头有空格  ']) {
      expect(runName(runName(name))).toBe(runName(name))
      expect(findRuns(inlineRun(name), (n) => n === runName(name))).toHaveLength(1)
    }
    expect(() => encodeURIComponent(runName('a'.repeat(79) + '😀xx'))).not.toThrow() // 没有切出半个字符
  })
  it('80 个表情的名字也认得出(正则按码点数,不按 UTF-16 长度)', () => {
    const name = '😀'.repeat(80)
    expect(findRuns(`看 ${inlineRun(name)}`, (n) => n === name)).toHaveLength(1)
  })
  it('往草稿后面接东西前去尾空白:普通空格换行去掉,结尾那段行内引用的边界留着', () => {
    const draft = `看 ${inlineRun('A')}`
    expect(trimDraftEnd(`${draft} \n `)).toBe(draft)
    expect(findRuns(trimDraftEnd(draft) + ' 接着说', (n) => n === 'A')).toHaveLength(1)
    expect(draft.replace(/\s+$/, '')).not.toBe(draft) // 对照:直接 /\s+$/ 会把边界吃掉
  })
})
