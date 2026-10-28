/**
 * 「官方」引擎插件:捆绑包根的 SIGNATURE 用引擎里钉死的公钥(./officialKeys.ts,按捆绑包 manifest.json 的 id 取)验得过,
 * 且这个引擎插件的 tangu-plugin.json 与入口文件都被签进去、磁盘上 sha256 一致。只有官方插件拿得到三扇门:
 *   ① ctx.cloud(以用户的 Forsion 账号请求云端;路径白名单见 cloudPathAllowed);
 *   ② 工具 capabilities.approvalPreview(插件自己写审批卡文案;见 toolRegistry.declaredApprovalPreview);
 *   ③ chat 预设的工具面(只认 PRESET_TABLE.chat.toolFace.officialPlugin 里点名的工具)。
 * 第三方插件拿到的是 undefined / 被忽略,与今天逐字节一致。
 *
 * 判定在每次激活时现做(bootstrap.startEntry,首次 import 之前):升级 / 重扫换了代码就重新核。
 * 只信磁盘与签名,不信 manifest 里的 id 或目录名本身:manifest.json 必须在签名里(它的 id 才可信),
 * 目录名必须等于这个 id(桌面播种内置包就落在 plugins/<id>,见 desktop/electron/builtinPlugins.ts),
 * 商店装的(market-* 目录、带 packageId 的改名身份)一律不是官方。
 *
 * ⚠️ 威胁模型:引擎插件是同进程的原生代码,这道判定挡的是「第三方插件拿到账号出口 / 冒充审批文案 / 混进聊天」这条契约面,
 * 不是沙箱 —— 能写用户插件目录、或已经在进程里跑的代码本来就什么都做得了。
 *
 * SIGNATURE 格式与 desktop/electron/bundleSignature.ts、Forsion-Extend 仓 scripts/signature.mjs 同一口径,改格式三处同改:
 *   { "alg": "ed25519", "files": { "<posix 相对路径>": "<sha256 hex>", … }, "sig": "<base64>" }
 *   被签名的字节 = canonicalFiles(files):键按码点升序后 JSON.stringify,不含空白。
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CloudAccountBrain, CloudResponse } from '../seams/cloudBrain.js';
import { deps } from '../seams/runtime.js';
import { OFFICIAL_BUNDLE_KEYS } from './officialKeys.js';
import type { DiscoveredPlugin } from './loader.js';
import type { PluginCloudRequest } from './types.js';

export const SIGNATURE_FILE = 'SIGNATURE';
const MAX_FILES = 5000;

export const canonicalFiles = (files: Record<string, string>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

export type SignatureVerdict = { ok: true; files: string[] } | { ok: false; reason: string };

const SAFE_REL = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0\\]+$/;

/** 核对 dir 下的 SIGNATURE(桌面 bundleSignature.verifyBundleSignature 的引擎侧移植)。require = 必须被签到的文件(posix 相对路径)。 */
export async function verifyBundleSignature(dir: string, publicKeyPem: string, require: readonly string[] = []): Promise<SignatureVerdict> {
  let parsed: { alg?: unknown; files?: unknown; sig?: unknown };
  try {
    parsed = JSON.parse(await fs.readFile(path.join(dir, SIGNATURE_FILE), 'utf8'));
  } catch (e) {
    return { ok: false, reason: `no readable ${SIGNATURE_FILE}: ${(e as Error)?.message || e}` };
  }
  if (!parsed || parsed.alg !== 'ed25519' || typeof parsed.sig !== 'string' || !parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
    return { ok: false, reason: `${SIGNATURE_FILE} is malformed` };
  }
  const files = parsed.files as Record<string, unknown>;
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > MAX_FILES) return { ok: false, reason: `${SIGNATURE_FILE} lists ${entries.length} files` };
  for (const [rel, digest] of entries) {
    if (!SAFE_REL.test(rel) || rel === SIGNATURE_FILE || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return { ok: false, reason: `bad entry ${JSON.stringify(rel)}` };
  }
  const digests = files as Record<string, string>;
  let sigOk = false;
  try {
    sigOk = verifySignature(null, Buffer.from(canonicalFiles(digests), 'utf8'), createPublicKey(publicKeyPem), Buffer.from(parsed.sig, 'base64'));
  } catch (e) {
    return { ok: false, reason: `signature check failed: ${(e as Error)?.message || e}` };
  }
  if (!sigOk) return { ok: false, reason: 'signature does not match the pinned public key' };
  for (const rel of require) {
    if (!Object.prototype.hasOwnProperty.call(digests, rel)) return { ok: false, reason: `${rel} is not covered by ${SIGNATURE_FILE}` };
  }
  for (const [rel, digest] of entries) {
    const file = path.join(dir, ...rel.split('/'));
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(file);
    } catch {
      return { ok: false, reason: `${rel} is missing` };
    }
    if (!stat.isFile()) return { ok: false, reason: `${rel} is not a regular file` };
    const actual = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    if (actual !== digest) return { ok: false, reason: `${rel} does not match its signed hash` };
  }
  return { ok: true, files: entries.map(([rel]) => rel) };
}

