/**
 * Forsion bundle 契约:共享域 plugins/<id>/(manifest.json 标志)内嵌内容的发现与播种。
 * 覆盖:bundle 目录识别 / 引擎插件根追加(且顶不掉用户装的同 id)/ 技能根追加(用户覆盖 bundle)/
 * agent 播种一次(永不覆盖活体)/ TANGU_PLUGINS(_DIR) 停用闸。TANGU_HOME=临时目录隔离。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundleDirs, bundleEnginePluginRoots, bundleSkillRoots, seedBundleAgents } from './bundles.js';
import { discoverPlugins, resolvePluginsDirs } from './loader.js';
import { TANGU_PLUGIN_API } from './types.js';
import { agentsDir, pluginsDir } from '../core/tanguHome.js';
import { listLocalSkills } from '../skills/localSkills.js';

let tmp: string;
let shared: string;
const savedEnv: Record<string, string | undefined> = {};

function writeJson(file: string, obj: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** 建一个 bundle:共享域 plugins/<id>/ + manifest.json(+可选内嵌件)。 */
function makeBundle(id: string): string {
  const dir = path.join(shared, 'plugins', id);
  writeJson(path.join(dir, 'manifest.json'), { id, name: id, version: '1.0.0' });
  return dir;
}

function engineManifest(id: string): object {
  return { id, name: id, version: '1.0.0', apiVersion: TANGU_PLUGIN_API, entry: 'dist/index.js' };
}

function pluginIconPng(size = 128): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(size, 16);
  buf.writeUInt32BE(size, 20);
  return buf;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tangu-bundles-'))); // macOS /var → /private/var(对齐 forsionSharedDir 的 realpath)
  shared = path.join(tmp, 'shared');
  const home = path.join(shared, 'tangu');
  mkdirSync(home, { recursive: true });
  for (const k of ['TANGU_HOME', 'TANGU_PLUGINS', 'TANGU_PLUGINS_DIR']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TANGU_HOME = home;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('bundleDirs', () => {
  it('识别共享域 plugins/ 下带 manifest.json 的目录,忽略其他', () => {
    makeBundle('my-bundle');
    mkdirSync(path.join(shared, 'plugins', 'not-a-bundle'), { recursive: true }); // 无 manifest.json
    writeFileSync(path.join(shared, 'plugins', 'stray-file'), 'x');
    const dirs = bundleDirs().map((d) => path.basename(d));
    expect(dirs).toEqual(['my-bundle']);
  });

  it('TANGU_PLUGINS=off / TANGU_PLUGINS_DIR 覆盖时整体停用', () => {
    makeBundle('my-bundle');
    process.env.TANGU_PLUGINS = 'off';
    expect(bundleDirs()).toEqual([]);
    delete process.env.TANGU_PLUGINS;
    process.env.TANGU_PLUGINS_DIR = tmp;
    expect(bundleDirs()).toEqual([]);
  });

  it('无共享域 plugins/ 目录 → 空数组(无桌面常态)', () => {
    expect(bundleDirs()).toEqual([]);
  });

  it('符号链接的 bundle 目录/内容根一律不认(与桌面 Dirent 扫描口径一致)', () => {
    const real = makeBundle('real-bundle');
    writeJson(path.join(real, 'tangu-plugins', 't1', 'tangu-plugin.json'), engineManifest('t1'));
    symlinkSync(real, path.join(shared, 'plugins', 'linked-bundle')); // 链接假 bundle
    expect(bundleDirs().map((d) => path.basename(d))).toEqual(['real-bundle']);

    const b2 = makeBundle('b2'); // 内容根是链接 → 不认
    const outside = path.join(tmp, 'outside-plugins');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(b2, 'tangu-plugins'));
    expect(bundleEnginePluginRoots()).toEqual([path.join(real, 'tangu-plugins')]);
  });
});

