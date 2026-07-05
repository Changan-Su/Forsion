/**
 * 插件发现 + 加载。仅扫描仓库内 `./plugins/`（相对**安装根**解析:`dist/plugins/loader.js`
 * → `<pkg>/plugins`）。纪律对齐 MCP loader（src/mcp/manager.ts）:启动期发现、按 id **确定性排序**、
 * 单插件失败仅告警跳过、不阻断其余。
 *
 * 两段式:**discover**（廉价:扫目录读 manifest）与 **activate**（昂贵:动态 import + `activate()`）分离,
 * 使 `tangu <plugin-cmd>` 只动态 import 命中的那一个插件，`tangu`/`tangu login` 零额外开销。
 *
 * 目录不存在（`ENOENT`）→ 干净 **no-op**:保证无插件时（OSS 核心、Desktop 打包）行为与今日逐字节一致,
 * tool-def 快照也因此不变。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pluginsDir } from '../core/tanguHome.js';
import {
  TANGU_PLUGIN_API,
  type TanguPlugin,
  type TanguPluginContext,
  type TanguPluginManifest,
} from './types.js';

const MANIFEST = 'tangu-plugin.json';

/**
 * 插件搜索目录(按优先级,先扫的同 id 胜):
 *   ① <pkg>/plugins —— 随包发布的首方插件(如 forsion-worker;会进 worker 镜像)。受保护,不被用户插件顶掉。
 *   ② ~/.tangu/plugins —— 用户安装的全局插件(可写、跨升级保留)。
 * `TANGU_PLUGINS=off` 全关;`TANGU_PLUGINS_DIR=<path>` 只扫该目录(覆盖以上两者)。
 */
export function resolvePluginsDirs(): string[] {
  if (process.env.TANGU_PLUGINS === 'off') return [];
  const override = process.env.TANGU_PLUGINS_DIR;
  if (override) return [path.resolve(override)];
  const here = path.dirname(fileURLToPath(import.meta.url)); // <pkg>/dist/plugins
  return [
    path.resolve(here, '../../plugins'), // ① <pkg>/plugins(首方,随包/进 worker 镜像)
    pluginsDir(), // ② ~/.tangu/plugins(用户安装的全局插件)
  ];
}

export interface DiscoveredPlugin {
  manifest: TanguPluginManifest;
  dir: string;
  /** 已构建入口的 file:// URL（动态 import 用）。 */
  entryUrl: string;
}

/** 廉价:扫各目录、读 manifest、校验 apiVersion，按 id 去重(先扫目录胜)后排序。目录全缺失/为空 → `[]`。 */
export function discoverPlugins(): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];
  const seen = new Set<string>(); // 同 id 只取第一个(高优先级目录),防用户插件顶掉首方(forsion-worker)
  for (const root of resolvePluginsDirs()) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') console.warn(`[tangu] 插件目录读取失败（忽略）:${root}:${e?.message || e}`);
      continue; // 目录不存在 → 跳过（OSS/Desktop/无用户插件 常态)
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const dir = path.join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      let manifest: TanguPluginManifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
      } catch (e: any) {
        if (e?.code !== 'ENOENT') console.warn(`[tangu] 插件 ${name} manifest 解析失败，跳过:${e?.message || e}`);
        continue; // 无 manifest 的子目录直接忽略
      }
      if (!manifest?.id || !manifest?.entry) {
        console.warn(`[tangu] 插件 ${name} manifest 缺 id/entry，跳过`);
        continue;
      }
      if (manifest.apiVersion !== TANGU_PLUGIN_API) {
        console.warn(`[tangu] 插件 ${manifest.id} apiVersion=${manifest.apiVersion} 与宿主 ${TANGU_PLUGIN_API} 不兼容，跳过`);
        continue;
      }
      if (seen.has(manifest.id)) {
        console.warn(`[tangu] 插件 ${manifest.id} 重复(${dir})，已被更高优先级目录加载，跳过`);
        continue;
      }
      seen.add(manifest.id);
      found.push({ manifest, dir, entryUrl: pathToFileURL(path.resolve(dir, manifest.entry)).href });
    }
  }
  // 确定性:按 id 排序（与 MCP 的字母序纪律一致，保证工具/路由注册顺序稳定）。
  found.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0));
  return found;
}

/** 昂贵:动态 import 入口、取 default-export `TanguPlugin`、调 `activate(ctx)`。失败抛（调用方决定吞/抛）。 */
export async function activatePlugin(d: DiscoveredPlugin, ctx: TanguPluginContext): Promise<TanguPlugin> {
  const mod = await import(d.entryUrl);
  const plugin: TanguPlugin = mod.default ?? mod.plugin;
  if (!plugin || typeof plugin.activate !== 'function') {
    throw new Error(`插件 ${d.manifest.id} 入口未 default-export 合法 TanguPlugin`);
  }
  await plugin.activate(ctx);
  return plugin;
}
