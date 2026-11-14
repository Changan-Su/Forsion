import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createWindowShortcut, iconPngFromDataUrl, spaceIconFile, spaceShortcutMetaFile, windowShortcutPlan, type CreateSpaceShortcutDeps, type SpaceShortcutPlan } from './spaceShortcut'
import {
  UNIT_SHORTCUT, isUnitId, parseRosterResponse, resolveUnitShortcutTarget, unitAppUserModelId, unitWindowIdFromUrl, unitWindowLink, type RosterRead,
} from './unitShortcut'

type Writer = NonNullable<CreateSpaceShortcutDeps['writeShortcutLink']>
const EXEC = '/Applications/Forsion.app/Contents/MacOS/Forsion'
const ID = '3f2a9c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c'
/** 名册里别的设备报上来的名字:什么花样都可能有。 */
const NASTY = [
  '../../etc/passwd',
  'C:\\Windows\\System32\\x',
  'say "hi" \'there\'',
  'line1\nline2\rline3',
  'a $(rm -rf ~) b',
  'tick `id` tock',
  '%h %f %%',
  '\u202Ekcod.exe',
]

let home: string
let desktop: string
let iconDir: string
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unit-shortcut-')))
  desktop = path.join(home, 'Desktop')
  iconDir = path.join(home, 'userData', 'unit-shortcuts')
  await fs.mkdir(desktop)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true })
})
const deps = (extra: Partial<CreateSpaceShortcutDeps> = {}): CreateSpaceShortcutDeps =>
  ({ isPackaged: true, desktopDir: desktop, execPath: EXEC, iconDir, ...extra })

describe('unit window link', () => {
  it('only the device id goes into the link and round-trips', () => {
    expect(unitWindowLink(ID)).toBe(`forsion://unit/${ID}?window=standalone`)
    expect(unitWindowIdFromUrl(unitWindowLink(ID))).toBe(ID)
    expect(unitWindowIdFromUrl(`FORSION://UNIT/${ID}?window=standalone`)).toBe(ID)
    expect(unitWindowIdFromUrl('forsion://unit/abcdefgh?window=standalone')).toBe('abcdefgh')
  })

  it('rejects ids outside ^[0-9a-zA-Z-]{8,64}$ in both directions', () => {
    for (const bad of ['short', 'a'.repeat(65), 'has space1', 'dot.ted.id', 'under_score', '../../../x', 'a%2Fbcdefgh', '']) {
      expect(isUnitId(bad)).toBe(false)
      expect(() => unitWindowLink(bad)).toThrow()
      expect(unitWindowIdFromUrl(`forsion://unit/${bad}?window=standalone`)).toBeNull()
    }
    expect(unitWindowIdFromUrl(`forsion://unit/${ID}/extra?window=standalone`)).toBeNull()
    expect(unitWindowIdFromUrl(`forsion://unit/abc%2Fdefgh?window=standalone`)).toBeNull()
    expect(unitWindowIdFromUrl(null)).toBeNull()
  })

  it('extra parameters never leak out: parsing returns the id only, other links stay normal deep links', () => {
    expect(unitWindowIdFromUrl(`forsion://unit/${ID}?window=standalone&url=http://192.168.1.2:3260&token=x`)).toBe(ID)
    expect(unitWindowIdFromUrl(`forsion://unit/${ID}`)).toBeNull()
    expect(unitWindowIdFromUrl(`forsion://unit/${ID}?window=1`)).toBeNull()
    expect(unitWindowIdFromUrl(`forsion://space/${ID}?window=standalone`)).toBeNull()
    expect(unitWindowIdFromUrl(`https://unit/${ID}?window=standalone`)).toBeNull()
  })

  it('has its own system identifiers, apart from Space ones', () => {
    expect(unitAppUserModelId(ID)).toBe(`Forsion.Unit.${ID.replace(/-/g, '-')}`)
    expect(unitAppUserModelId(ID)).toMatch(/^[A-Za-z0-9.-]+$/)
  })
})

/** 计划里「会被执行的东西」:mac 的 launch 脚本、.desktop 的 Exec=、.lnk 的参数。 */
function executable(plan: SpaceShortcutPlan | null): string {
  if (!plan) return ''
  if (plan.kind === 'bundle') return String(plan.files.find((f) => f.rel === 'Contents/MacOS/launch')?.content)
  if (plan.kind === 'file') return plan.content.split('\n').filter((l) => l.startsWith('Exec=')).join('\n')
  return plan.args
}