describe('内嵌引擎插件', () => {
  it('tangu-plugins/ 追加为搜索根,discoverPlugins 能发现', () => {
    const bundle = makeBundle('my-bundle');
    const pluginDir = path.join(bundle, 'tangu-plugins', 'embedded-tool');
    writeJson(path.join(pluginDir, 'tangu-plugin.json'), engineManifest('embedded-tool'));
    writeFileSync(path.join(pluginDir, 'icon.png'), pluginIconPng());
    expect(resolvePluginsDirs()).toContain(path.join(bundle, 'tangu-plugins'));
    const found = discoverPlugins();
    expect(found.map((d) => d.manifest.id)).toContain('embedded-tool');
    expect(found.find((d) => d.manifest.id === 'embedded-tool')?.iconUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('顶不掉用户目录里同 id 的插件(先扫者胜)', () => {
    const bundle = makeBundle('my-bundle');
    writeJson(path.join(bundle, 'tangu-plugins', 'dup-tool', 'tangu-plugin.json'), engineManifest('dup-tool'));
    writeJson(path.join(pluginsDir(), 'dup-tool', 'tangu-plugin.json'), engineManifest('dup-tool'));
    const found = discoverPlugins().filter((d) => d.manifest.id === 'dup-tool');
    expect(found).toHaveLength(1);
    expect(found[0].dir).toBe(path.join(pluginsDir(), 'dup-tool'));
  });

  it('无内嵌件的 bundle 不产生插件根', () => {
    makeBundle('ui-only');
    expect(bundleEnginePluginRoots()).toEqual([]);
  });
});

describe('内嵌技能', () => {
  it('skills/ 追加进扫描根;用户同 id 覆盖 bundle', async () => {
    const bundle = makeBundle('my-bundle');
    mkdirSync(path.join(bundle, 'skills', 'bundle-skill'), { recursive: true });
    writeFileSync(
      path.join(bundle, 'skills', 'bundle-skill', 'SKILL.md'),
      '---\nname: 来自bundle\ndescription: d\n---\nbody',
    );
    expect(bundleSkillRoots()).toEqual([path.join(bundle, 'skills')]);
    let skills = await listLocalSkills();
    expect(skills.find((s) => s.id === 'local:bundle-skill')?.name).toBe('来自bundle');

    // 用户目录同 slug → 覆盖 bundle 版本
    const userDir = path.join(process.env.TANGU_HOME!, 'skills', 'bundle-skill');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(path.join(userDir, 'SKILL.md'), '---\nname: 用户改版\n---\nbody');
    skills = await listLocalSkills();
    expect(skills.find((s) => s.id === 'local:bundle-skill')?.name).toBe('用户改版');
  });
});

describe('seedBundleAgents', () => {
  it('播种一次:整目录复制(含 skills/),已存在永不覆盖', async () => {
    const bundle = makeBundle('my-bundle');
    const src = path.join(bundle, 'agents', 'bluey');
    mkdirSync(path.join(src, 'skills', 'bluey-skill'), { recursive: true });
    writeFileSync(path.join(src, 'config.toml'), 'name = "Bluey"\nversion = "1"\n');
    writeFileSync(path.join(src, 'SOUL.md'), '初版灵魂');
    writeFileSync(path.join(src, 'skills', 'bluey-skill', 'SKILL.md'), '---\nname: s\n---\nb');

    expect(await seedBundleAgents()).toEqual(['bluey']);
    const dest = path.join(agentsDir(), 'bluey');
    expect(readFileSync(path.join(dest, 'SOUL.md'), 'utf8')).toBe('初版灵魂');
    expect(existsSync(path.join(dest, 'skills', 'bluey-skill', 'SKILL.md'))).toBe(true);

    // 用户改了 SOUL,bundle 也升级了 → 再播不覆盖(活体保护)
    writeFileSync(path.join(dest, 'SOUL.md'), '用户改过的灵魂');
    writeFileSync(path.join(src, 'SOUL.md'), 'bundle v2 灵魂');
    expect(await seedBundleAgents()).toEqual([]);
    expect(readFileSync(path.join(dest, 'SOUL.md'), 'utf8')).toBe('用户改过的灵魂');
  });

  it('agent 内符号链接被解引用复制(播种结果自包含),且不留 .seed- 残留', async () => {
    const bundle = makeBundle('my-bundle');
    const src = path.join(bundle, 'agents', 'linky');
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, 'config.toml'), 'name = "Linky"\nversion = "1"\n');
    writeFileSync(path.join(bundle, 'target.md'), '链接目标内容');
    symlinkSync(path.join(bundle, 'target.md'), path.join(src, 'SOUL.md')); // SOUL.md 是指向 bundle 根的链接

    expect(await seedBundleAgents()).toEqual(['linky']);
    const dest = path.join(agentsDir(), 'linky', 'SOUL.md');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false); // 解引用为普通文件
    expect(readFileSync(dest, 'utf8')).toBe('链接目标内容');
    expect(readdirSync(agentsDir()).filter((n) => n.startsWith('.seed-'))).toEqual([]); // 无 staging 残留
  });

  it('技能指纹自愈:新播种补指纹;没改过跟 bundle 更新;改过保护;人格恒不覆盖', async () => {
    const bundle = makeBundle('heal-bundle');
    const src = path.join(bundle, 'agents', 'healy');
    mkdirSync(path.join(src, 'skills', 'sk-a'), { recursive: true });
    mkdirSync(path.join(src, 'skills', 'sk-b'), { recursive: true });
    writeFileSync(path.join(src, 'config.toml'), 'name = "Healy"\nversion = "1"\n');
    writeFileSync(path.join(src, 'SOUL.md'), '初版灵魂');
    writeFileSync(path.join(src, 'skills', 'sk-a', 'SKILL.md'), 'v1-a');
    writeFileSync(path.join(src, 'skills', 'sk-b', 'SKILL.md'), 'v1-b');

    // 首播:整目录复制 + 技能立刻补指纹(否则下次更新被当无指纹老副本永久停更)
    expect(await seedBundleAgents()).toEqual(['healy']);
    const destSkills = path.join(agentsDir(), 'healy', 'skills');
    expect(existsSync(path.join(destSkills, 'sk-a', '.seed-stamp'))).toBe(true);
    expect(existsSync(path.join(destSkills, 'sk-b', '.seed-stamp'))).toBe(true);

    // bundle 升级:sk-a 没改过 → 跟着更新;sk-b 用户改过 → 保护;SOUL 恒不覆盖
    writeFileSync(path.join(src, 'skills', 'sk-a', 'SKILL.md'), 'v2-a');
    writeFileSync(path.join(src, 'skills', 'sk-b', 'SKILL.md'), 'v2-b');
    writeFileSync(path.join(destSkills, 'sk-b', 'SKILL.md'), '用户改过');
    writeFileSync(path.join(src, 'SOUL.md'), 'bundle v2 灵魂');
    expect(await seedBundleAgents()).toEqual([]); // 不算新播种
    expect(readFileSync(path.join(destSkills, 'sk-a', 'SKILL.md'), 'utf8')).toBe('v2-a');
    expect(readFileSync(path.join(destSkills, 'sk-b', 'SKILL.md'), 'utf8')).toBe('用户改过');
    expect(readFileSync(path.join(agentsDir(), 'healy', 'SOUL.md'), 'utf8')).toBe('初版灵魂');

    // bundle 新增技能 → 已存在的 agent 也能长出来(installed 路径)
    mkdirSync(path.join(src, 'skills', 'sk-new'), { recursive: true });
    writeFileSync(path.join(src, 'skills', 'sk-new', 'SKILL.md'), 'v1-new');
    await seedBundleAgents();
    expect(readFileSync(path.join(destSkills, 'sk-new', 'SKILL.md'), 'utf8')).toBe('v1-new');
  });

  it('跳过非法 slug 与无 config.toml 的目录', async () => {
    const bundle = makeBundle('my-bundle');
    mkdirSync(path.join(bundle, 'agents', 'Bad_Slug'), { recursive: true });
    writeFileSync(path.join(bundle, 'agents', 'Bad_Slug', 'config.toml'), 'name = "x"\n');
    mkdirSync(path.join(bundle, 'agents', 'no-config'), { recursive: true });
    expect(await seedBundleAgents()).toEqual([]);
    expect(existsSync(path.join(agentsDir(), 'Bad_Slug'))).toBe(false);
    expect(existsSync(path.join(agentsDir(), 'no-config'))).toBe(false);
  });
});
