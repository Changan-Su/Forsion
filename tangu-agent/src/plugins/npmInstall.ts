/**
 * npm 插件安装通道(核心;CLI 与 HTTP 路由共用一份实现)。
 *
 * **为什么不 spawn `npm install`**:npm 会执行包的生命周期脚本(postinstall)= 装前即运行任意代码,
 * 与「插件以完整系统权限运行、装前自审源码」的信任模型冲突;且桌面用户机器没有 npm(CLI shim 走
 * ELECTRON_RUN_AS_NODE)。这里直接拉 registry tarball → 内存 gunzip + untar(minitar 仅普通文件,
 * 拒绝 symlink 等) → integrity 校验 → 原子落位。安装动作本身**零代码执行**;插件代码只在被 activate
 * 时才跑(受 hostExec 门禁 + 审批约束)。
 *
 * 落点 = pluginsDir()(~/.tangu/plugins;桌面托管真身 ~/.forsion/tangu/plugins),与市场 zip 通道同构。
 */
import {
  mkdirSync, writeFileSync, rmSync, renameSync, existsSync, readFileSync,
  chmodSync, statSync, lstatSync, readdirSync, symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { untar, stripTopDir, type TarEntry } from './minitar.js';
import { pluginsDir } from '../core/tanguHome.js';
import { TANGU_PLUGIN_API, type TanguPluginManifest } from './types.js';

const MANIFEST = 'tangu-plugin.json';
const SOURCE_FILE = '.tangu-source.json';
const OFFICIAL = 'https://registry.npmjs.org';
const MIRROR = 'https://registry.npmmirror.com';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_TARBALL = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_UNPACK = 500 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/; // 与 loader.ts 同正则

export type InstallSpec =
  | { kind: 'npm'; name: string; version?: string }
  | { kind: 'path'; path: string }; // 本地目录或 .tgz

/** 写进插件目录 .tangu-source.json 的来源溯源。 */
export interface SourceMeta {
  source: 'npm' | 'path';
  spec: string;
  name: string;
  version?: string;
  registry?: string;
  tarball?: string;
  integrity?: string;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  dir: string;
  manifest: TanguPluginManifest;
}

export interface InstallOpts {
  preferMirror?: boolean;
  registry?: string;
  force?: boolean;
  /** 仅本地目录:symlink 进插件目录(开发流,不复制、不写 source.json)。 */
  link?: boolean;
  onLog?: (line: string) => void;
  /** npm 源:resolve 元数据后、下载前调用。返回 false → 取消(抛 InstallCancelled)。CLI 用它做 y/N 确认;
   *  HTTP 路由已在 UI 侧确认过则不传(或恒 true)。 */
  confirm?: (info: ConfirmInfo) => boolean | Promise<boolean>;
  /** 测试注入。缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

/** 确认回调拿到的元数据(展示给用户/agent 供装前审阅)。 */
export interface ConfirmInfo {
  name: string;
  version: string;
  registry: string;
  integrity?: string;
  unpackedSize?: number;
}

/** 用户/调用方在确认环节拒绝安装。isRetryable 对它返回 false → 不换源重试、直接冒泡。 */
export class InstallCancelled extends Error {
  constructor() { super('installation cancelled'); this.name = 'InstallCancelled'; }
}

/** semver 范围(^ ~ > < * | 空格、a - b、1.x)不支持——对齐 pi 的 spec 锁定语义,且省一个 semver 依赖。 */
function isRange(v: string): boolean {
  return /[\^~><*|\s]/.test(v) || v.includes(' - ') || /(^|\.)x$/i.test(v) || /^\d+\.x/i.test(v);
}

export function parseInstallSpec(raw: string): InstallSpec {
  const s = String(raw || '').trim();
  if (!s) throw new Error('安装源为空');
  if (s.startsWith('npm:')) {
    const rest = s.slice(4).trim();
    const at = rest.lastIndexOf('@'); // scoped 包首字符也是 @,故用 lastIndexOf 且要求 at>0
    let name = rest;
    let version: string | undefined;
    if (at > 0) { name = rest.slice(0, at); version = rest.slice(at + 1) || undefined; }
    if (!name) throw new Error('npm spec 缺包名');
    if (version && isRange(version)) {
      throw new Error(`不支持 semver 范围「${version}」——请给精确版本或 dist-tag(如 npm:${name}@1.2.3 或 npm:${name}@latest)`);
    }
    return { kind: 'npm', name, version };
  }
  if (s.startsWith('./') || s.startsWith('../') || s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s)) {
    return { kind: 'path', path: s };
  }
  throw new Error(`无法识别的安装源「${raw}」——用 npm:<包名>[@版本]、本地目录或 .tgz 路径`);
}

export function registryCandidates(opts?: { preferMirror?: boolean; override?: string }): string[] {
  const override = (opts?.override || process.env.TANGU_NPM_REGISTRY || '').trim();
  if (override) return [override.replace(/\/+$/, '')];
  return opts?.preferMirror ? [MIRROR, OFFICIAL] : [OFFICIAL, MIRROR];
}

function encodeName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2f') : name; // scoped 包路径段编码斜杠
}

