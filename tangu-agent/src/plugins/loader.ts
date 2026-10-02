import { isHostSandboxRestricted } from '../sandbox/hostSandboxPolicy.js';
/**
 * 插件发现 + 加载。仅扫描仓库内 `./plugins/`（相对**安装根**解析:`dist/plugins/loader.js`
 * → `<pkg>/plugins`）。纪律对齐 MCP loader（src/mcp/manager.ts）:启动期发现、按 id **确定性排序**、
 * 单插件失败仅告警跳过、不阻断其余。
 *
 * 两段式:**discover**（廉价:扫目录读 manifest）与 **activate**（昂贵:动态 import + `activate()`）分离,
 * 使 `tangu <plugin-cmd>` 只动态 import 命中的那一个插件，`tangu`/`tangu login` 零额外开销。
 * 启停 / 依赖 / 热升级的生命周期编排在 ./bootstrap.ts;这里只出纯函数(消毒、拓扑序、指纹、版本比较、import)。
 *
 * 目录不存在（`ENOENT`）→ 干净 **no-op**:保证无插件时（OSS 核心、Desktop 打包）行为与今日逐字节一致,
 * tool-def 快照也因此不变。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pluginsDir } from '../core/tanguHome.js';
import { bundleEnginePluginRoots } from './bundles.js';
import {
  TANGU_PLUGIN_API,
  type TanguPlugin,
  type TanguPluginContext,
  type TanguPluginManifest,
} from './types.js';
import { pluginIconDataUrl } from './icon.js';

const MANIFEST = 'tangu-plugin.json';

/**
 * 插件搜索目录(按优先级,先扫的同 id 胜):
 *   ① <pkg>/plugins —— 随包发布的首方插件(如 forsion-worker;会进 worker 镜像)。受保护,不被用户插件顶掉。
 *   ② ~/.tangu/plugins —— 用户安装的全局插件(可写、跨升级保留)。
 *   ③ 共享域 plugins/<bundle>/tangu-plugins —— Forsion 插件捆绑包内嵌的引擎插件(原地读取,见 bundles.ts)。
 * `TANGU_PLUGINS=off` 全关;`TANGU_PLUGINS_DIR=<path>` 只扫该目录(覆盖以上全部,含 bundle)。
 */
export function resolvePluginsDirs(bundleRoots = bundleEnginePluginRoots()): string[] {
  if (process.env.TANGU_PLUGINS === 'off') return [];
  const override = process.env.TANGU_PLUGINS_DIR;
  if (override) return [path.resolve(override)];
  const here = path.dirname(fileURLToPath(import.meta.url)); // <pkg>/dist/plugins
  return [
    path.resolve(here, '../../plugins'), // ① <pkg>/plugins(首方,随包/进 worker 镜像)
    pluginsDir(), // ② ~/.tangu/plugins(用户安装的全局插件)
    ...bundleRoots, // ③ Forsion bundle 内嵌(优先级最低:顶不掉首方/用户装的同 id)
  ];
}

/** 插件 id 字符集(kebab)。settings 存储(sanitizeId)与桌面卸载(isSafeSlug)都只认它;requiresPlugins 同口径。 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 单个插件最多声明的前置插件数(与桌面 UI 插件同上限)。 */
const MAX_REQUIRES = 8;

/** 消毒后的前置声明(manifest `requiresPlugins` 的一项)。 */
export interface PluginRequirement {
  id: string;
  minVersion?: string;
}

export interface DiscoveredPlugin {
  manifest: TanguPluginManifest;
  dir: string;
  /** 包根 icon.png，经宿主校验后的 data URL；设置页身份图标用。 */
  iconUrl?: string;
  /** 已构建入口的 file:// URL（动态 import 用）。 */
  entryUrl: string;
  /** 来自 Forsion 捆绑包内嵌根(③)。启停归捆绑包管,见 bootstrap 的 defaultEnabled。 */
  bundled: boolean;
  /** 消毒后的前置插件(kebab id、去重、≤8;字符串与对象两种写法归一,其余键忽略)。 */
  requiresPlugins: PluginRequirement[];
  /** 代码指纹:manifest 版本 + 入口路径 + 包内代码文件的 mtime/size 摘要。重扫时据此判「同 id 换了新代码」→ 原地升级。 */
  fingerprint: string;
}

