import { describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectProjectFiles, readConnectMeta, writeConnectMeta, CONNECT_MAX_FILE_BYTES } from './forsionConnect'

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fc-pack-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="./app.tsx"></script>')
  writeFileSync(join(dir, 'app.tsx'), 'export const A = () => <div>hi</div>')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'style.css'), 'body{color:red}')
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'skip me')
  writeFileSync(join(dir, '.hidden'), 'secret')
  writeFileSync(join(dir, 'types.d.ts'), 'declare const x: number')
  return dir
}

describe('collectProjectFiles', () => {
  test('打包:跳过 node_modules/隐藏文件/.d.ts;tsx 转译成 JS 且 content-type=text/javascript', () => {
    const { files, totalBytes } = collectProjectFiles(fixture())
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(['app.tsx', 'assets/style.css', 'index.html'])
    expect(totalBytes).toBeGreaterThan(0)

    const tsx = files.find((f) => f.path === 'app.tsx')!
    expect(tsx.content_type).toBe('text/javascript')
    const code = Buffer.from(tsx.content_b64, 'base64').toString('utf8')
    expect(code).not.toContain('<div>')       // JSX 已经转译
    expect(code).toContain('jsx')             // automatic runtime

    expect(files.find((f) => f.path === 'index.html')!.content_type).toBe('text/html')
    expect(files.find((f) => f.path === 'assets/style.css')!.content_type).toBe('text/css')
  })

  test('单文件超 5MB 抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-big-'))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(CONNECT_MAX_FILE_BYTES + 1))
    expect(() => collectProjectFiles(dir)).toThrow(/5MB/)
  })

  test('空项目抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-empty-'))
    expect(() => collectProjectFiles(dir)).toThrow(/项目为空/)
  })

  test('跳过符号链接（防跟随到项目外 / 防循环）', () => {
    const secret = mkdtempSync(join(tmpdir(), 'fc-secret-'))
    writeFileSync(join(secret, 'id_rsa'), 'PRIVATE KEY')
    const dir = mkdtempSync(join(tmpdir(), 'fc-link-'))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    symlinkSync(join(secret, 'id_rsa'), join(dir, 'leak.txt'))   // 文件软链指向项目外
    symlinkSync(secret, join(dir, 'outside'))                     // 目录软链指向项目外
    symlinkSync(dir, join(dir, 'loop'))                           // 自指软链（会造成循环）
    const { files } = collectProjectFiles(dir)
    expect(files.map((f) => f.path)).toEqual(['index.html'])       // 只打包真实文件，软链全跳过
  })
})

describe('connect meta', () => {
  test('读写往返;损坏文件回退空对象', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-meta-'))
    expect(readConnectMeta(dir)).toEqual({})
    writeConnectMeta(dir, { slug: 'my-app' })
    expect(readConnectMeta(dir)).toEqual({ slug: 'my-app' })
    writeFileSync(join(dir, '.forsion-connect.json'), '{broken')
    expect(readConnectMeta(dir)).toEqual({})
  })

  test('meta 文件是 dotfile,不会进发布包', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-meta2-'))
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    writeConnectMeta(dir, { slug: 'x-app' })
    const { files } = collectProjectFiles(dir)
    expect(files.map((f) => f.path)).toEqual(['index.html'])
  })
})