/** 官方判定。keys 可注入只为单测(生产恒用引擎钉的那张表);任何一步不满足都是 false,永不抛。 */
export async function isOfficialEnginePlugin(d: DiscoveredPlugin, keys: Readonly<Record<string, string>> = OFFICIAL_BUNDLE_KEYS): Promise<boolean> {
  try {
    if (!d.bundled || d.packageId !== undefined) return false;
    const root = path.dirname(path.dirname(d.dir)); // <shared>/plugins/<bundle>(d.dir = <bundle>/tangu-plugins/<pid>)
    const name = path.basename(root);
    if (path.basename(path.dirname(d.dir)) !== 'tangu-plugins' || name.startsWith('market-')) return false;
    let bundleId: unknown;
    try {
      bundleId = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'))?.id;
    } catch {
      return false;
    }
    if (typeof bundleId !== 'string' || !Object.prototype.hasOwnProperty.call(keys, bundleId)) return false; // 第三方捆绑包是常态,不出声
    const fail = (reason: string): false => {
      console.warn(`[tangu] 捆绑包 ${name} 的引擎插件 ${d.manifest.id} 不按官方插件对待:${reason}`);
      return false;
    };
    if (name !== bundleId) return fail(`folder name "${name}" is not the bundle id "${bundleId}"`);
    // 所有要核的文件都必须真的落在捆绑包目录里:中间任何一层是符号链接(含 tangu-plugins/<pid> 本身)realpath 就对不上。
    const realRoot = await fs.realpath(root);
    const pluginRel = path.relative(root, d.dir).split(path.sep).join('/');
    const entryAbs = path.resolve(d.dir, d.manifest.entry);
    const required = ['manifest.json', `${pluginRel}/tangu-plugin.json`, path.relative(root, entryAbs).split(path.sep).join('/')];
    for (const rel of required) {
      if (!SAFE_REL.test(rel) || rel.startsWith('..') || path.isAbsolute(rel)) return fail(`${rel} is outside the bundle`);
      let real: string;
      try { real = await fs.realpath(path.join(root, ...rel.split('/'))); } catch { return fail(`${rel} is missing`); }
      if (real !== path.join(realRoot, ...rel.split('/'))) return fail(`${rel} goes through a symbolic link`);
    }
    const verdict = await verifyBundleSignature(root, keys[bundleId], required);
    return verdict.ok ? true : fail(verdict.reason);
  } catch (e) {
    console.warn(`[tangu] 官方插件判定出错(按非官方处理):${(e as Error)?.message || e}`);
    return false;
  }
}

// ponytail: 白名单 = 商店「我的条目」与提交更新两条。要开新的账号接口,在这里加一条精确匹配(别改成前缀 / 正则放宽),
// 并在 server 侧确认那条路由只做插件该做的事;再往上走是按捆绑包分档的能力表(Forsion-Extend 之外的官方包出现时再做)。
const MINE_PATH = '/api/market/mine';
const UPDATE_PATH = /^\/api\/market\/mine\/[A-Za-z0-9_-]{1,128}\/update$/;

/** ctx.cloud 的路径闸:按原串精确匹配(不解码、不规整),通过的就是原样发出去的那串。 */
export function cloudPathAllowed(rawPath: unknown, method: unknown): boolean {
  if (typeof rawPath !== 'string') return false;
  const q = rawPath.indexOf('?');
  const pathname = q < 0 ? rawPath : rawPath.slice(0, q);
  const query = q < 0 ? null : rawPath.slice(q + 1);
  if (method === 'GET') return pathname === MINE_PATH && query === null;
  if (method === 'POST') return UPDATE_PATH.test(pathname) && (query === null || query === 'dryRun=1');
  return false;
}

const MAX_TIMEOUT_MS = 120_000;

/** 给一个官方插件实例造 ctx.cloud。live() = 这次激活还没停用(停用后的迟到调用一律拒,不发)。 */
export function createOfficialCloud(live: () => boolean): { request(req: PluginCloudRequest): Promise<CloudResponse> } {
  return {
    async request(req) {
      const method = req?.method ?? 'GET';
      const p = req?.path;
      if (!cloudPathAllowed(p, method)) return { status: 403, error: 'path_not_allowed' };
      if (!live()) return { status: 0, error: 'plugin_disabled' };
      let cloud: CloudAccountBrain | undefined;
      try { cloud = deps().brain?.cloud; } catch { cloud = undefined; }
      if (!cloud) return { status: 0, error: 'no_cloud' };
      const timeout = Number(req.timeoutMs);
      try {
        // 新建一份请求:不把调用方对象原样往下传(CloudRequest 还收 PUT / DELETE 等,这里只放白名单里的两种)。
        const r = await cloud.request({
          path: p as string,
          method,
          ...(method === 'POST' && req.body !== undefined ? { body: req.body } : {}),
          ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: Math.min(timeout, MAX_TIMEOUT_MS) } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
        });
        return { status: Number(r?.status) || 0, ...(r && 'json' in r ? { json: r.json } : {}), ...(r?.error ? { error: String(r.error) } : {}) };
      } catch (e) {
        return { status: 0, error: String((e as Error)?.message || e) };
      }
    },
  };
}
