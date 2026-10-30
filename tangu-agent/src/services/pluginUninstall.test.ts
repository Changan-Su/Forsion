/** 捆绑包内嵌引擎插件的设置只在 config 里时也要有回收站条目:没有的话 global 快照丢了,恢复捆绑包时设置回不来。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let home: string;
const manifest = (id: string) => JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: 1, entry: 'index.js' });
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-plugin-un-'));
  process.env.TANGU_HOME = home;
  const engine = path.join(home, 'plugins', 'bundle', 'tangu-plugins', 'embedded');
  await fs.mkdir(engine, { recursive: true });
  await fs.writeFile(path.join(home, 'plugins', 'bundle', 'manifest.json'), '{"id":"bundle"}');
  await fs.writeFile(path.join(engine, 'tangu-plugin.json'), manifest('embedded'));
  await fs.writeFile(path.join(engine, 'index.js'), 'export default {}\n');
  const bare = path.join(home, 'plugins', 'bundle', 'tangu-plugins', 'bare');
  await fs.mkdir(bare, { recursive: true });
  await fs.writeFile(path.join(bare, 'tangu-plugin.json'), manifest('bare'));
  await fs.writeFile(path.join(bare, 'index.js'), 'export default {}\n');
  const user = path.join(home, 'plugins', 'plain');
  await fs.mkdir(user, { recursive: true });
  await fs.writeFile(path.join(user, 'tangu-plugin.json'), manifest('plain'));
  await fs.writeFile(path.join(user, 'index.js'), 'export default {}\n');
});
afterAll(async () => { delete process.env.TANGU_HOME; await fs.rm(home, { recursive: true, force: true }); });

describe('trashEnginePlugin', () => {
  it('bundled, settings only in config: keeps a hidden entry, files stay, restore brings the settings back', async () => {
    const { setScopeSettings, getScopeSettings } = await import('../plugins/settingsStore.js');
    const { trashEnginePlugin, restoreEnginePlugin } = await import('./pluginUninstall.js');
    const { listTrash } = await import('./trash.js');
    await setScopeSettings('embedded', 'global', { apiKey: 'sk-x' });
    const { entry } = await trashEnginePlugin('embedded');
    expect(entry).not.toBeNull();
    expect(getScopeSettings('embedded', 'global').apiKey).toBeUndefined();
    expect(await fs.stat(path.join(home, 'plugins', 'bundle', 'tangu-plugins', 'embedded'))).toBeTruthy();
    expect((await listTrash()).some((e) => e.id === entry!.id)).toBe(false); // 没文件的条目不占回收站一行
    await restoreEnginePlugin(entry!);
    expect(getScopeSettings('embedded', 'global').apiKey).toBe('sk-x');
  });

  it('nothing in config: no entry for a bundled plugin; a user plugin without trash=1 still leaves none', async () => {
    const { trashEnginePlugin } = await import('./pluginUninstall.js');
    expect((await trashEnginePlugin('bare')).entry).toBeNull();
    const { setScopeSettings } = await import('../plugins/settingsStore.js');
    await setScopeSettings('plain', 'global', { k: 1 });
    expect((await trashEnginePlugin('plain', { files: false })).entry).toBeNull();
  });
});
