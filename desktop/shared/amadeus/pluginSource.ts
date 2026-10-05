/**
 * 已安装 Forsion 插件:manifest.json → ExternalPluginSource 的**纯映射**(无 I/O)。
 * 桌面主进程扫 ~/.forsion/plugins(electron/amadeus/ipc.ts 的 readExternalPlugins)与 Android App 扫
 * 应用私有目录 plugins/(mobile/src/plugins/pluginHost.ts)共用这一份 —— 两端列出来的插件长同一个样,
 * 新加 manifest 字段只改这里。I/O(读 main / README / 图标、bundle 清点、门禁所需的宿主版本)各端自理。
 */
import { PLUGIN_CAPABILITIES, sanitizeEvents, sanitizeOnboarding, sanitizeRequiresPlugins, type ExternalPluginSource } from './ipc'

/** manifest.json 里宿主会读的字段(全按 unknown 收:第三方写什么都可能)。 */
export interface InstalledPluginManifest {
  id?: unknown
  name?: unknown
  nameEn?: unknown
  version?: unknown
  description?: unknown
  descriptionEn?: unknown
  main?: unknown
  apiVersion?: unknown
  minAppVersion?: unknown
  requiresApp?: unknown
  requiresPlugins?: unknown
  capabilities?: unknown
  onboarding?: unknown
  fileExtensions?: unknown
  events?: unknown
  /** Obsidian 式平台旗标:true = 只能在桌面端运行(Android 列出但不装载、市场拒装)。 */
  isDesktopOnly?: unknown
}

/** manifest 推导出的展示 / 门禁字段(id、code、文档、图标、blocked 由调用方补)。
 *  ⚠️ name / version / description 沿用桌面原有的宽松取值(`m.name || 目录名`),别在这里顺手收紧 —— 两端同时变。 */
export type InstalledPluginFields = Pick<ExternalPluginSource,
  'name' | 'version' | 'description' | 'nameEn' | 'descriptionEn' | 'apiVersion' | 'minAppVersion' | 'requiresApp'
  | 'requiresPlugins' | 'capabilities' | 'onboarding' | 'events' | 'fileExtensions' | 'isDesktopOnly'>

export function installedPluginFields(m: InstalledPluginManifest, dirName: string, id?: string): InstalledPluginFields {
  return {
    name: (m.name as string) || dirName,
    version: (m.version as string) || '0.0.0',
    description: m.description as string | undefined,
    // 英文镜像:纯展示用,坏了就当没有(中文 canonical 永远兜底)。
    nameEn: typeof m.nameEn === 'string' && m.nameEn.trim() ? m.nameEn.trim().slice(0, 120) : undefined,
    descriptionEn: typeof m.descriptionEn === 'string' && m.descriptionEn.trim() ? m.descriptionEn.trim().slice(0, 2000) : undefined,
    apiVersion: typeof m.apiVersion === 'number' ? m.apiVersion : 1,
    minAppVersion: typeof m.minAppVersion === 'string' ? m.minAppVersion : undefined,
    requiresApp: typeof m.requiresApp === 'string' ? m.requiresApp : undefined,
    requiresPlugins: sanitizeRequiresPlugins(m.requiresPlugins, id), // id = 自己(依赖自己的条目丢掉)
    // 敏感能力:只认白名单里的字符串,别的静默丢(插件写什么都不能凭空造出接缝)。
    capabilities: Array.isArray(m.capabilities)
      ? PLUGIN_CAPABILITIES.filter((c) => (m.capabilities as unknown[]).includes(c))
      : undefined,
    onboarding: sanitizeOnboarding(m.onboarding),
    events: sanitizeEvents(m.events),
    fileExtensions: Array.isArray(m.fileExtensions)
      ? m.fileExtensions.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 8)
      : undefined,
    // 只认字面量 true:`"true"` / 1 之类不算声明(与 Obsidian 同口径;漏标的插件在手机上照常装载,用到桌面专属接口时由插件自己的可选链 / 报错兜住)。
    isDesktopOnly: m.isDesktopOnly === true ? true : undefined,
  }
}
