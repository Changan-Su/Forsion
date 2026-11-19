import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import { isSpaceId, spaceBundleId } from './spaceShortcut'
import { xml } from './productShortcut'

export const macSpaceSocket = (temp: string, profile: string): string =>
  join(temp, `fss-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}`, 'dock.sock')

interface SpaceWindowActions {
  open(id: string): void
  close(id: string): void
  exists(id: string): boolean
}

/** One socket per app profile, created in macOS's private per-user temp directory.
 * Each launcher subscribes to a single Space. Destroy its socket on window close. */
export function startMacSpaceLaunchers(endpoint: string, binary: string, windows: SpaceWindowActions) {
  const launchers = new Map<string, Socket>()
  const starting = new Set<string>()
  let listening = false
  const server = createServer((socket) => {
    let space: string | undefined
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(3000, () => socket.destroy())
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 1024) { socket.destroy(); return }
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const [command, id, extra] = buffer.slice(0, end).split(' ')
        buffer = buffer.slice(end + 1)
        if (extra !== undefined || !isSpaceId(id) || (space && id !== space)) {
          socket.destroy()
          return
        }
        if (!space && (command === 'open' || (command === 'watch' && windows.exists(id)))) {
          // Multiple copies of the same .app can be launched by path. Keep the
          // first instance as the Dock identity and still honor a user's click.
          if (launchers.has(id)) {
            if (command === 'open') windows.open(id)
            socket.destroy()
            return
          }
          space = id
          launchers.set(id, socket)
          starting.delete(id)
          socket.setTimeout(0)
        }
        if (space && command === 'open') windows.open(id)
        else if (space && command === 'close') windows.close(id)
        else if (!space || command !== 'watch') { socket.destroy(); return }
      }
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      if (space && launchers.get(space) === socket) launchers.delete(space)
    })
  })
  server.on('error', (error) => console.warn('[space-shortcut] Dock service:', error))
  // The host already holds Electron's profile singleton lock. Clean up a socket
  // left by a previous crash, leaving anything else at this path alone.
  const directory = dirname(endpoint)
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 ||
        Buffer.byteLength(endpoint) >= 104) throw new Error('Space launcher requires a private Unix socket path')
    try { if (lstatSync(endpoint).isSocket()) rmSync(endpoint) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    server.listen(endpoint, () => { listening = true })
    server.unref()
  } catch (error) {
    console.warn('[space-shortcut] Dock service:', error)
  }

  function matches(bundle: unknown, id: string): bundle is string {
    if (typeof bundle !== 'string' || !isAbsolute(bundle) || !bundle.endsWith('.app')) return false
    try {
      const plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
      return plist.includes(`<key>ForsionSpaceId</key>\t<string>${xml(id)}</string>`) &&
        plist.includes(`<key>ForsionSpaceSocket</key>\t<string>${xml(endpoint)}</string>`)
    } catch { return false }
  }

  function launch(id: string, bundle: string | undefined): void {
    if (!bundle || launchers.has(id) || !windows.exists(id)) {
      starting.delete(id)
      return
    }
    execFile('/usr/bin/open', ['-g', '-n', '-a', bundle, '--args', '--watch'], (error) => {
      if (error) console.warn('[space-shortcut] Dock launcher:', error.message)
      setTimeout(() => starting.delete(id), 2000).unref()
    })
  }

  return {
    show(id: string, bundle: string): void {
      if (!listening || launchers.has(id) || starting.has(id)) return
      starting.add(id)
      if (matches(bundle, id)) { launch(id, bundle); return }
      // Finder may have moved the .app to Applications. Resolve its installed
      // path by bundle ID, then verify it still belongs to this Space/profile.
      execFile(binary, ['--locate', spaceBundleId(id)], (error, output) => {
        let located: string | undefined
        if (!error) {
          try { located = (JSON.parse(output) as unknown[]).find((item) => matches(item, id)) } catch { /* no registered app */ }
        }
        launch(id, located)
      })
    },
    hide(id: string): void {
      const launcher = launchers.get(id)
      launchers.delete(id)
      launcher?.destroy()
      starting.delete(id)
    },
    dispose(): void {
      listening = false
      for (const launcher of launchers.values()) launcher.destroy()
      server.close()
    },
  }
}
