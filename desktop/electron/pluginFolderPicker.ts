/**
 * 插件的「选择文件夹」(ctx.app.pickFolder,2026-11-27+)。main.ts 只接线(dialog:pickFolder),逻辑在这里,单测直跑。
 *
 * ⚠️ 与 dialog:pickDirectory 分开:那条在 purpose === 'project' 时把选中的目录登记成本机项目根(unitLocalRoots.ts)。
 * 插件选一个文件夹不授予任何东西 —— 不登记项目根、不放行设备页浏览、不进任何白名单;本模块也不 import 那些登记表。
 * 插件给的选项只认 title / defaultPath 两个键,别的键(包括 purpose)一律丢掉。
 * ⚠️ 本模块不 import electron:对话框由调用方传进来(main.ts 里是 dialog.showOpenDialog,沙箱子进程会把它换成可预设答案的那份)。
 */
import { isAbsolute } from 'node:path'

/** 插件标题的上限(按字符,不按 UTF-16 码元):系统对话框的标题栏放不下更长的,也不让插件塞一大段话进系统界面。 */
export const PLUGIN_FOLDER_TITLE_MAX = 80

export interface PluginFolderDialogOptions {
  title: string
  /** macOS 的打开面板不显示 title,文案得放 message 才看得见;其它系统忽略 message。 */
  message: string
  defaultPath?: string
  properties: Array<'openDirectory' | 'createDirectory'>
}

/** 清洗插件给的选项:title 去控制字符、压空白、截断,空了用宿主的缺省标题;defaultPath 只收绝对路径,否则忽略。 */
export function pluginFolderDialogOptions(opts: unknown, defaultTitle: string): PluginFolderDialogOptions {
  const o = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {}
  const raw = typeof o.title === 'string' ? o.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
  const chars = Array.from(raw)
  const title = chars.length > PLUGIN_FOLDER_TITLE_MAX ? `${chars.slice(0, PLUGIN_FOLDER_TITLE_MAX - 1).join('')}…` : raw || defaultTitle
  const dp = typeof o.defaultPath === 'string' && !o.defaultPath.includes('\u0000') && isAbsolute(o.defaultPath) ? o.defaultPath : undefined
  return { title, message: title, ...(dp ? { defaultPath: dp } : {}), properties: ['openDirectory', 'createDirectory'] }
}

export type ShowFolderDialog = (opts: PluginFolderDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>

/** 弹框并回用户选的绝对路径;取消 / 没选 → null。没有任何登记副作用。 */
export async function pickPluginFolder(show: ShowFolderDialog, opts: unknown, defaultTitle: string): Promise<string | null> {
  const r = await show(pluginFolderDialogOptions(opts, defaultTitle))
  const picked = !r || r.canceled ? undefined : r.filePaths?.[0]
  return typeof picked === 'string' && picked ? picked : null
}
