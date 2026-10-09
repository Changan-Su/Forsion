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
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { writePrivateJson } from './configWrite'

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

// After the icon, LaunchServices is asked to read the bundle again: the usual remedy for a Dock that keeps drawing a
// pinned app's old icon. (That the Dock tile follows was not observed when this was written — reading it needs screen recording.)
const SET_ICON = "ObjC.import('AppKit');ObjC.import('CoreServices');function run(a){var ok=$.NSWorkspace.sharedWorkspace.setIconForFileOptions(a[1]?$.NSImage.alloc.initWithContentsOfFile(a[1]):$(),a[0],0);$.LSRegisterURL($.NSURL.fileURLWithPath(a[0]),true);return ok?'ok':'failed'}"
export const setFinderIcon = async (bundle: string, image?: string): Promise<boolean> =>
  (await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SET_ICON, bundle, ...(image ? [image] : [])], { timeout: 20_000 })).stdout.trim() === 'ok'

/** Identifies the custom icon now on the bundle ('' = none), so this app only ever takes back the one it put there. */
async function finderIconMark(bundle: string): Promise<string> {
  const icon = join(bundle, 'Icon\r')
  try {
    const { mtimeMs } = await stat(icon)
    // The picture itself is the file's resource fork (macOS only; elsewhere the timestamp alone).
    const fork = await stat(join(icon, '..namedfork', 'rsrc')).then((s) => s.size, () => 0)
    return `${mtimeMs}:${fork}`
  } catch { return '' }
}

export interface MacIconTarget {
  /** The .app directory. */
  bundle: string
  /** Where the picture and the record of what was applied live (userData). */
  dir: string
  set?: typeof setFinderIcon
}
/** What this app last put on the bundle. A write that failed never replaces it. */
interface Applied { key: string; mark: string }

export async function keepMacIcon(target: MacIconTarget, key: string | null, png: () => Buffer): Promise<void> {
  const { bundle, dir, set = setFinderIcon } = target
  const record = join(dir, 'system-icon.json'), image = join(dir, 'system-icon.png')
  let last: Applied | null = null
  try { last = JSON.parse(await readFile(record, 'utf8')) as Applied } catch { /* nothing applied yet */ }
  const now = await finderIconMark(bundle)
  if (!key) {
    // Only this app's own icon is taken back: one pasted in Finder's Get Info since then (another mark) stays.
    // Not taken back this time → the record stays, and the next launch tries again.
    if (last && now && now === last.mark && !(await set(bundle).catch(() => false))) return
    await Promise.all([rm(record, { force: true }), rm(image, { force: true })])
    return
  }
  const id = digest(key)
  // Already there — or the user pasted an icon of their own over it, which stays until another one is picked here.
  // No custom icon at all means an update replaced the bundle: written again.
  if (last?.key === id && now) return
  await mkdir(dir, { recursive: true })
  await writeFile(image, png())
  // Refused (read-only volume, another user's install): the record keeps describing what is still there; tried again at the next launch.
  if (!(await set(bundle, image).catch(() => false))) return
  await writePrivateJson(record, { key: id, mark: await finderIconMark(bundle) } satisfies Applied)
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
/** Older pictures kept on disk: a shortcut this app cannot see or rewrite (moved elsewhere, all-users) may still use one. */
const KEPT_ICONS = 8
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export async function keepWindowsIcon(target: WindowsIconTarget, key: string | null, png: () => Buffer, size: number): Promise<void> {
  const { shell, folders, exe, dir } = target
  // Explorer caches icons by path: every picture gets its own file name.
  const file = key ? join(dir, `app-icon-${digest(key)}.ico`) : null
  if (file && !existsSync(file)) {
    await mkdir(dir, { recursive: true })
    // Whole or not at all: a truncated file under the final name would be handed to every shortcut from then on.
    await writeFile(`${file}.tmp`, icoFromPng(png(), size))
    await rename(`${file}.tmp`, file)
  }
  for (const folder of folders) for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!/\.lnk$/i.test(name)) continue
    const link = join(folder, name)
    try {
      const now = shell.readShortcutLink(link)
      if (!same(now.target, exe)) continue
      const ours = !!now.icon && same(dirname(now.icon), dir) && ICO.test(basename(now.icon).toLowerCase())
      // Without a picture only our own icon is taken back: one the user set on a shortcut stays.
      if (file ? same(now.icon ?? '', file) : !ours) continue
      shell.writeShortcutLink(link, 'update', { target: now.target, icon: file ?? exe, iconIndex: 0 })
    } catch { /* unreadable, or an all-users shortcut this account cannot write: left as it is */ }
  }
  const old: { path: string; at: number }[] = []
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name)
    if (ICO.test(name) && !(file && same(path, file))) old.push({ path, at: await stat(path).then((s) => s.mtimeMs, () => 0) })
  }
  old.sort((a, b) => b.at - a.at)
  for (const { path } of old.slice(KEPT_ICONS - 1)) await rm(path, { force: true })
}
