/**
 * 卸载引擎插件(设置 › 插件、商店的「后端插件」;10-28 手动卸载规范):先停掉在跑的实例,插件文件(只限用户目录)
 * 和它的设置、数据一起进回收站的同一条。keepSettings = 「保留设置,重装后接着用」:设置原地不动,只挪文件。
 * 首方 / 编进 app / Forsion 插件捆绑包里的,文件不在这里挪(捆绑包的随 Forsion 插件走桌面那条)。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pluginsDir } from '../core/tanguHome.js';
import { discoverPlugins } from '../plugins/loader.js';
import { takePluginData, restorePluginGlobal } from '../plugins/settingsStore.js';
import { moveToTrash, restoreTrashItems, type TrashEntry } from './trash.js';

const inside = (root: string, p: string): boolean => { const rel = path.relative(root, p); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };

/** opts.bundle = 只收这个捆绑包(目录名)内嵌的那份:同 id 解析到别处(用户目录、首方)时什么都不动。 */
export async function trashEnginePlugin(id: string, opts: { files?: boolean; keepSettings?: boolean; bundle?: string } = {}): Promise<{ entry: TrashEntry | null; dirName?: string }> {
  const d = discoverPlugins().find((x) => x.manifest.id === id);
  if (opts.bundle !== undefined && !(d?.bundled && path.basename(path.dirname(path.dirname(d.dir))) === opts.bundle)) return { entry: null };
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
  let entry: TrashEntry | null;
  try {
    // 捆绑包内嵌的设置多半只在 config 里:没文件也留条目,否则 global 快照丢了,恢复捆绑包时设置回不来
    entry = await moveToTrash({ kind: 'plugin', ref: id, name: String(d?.manifest.name || id), paths, extra: { engine: true, ...(global !== undefined ? { global } : {}) }, keepEmpty: !!d?.bundled && global !== undefined });
  } catch (e) {
    if (global !== undefined) restorePluginGlobal(id, global); // 没挪成:设置快照写回去,别跟着丢
    throw e;
  }
  // 用户目录里的一件文件都没有(旧版桌面不带 trash=1、设置只在 config 里)= 照旧只清设置,不留空条目
  return { entry, ...(own ? { dirName: path.basename(d!.dir) } : {}) };
}

/** 重装过的(原处又有同 id 的插件)不恢复:文件会落到 -2 成两份同 id,设置还会盖掉新装那份的。 */
export class PluginReinstalledError extends Error { code = 'plugin_reinstalled'; }

/** opts.rescan:false = 先不重扫:捆绑包连着放几条时全放回再扫一次,否则第一条的重扫就把后面的激活了,它们建的空目录会占住原位。 */
export async function restoreEnginePlugin(entry: TrashEntry, opts: { rescan?: boolean } = {}): Promise<{ id: string }> {
  const files = entry.items.find((i) => i.role === 'files');
  if (files && !files.placed && (await fs.lstat(files.from).then(() => true, () => false) || discoverPlugins().some((x) => x.manifest.id === entry.ref))) throw new PluginReinstalledError('The plugin is installed again; uninstall that copy first');
  await restoreTrashItems(entry, async () => {
    const extra = entry.extra ?? {};
    if ('global' in extra) restorePluginGlobal(entry.ref, extra.global);
  });
  const { forgetUninstalled, rescanPlugins } = await import('../plugins/bootstrap.js');
  forgetUninstalled(entry.ref);
  if (opts.rescan !== false) await rescanPlugins();
  return { id: entry.ref };
}
