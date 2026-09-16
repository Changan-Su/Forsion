// 移植自 desktop/electron/amadeus/fs/attachmentPaths.ts —— 纯路径运算(vault 相对,POSIX)。
// path-browserify 本身即 POSIX 实现,故 path.posix.* 直接用 path.*。
import path from 'path-browserify'

export interface AttachmentPlacement {
  mode: 'attachments' | 'same' | 'vault'
  folder: string
}

export function attachmentPaths(
  pagePath: string,
  base: string,
  opts: AttachmentPlacement,
): { destDirRel: string; fileVaultRel: string; pageRel: string } {
  const dir = path.dirname(pagePath.replace(/\\/g, '/'))
  const pageDirRel = dir === '.' ? '' : dir
  const clean = (s: string): string => s.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const destDirRel =
    opts.mode === 'same' ? pageDirRel
    : opts.mode === 'vault' ? clean(opts.folder)
    : clean(`${pageDirRel}/attachments`)
  const fileVaultRel = destDirRel ? `${destDirRel}/${base}` : base
  // 两端补 '/' 成绝对路径再求相对:path-browserify 遇相对路径会回落 process.cwd(),WebView 里没有 process
  // (本地库 saveAttachment 曾因此一律抛)。库内路径下结果与 desktop 的 node 版逐格一致(scripts/attachment-paths.test.cjs)。
  const pageRel = path.relative(`/${pageDirRel}`, `/${fileVaultRel}`)
  return { destDirRel, fileVaultRel, pageRel }
}