async function fetchWithTimeout(url: string, init: RequestInit, opts: InstallOpts): Promise<Response> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  return (opts.fetchImpl ?? fetch)(url, { ...init, signal });
}

export interface ResolvedPackage {
  version: string;
  tarball: string;
  integrity?: string;
  shasum?: string;
  unpackedSize?: number;
}

/** 拉 abbreviated packument,解析精确版本 / dist-tag → tarball 元数据。 */
export async function resolvePackage(name: string, version: string | undefined, registry: string, opts: InstallOpts): Promise<ResolvedPackage> {
  const url = `${registry.replace(/\/+$/, '')}/${encodeName(name)}`;
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } }, opts);
  if (!res.ok) throw new HttpError(res.status, `拉取 ${name} 元数据失败(HTTP ${res.status} @ ${registry})`);
  const doc: any = await res.json();
  const tags = doc['dist-tags'] || {};
  let ver = version;
  if (!ver) ver = tags.latest;
  else if (tags[ver]) ver = tags[ver]; // dist-tag → 具体版本
  const v = ver && doc.versions ? doc.versions[ver] : undefined;
  if (!v) throw new HttpError(404, `${name} 无版本「${version || 'latest'}」`);
  const dist = v.dist || {};
  if (!dist.tarball) throw new Error(`${name}@${v.version} 缺 tarball 地址`);
  return { version: v.version, tarball: dist.tarball, integrity: dist.integrity, shasum: dist.shasum, unpackedSize: dist.unpackedSize };
}

