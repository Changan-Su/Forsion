/** Private device workspace. Cloud visitor storage remains in accountHttp. */
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, realpath, readdir, stat } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { pickUnitPreferences } from '../desktop/shared/unitPreferences'

export async function localOwnerToken(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const path = resolve(dataDir, 'owner-token')
  try { await writeFile(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }) }
  catch (error: any) { if (error.code !== 'EEXIST') throw error }
  const token = (await readFile(path, 'utf8')).trim()
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local workspace owner token')
  return token
}

export async function createLocalWorkspace(dataDir: string, workspaceDir: string, vaultRoot: () => string | null) {
  await mkdir(workspaceDir, { recursive: true, mode: 0o700 })
  const token = await localOwnerToken(dataDir)
  const device = { id: 'local-owner', name: 'Workspace owner', tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: 0 }
  const file = resolve(dataDir, 'preferences.json')
  const read = async () => {
    try { return pickUnitPreferences(JSON.parse(await readFile(file, 'utf8'))) }
    catch (error: any) { if (error.code === 'ENOENT') return {}; throw error }
  }
  let writes = Promise.resolve()
  const scoped = async (path: string) => {
    try {
      const actual = await realpath(path)
      for (const root of [workspaceDir, vaultRoot()].filter(Boolean) as string[]) {
        const realRoot = await realpath(root)
        if (actual === realRoot || actual.startsWith(realRoot + sep)) return actual
      }
    } catch { /* inaccessible is indistinguishable from out of scope */ }
    return null
  }
  return {
    token, device,
    readConfig: async () => ({ ...await read(), homeDir: workspaceDir, defaultWorkspaceDir: workspaceDir }),
    writeConfig: async (patch: Record<string, unknown>) => {
      const job = writes.then(async () => {
        const next = { ...await read(), ...pickUnitPreferences(patch) }
        const tmp = `${file}.${randomUUID()}.tmp`
        await writeFile(tmp, JSON.stringify(next), { mode: 0o600 }); await rename(tmp, file)
      })
      writes = job.catch(() => {})
      await job
      return { ...await read(), homeDir: workspaceDir, defaultWorkspaceDir: workspaceDir }
    },
    readHostFile: async (path: string, maxBytes = 50 * 1024 * 1024) => {
      const real = await scoped(path)
      if (!real) return null
      const st = await stat(real)
      if (!st.isFile()) return null
      const types: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }
      const mimeType = types[extname(real).toLowerCase()] || 'application/octet-stream'
      if (st.size > Math.min(maxBytes, 50 * 1024 * 1024)) return { mimeType, content: '', size: st.size, mtimeMs: st.mtimeMs, tooLarge: true }
      return { mimeType, content: (await readFile(real)).toString('base64'), size: st.size, mtimeMs: st.mtimeMs }
    },
    readHostDir: async (path: string) => {
      const real = await scoped(path)
      if (!real || !(await stat(real)).isDirectory()) return null
      const entries = await readdir(real, { withFileTypes: true })
      const values = await Promise.all(entries.slice(0, 2000).map(async (e) => {
        const child = await scoped(resolve(real, e.name))
        if (!child) return null
        const st = await stat(child)
        return { name: e.name, isDir: st.isDirectory(), size: st.size, path: child }
      }))
      return values.filter((e): e is NonNullable<typeof e> => !!e).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    },
    readHostStat: async (path: string) => {
      const real = await scoped(path)
      if (!real) return null
      const st = await stat(real)
      return { isDir: st.isDirectory(), mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs || null }
    },
  }
}
