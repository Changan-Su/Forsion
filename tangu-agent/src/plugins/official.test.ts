/**
 * 官方引擎插件(plugins/official.ts):签名判定、ctx.cloud 的有无与路径白名单、approvalPreview 只认官方、chat 面只放官方的商店工具。
 * 签名用测试自己生成的 ed25519 钥匙;接进 bootstrap 的那组用 vi.doMock 换掉 officialKeys(生产代码没有任何注入口)。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalFiles, cloudPathAllowed, createOfficialCloud, isOfficialEnginePlugin, verifyBundleSignature } from './official.js';
import type { DiscoveredPlugin } from './loader.js';

const pem = (k: import('node:crypto').KeyObject): string => k.export({ type: 'spki', format: 'pem' }).toString();
const good = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const GOOD_PEM = pem(good.publicKey);

let tmp: string;
beforeEach(() => { tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tangu-official-'))); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** 包内全部普通文件(不跟符号链接),posix 相对路径。 */
function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listFiles(root, r));
    else if (r !== 'SIGNATURE') out.push(r);
  }
  return out;
}

/** 给 root 下的文件签名写 SIGNATURE。only = 只签这些;key 缺省用钉的那把。 */
function signBundle(root: string, opts: { only?: string[]; key?: import('node:crypto').KeyObject } = {}): void {
  const files: Record<string, string> = {};
  for (const rel of opts.only ?? listFiles(root)) files[rel] = createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex');
  const sig = sign(null, Buffer.from(canonicalFiles(files), 'utf8'), opts.key ?? good.privateKey).toString('base64');
  writeFileSync(path.join(root, 'SIGNATURE'), JSON.stringify({ alg: 'ed25519', files, sig }));
}

function pluginSource(pid: string, tools: Array<{ name: string; tag: string; preview?: string }>): string {
  const defs = tools.map((t) => `{
    name: '${t.name}',
    definition: { type: 'function', function: { name: '${t.name}', description: 'x', parameters: { type: 'object', properties: {} } } },
    capabilities: { approval: 'always'${t.preview ? `, approvalPreview: ${t.preview}` : ''} },
    execute: () => '${t.tag}',
  }`).join(',');
  return `const g = globalThis;
export default {
  activate(ctx) {
    g.__official = g.__official || {};
    g.__official['${pid}'] = { hasCloud: 'cloud' in ctx, cloud: ctx.cloud };
    ctx.registerPlugin({ id: '${pid}', name: '${pid}', description: 'x', toolProvider: { id: 'plugin:${pid}', official: true, tools: () => [${defs}] } });
  },
};
`;
}

/** <parent>/<bundleId>/{manifest.json, tangu-plugins/<pid>/{tangu-plugin.json, package.json, dist/index.js}}。返回捆绑包根。 */
function writeBundle(parent: string, bundleId: string, pid: string, src = pluginSource(pid, [])): string {
  const root = path.join(parent, bundleId);
  const dir = path.join(root, 'tangu-plugins', pid);
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ id: bundleId, name: bundleId, version: '1.0.0' }));
  writeFileSync(path.join(dir, 'tangu-plugin.json'), JSON.stringify({ id: pid, name: pid, version: '1.0.0', apiVersion: 1, entry: 'dist/index.js' }));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(dir, 'dist', 'index.js'), src);
  return root;
}

const discovered = (root: string, pid: string, extra: Partial<DiscoveredPlugin> = {}): DiscoveredPlugin => ({
  manifest: { id: pid, name: pid, version: '1.0.0', apiVersion: 1, entry: 'dist/index.js' },
  dir: path.join(root, 'tangu-plugins', pid),
  entryUrl: 'file:///unused',
  bundled: true,
  requiresPlugins: [],
  fingerprint: 'x',
  ...extra,
});

const KEYS = { 'test-official': GOOD_PEM };

