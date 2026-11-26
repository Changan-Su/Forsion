/**
 * 两条路径在盘上是什么关系(同一个 / 一个在另一个里面 / 不相干 / 说不准),无 Electron 依赖。
 * 本机多 Unit 的「别碰默认那台的数据」都靠它:比的是**真实路径**(软链 / 别名解开)再加目录身份(dev + ino)兜底,
 * 不比路径字符串 —— `~/Forsion` 软链到某个 Unit 文件夹里、大小写不同的写法、同一卷挂了两处,字符串比较都看不出来。
 *
 * 说不准(没权限、悬空软链、软链成环)一律回 unknown,调用方按「有冲突」处理(拒绝),不当成「不相干」放行。
 */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** a 相对于 b:equal 同一个;inside a 在 b 里面;contains a 盖住了 b;none 不相干;unknown 说不准。 */
export type PathRelation = 'equal' | 'inside' | 'contains' | 'none' | 'unknown'

const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'
const norm = (p: string): string => (FOLD_CASE ? p.toLowerCase() : p)
const withSep = (p: string): string => (p.endsWith(sep) ? p : p + sep)
const missing = (e: unknown): boolean => {
  const c = (e as NodeJS.ErrnoException)?.code
  return c === 'ENOENT' || c === 'ENOTDIR'
}

/**
 * 真实路径:存在 → realpath;还不存在 → 最近一级存在的祖先的真实路径 + 余下几段(还没建的路径照样能比);
 * 存在但解不开(悬空软链、没权限、成环)→ null。
 */
export function realPathLoose(p: string): string | null {
  const rest: string[] = []
  let cur = resolve(p)
  for (;;) {
    try {
      const real = realpathSync.native(cur)
      return rest.length ? join(real, ...rest.reverse()) : real
    } catch (e) {
      if (!missing(e)) return null
      try { lstatSync(cur); return null } catch (le) { if (!missing(le)) return null } // lstat 得到、realpath 不行 = 悬空软链
      const parent = dirname(cur)
      if (parent === cur) return null
      rest.push(basename(cur))
      cur = parent
    }
  }
}

type DevIno = { dev: number; ino: number }
const idOf = (p: string): DevIno | null => {
  try { const st = statSync(p); return { dev: st.dev, ino: st.ino } } catch { return null }
}
const same = (a: DevIno, b: DevIno): boolean => a.dev === b.dev && a.ino === b.ino
/** p 自己和它每一级祖先里存在的那些的身份。 */
function chainIds(p: string): DevIno[] {
  const out: DevIno[] = []
  for (let cur = p; ; cur = dirname(cur)) {
    const id = idOf(cur)
    if (id) out.push(id)
    if (dirname(cur) === cur) return out
  }
}

export function pathRelation(a: string, b: string): PathRelation {
  const ra = realPathLoose(a)
  const rb = realPathLoose(b)
  if (!ra || !rb) return 'unknown'
  const na = norm(ra), nb = norm(rb)
  if (na === nb) return 'equal'
  if (na.startsWith(withSep(nb))) return 'inside'
  if (nb.startsWith(withSep(na))) return 'contains'
  // 字符串不相干时再按身份核:同一个目录挂在两处(bind mount、大小写写法不同)也认得出
  const ida = idOf(ra), idb = idOf(rb)
  if (ida && idb && same(ida, idb)) return 'equal'
  if (idb && chainIds(dirname(ra)).some((x) => same(x, idb))) return 'inside'
  if (ida && chainIds(dirname(rb)).some((x) => same(x, ida))) return 'contains'
  return 'none'
}

/**
 * 要护住的路径:
 *  · strict:谁都不许和它沾边(相同 / 在它里面 / 盖住它)—— 默认那台的 home、userData、工作区、别的 Unit 的文件夹;
 *  · cover:只是不许相同或盖住它(家目录本身:Unit 当然放在家目录里面,但不能就是家目录、也不能是它的上级);
 *  · legacyParents:旧的开发版缺省父目录(~/.forsion-dev/units)。在它**里面**的路径对「包含它的 strict 根」网开一面
 *    (老的开发版 Unit 照样能开、能清自己的数据);默认那台清数据时另有一道「名册里的 Unit 在要删的路径里就整个不删」兜着。
 */
export interface PathGuard { strict: readonly string[]; cover: readonly string[]; legacyParents?: readonly string[] }

/** p 和要护住的路径冲突 → 回冲突的那条(说不准也算冲突);不冲突 → null。 */
export function guardConflict(p: string, g: PathGuard): string | null {
  for (const root of g.strict) {
    const rel = pathRelation(p, root)
    if (rel === 'none') continue
    if (rel === 'inside' && (g.legacyParents ?? []).some((l) => {
      const inLegacy = pathRelation(p, l)
      const legacyUnderRoot = pathRelation(l, root)
      return inLegacy === 'inside' && (legacyUnderRoot === 'inside' || legacyUnderRoot === 'equal')
    })) continue
    return root
  }
  for (const root of g.cover) {
    const rel = pathRelation(p, root)
    if (rel === 'equal' || rel === 'contains' || rel === 'unknown') return root
  }
  return null
}
