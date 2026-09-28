/** 作品卡(```forsion-creation)的 `path:` 是模型写的:解析成绝对路径,且必须落在会话工作目录之内 ——
 *  `..` 爬出去、写成别处的绝对路径,一律 null。allowSelf:可不可以就是工作目录本身(项目文件夹整个加入造物;
 *  默认工作区是所有对话共用的大目录,调用方对它传 false)。Windows 盘符路径按大小写不敏感比较。宿主复制时还有一道目录闸。 */
export function resolveInside(cwd: string, rel: string, allowSelf: boolean): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const base = norm(cwd || '').replace(/\/+$/, '')
  const r = norm((rel || '').trim())
  if (!base || !r) return null
  const drive = /^[a-zA-Z]:/.exec(base)?.[0] ?? ''
  const absolute = /^([a-zA-Z]:)?\//.test(r)
  const full = absolute ? r : `${base}/${r}`
  const fullDrive = /^[a-zA-Z]:/.exec(full)?.[0] ?? ''
  const parts: string[] = []
  for (const seg of full.slice(fullDrive.length).split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue }
    parts.push(seg)
  }
  const out = `${fullDrive}/${parts.join('/')}`
  const fold = (s: string): string => (drive ? s.toLowerCase() : s)
  if (fold(out) === fold(base)) return allowSelf ? out : null
  return fold(out).startsWith(`${fold(base)}/`) ? out : null
}