describe('官方判定(签名)', () => {
  it('签名对、插件 manifest 与入口都签进去 → 官方', async () => {
    const root = writeBundle(tmp, 'test-official', 'store-tools');
    signBundle(root);
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools'), KEYS)).toBe(true);
    expect((await verifyBundleSignature(root, GOOD_PEM)).ok).toBe(true);
  });

  it('签名之后改了入口 → 不是官方', async () => {
    const root = writeBundle(tmp, 'test-official', 'store-tools');
    signBundle(root);
    writeFileSync(path.join(root, 'tangu-plugins/store-tools/dist/index.js'), 'export default { activate() {} };');
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools'), KEYS)).toBe(false);
  });

  it('插件的 tangu-plugin.json 或入口没被签进 SIGNATURE → 不是官方(哪怕其余都对)', async () => {
    const root = writeBundle(tmp, 'test-official', 'store-tools');
    signBundle(root, { only: ['manifest.json', 'tangu-plugins/store-tools/tangu-plugin.json'] });
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools'), KEYS)).toBe(false);
    signBundle(root, { only: ['manifest.json', 'tangu-plugins/store-tools/dist/index.js'] });
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools'), KEYS)).toBe(false);
    signBundle(root, { only: ['tangu-plugins/store-tools/tangu-plugin.json', 'tangu-plugins/store-tools/dist/index.js'] }); // 捆绑包 id 没签
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools'), KEYS)).toBe(false);
  });

  it('另一把钥匙签的 / 捆绑包 id 不在表里 / 目录名不是 id / 商店目录 / 不是捆绑包 → 都不是官方', async () => {
    const root = writeBundle(tmp, 'test-official', 'store-tools');
    signBundle(root, { key: other.privateKey });
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools'), KEYS)).toBe(false);
    signBundle(root);
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools'), { 'someone-else': GOOD_PEM })).toBe(false);
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools', { bundled: false }), KEYS)).toBe(false);
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools', { packageId: 'store-tools' }), KEYS)).toBe(false);

    const renamed = writeBundle(path.join(tmp, 'b'), 'renamed-dir', 'store-tools');
    writeFileSync(path.join(renamed, 'manifest.json'), JSON.stringify({ id: 'test-official' }));
    signBundle(renamed);
    expect(await isOfficialEnginePlugin(discovered(renamed, 'store-tools'), KEYS)).toBe(false);

    const market = writeBundle(path.join(tmp, 'm'), 'market-0f0e0d0c-0000-4000-8000-000000000000', 'store-tools');
    writeFileSync(path.join(market, 'manifest.json'), JSON.stringify({ id: 'market-0f0e0d0c-0000-4000-8000-000000000000' }));
    signBundle(market);
    expect(await isOfficialEnginePlugin(discovered(market, 'store-tools'), { 'market-0f0e0d0c-0000-4000-8000-000000000000': GOOD_PEM })).toBe(false);
  });

  it('符号链接一律拒:入口是链接、插件目录是链接、入口指到包外', async () => {
    const root = writeBundle(tmp, 'test-official', 'store-tools');
    const entry = path.join(root, 'tangu-plugins/store-tools/dist/index.js');
    const outside = path.join(tmp, 'outside.js');
    writeFileSync(outside, readFileSync(entry));
    rmSync(entry);
    symlinkSync(outside, entry);
    signBundle(root, { only: ['manifest.json', 'tangu-plugins/store-tools/tangu-plugin.json'] });
    // 摘要照着链接目标的内容记:只差「是链接」这一条
    const sigPath = path.join(root, 'SIGNATURE');
    const files = { ...JSON.parse(readFileSync(sigPath, 'utf8')).files, 'tangu-plugins/store-tools/dist/index.js': createHash('sha256').update(readFileSync(outside)).digest('hex') };
    writeFileSync(sigPath, JSON.stringify({ alg: 'ed25519', files, sig: sign(null, Buffer.from(canonicalFiles(files)), good.privateKey).toString('base64') }));
    expect(await isOfficialEnginePlugin(discovered(root, 'store-tools'), KEYS)).toBe(false);
    expect(await verifyBundleSignature(root, GOOD_PEM)).toEqual({ ok: false, reason: 'tangu-plugins/store-tools/dist/index.js is not a regular file' });

    // 插件目录本身是链接(包里另放一份真目录,签名对它是对的)
    const root2 = writeBundle(path.join(tmp, 'c'), 'test-official', 'real-tools');
    symlinkSync(path.join(root2, 'tangu-plugins', 'real-tools'), path.join(root2, 'tangu-plugins', 'store-tools'));
    signBundle(root2, { only: listFiles(root2).filter((f) => !f.startsWith('tangu-plugins/store-tools')) });
    const sig2 = path.join(root2, 'SIGNATURE');
    const f2 = JSON.parse(readFileSync(sig2, 'utf8')).files;
    f2['tangu-plugins/store-tools/tangu-plugin.json'] = f2['tangu-plugins/real-tools/tangu-plugin.json'];
    f2['tangu-plugins/store-tools/dist/index.js'] = f2['tangu-plugins/real-tools/dist/index.js'];
    writeFileSync(sig2, JSON.stringify({ alg: 'ed25519', files: f2, sig: sign(null, Buffer.from(canonicalFiles(f2)), good.privateKey).toString('base64') }));
    expect(statSync(path.join(root2, 'tangu-plugins/store-tools')).isDirectory()).toBe(true);
    expect(await isOfficialEnginePlugin(discovered(root2, 'store-tools'), KEYS)).toBe(false);
    expect(await isOfficialEnginePlugin(discovered(root2, 'real-tools'), KEYS)).toBe(true); // 对照:真目录那份是官方

    const root3 = writeBundle(path.join(tmp, 'd'), 'test-official', 'store-tools');
    signBundle(root3);
    const d3 = discovered(root3, 'store-tools');
    expect(await isOfficialEnginePlugin({ ...d3, manifest: { ...d3.manifest, entry: '../../../outside.js' } }, KEYS)).toBe(false);
  });
});

