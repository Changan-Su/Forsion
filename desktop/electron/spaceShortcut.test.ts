import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  buildIco, buildIcns, createSpaceShortcut, spaceAppUserModelId, spaceBundleId, spaceIconFile, spaceShortcutMetaFile,
  spaceShortcutPlan, spaceWindowIdFromUrl, spaceWindowLink, type CreateSpaceShortcutDeps,
} from './spaceShortcut'

type Writer = NonNullable<CreateSpaceShortcutDeps['writeShortcutLink']>

const EXEC = '/Applications/Forsion.app/Contents/MacOS/Forsion'
/** 最小的「PNG」:模块只当字节原样塞进容器,不解码。 */
const png = (size: number): Buffer => Buffer.from(`PNG-${size}`)

let home: string
let desktop: string
let iconDir: string
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'space-shortcut-')))
  desktop = path.join(home, 'Desktop')
  iconDir = path.join(home, 'userData', 'space-shortcuts')
  await fs.mkdir(desktop)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true })
})

const deps = (extra: Partial<CreateSpaceShortcutDeps> = {}): CreateSpaceShortcutDeps =>
  ({ isPackaged: true, desktopDir: desktop, execPath: EXEC, iconDir, ...extra })
const onDesktop = async (): Promise<string[]> => (await fs.readdir(desktop)).map((e) => e.normalize('NFC')).sort()

describe('space window link', () => {
  it('round-trips through the main-process matcher', () => {
    expect(spaceWindowLink('amadeus')).toBe('forsion://space/amadeus?window=standalone')
    expect(spaceWindowIdFromUrl(spaceWindowLink('amadeus'))).toBe('amadeus')
    expect(spaceWindowIdFromUrl(spaceWindowLink('user.my-space_2'))).toBe('user.my-space_2')
    expect(spaceWindowIdFromUrl('FORSION://SPACE/amadeus?window=standalone')).toBe('amadeus')
  })

  it('leaves every other forsion:// link to the normal deep-link path', () => {
    expect(spaceWindowIdFromUrl('forsion://space/amadeus')).toBeNull() // 普通「切到这个 Space」
    expect(spaceWindowIdFromUrl('forsion://space/amadeus?window=1')).toBeNull()
    expect(spaceWindowIdFromUrl('forsion://open?view=product&id=p_0123456789ab')).toBeNull()
    expect(spaceWindowIdFromUrl('https://space/amadeus?window=standalone')).toBeNull()
  })

  it('rejects ids outside the Space id shape (encoded separators, empty, too long)', () => {
    expect(spaceWindowIdFromUrl('forsion://space/a%2Fb?window=standalone')).toBeNull()
    expect(spaceWindowIdFromUrl('forsion://space/a/b?window=standalone')).toBeNull()
    expect(spaceWindowIdFromUrl('forsion://space/?window=standalone')).toBeNull()
    expect(spaceWindowIdFromUrl('forsion://space/%E4?window=standalone')).toBeNull()
    expect(spaceWindowIdFromUrl(`forsion://space/${'a'.repeat(129)}?window=standalone`)).toBeNull()
    expect(spaceWindowIdFromUrl(42)).toBeNull()
    expect(() => spaceWindowLink('a b')).toThrow()
  })
})

describe('system identifiers', () => {
  it('stay within platform character sets and length limits', () => {
    expect(spaceAppUserModelId('user.my_space')).toBe('Forsion.Space.user.my-space')
    expect(spaceBundleId('user.my_space')).toBe('net.forsion.space-shortcut.user.my-space')
    const long = 'x'.repeat(128)
    expect(spaceAppUserModelId(long).length).toBeLessThanOrEqual(128)
    expect(spaceBundleId(long)).toMatch(/^[A-Za-z0-9.-]+$/)
  })

  it('places icon files inside the icon directory only', () => {
    expect(spaceIconFile(iconDir, '..', 'win32')).toBe(path.join(iconDir, '...ico'))
    expect(spaceIconFile(iconDir, 'a/b', 'win32')).toBeNull()
    expect(spaceIconFile(iconDir, 'amadeus', 'darwin')).toBeNull()
    expect(path.dirname(spaceShortcutMetaFile(iconDir, 'amadeus'))).toBe(iconDir)
  })
})

describe('icon containers', () => {
  it('icns: header length covers every entry; 32 / 64 / 256 / 512 double up as @2x', () => {
    const icns = buildIcns([16, 32, 1024].map((size) => ({ size, png: png(size) })))
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const types: string[] = []
    for (let o = 8; o < icns.length;) {
      types.push(icns.subarray(o, o + 4).toString('ascii'))
      o += icns.readUInt32BE(o + 4)
    }
    expect(types).toEqual(['icp4', 'icp5', 'ic11', 'ic10'])
  })

  it('ico: directory points at each PNG, 256 written as 0', () => {
    const ico = buildIco([{ size: 16, png: png(16) }, { size: 256, png: png(256) }, { size: 512, png: png(512) }])
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(2) // 512 不进 ico
    expect(ico.readUInt8(6)).toBe(16)
    expect(ico.readUInt8(6 + 16)).toBe(0)
    const off = ico.readUInt32LE(6 + 16 + 12), len = ico.readUInt32LE(6 + 16 + 8)
    expect(ico.subarray(off, off + len).toString()).toBe('PNG-256')
  })
})

