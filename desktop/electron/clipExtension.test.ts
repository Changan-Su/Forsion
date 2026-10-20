import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
vi.mock('electron', () => ({ app: {}, clipboard: {}, ipcMain: {} }))
import { ensureClipCopy } from './clipExtension'

const ext = (root: string, version: string): string => {
  const dir = join(root, `src-${version}`)
  mkdirSync(join(dir, 'icon'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version }))
  writeFileSync(join(dir, 'icon', '48.png'), version)
  return dir
}

describe('ensureClipCopy', () => {
  it('没有就复制;同版本不动(Chrome 正从这里加载);换版本整份换掉,不留临时目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'clip-copy-'))
    const dst = join(root, 'Forsion', 'Forsion Clip')
    expect(ensureClipCopy(ext(root, '2.1.0'), dst)).toEqual({ dir: dst, version: '2.1.0' })
    expect(existsSync(join(dst, 'icon', '48.png'))).toBe(true)

    writeFileSync(join(dst, 'marker'), 'x')
    expect(ensureClipCopy(ext(root, '2.1.0'), dst)).toEqual({ dir: dst, version: '2.1.0' })
    expect(existsSync(join(dst, 'marker'))).toBe(true)

    expect(ensureClipCopy(ext(root, '2.2.0'), dst)).toEqual({ dir: dst, version: '2.2.0' })
    expect(existsSync(join(dst, 'marker'))).toBe(false)
    expect(readdirSync(join(root, 'Forsion'))).toEqual(['Forsion Clip'])
  })

  it('随包那份缺了就报错,不碰已有的副本', () => {
    const root = mkdtempSync(join(tmpdir(), 'clip-copy-'))
    const dst = join(root, 'Forsion Clip')
    ensureClipCopy(ext(root, '2.1.0'), dst)
    expect(ensureClipCopy(join(root, 'nope'), dst)).toEqual({ error: 'bundled extension not found' })
    expect(existsSync(join(dst, 'manifest.json'))).toBe(true)
  })
})
