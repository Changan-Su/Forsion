import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { icoFromPng, keepMacIcon, keepWindowsIcon } from './systemIcon'

const PNG = readFileSync(join(__dirname, '../build/icon.png'))
let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'system-icon-test-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('icoFromPng', () => {
  it('wraps the PNG as a single 32-bit icon entry', () => {
    const ico = icoFromPng(PNG, 256)
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 1])
    expect([ico[6], ico[7]]).toEqual([0, 0]) // 256 is written as 0
    expect(ico.readUInt32LE(14)).toBe(PNG.length)
    expect(ico.subarray(ico.readUInt32LE(18)).equals(PNG)).toBe(true)
    expect(icoFromPng(PNG, 48)[6]).toBe(48)
  })
})

describe('keepMacIcon', () => {
  const bundle = () => join(dir, 'Forsion.app')
  const target = (set: (bundle: string, image?: string) => Promise<boolean>, version = '1.0.0') => ({ bundle: bundle(), dir: join(dir, 'data'), version, set })
  // What the real call leaves behind, as far as this module looks.
  const finder = vi.fn(async (b: string, image?: string) => { if (image) await writeFile(join(b, 'Icon\r'), ''); else await rm(join(b, 'Icon\r'), { force: true }); return true })
  beforeEach(async () => { finder.mockClear(); await mkdir(bundle()) })

  it('writes once, again after an update replaced the bundle, and takes back only its own icon', async () => {
    await keepMacIcon(target(finder), 'a', () => PNG)
    await keepMacIcon(target(finder), 'a', () => { throw new Error('nothing to write') })
    expect(finder).toHaveBeenCalledTimes(1)
    expect(readFileSync(finder.mock.calls[0][1]!).equals(PNG)).toBe(true)
    await rm(join(bundle(), 'Icon\r'))
    await keepMacIcon(target(finder), 'a', () => PNG)
    await keepMacIcon(target(finder), 'b', () => PNG)
    expect(finder).toHaveBeenCalledTimes(3)
    await keepMacIcon(target(finder), null, () => PNG)
    expect(finder).toHaveBeenLastCalledWith(bundle())
    expect(existsSync(join(bundle(), 'Icon\r'))).toBe(false)
    expect(await readdir(join(dir, 'data'))).toEqual([])
    // Nothing of ours is left: an icon pasted in Finder is not touched.
    await writeFile(join(bundle(), 'Icon\r'), '')
    await keepMacIcon(target(finder), null, () => PNG)
    expect(finder).toHaveBeenCalledTimes(4)
  })
  it('does not retry a refused write until the picture or the app version changes', async () => {
    const refused = vi.fn(async () => { throw new Error('read-only volume') })
    await keepMacIcon(target(refused), 'a', () => PNG)
    await keepMacIcon(target(refused), 'a', () => PNG)
    expect(refused).toHaveBeenCalledTimes(1)
    await keepMacIcon(target(refused, '1.0.1'), 'a', () => PNG)
    await keepMacIcon(target(refused, '1.0.1'), 'b', () => PNG)
    expect(refused).toHaveBeenCalledTimes(3)
    // A refused write left nothing to take back.
    await keepMacIcon(target(refused, '1.0.1'), null, () => PNG)
    expect(refused).toHaveBeenCalledTimes(3)
  })
  // ponytail: the real AppKit call runs on a developer Mac only; CI's test job is Linux.
  it.skipIf(process.platform !== 'darwin' || !!process.env.CI)('sets and clears a real Finder custom icon', async () => {
    const real = { bundle: bundle(), dir: join(dir, 'data'), version: '1.0.0' }
    await keepMacIcon(real, 'a', () => PNG)
    expect(existsSync(join(bundle(), 'Icon\r'))).toBe(true)
    await keepMacIcon(real, null, () => PNG)
    expect(existsSync(join(bundle(), 'Icon\r'))).toBe(false)
  }, 30_000)
})

describe('keepWindowsIcon', () => {
  const exe = 'C:\\Program Files\\Forsion\\Forsion.exe'
  it('points only this install\'s shortcuts at the picture, and back', async () => {
    const data = join(dir, 'data'), folder = join(dir, 'desktop')
    await mkdir(folder)
    const links: Record<string, { target: string; icon?: string }> = {
      'Forsion.lnk': { target: exe.toUpperCase(), icon: exe },
      'Other.lnk': { target: 'C:\\Other\\other.exe', icon: 'C:\\Other\\other.exe' },
      'Mine.lnk': { target: exe, icon: 'C:\\Users\\me\\own.ico' },
      'Locked.lnk': { target: exe },
    }
    for (const name of [...Object.keys(links), 'notes.txt']) await writeFile(join(folder, name), '')
    const name = (path: string) => path.slice(folder.length + 1)
    const shell = {
      readShortcutLink: (path: string) => links[name(path)],
      writeShortcutLink: vi.fn((path: string, _op: 'update', options: { target: string; icon: string; iconIndex: number }) => {
        expect(options.target).toBe(links[name(path)].target) // only the icon changes
        if (name(path) === 'Locked.lnk') throw new Error('Access is denied')
        links[name(path)].icon = options.icon
        return true
      }),
    }
    const target = { shell, folders: [folder, join(dir, 'missing')], exe, dir: data }
    await keepWindowsIcon(target, 'a', () => PNG, 256)
    const first = links['Forsion.lnk'].icon!
    expect(readFileSync(first).subarray(22).equals(PNG)).toBe(true)
    expect(links['Mine.lnk'].icon).toBe(first)
    expect(links['Other.lnk'].icon).toBe('C:\\Other\\other.exe')
    const writes = shell.writeShortcutLink.mock.calls.length
    await keepWindowsIcon(target, 'a', () => { throw new Error('nothing to write') }, 256)
    expect(shell.writeShortcutLink.mock.calls.length).toBe(writes + 1) // only the locked one is tried again

    // Explorer caches by path: a new picture is a new file; the old one stays while a shortcut may still use it.
    await keepWindowsIcon(target, 'b', () => PNG, 256)
    expect(links['Forsion.lnk'].icon).not.toBe(first)
    expect((await readdir(data)).length).toBe(2)
    delete links['Locked.lnk']
    await rm(join(folder, 'Locked.lnk'))
    await keepWindowsIcon(target, 'b', () => PNG, 256)
    expect(await readdir(data)).toEqual([links['Forsion.lnk'].icon!.slice(data.length + 1)])

    links['Mine.lnk'].icon = 'C:\\Users\\me\\own.ico'
    await keepWindowsIcon(target, null, () => PNG, 256)
    expect(links['Forsion.lnk'].icon).toBe(exe)
    expect(links['Mine.lnk'].icon).toBe('C:\\Users\\me\\own.ico')
    expect(await readdir(data)).toEqual([])
  })
})
