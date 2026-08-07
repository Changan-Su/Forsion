// Build a nested folder tree from flat, vault-relative page paths + folder paths.
// Renderer-only, pure. File nodes keep the original page path verbatim so
// loadPage/rename receive exactly what listPages produced; explicit folders make
// empty directories visible too.

export interface TreeNode {
  name: string
  /** '' for the synthetic root; the '/'-joined folder path for folders; the verbatim page path for files. */
  path: string
  kind: 'folder' | 'file'
  children: TreeNode[]
}

export function buildTree(pages: string[], folders: string[] = []): TreeNode {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] }

  const ensureFolder = (relPath: string): TreeNode => {
    let node = root
    let prefix = ''
    for (const seg of relPath.split(/[\\/]/).filter(Boolean)) {
      prefix = prefix ? `${prefix}/${seg}` : seg
      let child = node.children.find((c) => c.kind === 'folder' && c.name === seg)
      if (!child) {
        child = { name: seg, path: prefix, kind: 'folder', children: [] }
        node.children.push(child)
      }
      node = child
    }
    return node
  }

  for (const f of folders) if (f) ensureFolder(f)

  for (const page of pages) {
    const segs = page.split(/[\\/]/).filter(Boolean)
    if (segs.length === 0) continue
    const fileSeg = segs[segs.length - 1]
    const folderPath = segs.slice(0, -1).join('/')
    const parent = folderPath ? ensureFolder(folderPath) : root
    parent.children.push({ name: fileSeg, path: page, kind: 'file', children: [] })
  }

  sortTree(root)
  return root
}

/** Folders first, then files; each group alphabetized. Recurses into folders. */
function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const c of node.children) if (c.kind === 'folder') sortTree(c)
}

/** 沿文件夹路径下钻,把 `path` 那层当作新的顶层(分享页只展示子树内部,不显示分享根本身)。
 *  路径对不齐就停在已走到的那层。`path` 为空 → 原样返回 root。 */
export function subtreeAt(root: TreeNode, path: string): TreeNode {
  let node = root
  for (const seg of path.split(/[\\/]/).filter(Boolean)) {
    const next = node.children.find((c) => c.kind === 'folder' && c.name === seg)
    if (!next) break
    node = next
  }
  return node
}

/** 通向 `targetPath` 节点的祖先链(不含目标本身),按树实走 —— 所以 mergeFdNotes 之后
 *  作为容器的 `X.md` 文件节点也会出现在链上(它的 path 是 `X.md` 而非 `X.fd`)。找不到返回 null。 */
export function pathTo(node: TreeNode, targetPath: string, acc: string[] = []): string[] | null {
  for (const c of node.children) {
    if (c.path === targetPath) return acc
    if (c.children.length) {
      const hit = pathTo(c, targetPath, [...acc, c.path])
      if (hit) return hit
    }
  }
  return null
}

/** Notion 式合并:同级 `X.fd` 文件夹的孩子挂到 `X.md` 文件节点上,文件夹行本身隐藏;
 *  孤儿 .fd(无同名 .md,精确同名、大小写敏感)保持普通文件夹可见。原地改写并返回 root。 */
export function mergeFdNotes(root: TreeNode): TreeNode {
  const walk = (n: TreeNode): void => {
    const fdByName = new Map(
      n.children.filter((c) => c.kind === 'folder' && c.name.endsWith('.fd')).map((c) => [c.name, c] as const),
    )
    if (fdByName.size) {
      for (const c of n.children) {
        if (c.kind !== 'file' || !/\.md$/i.test(c.name)) continue
        const fd = fdByName.get(c.name.replace(/\.md$/i, '.fd'))
        if (fd) {
          c.children = fd.children
          n.children = n.children.filter((x) => x !== fd)
        }
      }
    }
    for (const c of n.children) walk(c) // 合并后的 file.children 也递归 → .fd 套 .fd 自然生效
  }
  walk(root)
  return root
}
