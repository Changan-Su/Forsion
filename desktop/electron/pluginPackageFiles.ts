import { promises as fs } from 'node:fs'
import path from 'node:path'
import { effectivePluginId } from '../shared/products'

/** Read-only installed-package resources. No vault paths, absolute paths or symlink traversal. */
export async function pluginPackageFiles(root: string, id: string, relative: string, list = false): Promise<string | string[]> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some((s) => s === '..' || s === '.')) throw new Error('Invalid package path')
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(root, entry.name)
    let manifest: { id?: string }
    try { manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) } catch { continue }
    if (effectivePluginId(entry.name, manifest.id) !== id) continue
    // Reject symlinks component by component, including package root. Installed packages are trusted
    // code, but this API must not accidentally grant a path outside that package.
    let target = dir
    for (const part of relative.split('/').filter(Boolean)) {
      target = path.join(target, part)
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Package symlinks are unsupported')
    }
    if (list) {
      const items = await fs.readdir(target, { withFileTypes: true })
      if (items.length > 256) throw new Error('Package directory exceeds 256 entries')
      return items.filter((x) => !x.isSymbolicLink() && !x.name.startsWith('.')).map((x) => x.name).sort()
    }
    const stat = await fs.stat(target)
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Package resource must be a file of at most 8 MiB')
    return fs.readFile(target, 'utf8')
  }
  throw new Error('Installed plugin package not found')
}
