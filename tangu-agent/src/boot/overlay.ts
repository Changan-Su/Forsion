/**
 * 引擎热更新包的挑选与核对(2026-10-12)。
 *
 * 桌面端把从 npm 下回来的引擎新版按版本号并排放在 `<共享域>/engine/<版本>/`,安装包里的启动器(launch.ts)
 * 每次拉起引擎前在这里挑一份合格的;一份都不合格就跑安装包自带的。桌面主进程的更新器落盘前调的也是这里,
 * 所以「什么算合格」只有这一份实现。
 *
 * 合格 = 下面五条全过(都是机械判定,不靠人记):
 *  · 包名对、版本是正式版、比安装包自带的新;
 *  · `forsion.minDesktop` 不高于壳的版本。壳版本取自带引擎的版本号:两者同号发版是 build-desktop 的硬门禁;
 *  · `dependencies` 与自带的完全相同 —— 新版只带了 dist,依赖用的是安装包里那份 node_modules;
 *  · 建表 / 迁移文件与自带的逐字节相同 —— 带迁移的版本只能随安装包发,这样退回自带引擎永远安全;
 *  · SIGNATURE 对得上钉死的公钥,目录里的文件恰好是签过的那些(多一个、少一个、改一个字节都不行)。
 *
 * 只用 node 内置模块:启动器在挑定之前不能把引擎本体拉进来。
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ENGINE_SIGNING_KEY } from './signingKey.js';

export const ENGINE_PACKAGE = '@forsion/tangu-agent';
export const SIGNATURE_FILE = 'SIGNATURE';
/** 启动器认的两个入口(相对包根)。 */
export const ENGINE_ENTRIES = { standalone: 'dist/standalone/main.js', tui: 'dist/tui/main.js' } as const;
/** 定义本机数据库长什么样的文件;新版与自带的不一样就不收。 */
export const SCHEMA_FILES = ['dist/db/migrate.js', 'dist/db/schemaStandalone.js', 'dist/core/dialectDDL.js'] as const;
const RELEASE = /^\d+\.\d+\.\d+$/;
const MAX_FILES = 5000;
const SAFE_REL = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0]+$/;

/** signature = 不是我们发的字节(或被动过);其余几种 = 字节没问题,只是不适合这份安装包。 */
export type OverlayRejectCode = 'package' | 'version' | 'host' | 'deps' | 'schema' | 'signature';
export type OverlayVerdict = { ok: true; version: string } | { ok: false; code: OverlayRejectCode; reason: string };
export interface SelectedOverlay { version: string; dir: string }

export const engineOverlayRoot = (sharedDir: string): string => path.join(sharedDir, 'engine');

/** 只比正式版号(x.y.z);调用方先用 RELEASE 过滤。 */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