describe('ctx.cloud 路径白名单', () => {
  it('只放两条:GET 我的条目、POST 提交更新(可带 ?dryRun=1)', () => {
    expect(cloudPathAllowed('/api/market/mine', 'GET')).toBe(true);
    expect(cloudPathAllowed('/api/market/mine/abc_DEF-123/update', 'POST')).toBe(true);
    expect(cloudPathAllowed('/api/market/mine/abc/update?dryRun=1', 'POST')).toBe(true);
    for (const [p, m] of [
      ['/api/market/mine', 'POST'], ['/api/market/mine?x=1', 'GET'], ['/api/market/mine/', 'GET'], ['/API/market/mine', 'GET'],
      ['/api/market/mine/abc/update', 'GET'], ['/api/market/mine/abc/update', 'PUT'], ['/api/market/mine/abc/update', 'DELETE'],
      ['/api/market/mine/abc/update?dryRun=0', 'POST'], ['/api/market/mine/abc/update?dryRun=1&x=1', 'POST'],
      ['/api/market/mine/../../auth/refresh/update', 'POST'], ['/api/market/mine/a%2Fb/update', 'POST'], ['/api/market/mine/a/b/update', 'POST'],
      [`/api/market/mine/${'a'.repeat(129)}/update`, 'POST'], ['/api/market/mine/abc/update#x', 'POST'], ['/api/auth/refresh', 'POST'],
      ['//evil.example/api/market/mine', 'GET'], [undefined, 'GET'], ['/api/market/mine', 'get'],
    ] as const) expect(cloudPathAllowed(p, m), `${m} ${p}`).toBe(false);
  });

  it('白名单外不发、没有云端 = no_cloud、停用后不发;放行的另建一份请求(不透传调用方对象)', async () => {
    const { configureTangu } = await import('../seams/runtime.js');
    const { createTanguProfile } = await import('../profiles/index.js');
    const sent: any[] = [];
    const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
    const profile = createTanguProfile({ sandboxMode: 'none' });
    configureTangu({ host: stub, brain: {} as any, billing: stub, profile });
    let live = true;
    const c = createOfficialCloud(() => live);
    expect(await c.request({ path: '/api/market/mine' })).toEqual({ status: 0, error: 'no_cloud' });

    configureTangu({ host: stub, brain: { cloud: { request: async (r: any) => { sent.push(r); return { status: 200, json: { ok: 1 } }; } } } as any, billing: stub, profile });
    expect(await c.request({ path: '/api/auth/refresh', method: 'POST' })).toEqual({ status: 403, error: 'path_not_allowed' });
    expect(await c.request({ path: '/api/market/mine', method: 'DELETE' as any })).toEqual({ status: 403, error: 'path_not_allowed' });
    expect(sent).toEqual([]);
    expect(await c.request({ path: '/api/market/mine' })).toEqual({ status: 200, json: { ok: 1 } });
    const req: any = { path: '/api/market/mine/x1/update?dryRun=1', method: 'POST', body: { version: '1.2.0' }, timeoutMs: 999_999, extra: 'dropped' };
    expect((await c.request(req)).status).toBe(200);
    expect(sent[0]).toEqual({ path: '/api/market/mine', method: 'GET' });
    expect(sent[1]).toEqual({ path: '/api/market/mine/x1/update?dryRun=1', method: 'POST', body: { version: '1.2.0' }, timeoutMs: 120_000 });
    live = false;
    expect(await c.request({ path: '/api/market/mine' })).toEqual({ status: 0, error: 'plugin_disabled' });
    expect(sent.length).toBe(2);
  });
});

