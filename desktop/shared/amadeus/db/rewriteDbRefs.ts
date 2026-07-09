/** .db 改名时的引用重写(纯函数,主进程 renameDbFile 用,可测):
 *  把一页 markdown 里指向旧文件的 `[[..]]` / `![[..]]` 重写到新 basename,保留 `!` 前缀与 `|alias`。
 *  命中规则(与 resolveAttachment 的解析语义对齐):
 *  - 裸 basename(无 '/')=== 旧 basename;
 *  - 路径型 ref:按页目录相对解析 或 按 vault 根解析 等于旧路径(两种都认,resolveAttachment 有根兜底)。
 *  已知缺口:`[名](rel.db)` markdown 链接不重写(v1)。 */

const norm = (s: string): string => s.replace(/\\/g, '/')

/** 极简路径归一(shared 层无 node:path):拼接 + 消 '.'/'..'。 */
const joinNorm = (dir: string, rel: string): string => {
  const raw = dir === '.' || dir === '' ? rel : `${dir}/${rel}`
  const out: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

export function rewriteDbRefs(source: string, opts: { oldRel: string; newBase: string; pageDir: string }): string {
  const oldRel = norm(opts.oldRel)
  const oldBase = oldRel.split('/').pop() ?? oldRel
  const pageDir = norm(opts.pageDir)
  return source.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (m, bang: string, inner: string) => {
    const pipe = inner.indexOf('|')
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    const alias = pipe === -1 ? '' : inner.slice(pipe)
    if (!/\.db$/i.test(target)) return m
    const t = norm(target)
    const hit = t.includes('/')
      ? joinNorm(pageDir, t) === oldRel || joinNorm('', t) === oldRel
      : t === oldBase
    if (!hit) return m
    const newTarget = t.includes('/') ? t.slice(0, t.lastIndexOf('/') + 1) + opts.newBase : opts.newBase
    return `${bang}[[${newTarget}${alias}]]`
  })
}
