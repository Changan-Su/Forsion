/**
 * 卸载引擎插件(设置 › 插件、商店的「后端插件」;10-28 手动卸载规范):先停掉在跑的实例,插件文件(只限用户目录)
 * 和它的设置、数据一起进回收站的同一条。keepSettings = 「保留设置,重装后接着用」:设置原地不动,只挪文件。
 * 首方 / 编进 app / Forsion 插件捆绑包里的,文件不在这里挪(捆绑包的随 Forsion 插件走桌面那条)。
 */
import path from 'node:path';
import { pluginsDir } from '../core/tanguHome.js';
import { discoverPlugins } from '../plugins/loader.js';
import { takePluginData, restorePluginGlobal } from '../plugins/settingsStore.js';
import { moveToTrash, restoreTrashItems, type TrashEntry } from './trash.js';

const inside = (root: string, p: string): boolean => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

export async function trashEnginePlugin(id: string, opts: { files?: boolean; keepSettings?: boolean } = {}): Promise<{ entry: TrashEntry | null; dirName?: string }> {
  const d = discoverPlugins().find((x) => x.manifest.id === id);
  const { removePluginLive } = await import('../plugins/bootstrap.js');
  await removePluginLive(id); // 先注销:清完设置后 isPluginEnabledSync 不会落回 defaultEnabled=true
  const own = !!d && !d.bundled && inside(pluginsDir(), d.dir);
  const paths: Array<{ path: string; role: string }> = opts.files !== false && own ? [{ path: d!.dir, role: 'files' }] : [];
  let global: unknown;
  if (!opts.keepSettings) {
    const taken = await takePluginData(id);
    global = taken.global;
    paths.push(...taken.paths.map((p) => ({ path: p, role: 'settings' })));
  }
  const entry = await moveToTrash({ kind: 'plugin', ref: id, name: String(d?.manifest.name || id), paths, extra: { engine: true, ...(global !== undefined ? { global } : {}) } });
  if (!entry && global !== undefined) restorePluginGlobal(id, global); // 没有可挪的文件:设置快照没处放,写回去(等于只清了缓存)
  return { entry, ...(own ? { dirName: path.basename(d!.dir) } : {}) };
}

export async function restoreEnginePlugin(entry: TrashEntry): Promise<{ id: string }> {
  await restoreTrashItems(entry);
  const extra = entry.extra ?? {};
  if ('global' in extra) restorePluginGlobal(entry.ref, extra.global);
  const { forgetUninstalled, rescanPlugins } = await import('../plugins/bootstrap.js');
  forgetUninstalled(entry.ref);
  await rescanPlugins();
  return { id: entry.ref };
}
