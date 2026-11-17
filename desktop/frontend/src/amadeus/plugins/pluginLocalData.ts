/**
 * 本机那份插件私有数据(ctx.loadData / ctx.saveData 的 JSON)的唯一读取口。ctx.loadData 和云同步(pluginDataSync)都走这里。
 *
 * 「没写过」和「读不出来」必须分开(用户 10-28 定的规矩:读失败 ≠ 空):
 *  - 没写过 → null(各端宿主约定:文件不存在才回 null);
 *  - 读出错(权限、I/O、宿主抛错)或内容不是合法 JSON(零字节、写到一半、被手改坏)→ 抛 PluginDataUnreadableError。
 * 以前两样走同一个出口:插件拿到 null 就按默认值起来,用户下次改任何一项设置,整份默认值写回去,把原来那份盖掉;
 * 云同步把读不出来的本机当「本机没有」,拉云端那份直接写盘覆盖,或者把半截文件当本机内容推上去。
 * ctx.saveData 写的永远是 JSON.stringify 的结果,所以「不是合法 JSON」只可能是文件坏了,不会误伤插件自己写的东西。
 */

export type PluginDataUnreadableReason = 'read-failed' | 'invalid-json'

/** 插件能认的错误码(跨模块实例也认得:别用 instanceof 判)。 */
export const PLUGIN_DATA_UNREADABLE = 'plugin-data-unreadable'

export class PluginDataUnreadableError extends Error {
  readonly code = PLUGIN_DATA_UNREADABLE
  constructor(readonly pluginId: string, readonly reason: PluginDataUnreadableReason, cause?: unknown) {
    super(reason === 'invalid-json'
      ? `Saved data of plugin "${pluginId}" is not valid JSON; it was left untouched`
      : `Saved data of plugin "${pluginId}" could not be read; it was left untouched`)
    this.name = 'PluginDataUnreadableError'
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

export const isJsonText = (text: string): boolean => { try { JSON.parse(text); return true } catch { return false } }

export const isPluginDataUnreadable = (e: unknown): e is PluginDataUnreadableError =>
  !!e && typeof e === 'object' && (e as { code?: unknown }).code === PLUGIN_DATA_UNREADABLE

/**
 * 读本机这份:没写过 → null;读不出来 → 抛 PluginDataUnreadableError;否则原样返回文本(已确认是合法 JSON)。
 * `read` 是宿主桥上的 readPluginData(桌面主进程 / 手机双槽 / Unit),可能同步抛、可能 reject。
 */
export async function readLocalPluginData(
  pluginId: string,
  read: () => Promise<string | null | undefined> | string | null | undefined,
): Promise<string | null> {
  let raw: string | null | undefined
  try {
    raw = await read()
  } catch (e) {
    throw new PluginDataUnreadableError(pluginId, 'read-failed', e)
  }
  if (raw == null) return null
  if (typeof raw !== 'string') throw new PluginDataUnreadableError(pluginId, 'read-failed')
  try {
    JSON.parse(raw)
  } catch (e) {
    throw new PluginDataUnreadableError(pluginId, 'invalid-json', e)
  }
  return raw
}
