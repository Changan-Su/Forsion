/**
 * 「进造物」的宿主半边(2026-09-27):在托管根(~/Forsion/Project)里建一个新作品文件夹,或把别处做好的文件夹**复制**进来。
 * 起因:Tangu Space 里做出来的东西落在 `<笔记库>/Sessions` 或用户自己的文件夹,造物只认托管根的直接子目录,于是永远进不去。
 * 为什么复制不移动:移动会弄断笔记里的链接和原会话的目录;登记外部目录又和「宿主绝不在导入目录里建仓」冲突(方案见 docs/Log 09-27)。
 *
 * 无 Electron 依赖(纯 node fs),IPC 接线在 productsIpc。**源目录来自模型写的卡片**(渲染层先限定在会话工作目录内),
 * 这里再过一遍目录闸:根 / 家目录 / 家目录的上级 / 托管根本身 / 托管根里面 / 托管根的上级(复制进自己 = 无限递归)一律拒。
 * 复制时软链一律不跟(不带出目录外的东西)、跳过 .git 与 node_modules(版本由宿主重建、依赖可再装)、跳过两个作品身份文件
 * (身份由注册表重铸,免得和源作品撞 id / 误标「已发布」);先量体积再动手,超上限不复制。
 */
import { promises as fs, type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface AdoptLimits { maxFiles: number; maxBytes: number }
export const ADOPT_LIMITS: AdoptLimits = { maxFiles: 5000, maxBytes: 500 * 1024 * 1024 }
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const SKIP_FILES = new Set(['.forsion-product.json', '.forsion-connect.json'])
const NAME_MAX = 100

/** 带稳定 code 的失败:渲染层按 code 出本地化文案。 */
export class AdoptError extends Error {
  constructor(readonly code: 'invalid_source' | 'forbidden_source' | 'too_large', message: string, readonly detail?: string) { super(message) }
}

/** 作品文件夹名:与 Launchpad 的 validateProjectName 同一套禁区(路径分隔符 / 保留名 / 首尾的点),不合格的字符换成 `-`,
 *  清完是空的就退回 fallback。 */
export function safeCreationName(raw: string, fallback = 'creation'): string {
  let name = String(raw || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim()
  name = name.replace(/^[.\s-]+|[.\s]+$/g, '').slice(0, NAME_MAX).trim()
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `${name}-app`
  return name || (fallback === 'creation' ? fallback : safeCreationName(fallback))
}

/** 托管根里还没被占的名字:撞名(大小写不敏感,APFS / NTFS 默认如此)就接 ` 2`、` 3`…… */
async function uniqueName(root: string, base: string): Promise<string> {
  const taken = new Set((await fs.readdir(root).catch(() => [] as string[])).map((n) => n.normalize('NFC').toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; i < 1000; i++) {
    const next = `${base.slice(0, NAME_MAX - String(i).length - 1)} ${i}`
    if (!taken.has(next.toLowerCase())) return next
  }
  throw new Error('too many creations with the same name')
}

/** 新建一个空的作品文件夹(独占创建:并发的第二个请求拿到下一个名字,不会共用同一个目录)。 */
export async function createCreationDir(projectsRoot: string, name: string): Promise<{ dir: string; name: string }> {
  await fs.mkdir(projectsRoot, { recursive: true })
  for (let attempt = 0; attempt < 5; attempt++) {
    const final = await uniqueName(projectsRoot, safeCreationName(name))
    const dir = path.join(projectsRoot, final)
    try { await fs.mkdir(dir); return { dir, name: final } } catch (e: any) { if (e?.code !== 'EEXIST') throw e }
  }
  throw new Error('could not reserve a folder name')
}

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 源目录闸(realpath 之后判)。 */
async function checkSource(projectsRoot: string, source: string, home: string): Promise<string> {
  if (typeof source !== 'string' || !path.isAbsolute(source)) throw new AdoptError('invalid_source', 'The source folder must be an absolute path')
  const real = await fs.realpath(source).catch(() => null)
  const st = real ? await fs.stat(real).catch(() => null) : null
  if (!real || !st?.isDirectory()) throw new AdoptError('invalid_source', 'The source folder does not exist', source)
  const homeReal = await fs.realpath(home).catch(() => path.resolve(home))
  const rootReal = await fs.realpath(projectsRoot).catch(() => path.resolve(projectsRoot))
  const forbidden = real === path.parse(real).root || inside(homeReal, real) // 根 / 家目录 / 家目录的上级
    || inside(real, rootReal) || inside(rootReal, real)                        // 已在托管根里 / 托管根的上级(会复制进自己)
  if (forbidden) throw new AdoptError('forbidden_source', 'This folder cannot be added to Creations', real)
  return real
}

/** 先量:文件数与总字节(跳过的东西不算),超上限直接拒。 */
async function measure(dir: string, limits: AdoptLimits): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (current: string): Promise<void> => {
    let items: Dirent[]
    try { items = await fs.readdir(current, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (item.isSymbolicLink()) continue
      const full = path.join(current, item.name)
      if (item.isDirectory()) { if (!SKIP_DIRS.has(item.name)) await walk(full); continue }
      if (!item.isFile() || SKIP_FILES.has(item.name)) continue
      files += 1
      bytes += (await fs.lstat(full).catch(() => null))?.size ?? 0
      if (files > limits.maxFiles || bytes > limits.maxBytes) throw new AdoptError('too_large', 'The folder is too large to add to Creations', `${files} files, ${Math.round(bytes / 1024 / 1024)} MB`)
    }
  }
  await walk(dir)
  return { files, bytes }
}

/** 把 source 复制成托管根里的一个新作品。失败时删掉复制了一半的目标,不留半截作品。 */
export async function adoptIntoProjects(projectsRoot: string, source: string, name: string, opts: { home?: string; limits?: AdoptLimits } = {}): Promise<{ dir: string; name: string; files: number; bytes: number }> {
  const real = await checkSource(projectsRoot, source, opts.home ?? os.homedir())
  const size = await measure(real, opts.limits ?? ADOPT_LIMITS)
  const target = await createCreationDir(projectsRoot, safeCreationName(name, path.basename(real)))
  try {
    await fs.cp(real, target.dir, {
      recursive: true, force: false, errorOnExist: false,
      filter: async (src) => {
        if (src === real) return true
        const st = await fs.lstat(src).catch(() => null)
        if (!st || st.isSymbolicLink()) return false
        const base = path.basename(src)
        return st.isDirectory() ? !SKIP_DIRS.has(base) : !SKIP_FILES.has(base)
      },
    })
  } catch (e) {
    await fs.rm(target.dir, { recursive: true, force: true }).catch(() => {})
    throw e
  }
  return { ...target, ...size }
}
