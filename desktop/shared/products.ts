/** Creations(造物)Space 与 Coding Studio 的产物 / git 版本契约。主进程与 renderer 公用,无 Electron 依赖。 */

/** 产物种类。新种类在 electron/productsRegistry.ts 的判型表里加一行;未知种类照常列出,只给「继续编辑」。 */
export type ProductKind = 'web' | 'plugin' | 'unknown'

/** 项目目录里的身份文件名。id 在文件里不在路径里 → 改文件夹名 / 挪位置,快捷方式与稳定源都不死。 */
export const PRODUCT_SIDECAR = '.forsion-product.json'

/** 插件的**生效 id**:清单里的 id 合法(kebab-case)就用它,否则退回目录名,两者都不合法 → null。
 *  产物注册表与插件装载器(electron/amadeus/ipc.ts 的 pluginIdOf)**必须是同一条规则** —— 两边各判各的时,
 *  清单写 `com.demo.plugin`、目录叫 `my-plugin`,注册表报前者、装载器用后者:「在 Forsion 中加载」重载的是一个不存在的 id,
 *  Sandbox 面板永远看不到它(Codex 评审)。 */
const SAFE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
export function effectivePluginId(dirName: string, manifestId: unknown): string | null {
  if (typeof manifestId === 'string' && SAFE_PLUGIN_ID.test(manifestId)) return manifestId
  return SAFE_PLUGIN_ID.test(dirName) ? dirName : null
}

export interface ProductSummary {
  /** `p_<12hex>`;过得了 deepLinkPlan.isSafeId。 */
  id: string
  kind: ProductKind
  name: string
  /** 真实(realpath)项目根。 */
  root: string
  /** web:相对项目根的入口 html(正斜杠);其余 null。 */
  entry: string | null
  createdAt: number
  /** 项目目录 mtime,栅格排序用。 */
  updatedAt: number
  /** 存在 `.forsion-connect.json` = 经 Forsion Connect 发布过。 */
  published: boolean
  /** kind==='plugin':manifest.json 里的插件 id。 */
  pluginId?: string
  /** kind==='plugin':已选择「在 Forsion 中加载」(开发态加载,非隔离)。 */
  devLoad?: boolean
}

/** products:serve 的永久性拒绝(这类产物没有可当网页打开的入口)。渲染层据此判「重试无意义」——
 *  两侧引同一个常量,主进程改措辞不会让渲染层静默退回「通用错误 + 永远点不出结果的重试」。 */
export const PRODUCT_NO_WEB_ENTRY = 'product has no web entry'

export type ShortcutResult =
  | { ok: true; path: string }
  | { ok: false; code: 'unpackaged' | 'unsupported' | 'not_found' | 'error'; detail?: string }

/** none = 没有仓;owned = 我方 init 的仓(带 `.git/forsion-history` 标记);
 *  foreign = 用户自己的仓(无标记);nested = 项目落在别的仓里(toplevel ≠ 项目根)。后两者只读。 */
export type GitRepoState = 'none' | 'owned' | 'foreign' | 'nested'

export interface GitHistoryStatus {
  /** 本机找得到 git 可执行文件。false 时 History 区域改为安装建议。 */
  available: boolean
  state: GitRepoState
  /** 工作区有未提交改动(state 为 none 时恒 false)。 */
  dirty: boolean
}

/** History 面板用:writable = 本机有 git、项目在托管根(~/Forsion/Project)下、且仓是我方的或尚未建仓。
 *  根外导入的项目一律只读 —— 宿主绝不在用户随手导入的目录里 `git init` / `add -A`。 */
export interface GitPanelStatus extends GitHistoryStatus {
  writable: boolean
}

export interface GitVersion {
  /** 完整 commit sha。 */
  id: string
  name: string
  createdAt: number
  /** 宿主在一轮 agent 结束后自动提交的;false = 用户手动命名的版本(或外来仓里的普通提交)。 */
  auto: boolean
  /** 该提交改动的文件数。 */
  files: number
}

export interface GitRestoreSummary {
  /** 恢复前把现场提交成的备份 sha;现场本来就干净则为 null。 */
  backupId: string | null
  /** 恢复动作自身产生的新提交 sha;目标与现状一致、无需提交时为 null。 */
  restoreId: string | null
}
