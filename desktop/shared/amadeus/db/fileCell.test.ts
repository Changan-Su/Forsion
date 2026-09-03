import { describe, expect, it } from 'vitest'
import { addFileRefs, fileRefs, removeFileAt } from './fileCell'

describe('fileRefs(两形态都认)', () => {
  it('旧单值 string / 新 string[] 都读得出;空与脏值一律空表', () => {
    expect(fileRefs('a.png')).toEqual(['a.png'])
    expect(fileRefs(['a.png', 'b.pdf'])).toEqual(['a.png', 'b.pdf'])
    expect(fileRefs('')).toEqual([])
    expect(fileRefs(null)).toEqual([])
    expect(fileRefs(undefined)).toEqual([])
    expect(fileRefs([])).toEqual([])
    expect(fileRefs(42)).toEqual([])
    expect(fileRefs(true)).toEqual([])
    expect(fileRefs(['a.png', '', 'b.pdf'])).toEqual(['a.png', 'b.pdf']) // 数组里的空串是脏值
  })

  it('往返:旧单值不被改写(读出来再写回去还是同一组引用)', () => {
    const legacy = '.amadeus/发票.pdf'
    expect(fileRefs(legacy)).toEqual([legacy])
    expect(addFileRefs(legacy, [])).toEqual([legacy]) // 升格成数组但内容一致
  })
})

describe('addFileRefs(上传 = 追加,不是替换)', () => {
  it('旧单值上追加 → 数组,原引用在前', () => {
    expect(addFileRefs('a.png', ['b.pdf'])).toEqual(['a.png', 'b.pdf'])
  })
  it('数组上追加多个 → 一次写完(不是逐个)', () => {
    expect(addFileRefs(['a.png'], ['b.pdf', 'c.png'])).toEqual(['a.png', 'b.pdf', 'c.png'])
  })
  it('空格子上追加 → 数组', () => {
    expect(addFileRefs(undefined, ['a.png'])).toEqual(['a.png'])
    expect(addFileRefs('', ['a.png'])).toEqual(['a.png'])
  })
  it('空 ref 被丢掉', () => {
    expect(addFileRefs('a.png', ['', 'b.pdf'])).toEqual(['a.png', 'b.pdf'])
  })
})

describe('removeFileAt(删单个,只清引用)', () => {
  it('多附件删中间一个,顺序不变', () => {
    expect(removeFileAt(['a.png', 'b.pdf', 'c.png'], 1)).toEqual(['a.png', 'c.png'])
  })
  it('同名重复项按下标删,不会一次抹掉两条', () => {
    expect(removeFileAt(['a.png', 'a.png'], 0)).toEqual(['a.png'])
  })
  it('删到空 → undefined(删键,不是 [] 也不是 "")', () => {
    expect(removeFileAt(['a.png'], 0)).toBeUndefined()
    expect(removeFileAt('a.png', 0)).toBeUndefined() // 旧单值清空同款
  })
  it('留一个时保持数组形态,不塌回字符串', () => {
    const r = removeFileAt(['a.png', 'b.pdf'], 1)
    expect(Array.isArray(r)).toBe(true)
    expect(r).toEqual(['a.png'])
  })
  it('越界下标 = no-op(不误删)', () => {
    expect(removeFileAt(['a.png', 'b.pdf'], 5)).toEqual(['a.png', 'b.pdf'])
    expect(removeFileAt(['a.png'], -1)).toEqual(['a.png'])
    expect(removeFileAt(undefined, 0)).toBeUndefined()
  })
})