async function downloadTarball(url: string, opts: InstallOpts): Promise<Buffer> {
  const res = await fetchWithTimeout(url, {}, opts);
  if (!res.ok) throw new HttpError(res.status, `下载 tarball 失败(HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TARBALL) throw new Error(`tarball 超过上限(${(buf.length / 1048576).toFixed(1)}MB > 100MB)`);
  return buf;
}

function verifyIntegrity(tgz: Buffer, pkg: ResolvedPackage, onLog?: (l: string) => void): void {
  if (pkg.integrity) {
    const sri = pkg.integrity.split(/\s+/)[0]; // 可能多算法空格分隔,取第一个
    const dash = sri.indexOf('-');
    const algo = sri.slice(0, dash);
    const want = sri.slice(dash + 1);
    const got = createHash(algo).update(tgz).digest('base64');
    if (got !== want) throw new Error('integrity 校验失败(tarball 与 registry 记录不符,可能被篡改)');
  } else if (pkg.shasum) {
    const got = createHash('sha1').update(tgz).digest('hex');
    if (got !== pkg.shasum) throw new Error('shasum 校验失败(tarball 与 registry 记录不符)');
  } else {
    onLog?.('⚠ registry 未提供 integrity/shasum,跳过完整性校验');
  }
}

/** 落盘防穿越:rel 归一后必须仍在 root 之内。 */
function safeJoin(root: string, rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const out = path.join(root, norm);
  const rp = path.relative(root, out);
  if (!rp || rp.startsWith('..') || path.isAbsolute(rp)) throw new Error(`非法路径(疑似穿越): ${rel}`);
  return out;
}

function parseManifest(entries: TarEntry[]): TanguPluginManifest {
  const m = entries.find((e) => e.path === MANIFEST);
  if (!m) throw new Error(`不是 Tangu 插件包(缺 ${MANIFEST})`);
  let manifest: TanguPluginManifest;
  try { manifest = JSON.parse(m.data.toString('utf8')); } catch (e: any) { throw new Error(`${MANIFEST} 解析失败: ${e?.message || e}`); }
  if (!manifest?.id || !ID_RE.test(manifest.id)) throw new Error(`插件 id「${manifest?.id}」非法(须 kebab-case)`);
  if (manifest.apiVersion !== TANGU_PLUGIN_API) throw new Error(`插件 apiVersion=${manifest.apiVersion} 与宿主 ${TANGU_PLUGIN_API} 不兼容`);
  if (!manifest.entry) throw new Error('manifest 缺 entry(已构建 ESM 入口)');
  const entryPath = manifest.entry.replace(/^\.\//, '');
  if (!entries.some((e) => e.path === entryPath)) throw new Error(`入口文件不存在于包内: ${manifest.entry}(是否忘了构建 / 忘了加进 files?)`);
  return manifest;
}

/** 同 id 冲突预检:首方(随包内置)同名一律拒;Forsion bundle 内嵌同 id → 要 --force(用户目录按
 *  loader 优先级会胜出,允许显式覆盖,不能误报成首方,codex P1-6);用户目录同 id 但来源包名不同 → 要 --force。 */
async function checkConflict(id: string, newName: string, force: boolean | undefined): Promise<void> {
  const { discoverPlugins } = await import('./loader.js');
  const { bundleEnginePluginRoots } = await import('./bundles.js');
  const existing = discoverPlugins().find((d) => d.manifest.id === id);
  if (!existing) return;
  const existingDir = path.resolve(existing.dir);
  const userRoot = path.resolve(pluginsDir());
  const inUser = existingDir.startsWith(userRoot + path.sep);
  if (!inUser) {
    const fromBundle = bundleEnginePluginRoots().some((r) => existingDir.startsWith(path.resolve(r) + path.sep));
    if (!fromBundle) throw new Error(`插件 id「${id}」与随包内置插件同名,拒绝安装`);
    if (!force) throw new Error(`插件 id「${id}」已由 Forsion 捆绑包提供——加 --force 安装用户目录版本(将优先生效)`);
    return;
  }
  if (force) return;
  const prev = readSource(existing.dir);
  if (prev && prev.name && prev.name !== newName) {
    throw new Error(`已安装同 id 不同来源的插件(${prev.name}@${prev.version || '?'})——加 --force 覆盖`);
  }
}

function readSource(dir: string): (SourceMeta & { id?: string; version?: string; installedAt?: string }) | null {
  try { return JSON.parse(readFileSync(path.join(dir, SOURCE_FILE), 'utf8')); } catch { return null; }
}

function warnIfUnbundled(entries: TarEntry[], onLog?: (l: string) => void): void {
  const pkg = entries.find((e) => e.path === 'package.json');
  if (!pkg) return;
  try {
    const deps = JSON.parse(pkg.data.toString('utf8')).dependencies;
    const hasDeps = deps && Object.keys(deps).length > 0;
    const hasNodeModules = entries.some((e) => e.path.startsWith('node_modules/'));
    if (hasDeps && !hasNodeModules) {
      onLog?.('⚠ 包声明了运行时依赖但未内置 node_modules——若插件加载报「找不到模块」,请让作者 esbuild 打包成单文件或用 bundleDependencies。');
    }
  } catch { /* package.json 坏了,略 */ }
}

/** 核心落盘(tarball 与本地目录共用):内存 entries → staging → 原子落位 → source.json。 */
async function installFromEntries(entries: TarEntry[], meta: SourceMeta, opts: InstallOpts): Promise<InstalledPlugin> {
  if (!entries.length) throw new Error('包为空');
  if (entries.length > MAX_ENTRIES) throw new Error(`条目数超上限(${entries.length} > ${MAX_ENTRIES})`);
  let total = 0;
  for (const e of entries) total += e.data.length;
  if (total > MAX_UNPACK) throw new Error(`解包总量超上限(${(total / 1048576).toFixed(0)}MB > 500MB)`);

  const manifest = parseManifest(entries);
  await checkConflict(manifest.id, meta.name, opts.force);

  const root = pluginsDir();
  mkdirSync(root, { recursive: true });
  const staging = path.join(root, `.staging-${Date.now()}-${process.pid}`);
  try {
    for (const e of entries) {
      const dest = safeJoin(staging, e.path);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, e.data);
      if (e.mode && process.platform !== 'win32') { try { chmodSync(dest, e.mode); } catch { /* 权限恢复失败不致命 */ } }
    }
    const target = path.join(root, manifest.id);
    let trash: string | undefined;
    if (existsSync(target)) { trash = `${target}.trash-${Date.now()}`; renameSync(target, trash); }
    try {
      renameSync(staging, target);
    } catch (e) {
      if (trash) renameSync(trash, target); // 回滚
      throw e;
    }
    if (trash) rmSync(trash, { recursive: true, force: true });
    writeFileSync(
      path.join(target, SOURCE_FILE),
      JSON.stringify({ ...meta, id: manifest.id, version: manifest.version, installedAt: new Date().toISOString() }, null, 2),
    );
    warnIfUnbundled(entries, opts.onLog);
    return { id: manifest.id, name: manifest.name, version: manifest.version, dir: target, manifest };
  } finally {
    rmSync(staging, { recursive: true, force: true }); // 成功已 rename 走(不存在=no-op),失败清残留
  }
}

/** .tgz(gzip)字节 → 落盘。 */
export async function installFromTarball(tgz: Buffer, meta: SourceMeta, opts: InstallOpts): Promise<InstalledPlugin> {
  const tar = gunzipSync(tgz);
  return installFromEntries(stripTopDir(untar(tar)), meta, opts);
}

/** 递归读本地目录成 TarEntry[](跳过 .git / node_modules 里的 .bin 软链等风险项由 minitar 同源规则约束——这里只读文件)。 */
function readDirEntries(dir: string): TarEntry[] {
  const out: TarEntry[] = [];
  const walk = (d: string, rel: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (ent.name === '.git') continue;
      const abs = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) out.push({ path: r, data: readFileSync(abs), mode: statSync(abs).mode & 0o777 });
      // symlink 等:跳过(与 minitar 拒绝 symlink 同源立场)
    }
  };
  walk(dir, '');
  return out;
}

/** 本地目录 symlink 进插件目录(开发流)。读源目录 manifest 取 id,不复制、不写 source.json。 */
async function linkLocalDir(dir: string, opts: InstallOpts): Promise<InstalledPlugin> {
  const abs = path.resolve(dir);
  let manifest: TanguPluginManifest;
  try { manifest = JSON.parse(readFileSync(path.join(abs, MANIFEST), 'utf8')); } catch { throw new Error(`目录缺 ${MANIFEST}: ${abs}`); }
  if (!manifest?.id || !ID_RE.test(manifest.id)) throw new Error(`插件 id「${manifest?.id}」非法(须 kebab-case)`);
  if (manifest.apiVersion !== TANGU_PLUGIN_API) throw new Error(`插件 apiVersion=${manifest.apiVersion} 与宿主 ${TANGU_PLUGIN_API} 不兼容`);
  await checkConflict(manifest.id, manifest.name, opts.force);
  const root = pluginsDir();
  mkdirSync(root, { recursive: true });
  const target = path.join(root, manifest.id);
  if (existsSync(target) || isSymlink(target)) rmSync(target, { recursive: true, force: true });
  symlinkSync(abs, target, 'dir');
  opts.onLog?.(`已 symlink ${abs} → ${target}(改源目录 dist 后重启引擎即生效)`);
  return { id: manifest.id, name: manifest.name, version: manifest.version, dir: target, manifest };
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function isRetryable(e: unknown): boolean {
  if (e instanceof HttpError) return e.status >= 500 || e.status === 404 || e.status === 429;
  // fetch 网络错误(TypeError)/ 超时(AbortError/TimeoutError)→ 可换源重试
  const name = (e as any)?.name;
  return name === 'AbortError' || name === 'TimeoutError' || e instanceof TypeError;
}

/** 编排入口:解析 spec → 下载/读取 → 落盘。 */
export async function installPlugin(spec: InstallSpec, rawSpec: string, opts: InstallOpts = {}): Promise<InstalledPlugin> {
  if (spec.kind === 'path') {
    const p = path.resolve(spec.path);
    let st;
    try { st = statSync(p); } catch { throw new Error(`路径不存在: ${p}`); }
    if (st.isDirectory()) {
      if (opts.link) return linkLocalDir(p, opts);
      return installFromEntries(readDirEntries(p), { source: 'path', spec: rawSpec, name: p }, opts);
    }
    if (opts.link) throw new Error('--link 仅支持本地目录');
    const tgz = readFileSync(p); // .tgz
    return installFromTarball(tgz, { source: 'path', spec: rawSpec, name: p }, opts);
  }
  // npm:候选 registry 依次尝试,可重试错误(网络/超时/5xx/404/429)换下一个;完整性/manifest 错误直接抛。
  let lastErr: unknown;
  for (const registry of registryCandidates({ preferMirror: opts.preferMirror, override: opts.registry })) {
    try {
      const pkg = await resolvePackage(spec.name, spec.version, registry, opts);
      if (opts.confirm) {
        const ok = await opts.confirm({ name: spec.name, version: pkg.version, registry, integrity: pkg.integrity, unpackedSize: pkg.unpackedSize });
        if (!ok) throw new InstallCancelled();
      }
      const tgz = await downloadTarball(pkg.tarball, opts);
      verifyIntegrity(tgz, pkg, opts.onLog);
      return await installFromTarball(
        tgz,
        { source: 'npm', spec: rawSpec, name: spec.name, version: pkg.version, registry, tarball: pkg.tarball, integrity: pkg.integrity },
        opts,
      );
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e)) throw e;
      opts.onLog?.(`registry ${registry} 失败(${(e as any)?.message || e}),尝试下一个…`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 卸载用户目录插件(首方内置不可卸)。删目录(symlink 只删链接)+ 清设置 + 注销 meta。 */
export async function uninstallPlugin(id: string): Promise<{ dir: string }> {
  if (!ID_RE.test(id)) throw new Error(`非法插件 id: ${id}`);
  const root = pluginsDir();
  const dir = findUserPluginDir(root, id);
  if (!dir) throw new Error(`未找到已安装插件「${id}」(或它是随包内置插件,不可卸载)`);
  rmSync(dir, { recursive: true, force: true }); // symlink 时删链接本身
  try { const { clearPluginData } = await import('./settingsStore.js'); await clearPluginData(id); } catch { /* 设置清理失败不致命 */ }
  try { const { unregisterPlugin } = await import('./registry.js'); unregisterPlugin(id); } catch { /* 内存注销失败不致命 */ }
  return { dir };
}

/** 扫用户插件目录,读各子目录 manifest.id,返回 id 匹配的目录(只看用户目录 → 天然不碰首方内置)。 */
function findUserPluginDir(root: string, id: string): string | undefined {
  let names: string[];
  try { names = readdirSync(root); } catch { return undefined; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    try {
      const m = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'));
      if (m?.id === id) return dir;
    } catch { /* 无/坏 manifest → 跳过 */ }
  }
  return undefined;
}

/** 读某已安装插件的来源溯源(.tangu-source.json);未找到/非 npm 装的返回 null。桌面「来源/更新」用。 */
export function readInstalledSource(id: string): (SourceMeta & { id?: string; version?: string; installedAt?: string }) | null {
  if (!ID_RE.test(id)) return null;
  const dir = findUserPluginDir(pluginsDir(), id);
  return dir ? readSource(dir) : null;
}
