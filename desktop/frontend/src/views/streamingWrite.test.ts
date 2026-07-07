import { describe, it, expect } from 'vitest'
import { parseStreamingWrite, decodeJsonStringAt } from './streamingWrite'

describe('streamingWrite 容错抽取', () => {
  it('完整 args', () => {
    const r = parseStreamingWrite('{"path":"index.html","content":"<h1>hi</h1>"}')
    expect(r.path).toBe('index.html')
    expect(r.content).toBe('<h1>hi</h1>')
  })
  it('截断在 content 中途(流式未闭合)', () => {
    const r = parseStreamingWrite('{"path":"app.js","content":"const a = 1;\\nconst b')
    expect(r.path).toBe('app.js')
    expect(r.content).toBe('const a = 1;\nconst b') // 半截也解出
  })
  it('转义:换行/引号/tab/unicode', () => {
    const r = parseStreamingWrite('{"content":"line1\\nsay \\"hi\\"\\t\\u0041"}')
    expect(r.content).toBe('line1\nsay "hi"\tA')
  })
  it('截断在转义符处不崩', () => {
    expect(parseStreamingWrite('{"content":"ok\\').content).toBe('ok')
    expect(parseStreamingWrite('{"content":"ok\\u00').content).toBe('ok') // 半截 unicode
  })
  it('content 尚未到达 → undefined', () => {
    const r = parseStreamingWrite('{"path":"x.html","con')
    expect(r.path).toBe('x.html')
    expect(r.content).toBeUndefined()
  })
  it('别名 key:file_path / new_str', () => {
    const r = parseStreamingWrite('{"file_path":"a.py","new_str":"print(1)"}')
    expect(r.path).toBe('a.py')
    expect(r.content).toBe('print(1)')
  })
  it('decodeJsonStringAt 直接用', () => {
    expect(decodeJsonStringAt('"ab\\nc"', 0)).toBe('ab\nc')
  })
})
