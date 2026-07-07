/**
 * 云端 vault 的纯 posix 路径工具:浏览器无 node:path,全部手写(照 mobile 的 path-browserify 先例,
 * 但零依赖)。语义逐条镜像 desktop/electron/amadeus 的实现:
 * - attachmentPaths ← electron/amadeus/fs/attachmentPaths.ts(拖入附件的落位数学)
 * - uniqueNameAmong ← vaultManager.uniqueName(撞名加 -1/-2 后缀)
 * - resolveRef 的纯部件 ← vaultManager.resolveAttachment(<> 剥壳 + safeDecode + basename 大小写不敏感兜底)
 * 所有路径 vault 相对、'/' 分隔。
 */
import type { AttachmentOpts } from '@amadeus-shared/ipc'

/** 目录部分('' = vault 根;不返回 '.',与 node 的 dirname 不同)。 */
export function dirnamePosix(p: string): string {
  const s = p.replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i < 0 ? '' : s.slice(0, i)
}

export function basenamePosix(p: string): string {
  const s = p.replace(/\\/g, '/')
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}

/** 扩展名(含点;隐藏文件 ".env" 无扩展名,与 node 一致)。 */
export function extnamePosix(p: string): string {
  const base = basenamePosix(p)
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i) : ''
}

/** 归一化 './'/'..'/多斜杠;越出根('..' 穿顶)返回 null —— 即 vault 越界钳制的纯函数版。 */
export function normalizePosix(p: string): string | null {
  const out: string[] = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

/** posix relative(from 是目录,'' = 根);结果可以 '../' 开头(页面相对链接需要)。 */
export function relativePosix(fromDir: string, to: string): string {
  const f = fromDir.split('/').filter((s) => s && s !== '.')
  const t = to.split('/').filter((s) => s && s !== '.')
  let i = 0
  while (i < f.length && i < t.length && f[i] === t[i]) i++
  const parts = [...Array<string>(f.length - i).fill('..'), ...t.slice(i)]
  return parts.join('/') || '.'
}

/** 文件名可含裸 '%'(如 "100% done.png"),decodeURIComponent 会抛 → 原样回退(镜像 vaultManager)。 */
export function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/** `![[<ref>]]` 的 ref 可能被 <> 包裹:剥壳 + trim(镜像 vaultManager.resolveAttachment)。 */
export function stripRefWrappers(ref: string): string {
  return ref.replace(/^<|>$/g, '').trim()
}

/** 大小写不敏感的 basename 兜底搜索(镜像 findByBasename,但走树缓存而非磁盘)。 */
export function findByBasenameIn(paths: Iterable<string>, basename: string): string | null {
  const target = basename.toLowerCase()
  for (const p of paths) {
    if (basenamePosix(p).toLowerCase() === target) return p
  }
  return null
}

/** 拖入附件的落位数学 —— 逐行移植 electron/amadeus/fs/attachmentPaths.ts(node:path → 本地纯函数)。
 *  destDirRel 与文件名无关(可先算再去重名);pageRel 相对笔记目录(可 '../' 开头)。 */
export function attachmentPaths(
  pagePath: string,
  base: string,
  opts: AttachmentOpts,
): { destDirRel: string; fileVaultRel: string; pageRel: string } {
  const pageDirRel = dirnamePosix(pagePath)
  const clean = (s: string): string => s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const destDirRel =
    opts.mode === 'same' ? pageDirRel
    : opts.mode === 'vault' ? clean(opts.folder)
    : clean(`${pageDirRel}/attachments`)
  const fileVaultRel = destDirRel ? `${destDirRel}/${base}` : base
  const pageRel = relativePosix(pageDirRel, fileVaultRel)
  return { destDirRel, fileVaultRel, pageRel }
}

/** 目录内免撞文件名:扩展名前加 "-1"/"-2"…(镜像 vaultManager.uniqueName;existing = 目录内已有
 *  basename 的小写集合)。1000 次仍撞 → 时间戳兜底。 */
export function uniqueNameAmong(existing: ReadonlySet<string>, name: string): string {
  const ext = extnamePosix(name)
  const stem = name.slice(0, name.length - ext.length) || 'file'
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${stem}-${i}${ext}`
    if (!existing.has(candidate.toLowerCase())) return candidate
  }
  return `${stem}-${Date.now().toString(36)}${ext}`
}