describe('spaceShortcutPlan', () => {
  it('mac: a launcher .app whose script only carries the link, never the name', () => {
    const plan = spaceShortcutPlan('darwin', { id: 'amadeus', name: 'Notes & <Ideas> $(rm -rf ~)', execPath: EXEC, icns: Buffer.from('i') })
    expect(plan?.kind).toBe('bundle')
    if (plan?.kind !== 'bundle') return
    const file = (rel: string): string => String(plan.files.find((f) => f.rel === rel)?.content)
    expect(file('Contents/MacOS/launch')).toBe('#!/bin/sh\n# Forsion Space shortcut: opens this Space in its own Forsion window.\nexec /usr/bin/open "forsion://space/amadeus?window=standalone"\n')
    expect(plan.files.find((f) => f.rel === 'Contents/MacOS/launch')?.mode).toBe(0o755)
    const plist = file('Contents/Info.plist')
    expect(plist).toContain('<string>Notes &amp; Ideas $(rm -rf ~)</string>')
    expect(plist).toContain('<key>CFBundleIconFile</key>')
    expect(plist).toContain('<key>LSUIElement</key>\t<true/>')
    expect(plist).toContain(`<string>${spaceBundleId('amadeus')}</string>`)
    expect(plan.files.some((f) => f.rel === 'Contents/Resources/AppIcon.icns')).toBe(true)
  })

  it('mac without an icon leaves CFBundleIconFile out', () => {
    const plan = spaceShortcutPlan('darwin', { id: 'amadeus', name: 'Notes', execPath: EXEC })
    expect(plan?.kind === 'bundle' && plan.files.map((f) => f.rel)).toEqual(['Contents/Info.plist', 'Contents/PkgInfo', 'Contents/MacOS/launch'])
    expect(plan?.kind === 'bundle' && String(plan.files[0].content)).not.toContain('CFBundleIconFile')
  })

  it('linux: .desktop runs Forsion with the link and points Icon at the stored png', () => {
    const plan = spaceShortcutPlan('linux', { id: 'amadeus', name: 'Notes', execPath: '/opt/Forsion/forsion', appImage: '/home/u/Forsion.AppImage', iconPath: '/u/space-shortcuts/amadeus.png' })
    expect(plan?.kind === 'file' && plan.content).toContain('Exec="/home/u/Forsion.AppImage" "forsion://space/amadeus?window=standalone"')
    expect(plan?.kind === 'file' && plan.content).toContain('Icon=/u/space-shortcuts/amadeus.png')
  })

  it('unknown platforms are unsupported', () => {
    expect(spaceShortcutPlan('aix', { id: 'amadeus', name: 'Notes', execPath: EXEC })).toBeNull()
  })
})

describe('createSpaceShortcut', () => {
  it('refuses in dev builds', async () => {
    expect(await createSpaceShortcut({ id: 'amadeus', name: 'Notes' }, deps({ isPackaged: false }))).toEqual({ ok: false, code: 'unpackaged' })
    expect(await onDesktop()).toEqual([])
  })

  it('mac: writes an executable .app and never overwrites an existing one', async () => {
    const d = deps({ platform: 'darwin', iconPng: png })
    const first = await createSpaceShortcut({ id: 'amadeus', name: 'Notes' }, d)
    const second = await createSpaceShortcut({ id: 'amadeus', name: 'Notes' }, d)
    expect(first).toEqual({ ok: true, path: path.join(desktop, 'Notes.app') })
    expect(second).toEqual({ ok: true, path: path.join(desktop, 'Notes (1).app') })
    const launch = path.join(desktop, 'Notes.app', 'Contents', 'MacOS', 'launch')
    expect((await fs.stat(launch)).mode & 0o777).toBe(0o755)
    const icns = await fs.readFile(path.join(desktop, 'Notes.app', 'Contents', 'Resources', 'AppIcon.icns'))
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(await onDesktop()).toEqual(['Notes (1).app', 'Notes.app'])
  })

  it('mac: a plain file squatting on the name is skipped, not replaced', async () => {
    await fs.writeFile(path.join(desktop, 'Notes.app'), 'mine')
    const r = await createSpaceShortcut({ id: 'amadeus', name: 'Notes' }, deps({ platform: 'darwin' }))
    expect(r).toEqual({ ok: true, path: path.join(desktop, 'Notes (1).app') })
    expect(await fs.readFile(path.join(desktop, 'Notes.app'), 'utf8')).toBe('mine')
  })

  it('windows: .lnk carries the link, the Space AppUserModelID and the stored .ico; name is recorded for the taskbar', async () => {
    const writer = vi.fn<Writer>(() => true)
    const r = await createSpaceShortcut({ id: 'amadeus', name: 'Notes' }, deps({ platform: 'win32', iconPng: png, writeShortcutLink: writer }))
    const ico = spaceIconFile(iconDir, 'amadeus', 'win32')!
    expect(r).toEqual({ ok: true, path: path.join(desktop, 'Notes.lnk') })
    expect(writer.mock.calls[0][1]).toEqual({
      target: EXEC, args: '"forsion://space/amadeus?window=standalone"', description: 'Notes',
      appUserModelId: 'Forsion.Space.amadeus', icon: ico, iconIndex: 0,
    })
    expect((await fs.readFile(ico)).readUInt16LE(4)).toBe(7)
    expect(JSON.parse(await fs.readFile(spaceShortcutMetaFile(iconDir, 'amadeus'), 'utf8'))).toEqual({ name: 'Notes' })
  })

  it('windows: no icon source → shortcut without icon', async () => {
    const writer = vi.fn<Writer>(() => true)
    await createSpaceShortcut({ id: 'amadeus', name: 'Notes' }, deps({ platform: 'win32', writeShortcutLink: writer }))
    expect(writer.mock.calls[0][1]).not.toHaveProperty('icon')
  })

  it('rejects malformed ids before touching the disk', async () => {
    expect(await createSpaceShortcut({ id: '../x', name: 'Notes' }, deps({ platform: 'darwin' }))).toEqual({ ok: false, code: 'not_found' })
    expect(await onDesktop()).toEqual([])
  })
})