const sorted = (o: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
/** 被签名的字节:files 的键按码点升序后 JSON.stringify。与 desktop/electron/bundleSignature.ts 同一格式。 */
export const canonicalFiles = (files: Record<string, string>): string => JSON.stringify(sorted(files));
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'));
const reject = (code: OverlayRejectCode, reason: string): OverlayVerdict => ({ ok: false, code, reason });

/** dir 下的全部普通文件(posix 相对路径);遇到符号链接等别的类型直接抛。 */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(child);
      else throw new Error(`${child} is not a regular file`);
      if (out.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files`);
    }
  };
  walk('');
  return out;
}

/** 核对 dir 下的 SIGNATURE:返回 null = 通过,否则是原因。 */
export function verifyEngineSignature(dir: string, publicKeyPem: string = ENGINE_SIGNING_KEY): string | null {
  let parsed: { alg?: unknown; sig?: unknown; files?: unknown };
  try {
    parsed = readJson(path.join(dir, SIGNATURE_FILE));
  } catch (e) {
    return `no readable ${SIGNATURE_FILE}: ${(e as Error)?.message || e}`;
  }
  if (parsed.alg !== 'ed25519' || typeof parsed.sig !== 'string' || !parsed.files || typeof parsed.files !== 'object') return `${SIGNATURE_FILE} is malformed`;
  const files = parsed.files as Record<string, string>;
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > MAX_FILES) return `${SIGNATURE_FILE} lists ${entries.length} files`;
  for (const [rel, digest] of entries) {
    if (!SAFE_REL.test(rel) || rel === SIGNATURE_FILE || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return `bad entry ${JSON.stringify(rel)}`;
  }
  try {
    if (!verifySignature(null, Buffer.from(canonicalFiles(files), 'utf8'), createPublicKey(publicKeyPem), Buffer.from(parsed.sig, 'base64'))) {
      return 'signature does not match the pinned public key';
    }
  } catch (e) {
    return `signature check failed: ${(e as Error)?.message || e}`;
  }
  for (const rel of ['package.json', ...Object.values(ENGINE_ENTRIES)]) if (!(rel in files)) return `${rel} is not covered by ${SIGNATURE_FILE}`;
  // 入口会 import 相邻文件,所以目录里不能有签名表以外的东西:多出来的一个 node_modules 就能把依赖解析劫走。
  let present: string[];
  try {
    present = listFiles(dir);
  } catch (e) {
    return (e as Error)?.message || String(e);
  }
  for (const rel of present) if (rel !== SIGNATURE_FILE && !(rel in files)) return `${rel} is not covered by ${SIGNATURE_FILE}`;
  const have = new Set(present);
  for (const [rel, digest] of entries) {
    if (!have.has(rel)) return `${rel} is missing`;
    if (sha256(path.join(dir, ...rel.split('/'))) !== digest) return `${rel} does not match its signed hash`;
  }
  return null;
}

/** dir 这份新版能不能在 bundledRoot 这份安装包上跑。 */
export function checkOverlay(dir: string, bundledRoot: string, publicKeyPem: string = ENGINE_SIGNING_KEY): OverlayVerdict {
  let pkg: any;
  let bundled: any;
  try {
    pkg = readJson(path.join(dir, 'package.json'));
    bundled = readJson(path.join(bundledRoot, 'package.json'));
  } catch (e) {
    return reject('package', `unreadable package.json: ${(e as Error)?.message || e}`);
  }
  if (pkg?.name !== ENGINE_PACKAGE) return reject('package', `package is ${String(pkg?.name)}, not ${ENGINE_PACKAGE}`);
  const version = String(pkg.version ?? '');
  const base = String(bundled?.version ?? '');
  if (!RELEASE.test(version) || !RELEASE.test(base)) return reject('version', `${version || '?'} / bundled ${base || '?'} is not a release version`);
  if (cmpVersion(version, base) <= 0) return reject('version', `${version} is not newer than the bundled ${base}`);
  const minDesktop = pkg.forsion?.minDesktop;
  if (typeof minDesktop !== 'string' || !RELEASE.test(minDesktop)) return reject('host', 'forsion.minDesktop is missing');
  if (cmpVersion(base, minDesktop) < 0) return reject('host', `needs Forsion ≥ ${minDesktop}, this is ${base}`);
  if (canonicalFiles(pkg.dependencies ?? {}) !== canonicalFiles(bundled.dependencies ?? {})) return reject('deps', 'dependencies differ from the bundled engine');
  try {
    for (const rel of SCHEMA_FILES) {
      if (sha256(path.join(dir, rel)) !== sha256(path.join(bundledRoot, rel))) return reject('schema', `${rel} differs from the bundled engine`);
    }
  } catch (e) {
    return reject('schema', `cannot compare schema files: ${(e as Error)?.message || e}`);
  }
  const bad = verifyEngineSignature(dir, publicKeyPem);
  return bad ? reject('signature', bad) : { ok: true, version };
}

const badFile = (engineRoot: string): string => path.join(engineRoot, 'bad.json');

/** 起不来过的版本(版本 → 原因)。启动器跳过它们,更新器不再下它们。 */
export function readBad(engineRoot: string): Record<string, string> {
  try {
    const v = readJson(badFile(engineRoot));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** 记一个起不来的版本。写不进去就算了(下次还会再试一次这个版本),不能因此挡住启动。 */
export function markBad(engineRoot: string, version: string, reason: string): void {
  try {
    mkdirSync(engineRoot, { recursive: true });
    const tmp = `${badFile(engineRoot)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...readBad(engineRoot), [version]: reason.slice(0, 500) }, null, 2) + '\n', 'utf8');
    renameSync(tmp, badFile(engineRoot));
  } catch { /* best effort */ }
}

/** engineRoot 下版本号最高的那份合格新版;没有就返回 null。不合格的各报一次原因。 */
export function selectOverlay(
  engineRoot: string,
  bundledRoot: string,
  opts: { publicKeyPem?: string; onReject?: (version: string, code: OverlayRejectCode, reason: string) => void } = {},
): SelectedOverlay | null {
  let names: string[];
  try {
    names = readdirSync(engineRoot).filter((n) => RELEASE.test(n));
  } catch {
    return null;
  }
  const bad = readBad(engineRoot);
  for (const name of names.sort((a, b) => cmpVersion(b, a))) {
    if (name in bad) continue;
    const dir = path.join(engineRoot, name);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const verdict = checkOverlay(dir, bundledRoot, opts.publicKeyPem);
    if (verdict.ok && verdict.version === name) return { version: name, dir };
    if (verdict.ok) opts.onReject?.(name, 'package', `directory ${name} holds version ${verdict.version}`);
    else opts.onReject?.(name, verdict.code, verdict.reason);
  }
  return null;
}
