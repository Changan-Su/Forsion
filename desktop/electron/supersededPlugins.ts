/**
 * 共享插件目录里「被商店安装取代」的普通目录:同一个包既有普通目录(按 manifest id 跑)、又有商店装的 market-<uuid>
 * (按目录名跑)时,只装商店那份。规则本体在引擎契约 supersededPlainInstalls(引擎扫捆绑包时同一条),这里只负责读盘。
 * 插件列表(amadeus/ipc.ts readExternalPlugins)与随包 Space 列表(main.ts readSpacesList)必须都过这一道,
 * 否则一边只认商店那份、另一边还把旧副本的 Space 先注册上。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { supersededPlainInstalls } from '../shared/pluginAliases'

/** names = 插件根下的子目录名(调用方已滤掉点目录 / 非目录)。返回 普通目录名 → 取代它的商店目录名。 */
export async function supersededPluginDirs(root: string, names: readonly string[], keep?: ReadonlySet<string>): Promise<Map<string, string>> {
  const entries = await Promise.all(names.map(async (dir) => ({
    dir,
    manifestId: await readFile(join(root, dir, 'manifest.json'), 'utf8').then((s) => (JSON.parse(s) as { id?: unknown })?.id, () => undefined),
  })))
  const replaced = supersededPlainInstalls(entries, keep)
  for (const [plain, store] of replaced) console.warn(`[plugins] ${plain} 与商店安装的 ${store} 是同一个插件,只装载商店那份`)
  return replaced
}
