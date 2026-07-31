/**
 * 同步路径工具:本地子树相对路径 ↔ 服务端 vault 相对路径 的映射与校验。
 * 服务端规则镜像 server/microserver/amadeus/lib/paths.ts 的 normalizePath:
 * '/' 分隔、NFC、无前导 '/'、无反斜杠/控制符、段非空且非 '.'/'..'、≤512。
 * mac 磁盘文件名是 NFD —— 所有 shadow key / 服务端路径一律 NFC 归一。
 */

export const MAX_SERVER_PATH_LEN = 512

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/ // eslint-disable-line no-control-regex

/** 归一并校验服务端路径;非法返回 null(与服务端同判据)。 */
export function normalizeServerPath(input: string): string | null {
  let p = input.replace(/\\/g, '/').normalize('NFC').trim()
  p = p.replace(/\/+$/, '')
  if (!p || p.length > MAX_SERVER_PATH_LEN) return null
  if (p.startsWith('/')) return null
  if (CONTROL_CHARS.test(p)) return null
  const segs = p.split('/')
  for (const s of segs) {
    if (!s || s === '.' || s === '..') return null
  }
  return segs.join('/')
}

/** vault 相对路径(可能带 OS 分隔符)是否位于同步子树内。folder='' = 整库同步(镜像模式)。 */
export function isUnderFolder(vaultRel: string, folder: string): boolean {
  if (folder === '') return true
  const p = vaultRel.replace(/\\/g, '/').normalize('NFC')
  return p === folder || p.startsWith(`${folder}/`)
}

/** vault 相对路径 → 服务端路径(剥掉子树前缀);不在子树内或非法返回 null。folder='' 直通。 */
export function toServerPath(vaultRel: string, folder: string): string | null {
  const p = vaultRel.replace(/\\/g, '/').normalize('NFC')
  if (folder === '') return normalizeServerPath(p)
  if (!p.startsWith(`${folder}/`)) return null
  return normalizeServerPath(p.slice(folder.length + 1))
}

/** 服务端路径 → vault 相对路径(POSIX 分隔;调用方再 path.join 成绝对路径)。 */
export function toVaultRel(serverPath: string, folder: string): string {
  return folder === '' ? serverPath : `${folder}/${serverPath}`
}

/** 不参与同步的文件(两个方向都跳过)。 */
export function isIgnoredName(baseName: string): boolean {
  if (baseName === '.DS_Store' || baseName === 'Icon\r') return true
  if (/\.tmp-\d+-\d+-\d+$/.test(baseName)) return true // vaultManager/引擎的原子写临时文件
  if (/^\..+\.lock$/.test(baseName)) return true // `.<表名>.db.lock` = 跨进程写锁,活不过几毫秒(见 fs/dbLock.ts)
  return false
}

export function kindForServerPath(p: string): 'page' | 'db' | 'binary' {
  if (/\.md$/i.test(p)) return 'page'
  if (/\.db$/i.test(p)) return 'db'
  return 'binary'
}

export const isTextKind = (k: string): boolean => k === 'page' || k === 'db'
