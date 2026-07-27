import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get as httpGet } from 'node:http'
import { resolveSafe, transpileForServe, servePathRoot, serveDir, setForsionPreviewHooks, stopCodePreview } from './codePreview'

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

describe('Forsion Connect 端点在两种根都可达', () => {
  afterAll(() => stopCodePreview())

  /** 带 Host 头打真服务器(node fetch 不解析 *.localhost,用裸 http + Host 头模拟 Chromium 行为)。 */
  const get = (port: string, path: string, host?: string): Promise<{ code: number; body: string }> =>
    new Promise((res, rej) => {
      httpGet({ host: '127.0.0.1', port, path, headers: host ? { host } : {} }, (r) => {
        let b = ''
        r.on('data', (c) => { b += c })
        r.on('end', () => res({ code: r.statusCode || 0, body: b }))
      }).on('error', rej)
    })

  it('令牌根(Agent Desk/wsfile/笔记预览)与 Coding Space 主根都供 SDK 与 __forsion 代理', async () => {
    setForsionPreviewHooks({ sdkJs: 'window.__sdk=1', proxy: (_req, res) => { res.end('{"proxied":1}') } })
    const dir = mkdtempSync(join(tmpdir(), 'fc-preview-'))
    writeFileSync(join(dir, 'index.html'), 'hi')

    // 令牌根:普通聊天里 agent 生成的 AI 页面走这条,漏了它 window.forsion 直接 404(tangu-session-9d1fa366)
    const { origin, token } = await servePathRoot(dir)
    const tPort = new URL(origin).port
    const tHost = `${token}.localhost:${tPort}`
    expect((await get(tPort, '/forsion-connect.js', tHost)).body).toContain('__sdk')
    expect((await get(tPort, '/__forsion/config', tHost)).body).toContain('proxied')
    expect((await get(tPort, '/index.html', tHost)).body).toBe('hi') // 正常静态服务不受影响
    expect((await get(tPort, '/forsion-connect.js')).code).toBe(404) // 无有效 token 照旧 404

    // Coding Space 主根(回归:重构抽 helper 后不能丢)
    const { origin: mainOrigin } = await serveDir(dir)
    const mPort = new URL(mainOrigin).port
    expect((await get(mPort, '/forsion-connect.js')).body).toContain('__sdk')
    expect((await get(mPort, '/__forsion/config')).body).toContain('proxied')
  })
})
