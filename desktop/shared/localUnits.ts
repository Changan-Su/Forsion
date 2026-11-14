/**
 * 本机多 Unit:同一份安装在这台电脑上再跑一份自成一体的 Forsion(自己的登录、配置、Agent、插件、对话、智库清单、引擎)。
 *
 * 一个本机 Unit = 一个文件夹:
 *   <dir>/forsion-unit.json   标记文件(身份、名字、图标、所属通道),名字和图标以它为准
 *   <dir>/home/               引擎 home(TANGU_HOME)
 *   <dir>/app-data/           Electron userData
 *   <dir>/Forsion/            工作区(缺省智库、Sessions、Coding 项目)
 *
 * 默认那台(~/.forsion + 系统应用数据目录)不搬家,也不算「文件夹 Unit」。
 * 名册(这台电脑上登记了哪些文件夹 Unit)放在默认那台的 userData 里,所有实例共读;只记 id + 路径。
 * 启动参数只带 id(LOCAL_UNIT_ARG=<id>),路径一律从名册取,再和标记文件里的 id、通道核对 —— 参数和链接里不出现路径。
 *
 * 本文件只放主进程与渲染层共用的类型和纯函数,不碰 fs / electron。
 */

/** 文件夹里的标记文件名。 */
export const LOCAL_UNIT_MARKER = 'forsion-unit.json'
/** 名册文件名(在默认那台的 userData 下)。 */
export const LOCAL_UNIT_REGISTRY = 'local-units.json'
/** 启动参数:`--forsion-unit=<id>`。 */
export const LOCAL_UNIT_ARG = '--forsion-unit'
/** 与 LOCAL_UNIT_ARG 同时出现:叫已在跑的那份文件夹 Unit 退出;没在跑就什么也不做、立刻退出。 */
export const LOCAL_UNIT_QUIT_ARG = '--forsion-unit-quit'

/** 文件夹内的子目录名。 */
export const LOCAL_UNIT_DIRS = { home: 'home', appData: 'app-data', workspace: 'Forsion' } as const

/** stable = 安装版,dev = 开发版;两边各有各的名册,跨通道打开一律拒绝。 */
export type LocalUnitChannel = 'stable' | 'dev'

export interface LocalUnitMarker {
  schema: 1
  /** uuid,创建时生成,之后不变。 */
  id: string
  name: string
  /** 图标:emoji 或宿主图标名(与 Space 图标同一套取值)。 */
  icon: string
  channel: LocalUnitChannel
  createdAt: number
}

export interface LocalUnitRegistryEntry {
  id: string
  /** 绝对路径(realpath 后)。 */
  path: string
  addedAt: number
}

export interface LocalUnitRegistry {
  schema: 1
  units: LocalUnitRegistryEntry[]
}

/**
 * running   文件夹 Unit 正在跑(run 记录里的 pid 还活着)
 * stopped   没在跑
 * missing   名册里有、文件夹或标记文件不在了(搬走 / 删了 / 外接盘没插)
 * mismatch  标记文件在,但 id 或通道对不上名册
 */
export type LocalUnitState = 'running' | 'stopped' | 'missing' | 'mismatch'

export interface LocalUnitRow {
  id: string
  name: string
  icon: string
  /** 绝对路径。 */
  path: string
  /** 给人看的路径(家目录缩成 ~)。 */
  displayPath: string
  state: LocalUnitState
  /** 这一行就是当前这个进程自己。 */
  current: boolean
}

export type LocalUnitSelf =
  | { kind: 'default' }
  | { kind: 'folder'; id: string; name: string; icon: string; path: string; displayPath: string }

export interface LocalUnitsSnapshot {
  self: LocalUnitSelf
  /** 只有文件夹 Unit;默认那台不在里面(面板里它是「这台电脑」那一行)。 */
  units: LocalUnitRow[]
  /** 名册读不出来 ≠ 空:unreadable 时 units 为空数组,界面要说「读不出」,写操作一律被拒。 */
  registry: 'ok' | 'unreadable'
  /** 「新建」对话框里缺省的父目录(安装版 ~/Forsion Units,开发版 ~/.forsion-dev-units)。 */
  defaultParent: string
  /** 同上,给人看的写法。 */
  defaultParentDisplay: string
}