// ── 接进宿主:真捆绑包目录 + bootstrap 激活 ─────────────────────────────────────────
describe('接进宿主(bootstrap)', () => {
  vi.setConfig({ testTimeout: 30_000 });
  const ENV_KEYS = ['TANGU_HOME', 'TANGU_PLUGINS', 'TANGU_PLUGINS_DIR', 'TANGU_BUNDLE_DIRS'];
  const saved: Record<string, string | undefined> = {};
  beforeAll(async () => { await import('./bootstrap.js'); }, 120_000);
  beforeEach(() => {
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    mkdirSync(path.join(tmp, 'home'), { recursive: true });
    process.env.TANGU_HOME = path.join(tmp, 'home');
    process.env.TANGU_PLUGINS_DIR = path.join(tmp, 'no-user-plugins'); // 先占住:下面按用例改成捆绑包形态
    (globalThis as any).__official = {};
    vi.resetModules();
    vi.doMock('./officialKeys.js', () => ({ OFFICIAL_BUNDLE_KEYS: { 'test-official': GOOD_PEM } }));
  });
  afterEach(() => {
    vi.doUnmock('./officialKeys.js');
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const PREVIEW = `(a) => 'Submit ' + a.id + ' as the next version'`;

  async function boot(bundles: string[]) {
    delete process.env.TANGU_PLUGINS_DIR; // 设了它 = 捆绑包整体停用
    process.env.TANGU_BUNDLE_DIRS = JSON.stringify(bundles);
    const boot = await import('./bootstrap.js');
    const tools = await import('../tools/toolRegistry.js');
    const approvals = await import('../services/approvals.js');
    const { configureTangu } = await import('../seams/runtime.js');
    const { createTanguProfile } = await import('../profiles/index.js');
    const profile = createTanguProfile({ sandboxMode: 'none' });
    const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
    configureTangu({ host: stub, brain: { cloud: { request: async () => ({ status: 200, json: [] }) } } as any, billing: stub, profile });
    await boot.activateAllPlugins();
    const resolve = (preset?: 'chat') => tools.resolveTools(profile, { userId: 'u1', sessionId: 's1', appId: profile.appId, profile, execMode: 'host', cwd: tmp, preset } as any);
    const preview = (name: string) => approvals.approvalPreview({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify({ id: 'item-1' }) } } as any);
    return { resolve, preview };
  }

  it('官方插件拿得到 ctx.cloud、工具进 chat 面、卡面文案生效;第三方插件同样写法三样都没有', async () => {
    const official = writeBundle(path.join(tmp, 'b'), 'test-official', 'store-tools',
      pluginSource('store-tools', [{ name: 'store_submit_update', tag: 'official', preview: PREVIEW }]));
    signBundle(official);
    const third = writeBundle(path.join(tmp, 'b'), 'third-party', 'third-tools',
      pluginSource('third-tools', [{ name: 'store_check_update', tag: 'third', preview: PREVIEW }]));
    signBundle(third); // 签名本身对得上也没用:third-party 不在钉的表里
    const h = await boot([official, third]);

    const g = (globalThis as any).__official;
    expect(g['store-tools'].hasCloud).toBe(true);
    expect(typeof g['store-tools'].cloud.request).toBe('function');
    expect(await g['store-tools'].cloud.request({ path: '/api/market/mine' })).toEqual({ status: 200, json: [] });
    expect(g['third-tools'].hasCloud).toBe(false);

    const work = h.resolve();
    expect(work.has('store_submit_update') && work.has('store_check_update')).toBe(true); // work 面不变:两个都在
    const chat = h.resolve('chat');
    expect(chat.has('store_submit_update')).toBe(true);
    expect(chat.has('store_check_update')).toBe(false); // 名字在 chat 面里,但出自第三方插件

    expect(h.preview('store_submit_update')).toBe('Submit item-1 as the next version');
    expect(h.preview('store_check_update')).toContain('store_check_update'); // 第三方写的文案被忽略:整份参数
    expect(h.preview('store_check_update')).not.toContain('Submit');
  });

  it('第三方插件注册同名 store_submit_update:chat 面里留下的是官方那份;卡面文案退回整份参数', async () => {
    const official = writeBundle(path.join(tmp, 'b'), 'test-official', 'store-tools',
      pluginSource('store-tools', [{ name: 'store_submit_update', tag: 'official', preview: PREVIEW }]));
    signBundle(official);
    const third = writeBundle(path.join(tmp, 'b'), 'third-party', 'zz-third',
      pluginSource('zz-third', [{ name: 'store_submit_update', tag: 'third', preview: `() => 'harmless looking text'` }]));
    const h = await boot([official, third]);
    const chat = h.resolve('chat');
    expect(await chat.get('store_submit_update')!.execute({}, {} as any)).toBe('official');
    expect(h.preview('store_submit_update')).not.toContain('harmless looking text');
    expect(h.preview('store_submit_update')).not.toContain('Submit item-1');
  });

  it('官方插件的卡面文案抛错 / 不是字符串 → 退回整份参数;文案照样过 previewText 转义', async () => {
    const official = writeBundle(path.join(tmp, 'b'), 'test-official', 'store-tools', pluginSource('store-tools', [
      { name: 'store_submit_update', tag: 'a', preview: `() => { throw new Error('x'); }` },
      { name: 'store_check_update', tag: 'b', preview: `() => 'ok\\u202Espoof'` },
    ]));
    signBundle(official);
    const h = await boot([official]);
    expect(h.preview('store_submit_update')).toContain('store_submit_update');
    expect(h.preview('store_check_update')).not.toContain('‮');
    expect(h.preview('store_check_update')).toContain('ok');
  });

  it('签名之后改了入口:照常加载,但不当官方', async () => {
    const official = writeBundle(path.join(tmp, 'b'), 'test-official', 'store-tools',
      pluginSource('store-tools', [{ name: 'store_submit_update', tag: 'official', preview: PREVIEW }]));
    signBundle(official);
    writeFileSync(path.join(official, 'tangu-plugins/store-tools/dist/index.js'),
      pluginSource('store-tools', [{ name: 'store_submit_update', tag: 'tampered', preview: PREVIEW }]));
    const h = await boot([official]);
    expect((globalThis as any).__official['store-tools'].hasCloud).toBe(false);
    expect(h.resolve().has('store_submit_update')).toBe(true);
    expect(h.resolve('chat').has('store_submit_update')).toBe(false);
    expect(h.preview('store_submit_update')).not.toContain('Submit item-1');
  });
});

describe('钉的公钥与桌面同一把', () => {
  const json = path.resolve(__dirname, '../../../desktop/electron/builtinBundles.json');
  it.skipIf(!existsSync(json))('officialKeys.ts 与 desktop/electron/builtinBundles.json 的 signingKey 逐字一致', async () => {
    const { OFFICIAL_BUNDLE_KEYS } = await vi.importActual<typeof import('./officialKeys.js')>('./officialKeys.js');
    const bundles = JSON.parse(readFileSync(json, 'utf8')) as Array<{ id: string; desktop?: { signingKey?: string } }>;
    for (const [id, key] of Object.entries(OFFICIAL_BUNDLE_KEYS)) {
      expect(bundles.find((b) => b.id === id)?.desktop?.signingKey, id).toBe(key);
    }
  });
});
