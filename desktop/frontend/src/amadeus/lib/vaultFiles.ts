/** [[链接]] 的「文件命名空间」解析:名字带非 .md 扩展名(xxx.db / photo.png)才进入,
 *  裸名 [[Note]] 永远是页面语义;页面命中永远优先于文件(调用方先查 resolvePageName)。
 *  与 resolvePageName 同精神的简化版:带路径 → 精确匹配或 null;裸名 → 源同目录优先,
 *  再全库字典序首个。刻意住渲染层不进 shared/links.ts(免动 server vendor):
 *  反链/图谱仍是页面级,这里只服务编辑器的补全/点击/装饰。 */

const norm = (p: string): string => p.replace(/\\/g, '/')

/** 名字是否落在文件命名空间(带非 .md 扩展名)。扩展名须含字母:
 *  「v2.0」这类版本号笔记名(数字尾)不是文件引用。 */
export function isFileRef(name: string): boolean {
  return /\.(?=[a-z0-9]*[a-z])[a-z0-9]{1,10}$/i.test(name) && !/\.md$/i.test(name)
}

/** name → 命中的 vault 相对文件路径(files 原样返回,大小写不敏感比较)或 null。 */
export function resolveFileName(name: string, files: string[], sourcePath?: string): string | null {
  if (!isFileRef(name)) return null
  return resolveVaultPath(name, files, sourcePath)
}

/** resolveFileName 去掉「文件命名空间」闸的版本:调用方已经确定这是个文件引用时用。
 *  复合后缀类型(内置的 `.excalidraw.md`、插件声明的 `.mindmap.md` 一类)非用不可 —— 它们以 `.md` 结尾,
 *  被 isFileRef 一律挡在门外,过 resolveFileName 永远返回 null(Codex)。 */
export function resolveVaultPath(name: string, files: string[], sourcePath?: string): string | null {
  const want = norm(name).toLowerCase()
  const key = (p: string): string => norm(p).toLowerCase()
  if (want.includes('/')) return files.find((f) => key(f) === want) ?? null
  const cands = files.filter((f) => key(f).split('/').pop() === want).sort()
  if (cands.length > 1 && sourcePath) {
    const dir = norm(sourcePath).toLowerCase().split('/').slice(0, -1).join('/')
    const same = cands.find((f) => key(f).split('/').slice(0, -1).join('/') === dir)
    if (same) return same
  }
  return cands[0] ?? null
}