/**
 * manifest `requiresPlugins` 消毒(与桌面 sanitizeRequiresPlugins 同口径):`"id"` 或 `{ id, minVersion? }`
 * (market / name 等桌面用的键引擎忽略)。非 kebab id、依赖自己的丢弃,同 id 留第一条,最多看前 32 项、留 8 条;
 * minVersion 须是点分数字(可带前导 v),否则只丢 minVersion、依赖照留。
 */
function sanitizeRequires(raw: unknown, selfId: string): PluginRequirement[] {
  if (!Array.isArray(raw)) return [];
  const out: PluginRequirement[] = [];
  for (const r of raw.slice(0, 32)) {
    if (out.length >= MAX_REQUIRES) break;
    const o = typeof r === 'string' ? { id: r } : r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
    const id = typeof o?.id === 'string' ? o.id.trim() : '';
    if (!PLUGIN_ID_RE.test(id) || id === selfId || out.some((x) => x.id === id)) continue;
    const mv = typeof o?.minVersion === 'string' ? o.minVersion.trim().slice(0, 32) : '';
    out.push(/^v?\d+(\.\d+){0,3}$/.test(mv) ? { id, minVersion: mv } : { id });
  }
  return out;
}

/** 简单点分数字比较(与桌面同口径):前导 v 忽略、缺的段按 0、非数字段按 0。返回 -1 / 0 / 1。 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => String(v ?? '').trim().replace(/^v/i, '').split('.').map((s) => parseInt(s, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.node', '.wasm']);
// ponytail: 最多看这么多个代码文件;更大的包只按前这些算(只改了排在后面的 helper 会漏判成「没变」)。
const MAX_FINGERPRINT_FILES = 2000;

/** 包内代码文件(绝对路径,按路径排序;跳过 node_modules 与点目录)。指纹与热升级判定同一口径。 */
function codeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length >= MAX_FINGERPRINT_FILES) return;
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && CODE_EXT.has(path.extname(ent.name))) out.push(abs);
    }
  };
  walk(dir);
  return out;
}

/** 指纹覆盖整个包的代码文件,不只入口:只改了 dist/helper.js 也要判成「变了」,
 *  否则重扫当它没变、老 helper 照跑还报 needsRestart:false(Codex 10-02)。 */
function fingerprintOf(version: string, entryPath: string, dir: string): string {
  const parts: string[] = [];
  for (const f of codeFiles(dir)) {
    try { const st = statSync(f); parts.push(`${path.relative(dir, f)}:${st.mtimeMs}:${st.size}`); } catch { /* 刚被删:不计 */ }
  }
  let entry: string;
  try { const st = statSync(entryPath); entry = `${st.mtimeMs}|${st.size}`; } catch { entry = 'missing'; }
  return `${version}|${entryPath}|${entry}|${createHash('sha1').update(parts.join('\n')).digest('hex')}`;
}

/**
 * 激活顺序:按 requiresPlugins 拓扑排序,同层按 id(每步取「已就绪」里 id 最小者)——无依赖时**逐字等于**
 * 今日的 id 字母序,工具/路由注册顺序因此不变。成环的(及其下游)排不出拓扑序,按 id 接在末尾(它们都会休眠)。
 * 指向未发现插件的边不参与排序(该插件以 'missing' 休眠)。
 */
export function orderByRequires(list: DiscoveredPlugin[]): DiscoveredPlugin[] {
  const byId = new Map(list.map((d) => [d.manifest.id, d]));
  const pending = new Map(list.map((d) => [d.manifest.id, new Set(d.requiresPlugins.map((r) => r.id).filter((id) => byId.has(id)))]));
  const out: DiscoveredPlugin[] = [];
  while (pending.size) {
    const ready = [...pending.keys()].filter((id) => pending.get(id)!.size === 0).sort();
    if (!ready.length) {
      for (const id of [...pending.keys()].sort()) out.push(byId.get(id)!);
      break;
    }
    const id = ready[0];
    out.push(byId.get(id)!);
    pending.delete(id);
    for (const deps of pending.values()) deps.delete(id);
  }
  return out;
}

