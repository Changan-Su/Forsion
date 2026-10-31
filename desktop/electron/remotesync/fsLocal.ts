/**
 * 本地磁盘侧(Forsion 自研):
 *  - walkLocalFiles / sha256 / atomicWrite:引擎用的本地库扫描与写入工具
 *  - createDirRemote:把一个目录当远端(folder 后端:U 盘 / NAS 挂载点;也是测试假远端)
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RemoteFs } from './types'
import { writeFileDurable } from '../amadeus/fs/renameAtomic'

export interface LocalFile {
  key: string
  size: number
  mtimeMs: number
  absPath: string
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 递归列出 root 下全部普通文件(跳过符号链接);key = posix 相对路径。root 不存在 → throw。 */
export async function walkLocalFiles(root: string): Promise<LocalFile[]> {
  const out: LocalFile[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true })
    for (const it of items) {
      const abs = path.join(dir, it.name)
      const key = rel ? `${rel}/${it.name}` : it.name
      if (it.isSymbolicLink()) continue
      if (it.isDirectory()) {
        await walk(abs, key)
      } else if (it.isFile()) {
        const st = await fs.stat(abs)
        out.push({ key, size: st.size, mtimeMs: Math.floor(st.mtimeMs), absPath: abs })
      }
    }
  }
  await walk(root, '')
  return out
}

/** 原子写(同目录 tmp + fsync + rename,见 writeFileDurable)+ 尽力对齐 mtime(跨设备 stat 缓存命中)。
 *  临时名带随机后缀:writeFileDurable 独占创建,只带 pid 时崩溃留下的同名残渣会让之后每次写都 EEXIST。
 *  不拼目标文件名:长文件名再加 UUID 会超 255 字符上限(ENAMETOOLONG);点开头,库 watcher 不当成新文件。 */
export async function atomicWrite(absPath: string, data: Buffer, mtimeMs?: number): Promise<void> {
  const dir = path.dirname(absPath)
  await fs.mkdir(dir, { recursive: true })
  await writeFileDurable(absPath, path.join(dir, `.rsync-tmp-${process.pid}-${randomUUID()}`), data)
  if (mtimeMs && mtimeMs > 0) {
    await fs.utimes(absPath, new Date(mtimeMs), new Date(mtimeMs)).catch(() => {})
  }
}

/** 目录当远端。身份 = mtime+size(ponytail: 同毫秒同大小的改动检测不到,够用;要更强换内容 hash)。 */
export function createDirRemote(root: string): RemoteFs {
  const abs = (key: string): string => {
    const p = path.join(root, ...key.split('/'))
    const resolved = path.resolve(p)
    if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
      throw new Error(`key escapes root: ${key}`)
    }
    return resolved
  }
  return {
    kind: 'folder',
    async walk() {
      const files = await walkLocalFiles(root)
      return files.map((f) => ({ key: f.key, size: f.size, mtimeMs: f.mtimeMs, id: `${f.mtimeMs}:${f.size}` }))
    },
    async readFile(key) {
      return fs.readFile(abs(key))
    },
    async writeFile(key, data, mtimeMs) {
      await atomicWrite(abs(key), data, mtimeMs)
      const st = await fs.stat(abs(key))
      const mt = Math.floor(st.mtimeMs)
      return { key, size: st.size, mtimeMs: mt, id: `${mt}:${st.size}` }
    },
    async rm(key) {
      await fs.rm(abs(key), { force: true })
    },
    async check() {
      try {
        await fs.mkdir(root, { recursive: true })
        await fs.access(root)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) }
      }
    },
  }
}
