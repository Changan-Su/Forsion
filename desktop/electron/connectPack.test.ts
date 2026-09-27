/**
 * Forsion Connect 的发布打包 × 宿主真转译器:collectProjectFiles 住在 @forsion/extend,转译器由宿主经 CloudHost 注入
 * (发布产物 = 预览所见)。Extend 自己的测试只能用桩,证不了 JSX 真被转译 —— 这条在接缝处用 Genesis 的 transpileForServe
 * 与 MIME 表实跑,钉住搬迁前 forsionConnect.test.ts 那条「tsx 转译成 JS」的断言(Codex:桩测试对原样返回的转译器假绿)。
 * 读的是 node_modules 里钉住的那份 @forsion/extend(与 release-content / 播种来源同一份)。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transpileForServe, MIME } from './codePreview'
// @ts-expect-error 私有包不带类型;这里只用运行时导出
import { collectProjectFiles } from '@forsion/extend/dist/desktop.mjs'

describe('Connect 打包 × 宿主转译器', () => {
  it('tsx 经宿主 transpileForServe 真变成 JS(content_type=text/javascript,JSX 不留),MIME 走宿主表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'connect-pack-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="./app.tsx"></script>')
    writeFileSync(join(dir, 'app.tsx'), 'export const A = () => <div>hi</div>')
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'style.css'), 'body{color:red}')
    const { files } = collectProjectFiles(dir, { transpile: transpileForServe, mimeOf: (ext: string) => MIME[ext] })
    const tsx = files.find((f: { path: string }) => f.path === 'app.tsx')
    expect(tsx.content_type).toBe('text/javascript')
    const code = Buffer.from(tsx.content_b64, 'base64').toString('utf8')
    expect(code).not.toContain('<div>')
    expect(code).toContain('jsx')
    expect(files.find((f: { path: string }) => f.path === 'index.html').content_type).toBe('text/html')
    expect(files.find((f: { path: string }) => f.path === 'assets/style.css').content_type).toBe('text/css')
  })
})