/** 廉价:扫各目录、读 manifest、校验 apiVersion，按 id 去重(先扫目录胜)后排序(依赖拓扑,同层 id 序)。目录全缺失/为空 → `[]`。 */
export function discoverPlugins(): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = [];
  const seen = new Set<string>(); // 同 id 只取第一个(高优先级目录),防用户插件顶掉首方(forsion-worker)
  const bundleRoots = bundleEnginePluginRoots(); // 只扫一次:搜索根与 bundled 标记必须出自同一份结果
  for (const root of resolvePluginsDirs(bundleRoots)) {
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
      // id 必须 kebab:settings 存储(sanitizeId)与桌面卸载(isSafeSlug)都只认这个字符集,
      // 放进来就是「能装不能卸、设置永远清不掉」的孤儿,入口处直接挡。
      if (!PLUGIN_ID_RE.test(manifest.id)) {
        console.warn(`[tangu] 插件 ${name} id "${manifest.id}" 非法(须 kebab-case),跳过`);
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
      const entryPath = path.resolve(dir, manifest.entry);
      found.push({
        manifest, dir, iconUrl: pluginIconDataUrl(dir), entryUrl: pathToFileURL(entryPath).href, bundled: bundleRoots.includes(root),
        requiresPlugins: sanitizeRequires(manifest.requiresPlugins, manifest.id),
        fingerprint: fingerprintOf(String(manifest.version ?? ''), entryPath, dir),
      });
    }
  }
  // 确定性:按 id 排序（与 MCP 的字母序纪律一致，保证工具/路由注册顺序稳定）,再按 requiresPlugins 拓扑(无依赖时不变)。
  found.sort((a, b) => (a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0));
  return orderByRequires(found);
}

// 空白与注释(`from /* x */ './a'`、`import(/* x */ './a')` 都得认出来)
const GAP = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*`;
/** ESM 相对引入:import x from './x' / export * from '../x' / import './x' / import('./x') / import(变量 / 模板串)。 */
const ESM_IMPORT = new RegExp([
  String.raw`\b(?:from|import)${GAP}['"]\.{1,2}/`,
  String.raw`\bimport${GAP}\(${GAP}(?:['"]\.{1,2}/|[^'"\s)])`,
].join('|'));
/** CommonJS 引入:require('./x') / require(变量)。CommonJS 按文件名缓存,查询串破不了。
 *  (单写 createRequire 不算:esbuild banner 用它造 require 只拿 node 内置,不涉及包内文件。) */
const CJS_REQUIRE = new RegExp(String.raw`\brequire${GAP}\(${GAP}(?:['"]\.{1,2}/|[^'"\s)])`);

/** 运行时能不能整图换代:Node ≥ 22.15 的同步模块钩子(打包版 Electron 40 = Node 24)。
 *  `TANGU_PLUGIN_GRAPH_SWAP=0` 关掉,退回只破入口(多文件插件换代 = 需重启)。 */
export function canSwapWholeGraph(): boolean {
  return process.env.TANGU_PLUGIN_GRAPH_SWAP !== '0' && typeof (module as { registerHooks?: unknown }).registerHooks === 'function';
}

/** 入口所在的包作用域是不是 ESM:与 Node 同法,从入口目录往上找最近的 package.json(可以在插件目录之外,
 *  如捆绑包根),看它的 "type"。入口本身是 .mjs 也算。 */
function entryScopeIsModule(entryFile: string): boolean {
  if (entryFile.endsWith('.mjs')) return true;
  for (let d = path.dirname(entryFile); path.basename(d) !== 'node_modules'; d = path.dirname(d)) {
    try {
      return JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8'))?.type === 'module';
    } catch { /* 没有或坏了:往上找 */ }
    if (path.dirname(d) === d) break;
  }
  return false;
}

/**
 * 能不能原地热升级。换代时入口带 `?tangu-gen=` 查询串重新 import;入口引入的同包 ESM 文件靠 resolve 钩子带上同一代号
 * (loadPlugin)。破不了的如实判「需重启」(老实例继续跑):包里自带 node_modules、任何 CommonJS(.cjs / require(…) /
 * 非 type:module 作用域)、原生 .node、或运行时没有模块钩子而入口有相对引入。宁可误报不可漏报(注释、字符串里出现也算)。
 * 首方引擎插件是 esbuild 单文件 bundle,只破入口就够。
 */
