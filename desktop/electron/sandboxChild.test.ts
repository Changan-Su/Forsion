import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, dialog: {}, ipcMain: {} }))
const { keyEvents, sandboxFilePath } = await import('./sandboxChild')

describe('press 的键', () => {
  it('普通键带字符事件(真打进输入框);带 Meta / Ctrl 的是快捷键,不打字;Mod 跟平台走', () => {
    expect(keyEvents('a')).toEqual([{ type: 'keyDown', keyCode: 'a', modifiers: [] }, { type: 'char', keyCode: 'a', modifiers: [] }, { type: 'keyUp', keyCode: 'a', modifiers: [] }])
    expect(keyEvents('Enter')?.[1]).toEqual({ type: 'char', keyCode: '\r', modifiers: [] })
    expect(keyEvents('ArrowDown')?.map((e) => e.type)).toEqual(['keyDown', 'keyUp'])
    expect(keyEvents('ArrowDown')?.[0].keyCode).toBe('Down')
    expect(keyEvents('Mod+K', 'darwin')).toEqual([{ type: 'keyDown', keyCode: 'K', modifiers: ['meta'] }, { type: 'keyUp', keyCode: 'K', modifiers: ['meta'] }])
    expect(keyEvents('Mod+K', 'win32')?.[0].modifiers).toEqual(['control'])
    expect(keyEvents('Shift+a')?.map((e) => e.type)).toEqual(['keyDown', 'char', 'keyUp'])
  })
  it('认不出的键 / 修饰键 → null', () => {
    expect(keyEvents('Hyper+K')).toBeNull()
    expect(keyEvents('NotAKey')).toBeNull()
    expect(keyEvents('')).toBeNull()
  })
})

describe('files 的路径', () => {
  const setup = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'sbxc-')))
    const dir = join(base, 'plugin'), root = join(base, 'sandbox', 'reading-log'), outside = join(base, 'secret')
    for (const d of [dir, root, outside]) mkdirSync(d, { recursive: true })
    writeFileSync(join(dir, 'books.csv'), 'a'); writeFileSync(join(root, 'in.csv'), 'b'); writeFileSync(join(outside, 'key.txt'), 'c')
    symlinkSync(outside, join(dir, 'link'))
    return { dir, root, outside }
  }
  it('插件目录 / 沙箱目录里的认(相对路径按插件目录);外面的、软链指出去的、../ 绕出去的不认', () => {
    const b = setup()
    expect(sandboxFilePath('books.csv', b, true)).toBe(join(b.dir, 'books.csv'))
    expect(sandboxFilePath(join(b.root, 'in.csv'), b, true)).toBe(join(b.root, 'in.csv'))
    expect(sandboxFilePath(join(b.outside, 'key.txt'), b, true)).toBeNull()
    expect(sandboxFilePath('link/key.txt', b, true)).toBeNull()
    expect(sandboxFilePath('../secret/key.txt', b, true)).toBeNull()
    expect(sandboxFilePath('missing.csv', b, true)).toBeNull()
  })
  it('save:文件可以还不存在,父目录得在里面', () => {
    const b = setup()
    expect(sandboxFilePath('out.csv', b, false)).toBe(join(b.dir, 'out.csv'))
    expect(sandboxFilePath('link/out.csv', b, false)).toBeNull()
    expect(sandboxFilePath('', b, false)).toBeNull()
  })
})
