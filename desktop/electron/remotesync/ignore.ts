/**
 * 忽略规则(Forsion 自研):默认规则 + 用户 glob。
 * 语法:`*` 段内通配、`**` 跨段通配、`?` 单字符;
 * 不含 `/` 的模式匹配任意层级的文件/目录名;含 `/` 的匹配完整相对路径;
 * 以 `/` 结尾视为目录前缀(等价 `xxx/**`)。
 */

/** .forsion-sync-id.json = 新同步(Forsion Extend 内容同步)在每个认领的文件夹里写的隐藏标记,只认这台的这次认领:
 *  传上去会让别的设备 / 网页把它当成自己的认领(关掉新同步、换回蓬洲云远程服务的那台就会传),一律不同步。
 *  2026-11-27 智库同步统一方案第 0 步。忽略规则不进基线指纹,加一条不会触发整份重推;基线里留着的旧条目也只是跳过,不产生删除。 */
export const DEFAULT_IGNORES = ['.DS_Store', 'desktop.ini', 'Thumbs.db', '.git/', '.trash/', '.forsion-sync-id.json']

function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/** 编译规则集 → 判定函数(入参 posix 相对路径,不含前导 /)。 */
export function compileIgnore(userGlobs: string[] = []): (relPath: string) => boolean {
  const nameRes: RegExp[] = []
  const pathRes: RegExp[] = []
  for (const raw of [...DEFAULT_IGNORES, ...userGlobs]) {
    const g = raw.trim()
    if (!g || g.startsWith('#')) continue
    if (g.endsWith('/')) pathRes.push(globToRegExp(`${g}**`))
    else if (g.includes('/')) pathRes.push(globToRegExp(g.replace(/^\//, '')))
    else nameRes.push(globToRegExp(g))
  }
  return (relPath: string): boolean => {
    if (pathRes.some((re) => re.test(relPath))) return true
    if (nameRes.length === 0) return false
    return relPath.split('/').some((seg) => nameRes.some((re) => re.test(seg)))
  }
}