export function cannotHotSwap(d: DiscoveredPlugin): boolean {
  if (existsSync(path.join(d.dir, 'node_modules'))) return true;
  let entryFile: string;
  let src: string;
  try {
    entryFile = fileURLToPath(d.entryUrl);
    src = readFileSync(entryFile, 'utf8');
  } catch {
    return false; // 读不到入口 → 升级时 import 会自己报错(lastError),不在这里拦
  }
  if (!ESM_IMPORT.test(src) && !CJS_REQUIRE.test(src)) return false; // 单文件:只破入口就够
  if (!canSwapWholeGraph() || !entryScopeIsModule(entryFile)) return true;
  for (const f of codeFiles(d.dir)) {
    if (f.endsWith('.cjs') || f.endsWith('.node')) return true;
    if (f.endsWith('.js') && !entryScopeIsModule(f)) return true; // 子目录自带非 module 的 package.json → 那里的 .js 是 CommonJS
    if (/\.m?js$/.test(f)) {
      try { if (CJS_REQUIRE.test(readFileSync(f, 'utf8'))) return true; } catch { /* 刚被删:不计 */ }
    }
  }
  return false;
}

/** 代号 → 那一代入口所在插件根(realpath)。只增不减:总量受热换代上限约束(bootstrap MAX_HOT_GENERATIONS)。 */
const genRoots = new Map<string, string>();
const GEN_PARAM = /[?&]tangu-gen=(\d+)/;
let graphHooksInstalled = false;

/** 第一次换代时装一个同步 resolve 钩子:父模块 URL 带 `?tangu-gen=N`、解析结果是同一插件根里的 file: 模块 → 也带上
 *  同一代号。于是入口相对引入的文件(及其再引入的)都是这一代的新模块,不沿用 ESM 缓存里的旧 helper。
 *  不带代号的父模块(引擎自己、首次 import 的插件)原样放行。 */
function ensureGraphHooks(): void {
  if (graphHooksInstalled || !canSwapWholeGraph()) return;
  graphHooksInstalled = true;
  type Resolved = { url: string };
  (module as unknown as { registerHooks(h: { resolve(s: string, c: { parentURL?: string }, next: (s: string, c: unknown) => Resolved): Resolved }): unknown }).registerHooks({
    resolve(specifier, context, nextResolve) {
      const r = nextResolve(specifier, context);
      const gen = context.parentURL ? GEN_PARAM.exec(context.parentURL)?.[1] : undefined;
      const root = gen ? genRoots.get(gen) : undefined;
      if (!root || !r.url.startsWith('file:') || GEN_PARAM.test(r.url)) return r;
      let file: string;
      try { file = fileURLToPath(r.url); } catch { return r; }
      if (!file.startsWith(root + path.sep)) return r;
      return { ...r, url: `${r.url}${r.url.includes('?') ? '&' : '?'}tangu-gen=${gen}` };
    },
  });
}

/** 本机沙箱开启时原生插件一律不可用。每次激活都判 —— 停用→启用复用已 import 的模块对象也要过这道闸。 */
export function assertNativePluginsAllowed(): void {
  if (isHostSandboxRestricted()) throw new Error('Native plugins are unavailable while the local sandbox is enabled');
}

/**
 * 昂贵:动态 import 入口、取 default-export `TanguPlugin`(不 activate)。失败抛。
 * `gen > 0` 时给入口 URL 带 `?tangu-gen=<n>` 破 ESM 缓存(原地升级用),同包 ESM 文件经 resolve 钩子带上同一代号(见 cannotHotSwap)。
 * 普通停用→启用**不**重 import(ESM 模块永不卸载,每拨一次 import 一份会泄漏),复用同一模块对象再 activate。
 */
export async function loadPlugin(d: DiscoveredPlugin, gen = 0): Promise<TanguPlugin> {
  assertNativePluginsAllowed();
  if (gen > 0) {
    try { genRoots.set(String(gen), realpathSync(d.dir)); } catch { /* 目录没了:下面的 import 自己报错 */ }
    ensureGraphHooks();
  }
  const mod = await import(gen > 0 ? `${d.entryUrl}?tangu-gen=${gen}` : d.entryUrl);
  const plugin: TanguPlugin = mod.default ?? mod.plugin;
  if (!plugin || typeof plugin.activate !== 'function') {
    throw new Error(`插件 ${d.manifest.id} 入口未 default-export 合法 TanguPlugin`);
  }
  return plugin;
}

/** 一次性:import + `activate(ctx)`(tui 的 `tangu <plugin-cmd>` 用,不进生命周期台账)。失败抛（调用方决定吞/抛）。 */
export async function activatePlugin(d: DiscoveredPlugin, ctx: TanguPluginContext): Promise<TanguPlugin> {
  const plugin = await loadPlugin(d);
  await plugin.activate(ctx);
  return plugin;
}