describe('names from the roster are data, never code', () => {
  it.each(NASTY)('%j: never in the script / Exec= / .lnk args on any platform', (name) => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const plan = windowShortcutPlan(UNIT_SHORTCUT, platform, { id: ID, name, execPath: EXEC, appImage: '/home/u/Forsion.AppImage' })
      // 可执行部分与名字无关:逐字等于只带链接的那一份
      expect(executable(plan)).toBe(executable(windowShortcutPlan(UNIT_SHORTCUT, platform, { id: ID, name: 'Plain', execPath: EXEC, appImage: '/home/u/Forsion.AppImage' })))
      expect(executable(plan)).toContain(`forsion://unit/${ID}?window=standalone`)
      // 文件名主干:一段、不含路径分隔符和控制字符、不以点开头
      expect(plan!.name).not.toMatch(/[/\\\p{Cc}\u202e]/u)
      expect(plan!.name.startsWith('.')).toBe(false)
    }
  })

  it('mac plist escapes the name; the script carries only the link', () => {
    const plan = windowShortcutPlan(UNIT_SHORTCUT, 'darwin', { id: ID, name: 'Mac <mini> & "den"', execPath: EXEC })
    if (plan?.kind !== 'bundle') throw new Error('expected bundle')
    const plist = String(plan.files.find((f) => f.rel === 'Contents/Info.plist')?.content)
    expect(plist).toContain('<string>Mac mini &amp; den</string>') // < > " 是文件名非法字符,先被洗掉;& 转义
    expect(plist).toContain(`<key>ForsionUnitId</key>\t<string>${ID}</string>`)
    expect(plist).toContain('<string>net.forsion.unit-shortcut.')
    expect(executable(plan)).toBe(`#!/bin/sh\n# Forsion device shortcut: opens this device in its own Forsion window.\nexec /usr/bin/open "forsion://unit/${ID}?window=standalone"\n`)
  })

  it('.desktop: a newline in the name cannot start a new key line', () => {
    const plan = windowShortcutPlan(UNIT_SHORTCUT, 'linux', { id: ID, name: 'den\nExec=/bin/evil', execPath: '/opt/Forsion/forsion' })
    if (plan?.kind !== 'file') throw new Error('expected file')
    const lines = plan.content.split('\n')
    expect(lines.filter((l) => l.startsWith('Exec='))).toEqual([`Exec="/opt/Forsion/forsion" "forsion://unit/${ID}?window=standalone"`])
    expect(lines.find((l) => l.startsWith('Name='))).not.toContain('\n')
  })

  it('windows: the AppUserModelID is the Unit one', () => {
    const plan = windowShortcutPlan(UNIT_SHORTCUT, 'win32', { id: ID, name: 'Den', execPath: EXEC })
    expect(plan).toMatchObject({ kind: 'lnk', args: `"forsion://unit/${ID}?window=standalone"`, appUserModelId: unitAppUserModelId(ID) })
  })

  it('long, dot-only and empty names fall back or get capped', () => {
    const plan = (name: string, fallbackName?: string) => windowShortcutPlan(UNIT_SHORTCUT, 'darwin', { id: ID, name, fallbackName, execPath: EXEC })!.name
    expect(plan('....', 'Forsion device')).toBe('Forsion device')
    expect(plan(' . . ', 'Forsion device')).toBe('Forsion device')
    expect(plan('', '')).toBe('Forsion App')
    expect(plan('../..', 'Forsion device')).toBe('Forsion device')
    expect(Array.from(plan('名'.repeat(500))).length).toBeLessThanOrEqual(80)
    expect(Buffer.byteLength(plan('😀'.repeat(200)))).toBeLessThanOrEqual(240)
  })
})

