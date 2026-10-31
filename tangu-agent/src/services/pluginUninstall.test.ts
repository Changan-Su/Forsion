/** 捆绑包内嵌引擎插件:设置只在 config 里时也要有回收站条目(否则 global 快照丢了,恢复捆绑包时设置回不来);bundle 参数只认这个捆绑包里的那份。 */
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
  it('bundled, settings only in config: keeps an entry, files stay, restore brings the settings back', async () => {
    const { setScopeSettings, getScopeSettings } = await import('../plugins/settingsStore.js');
    const { trashEnginePlugin, restoreEnginePlugin } = await import('./pluginUninstall.js');
    const { listTrash } = await import('./trash.js');
    await setScopeSettings('embedded', 'global', { apiKey: 'sk-x' });
    const { entry } = await trashEnginePlugin('embedded');
    expect(entry).not.toBeNull();
    expect(getScopeSettings('embedded', 'global').apiKey).toBeUndefined();
    expect(await fs.stat(path.join(home, 'plugins', 'bundle', 'tangu-plugins', 'embedded'))).toBeTruthy();
    expect((await listTrash()).some((e) => e.id === entry!.id)).toBe(true); // 捆绑包恢复时放不回,用户还能在回收站手动恢复
    await restoreEnginePlugin(entry!, { rescan: false });
    expect(getScopeSettings('embedded', 'global').apiKey).toBe('sk-x');
    expect((await listTrash()).some((e) => e.id === entry!.id)).toBe(false);
  }, 30000); // 第一次动态 import 引擎模块图,高负载时超过缺省 5 秒

  it('bundle check: a same-id plugin resolved elsewhere, or another bundle, is left alone', async () => {
    const { setScopeSettings, getScopeSettings } = await import('../plugins/settingsStore.js');
    const { trashEnginePlugin } = await import('./pluginUninstall.js');
    await setScopeSettings('plain', 'global', { k: 1 });
    expect((await trashEnginePlugin('plain', { bundle: 'bundle' })).entry).toBeNull();
    expect(getScopeSettings('plain', 'global').k).toBe(1);
    await setScopeSettings('embedded', 'global', { k: 2 });
    expect((await trashEnginePlugin('embedded', { bundle: 'other' })).entry).toBeNull();
    expect(getScopeSettings('embedded', 'global').k).toBe(2);
    expect((await trashEnginePlugin('embedded', { bundle: 'bundle' })).entry).not.toBeNull();
  });

  it('nothing in config: no entry for a bundled plugin; a user plugin without trash=1 still leaves none', async () => {
    const { trashEnginePlugin } = await import('./pluginUninstall.js');
    expect((await trashEnginePlugin('bare')).entry).toBeNull();
    const { setScopeSettings } = await import('../plugins/settingsStore.js');
    await setScopeSettings('plain', 'global', { k: 1 });
    expect((await trashEnginePlugin('plain', { files: false })).entry).toBeNull();
  });
});
