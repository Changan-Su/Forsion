/**
 * 智库同步第 4 步 U4:撤掉「本次刚建、还空着」的库文件夹(新建智库撞了云端的名字 / 落盘在建好文件夹之后失败)。
 *
 * 只在三件事都确认了才动:这一次是宿主新建的(created)、此刻没有绑定指着它、它还是空的(一个条目都没有)。
 * 任何一件读不出 = 不知道 = 留着(读失败 ≠ 空,CLAUDE.md「读写用户数据」)。动的顺序:先删空目录、再从清单移除 ——
 * 删不掉(这期间被写进了东西)就整个留着、照旧在清单里,绝不先把一个可能有内容的文件夹从清单里藏起来。
 * 宿主那边的删除必须是非递归的 rmdir(这里先查后删有竞态,文件夹在两步之间被写进东西时 rmdir 自己会失败)。
 * 没有 JSX、不出文案:回码,界面按码说。
 */

/** 宿主给的几样(都要注入;测试给桩)。 */
export interface CreatedFolderHost {
  /** 只读:目录里一个条目都没有 = true;有任何条目(含点开头的)= false;读不出 / 不是目录 = null。 */
  isEmptyDir(root: string): Promise<boolean | null>
  /** 此刻有绑定(任何去处、停用的也算)指着的本机根;读不出 = null。 */
  boundRoots(): Promise<string[] | null>
  /** 它是不是当前库 / 钉住的库(宿主 listVaults 的 current / pinned);读不出 = null。 */
  inUse(root: string): Promise<boolean | null>
  /** 从智库清单移除(文件不动)。当前库 / 钉住的库回 false。 */
  forgetVault(root: string): Promise<boolean>
  /** 删空目录:宿主必须用非递归 rmdir,目录不空就抛。 */
  removeEmptyDir(root: string): Promise<void>
  /** 两个路径是不是同一个(宿主口径:大小写、分隔符);缺省逐字比。 */
  samePath?(a: string, b: string): boolean
}

export type DiscardOutcome =
  /** 清单里去掉了、空文件夹也删了 */
  | 'removed'
  /** 不是这一次建的(本来就在):留着 */
  | 'kept_not_created'
  /** 有绑定指着它:留着 */
  | 'kept_bound'
  /** 读不出绑定:不知道,留着 */
  | 'kept_bindings_unknown'
  /** 里面有东西了:留着 */
  | 'kept_not_empty'
  /** 读不出是不是空的:留着 */
  | 'kept_unreadable'
  /** 它成了当前库 / 钉住的库,或读不出是不是:留着 */
  | 'kept_in_use'
  /** 删目录失败(多半是这期间被写进了东西):整个留着,照旧在清单里 */
  | 'kept_remove_failed'
  /** 空文件夹删了,但清单里那一行没去掉(宿主拒了 / 抛了):那一行会显示「找不到文件夹」,右键能移除 */
  | 'removed_still_listed'

/** 文件夹已经不在了(清单那行去没去掉另说)。 */
export const discardRemoved = (o: DiscardOutcome): boolean => o === 'removed' || o === 'removed_still_listed'

/** 撤掉本次新建、仍为空、没有绑定的库文件夹。返回码,不抛。 */
export async function discardCreatedFolder(host: CreatedFolderHost, folder: { root: string; created: boolean }): Promise<DiscardOutcome> {
  if (folder.created !== true) return 'kept_not_created'
  const same = host.samePath ?? ((a: string, b: string) => a === b)
  const bound = await host.boundRoots().catch(() => null)
  if (!bound) return 'kept_bindings_unknown'
  if (bound.some((r) => same(r, folder.root))) return 'kept_bound'
  const empty = await host.isEmptyDir(folder.root).catch(() => null)
  if (empty === null) return 'kept_unreadable'
  if (empty !== true) return 'kept_not_empty'
  const busy = await host.inUse(folder.root).catch(() => null)
  if (busy !== false) return 'kept_in_use'
  try { await host.removeEmptyDir(folder.root) } catch { return 'kept_remove_failed' }
  const forgot = await host.forgetVault(folder.root).catch(() => false)
  return forgot ? 'removed' : 'removed_still_listed'
}