export type LocalUnitsErrorCode =
  | 'name_invalid'       // 名字空、过长、或只剩不能做文件夹名的字符
  | 'path_exists'        // 目标文件夹已存在
  | 'parent_invalid'     // 父目录不是绝对路径 / 不存在 / 不可写
  | 'not_a_unit'         // 选的文件夹里没有可读的标记文件
  | 'channel_mismatch'   // 标记文件属于另一个通道(安装版 / 开发版)
  | 'duplicate_id'       // 这个 id 已登记在另一个仍然存在的文件夹上(多半是拷贝出来的)
  | 'registry_unreadable'
  | 'not_found'          // 名册里没有这个 id
  | 'is_self'            // 不能对当前这份自己做这件事(比如从列表移除)
  | 'cancelled'          // 用户在系统对话框里取消
  | 'io'

export type LocalUnitsResult<T extends object = object> = ({ ok: true } & T) | { ok: false; code: LocalUnitsErrorCode; message?: string }

/** 渲染层看到的接口(window.tangu.localUnits);只在主窗、有本机引擎的产品形态、且不是插件沙箱时存在。 */
export interface LocalUnitsApi {
  list(): Promise<LocalUnitsSnapshot>
  /** 新建并登记;parentDir 缺省 = snapshot.defaultParent。不自动打开。 */
  create(input: { name: string; icon: string; parentDir?: string }): Promise<LocalUnitsResult<{ unit: LocalUnitRow }>>
  /** 弹系统对话框选新建位置的父目录;取消 → null。 */
  chooseParent(): Promise<{ path: string; display: string } | null>
  /** 弹系统对话框选一个已有的 Unit 文件夹并登记。 */
  addExisting(): Promise<LocalUnitsResult<{ unit: LocalUnitRow }>>
  /** 打开:文件夹 Unit 起一个新进程(已在跑就叫到前面);'default' = 叫出默认那台。 */
  open(id: string | 'default'): Promise<LocalUnitsResult>
  rename(id: string, patch: { name?: string; icon?: string }): Promise<LocalUnitsResult<{ unit: LocalUnitRow }>>
  /** 在访达 / 资源管理器 / 文件管理器里显示文件夹。 */
  reveal(id: string): Promise<LocalUnitsResult>
  /** 只从名册拿掉,文件夹和里面的数据都不动。 */
  remove(id: string): Promise<LocalUnitsResult>
  /** 图标:渲染层画好的 1024px PNG data URL(同 Space 的「添加到桌面」);不给 = 系统的通用 App 图标。
   *  fallbackName:名字洗空时的本地化缺省名。开发版一律 { ok: false, code: 'io', message: 'unpackaged' }。 */
  addToDesktop(id: string, opts?: { iconPng?: string; fallbackName?: string }): Promise<LocalUnitsResult>
  /** 名册、标记文件或运行状态变了(任一实例改的都算)。 */
  onChanged(cb: () => void): () => void
}

/** 名字 → 文件夹名:去掉路径分隔符和控制字符、首尾空白与点;空了返回 null。上限 64 个字符。 */
export function localUnitFolderName(name: string): string | null {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (!cleaned) return null
  return Array.from(cleaned).slice(0, 64).join('').trim() || null
}

/** 名字是否可用(界面先判一次,主进程再判一次)。 */
export function isValidLocalUnitName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && Array.from(trimmed).length <= 64 && localUnitFolderName(trimmed) !== null
}

/** 解析标记文件内容;任何一处不对都返回 null(调用方把 null 当「不知道」,不是「空」)。 */
export function parseLocalUnitMarker(raw: unknown): LocalUnitMarker | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (m.schema !== 1) return null
  if (typeof m.id !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(m.id)) return null
  if (typeof m.name !== 'string' || !m.name.trim()) return null
  if (typeof m.icon !== 'string') return null
  if (m.channel !== 'stable' && m.channel !== 'dev') return null
  if (typeof m.createdAt !== 'number' || !Number.isFinite(m.createdAt)) return null
  return { schema: 1, id: m.id, name: m.name, icon: m.icon, channel: m.channel, createdAt: m.createdAt }
}

/** 解析名册;结构不对返回 null(= 读不出,不是空名册)。重复 id 只留第一条。 */
export function parseLocalUnitRegistry(raw: unknown): LocalUnitRegistry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.schema !== 1 || !Array.isArray(r.units)) return null
  const seen = new Set<string>()
  const units: LocalUnitRegistryEntry[] = []
  for (const u of r.units) {
    if (!u || typeof u !== 'object') return null
    const e = u as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.path !== 'string' || typeof e.addedAt !== 'number') return null
    if (seen.has(e.id)) continue
    seen.add(e.id)
    units.push({ id: e.id, path: e.path, addedAt: e.addedAt })
  }
  return { schema: 1, units }
}
