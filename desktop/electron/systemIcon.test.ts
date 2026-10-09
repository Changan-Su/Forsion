import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { icoFromPng, keepMacIcon, keepWindowsIcon, setFinderIcon } from './systemIcon'

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
  const icon = () => join(bundle(), 'Icon\r')
  const target = (set: (bundle: string, image?: string) => Promise<boolean>) => ({ bundle: bundle(), dir: join(dir, 'data'), set })
  // What the real call leaves behind, as far as this module looks: a new Icon\r per picture, none after a reset.
  let stamp = 0
  const paste = async () => { await writeFile(icon(), ''); await utimes(icon(), ++stamp, stamp) }
  const finder = vi.fn(async (_bundle: string, image?: string) => { if (image) await paste(); else await rm(icon(), { force: true }); return true })
  beforeEach(async () => { finder.mockClear(); await mkdir(bundle()) })

  it('writes once, again after an update replaced the bundle, and takes its own icon back', async () => {
    await keepMacIcon(target(finder), 'a', () => PNG)
    await keepMacIcon(target(finder), 'a', () => { throw new Error('nothing to write') })
    expect(finder).toHaveBeenCalledTimes(1)
    expect(readFileSync(finder.mock.calls[0][1]!).equals(PNG)).toBe(true)
    await rm(icon())
    await keepMacIcon(target(finder), 'a', () => PNG)
    await keepMacIcon(target(finder), 'b', () => PNG)
    expect(finder).toHaveBeenCalledTimes(3)
    await keepMacIcon(target(finder), null, () => PNG)
    expect(finder).toHaveBeenLastCalledWith(bundle())
    expect(existsSync(icon())).toBe(false)
    expect(await readdir(join(dir, 'data'))).toEqual([])
  })
  it('leaves an icon the user pasted in Finder: never one of ours, or pasted over ours', async () => {
    await paste()
    await keepMacIcon(target(finder), null, () => PNG)
    expect(finder).not.toHaveBeenCalled()
    await keepMacIcon(target(finder), 'a', () => PNG) // picking one here is the user's word: it replaces theirs
    await paste() // … and they paste another over it
    await keepMacIcon(target(finder), 'a', () => PNG)
    await keepMacIcon(target(finder), null, () => PNG)
    expect(finder).toHaveBeenCalledTimes(1)
    expect(existsSync(icon())).toBe(true)
  })
  it('keeps describing what is on the bundle when a write or a reset fails, and tries again', async () => {
    const refused = vi.fn(async () => { throw new Error('read-only volume') })
    await keepMacIcon(target(refused), 'a', () => PNG)
    await keepMacIcon(target(refused), 'a', () => PNG)
    expect(refused).toHaveBeenCalledTimes(2) // every launch, until it works
    await keepMacIcon(target(refused), null, () => PNG)
    expect(refused).toHaveBeenCalledTimes(2) // nothing of ours to take back

    await keepMacIcon(target(finder), 'a', () => PNG)
    await keepMacIcon(target(refused), 'b', () => PNG) // A is still what is there
    await keepMacIcon(target(async () => false), null, () => PNG)
    expect(existsSync(icon())).toBe(true)
    await keepMacIcon(target(finder), null, () => PNG)
    expect(existsSync(icon())).toBe(false)
    expect(await readdir(join(dir, 'data'))).toEqual([])
  })
  // ponytail: the real AppKit call runs on a developer Mac only; CI's test job is Linux.
  it.skipIf(process.platform !== 'darwin' || !!process.env.CI)('sets and clears a real Finder custom icon, and tells its own from one pasted since', async () => {
    const real = { bundle: bundle(), dir: join(dir, 'data') }
    await keepMacIcon(real, 'a', () => PNG)
    expect(existsSync(icon())).toBe(true)
    await keepMacIcon(real, null, () => PNG)
    expect(existsSync(icon())).toBe(false)
    await keepMacIcon(real, 'a', () => PNG)
    expect(await setFinderIcon(bundle(), join(__dirname, '../frontend/src/assets/forsion-logo-arioso.png'))).toBe(true) // what a paste in Get Info does
    await keepMacIcon(real, null, () => PNG)
    expect(existsSync(icon())).toBe(true)
  }, 60_000)
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
    for (const name of [...Object.keys(links), 'Broken.lnk', 'notes.txt']) await writeFile(join(folder, name), '')
    const name = (path: string) => path.slice(folder.length + 1)
    const shell = {
      readShortcutLink: (path: string) => { if (!links[name(path)]) throw new Error('not a shortcut'); return links[name(path)] },
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

    // Explorer caches by path: a new picture is a new file. The old one stays — a shortcut that could not be rewritten may still use it.
    await keepWindowsIcon(target, 'b', () => PNG, 256)
    expect(links['Forsion.lnk'].icon).not.toBe(first)
    expect(existsSync(first)).toBe(true)

    links['Mine.lnk'].icon = 'C:\\Users\\me\\own.ico'
    await keepWindowsIcon(target, null, () => PNG, 256)
    expect(links['Forsion.lnk'].icon).toBe(exe)
    expect(links['Mine.lnk'].icon).toBe('C:\\Users\\me\\own.ico')
  })
  it('never hands out a half-written icon, and keeps only the latest few', async () => {
    const data = join(dir, 'data')
    const target = { shell: { readShortcutLink: () => ({ target: '' }), writeShortcutLink: () => true }, folders: [], exe, dir: data }
    await expect(keepWindowsIcon(target, 'a', () => { throw new Error('disk full') }, 256)).rejects.toThrow('disk full')
    expect(await readdir(data)).toEqual([])
    for (let i = 0; i < 12; i++) await keepWindowsIcon(target, `picture ${i}`, () => PNG, 256)
    const left = await readdir(data)
    expect(left.length).toBe(8)
    await keepWindowsIcon(target, 'picture 11', () => { throw new Error('already written') }, 256) // the current one is among them
  })
})
