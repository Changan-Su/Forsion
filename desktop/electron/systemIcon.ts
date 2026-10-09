/**
 * The chosen app icon, kept after Forsion quits. `dock.setIcon` / `win.setIcon` only last as long as the process:
 *  - macOS: a Finder custom icon on the .app (`Icon\r` beside `Contents/`, outside the signature's seal) — what Finder,
 *    the Dock and Launchpad draw for an app that is not running. Electron has no call for it; AppKit does.
 *  - Windows: the icon of our own Start menu / desktop / taskbar shortcuts.
 * An update replaces the bundle and recreates the shortcuts, so the caller runs this on every launch: both are
 * no-ops when nothing changed. Linux (AppImage) has no install to write to.
 * `key` identifies the picture (null = default artwork); `png` is only asked for when something has to be written.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const digest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16)

/** A PNG wrapped as a one-image .ico (PNG entries are read since Vista; a size byte of 0 means 256). */
export function icoFromPng(png: Buffer, size: number): Buffer {
  const head = Buffer.alloc(22)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(1, 4) // one image
  head[6] = head[7] = size >= 256 ? 0 : size
  head.writeUInt16LE(1, 10) // planes
  head.writeUInt16LE(32, 12) // bits per pixel
  head.writeUInt32LE(png.length, 14)
  head.writeUInt32LE(head.length, 18)
  return Buffer.concat([head, png])
}

const SET_ICON = "ObjC.import('AppKit');function run(a){return $.NSWorkspace.sharedWorkspace.setIconForFileOptions(a[1]?$.NSImage.alloc.initWithContentsOfFile(a[1]):$(),a[0],0)?'ok':'failed'}"
const setFinderIcon = async (bundle: string, image?: string): Promise<boolean> =>
  (await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SET_ICON, bundle, ...(image ? [image] : [])], { timeout: 20_000 })).stdout.trim() === 'ok'

export interface MacIconTarget {
  /** The .app directory. */
  bundle: string
  /** Where the picture and the record of what was applied live (userData). */
  dir: string
  version: string
  set?: typeof setFinderIcon
}
interface Applied { key: string; version: string; ok: boolean }

export async function keepMacIcon(target: MacIconTarget, key: string | null, png: () => Buffer): Promise<void> {
  const { bundle, dir, version, set = setFinderIcon } = target
  const record = join(dir, 'system-icon.json'), image = join(dir, 'system-icon.png')
  let last: Applied | null = null
  try { last = JSON.parse(await readFile(record, 'utf8')) as Applied } catch { /* nothing applied yet */ }
  const present = existsSync(join(bundle, 'Icon\r'))
  if (!key) {
    // Only what this app put there is taken back: an icon the user pasted in Finder's Get Info stays.
    if (last?.ok && present) await set(bundle).catch(() => false)
    await Promise.all([rm(record, { force: true }), rm(image, { force: true })])
    return
  }
  const id = digest(key)
  // A refused write (read-only volume, another user's install) is not retried until the picture or the app changes.
  if (last?.key === id && (last.ok ? present : last.version === version)) return
  await mkdir(dir, { recursive: true })
  await writeFile(image, png())
  const ok = await set(bundle, image).catch(() => false)
  await writeFile(record, JSON.stringify({ key: id, version, ok } satisfies Applied))
}

export interface WindowsIconTarget {
  shell: {
    readShortcutLink(path: string): { target: string; icon?: string }
    writeShortcutLink(path: string, operation: 'update', options: { target: string; icon: string; iconIndex: number }): boolean
  }
  /** Folders that may hold a shortcut to this install. */
  folders: string[]
  exe: string
  /** Where the .ico is written (userData). */
  dir: string
}
const ICO = /^app-icon-[0-9a-f]+\.ico$/
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export async function keepWindowsIcon(target: WindowsIconTarget, key: string | null, png: () => Buffer, size: number): Promise<void> {
  const { shell, folders, exe, dir } = target
  // Explorer caches icons by path: every picture gets its own file name.
  const file = key ? join(dir, `app-icon-${digest(key)}.ico`) : null
  if (file && !existsSync(file)) {
    await mkdir(dir, { recursive: true })
    await writeFile(file, icoFromPng(png(), size))
  }
  let left = false
  for (const folder of folders) for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!/\.lnk$/i.test(name)) continue
    const link = join(folder, name)
    let now: { target: string; icon?: string }
    try { now = shell.readShortcutLink(link) } catch { continue }
    if (!same(now.target, exe)) continue
    const ours = !!now.icon && same(dirname(now.icon), dir) && ICO.test(basename(now.icon).toLowerCase())
    // Without a picture only our own icon is taken back: one the user set on a shortcut stays.
    if (file ? same(now.icon ?? '', file) : !ours) continue
    let written = false
    try { written = shell.writeShortcutLink(link, 'update', { target: now.target, icon: file ?? exe, iconIndex: 0 }) } catch { /* an all-users shortcut this account cannot write */ }
    left ||= !written
  }
  // A shortcut that could not be rewritten may still point at an older file.
  if (left) return
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (ICO.test(name) && (!file || !same(join(dir, name), file))) await rm(join(dir, name), { force: true })
  }
}
