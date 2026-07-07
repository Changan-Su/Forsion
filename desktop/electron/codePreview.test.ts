import { describe, it, expect } from 'vitest'
import { resolveSafe, transpileForServe } from './codePreview'

describe('codePreview transpileForServe (按需 JSX/TS 转译)', () => {
  it('transpiles .tsx → ESM,jsx-runtime 自动导入', () => {
    const out = transpileForServe('const A = () => <div className="x">hi</div>; export default A', '.tsx', 'App.tsx')
    expect(out).toContain('react/jsx-runtime') // automatic runtime
    expect(out).not.toContain('<div') // JSX 已转译
    expect(out).toContain('export default A')
  })
  it('strips TS types from .ts', () => {
    const out = transpileForServe('export const n: number = 1', '.ts')
    expect(out).toContain('export const n = 1')
  })
  it('非转译扩展返回 null(原样服务)', () => {
    expect(transpileForServe('body{}', '.css')).toBeNull()
    expect(transpileForServe('<html>', '.html')).toBeNull()
  })
  it('语法错误 → 不抛,返回一段报错 JS(iframe 控制台可见,不白屏)', () => {
    const out = transpileForServe('const = = =', '.tsx', 'bad.tsx')
    expect(out).toContain('console.error')
    expect(out).toContain('transpile error')
  })
})

describe('codePreview resolveSafe (穿越守卫)', () => {
  const root = '/tmp/proj'
  it('serves files inside root', () => {
    expect(resolveSafe(root, '/index.html')).toBe('/tmp/proj/index.html')
    expect(resolveSafe(root, '/sub/app.js')).toBe('/tmp/proj/sub/app.js')
    expect(resolveSafe(root, '/')).toBe('/tmp/proj')
  })
  it('blocks path traversal out of root', () => {
    expect(resolveSafe(root, '/../etc/passwd')).toBeNull()
    expect(resolveSafe(root, '/../../secret')).toBeNull()
    expect(resolveSafe(root, '/sub/../../out')).toBeNull()
  })
  it('rejects NUL and bad encoding', () => {
    expect(resolveSafe(root, '/%00')).toBeNull()
    expect(resolveSafe(root, '/%')).toBeNull() // 非法 URI 编码
  })
})