describe('createWindowShortcut(UNIT_SHORTCUT)', () => {
  it('mac: writes the .app on the desktop, never outside it, never overwriting', async () => {
    const d = deps({ platform: 'darwin' })
    const a = await createWindowShortcut(UNIT_SHORTCUT, { id: ID, name: '../../evil' }, d)
    const b = await createWindowShortcut(UNIT_SHORTCUT, { id: ID, name: '../../evil' }, d)
    expect(a.ok && path.dirname(a.path)).toBe(desktop)
    expect(b.ok && path.dirname(b.path)).toBe(desktop)
    expect(a.ok && b.ok && a.path !== b.path).toBe(true)
    const launch = await fs.readFile(path.join((a as { path: string }).path, 'Contents/MacOS/launch'), 'utf8')
    expect(launch).not.toContain('evil')
  })

  it('windows: icon + name record land in the Unit directory, keyed by device id', async () => {
    const writer = vi.fn<Writer>(() => true)
    const r = await createWindowShortcut(UNIT_SHORTCUT, { id: ID, name: 'Den' }, deps({ platform: 'win32', writeShortcutLink: writer, iconPng: (s) => Buffer.from(`PNG-${s}`) }))
    expect(r).toEqual({ ok: true, path: path.join(desktop, 'Den.lnk') })
    const ico = spaceIconFile(iconDir, ID, 'win32', UNIT_SHORTCUT)!
    expect(path.dirname(ico)).toBe(iconDir)
    expect(writer.mock.calls[0][1]).toMatchObject({ args: `"forsion://unit/${ID}?window=standalone"`, appUserModelId: unitAppUserModelId(ID), icon: ico })
    expect(JSON.parse(await fs.readFile(spaceShortcutMetaFile(iconDir, ID), 'utf8'))).toEqual({ name: 'Den' })
  })

  it('a malformed id is refused before touching the disk', async () => {
    expect(await createWindowShortcut(UNIT_SHORTCUT, { id: 'bad id!', name: 'Den' }, deps({ platform: 'darwin' }))).toEqual({ ok: false, code: 'not_found' })
    expect(await fs.readdir(desktop)).toEqual([])
  })
})

describe('IPC input validation (resolveUnitShortcutTarget)', () => {
  const roster = (units: RosterRead): (() => Promise<RosterRead>) => vi.fn(async () => units)
  const den = { id: ID, name: 'Den from roster', icon: '🦊', platform: 'darwin' }

  it('bad ids are refused without reading the roster', async () => {
    for (const raw of [null, 'x', { id: 42 }, { id: 'short' }, { id: '../../../../etc' }, { id: `${ID}?url=x` }]) {
      const read = roster({ ok: true, units: [den] })
      expect(await resolveUnitShortcutTarget(raw, read)).toEqual({ ok: false, code: 'not_found' })
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('the device must be in the roster read right now; the name comes from the roster, not the renderer', async () => {
    expect(await resolveUnitShortcutTarget({ id: ID, name: 'renderer says $(evil)' }, roster({ ok: true, units: [den] }))).toEqual({ ok: true, unit: den })
    expect(await resolveUnitShortcutTarget({ id: 'abcdefgh-1234' }, roster({ ok: true, units: [den] }))).toEqual({ ok: false, code: 'not_found' })
  })

  it('a failed roster read is "unknown", never "not found"', async () => {
    expect(await resolveUnitShortcutTarget({ id: ID }, roster({ ok: false, code: 'signed_out' }))).toEqual({ ok: false, code: 'signed_out' })
    expect(await resolveUnitShortcutTarget({ id: ID }, roster({ ok: false, code: 'roster_unavailable' }))).toEqual({ ok: false, code: 'roster_unavailable' })
    expect(await resolveUnitShortcutTarget({ id: ID }, async () => { throw new Error('ECONNRESET') })).toMatchObject({ ok: false, code: 'roster_unavailable' })
  })

  it('parseRosterResponse: 200 with units / 401 / anything else', () => {
    expect(parseRosterResponse({ status: 200, json: { units: [den, { id: 7 }, null] } })).toEqual({ ok: true, units: [den] })
    expect(parseRosterResponse({ status: 401, json: null })).toEqual({ ok: false, code: 'signed_out' })
    expect(parseRosterResponse({ status: 502, json: null })).toMatchObject({ ok: false, code: 'roster_unavailable' })
    expect(parseRosterResponse({ status: 200, json: {} })).toMatchObject({ ok: false, code: 'roster_unavailable' })
    expect(parseRosterResponse(undefined)).toMatchObject({ ok: false, code: 'roster_unavailable' })
  })
})

describe('iconPngFromDataUrl', () => {
  const pngHead = (w: number, h: number): Buffer => {
    const b = Buffer.alloc(33)
    b.writeUInt32BE(0x89504e47, 0); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
    return b
  }
  it('accepts a PNG up to 2048 px, refuses everything else', () => {
    expect(iconPngFromDataUrl(`data:image/png;base64,${pngHead(1024, 1024).toString('base64')}`)).toBeInstanceOf(Buffer)
    expect(iconPngFromDataUrl(`data:image/png;base64,${pngHead(4096, 16).toString('base64')}`)).toBeNull()
    expect(iconPngFromDataUrl(`data:image/jpeg;base64,${pngHead(16, 16).toString('base64')}`)).toBeNull()
    expect(iconPngFromDataUrl('data:image/png;base64,AAAA')).toBeNull()
    expect(iconPngFromDataUrl(undefined)).toBeNull()
  })
})
