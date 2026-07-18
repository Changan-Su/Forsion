// 页面共享/发布态判定 —— 单一真源(ShareCard 的「继承发布态」与状态栏共享指示共用,不各写一份)。
// 覆盖判定镜像 server microserver/amadeus/lib/pageScope.ts 的 inPageScope(page 恒为 .md,故只需 page/subtree 两分支)。

/** 发布记录(collab.publishes() 的行形状)。 */
export interface PublishRow {
  token: string
  mode: string // 'page' | 'subtree'
  path: string
  createdAt?: string
}

export type PublishState =
  | { kind: 'direct'; token: string }
  | { kind: 'inherited'; via: string; viaMode: 'subtree' | 'page'; token: string }
  | { kind: 'none' }

/** 发布记录 pub 是否覆盖 page 路径 path。mirror inPageScope:
 *  - subtree:root 本身 + 前缀子树;
 *  - page:root 本身 + 其 `<stem>.fd/` 子页面树。 */
export function publishCovers(pub: PublishRow, path: string): boolean {
  if (pub.path === path) return true
  if (pub.mode === 'subtree') return path.startsWith(`${pub.path}/`)
  return path.startsWith(`${pub.path.replace(/\.md$/i, '')}.fd/`) // page 模式:.fd 子页面树
}

/** page 的发布态:直接发布 / 被祖先(文件夹 subtree 或父页 .fd)覆盖 / 未发布。
 *  直接 = 任何 root 恰为本页的发布(优先);否则取第一条覆盖本页的祖先发布。 */
export function publishStateFor(path: string, publishes: PublishRow[]): PublishState {
  const direct = publishes.find((p) => p.path === path)
  if (direct) return { kind: 'direct', token: direct.token }
  const anc = publishes.find((p) => publishCovers(p, path))
  if (anc) return { kind: 'inherited', via: anc.path, viaMode: anc.mode === 'subtree' ? 'subtree' : 'page', token: anc.token }
  return { kind: 'none' }
}
