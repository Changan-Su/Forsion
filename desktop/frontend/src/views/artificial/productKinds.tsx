/**
 * 造物 Space 的**种类表** = 这一块的扩展契约:以后多一类产物(小程序 / 脚本 / 桌面应用…)
 * 就在 PRODUCT_KINDS 里加一行 —— 图标、分组标题、能不能启动、能不能加到桌面全从这里取,
 * 视图层不再出现 `kind === 'web'` 这种散落判断。
 *
 * ⚠️**运行时的 kind 是开集**:主进程的判型表(electron/productsRegistry)可能先于渲染层更新,
 * 送来表里没有的字符串。kindRow() 一律回落 unknown —— 照常列出、只给「继续编辑」,
 * 绝不让一张卡片凭空消失(用户会以为项目丢了)。
 *
 * 纯数据 + 纯函数,不碰 window:单测直接 import(productKinds.test.ts)。
 */
import { Globe, Package, Puzzle, type LucideIcon } from 'lucide-react'
import { PRODUCT_NO_WEB_ENTRY, type ProductKind, type ProductSummary, type ShortcutResult } from '../../../../shared/products'

export interface ProductKindRow {
  icon: LucideIcon
  /** i18n **键**(不是文案):模块作用域的标签表存键,渲染期才求值 —— 存成字符串会在切语言后纹丝不动。 */
  labelKey: string
  /** 宿主能把它跑起来(有可加载的 URL)→ 卡片给「打开 / 在独立窗口中打开」。 */
  canLaunch: boolean
  /** 能做成桌面快捷方式(快捷方式拉起的就是 launch 的那条路径)。 */
  canShortcut: boolean
}

/** 键的**声明顺序 = 栅格里的分组顺序**;unknown 恒排最后,新种类插在它前面。 */
export const PRODUCT_KINDS: Record<ProductKind, ProductKindRow> = {
  web: { icon: Globe, labelKey: 'artificial.kind.web', canLaunch: true, canShortcut: true },
  // 插件靠「设置 → Forsion 插件」装载,没有独立 URL → 只给「继续编辑」与文件夹动作。
  plugin: { icon: Puzzle, labelKey: 'artificial.kind.plugin', canLaunch: false, canShortcut: false },
  unknown: { icon: Package, labelKey: 'artificial.kind.unknown', canLaunch: false, canShortcut: false },
}

export const KIND_ORDER = Object.keys(PRODUCT_KINDS) as ProductKind[]

/** 开集 → 表内种类(表里没有的一律 unknown)。 */
export function resolveKind(kind: string): ProductKind {
  return Object.prototype.hasOwnProperty.call(PRODUCT_KINDS, kind) ? (kind as ProductKind) : 'unknown'
}

/** 取某个 kind 的那一行(开集安全)。 */
export function kindRow(kind: string): ProductKindRow {
  return PRODUCT_KINDS[resolveKind(kind)]
}

/** 产物 id 的形态(与 shared/products 的 `p_<12hex>`、主进程 isProductId 同一条)。 */
export const PRODUCT_ID_RE = /^p_[0-9a-f]{12}$/

/**
 * deep link / 布局恢复送来的 params → 产物 id。
 * **只认 `id` 一个键,别的一律丢掉** —— 这条路径任意网页可达(forsion://open?view=product&…),
 * 而它打开的页面里住着 Forsion Connect 代理;多收一个参数就是多一个可被拼进 URL 的口子。
 */
export function productIdFromParams(params: Record<string, unknown>): string | null {
  const id = params?.id
  return typeof id === 'string' && PRODUCT_ID_RE.test(id) ? id : null
}

/**
 * `products:serve` 的三种结局 —— 用户能做的动作完全不同,所以界面上也是三个状态,不是一句笼统的失败:
 *  · `gone`       查无此物(id 形态不合 / 注册表里没有 / 目录没了)→ 只能回栅格;
 *  · `unservable` 这类作品压根没有网页入口(插件、以后的脚本…)→ **永久**失败,重试一万次也是这个结果,
 *                 出路只有「继续编辑」;
 *  · `error`      其余(端口起不来、读盘瞬时错…)→ 可以重试。
 *
 * ⚠️`unservable` 必须先判:主进程那句 `product has no web entry`(electron/productsIpc)既不含
 * 「not found」也不含 ENOENT,少了这条就会掉进 `error` 分支 —— 界面给出一颗永远点不出结果的重试。
 * 这条路径卡片 UI 到不了(插件的 canLaunch=false),但 deep link 与布局恢复都能直接开出 product 视图。
 */
export type ServeOutcome = 'gone' | 'unservable' | 'error'

const SERVE_GONE = /not found|invalid product id|ENOENT/i

export function serveOutcome(error: unknown): ServeOutcome {
  const message = error instanceof Error ? error.message : String(error)
  // IPC 会把错误包成 `Error invoking remote method …: Error: <message>` → 用 includes,不用全等。
  if (message.includes(PRODUCT_NO_WEB_ENTRY)) return 'unservable'
  return SERVE_GONE.test(message) ? 'gone' : 'error'
}

/** 最近改动的排前面;同一时刻按名字定序(否则每次刷新顺序会抖)。 */
export function sortProducts(list: readonly ProductSummary[]): ProductSummary[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

/** 按种类分组(表序),空组不出现。 */
export function groupProducts(list: readonly ProductSummary[]): Array<{ kind: ProductKind; items: ProductSummary[] }> {
  const sorted = sortProducts(list)
  return KIND_ORDER
    .map((kind) => ({ kind, items: sorted.filter((p) => resolveKind(p.kind) === kind) }))
    .filter((group) => group.items.length > 0)
}

/** 桌面快捷方式的结果 → 一条 toast(键 + 是否报错 + 占位符)。 */
export function shortcutToast(result: ShortcutResult): { key: string; error: boolean; vars?: { detail: string } } {
  if (result.ok) return { key: 'artificial.toast.shortcutOk', error: false }
  // 开发模式下 electron 跑的是 node 可执行文件,做出来的快捷方式点了只会起一个空壳 → 明说,不假装成一般失败。
  if (result.code === 'unpackaged') return { key: 'artificial.toast.shortcutUnpackaged', error: true }
  return { key: 'artificial.toast.shortcutFailed', error: true, vars: { detail: result.detail || result.code } }
}

