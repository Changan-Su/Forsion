/**
 * npm 安装通道契约:spec 解析 / registry 回退 / integrity 校验 / 原子落位 + .tangu-source.json /
 * 冲突预检 / 穿越拒绝 / 卸载。用 TANGU_HOME=临时目录隔离落盘;registry 走注入的 fetch mock。
 * tar fixture 由内联 writer 构造(gzip 后喂 installFromTarball)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  parseInstallSpec, registryCandidates, resolvePackage, installFromTarball,
  installPlugin, uninstallPlugin, readInstalledSource, InstallCancelled,
} from './npmInstall.js';
import { pluginsDir } from '../core/tanguHome.js';

// 卸载会先经 bootstrap 现场停用(removePluginLive)再删目录。单测不拉起整张宿主模块图(冷转译数秒),桩住并记下
// 被调时目录是否还在 —— 钉「先停再删」的顺序。
const live = vi.hoisted(() => ({ calls: [] as Array<{ id: string; dirExisted: boolean }>, during: null as null | (() => Promise<unknown>) }));
vi.mock('./bootstrap.js', async () => {
  const { existsSync: exists } = await import('node:fs');
  const { pluginsDir: dirOf } = await import('../core/tanguHome.js');
  const p = await import('node:path');
  return { removePluginLive: async (id: string) => { live.calls.push({ id, dirExisted: exists(p.join(dirOf(), id)) }); await live.during?.(); } };
});

// ── 内联 tar writer(untar 的逆,仅普通文件)──
const BLOCK = 512;
function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100, 8);
  h.write('0000000\0', 108, 8);
  h.write('0000000\0', 116, 8);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  h.write('00000000000\0', 136, 12);
  h.write('0', 156, 1);
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);
  h.write('        ', 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
function block(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const pad = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
  return Buffer.concat([header(name, data.length), data, pad]);
}
function tgzOf(blocks: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(BLOCK * 2)]));
}
function pluginTgz(id: string, version = '1.0.0', apiVersion = 1, extra: Buffer[] = []): Buffer {
  return tgzOf([
    block('package/tangu-plugin.json', JSON.stringify({ id, name: id, version, apiVersion, entry: 'index.js' })),
    block('package/index.js', 'export default { activate() {} }'),
    ...extra,
  ]);
}
const okResponse = (body: any, status = 200): Response => {
  const init = typeof body === 'string' ? body : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body);
  return new Response(init, { status });
};
function packument(name: string, version: string, tarball: string, dist: Record<string, unknown> = {}): any {
  return { name, 'dist-tags': { latest: version }, versions: { [version]: { version, dist: { tarball, ...dist } } } };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'tangu-npm-'));
  process.env.TANGU_HOME = tmp;
  delete process.env.TANGU_NPM_REGISTRY;
  mkdirSync(pluginsDir(), { recursive: true });
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  rmSync(tmp, { recursive: true, force: true });
});

describe('parseInstallSpec', () => {
  it.each([
    ['npm:foo', { kind: 'npm', name: 'foo', version: undefined }],
    ['npm:foo@1.2.3', { kind: 'npm', name: 'foo', version: '1.2.3' }],
    ['npm:foo@latest', { kind: 'npm', name: 'foo', version: 'latest' }],
    ['npm:@scope/bar@2.0.0', { kind: 'npm', name: '@scope/bar', version: '2.0.0' }],
    ['npm:@scope/bar', { kind: 'npm', name: '@scope/bar', version: undefined }],
    ['./local', { kind: 'path', path: './local' }],
    ['/abs/x.tgz', { kind: 'path', path: '/abs/x.tgz' }],
  ])('%s', (raw, exp) => expect(parseInstallSpec(raw as string)).toEqual(exp));

  it.each(['npm:foo@^1.0.0', 'npm:foo@~1.2', 'npm:foo@1.x', 'npm:foo@>=2', 'npm:bar@1 - 2'])(
    'semver 范围报错: %s', (raw) => expect(() => parseInstallSpec(raw)).toThrow(/范围/));

  it('裸包名(无 npm: 前缀)报错', () => expect(() => parseInstallSpec('foo')).toThrow());
});

describe('registryCandidates', () => {
  it('默认官方在前、镜像兜底', () => {
    expect(registryCandidates()).toEqual(['https://registry.npmjs.org', 'https://registry.npmmirror.com']);
  });
  it('preferMirror → 镜像在前', () => expect(registryCandidates({ preferMirror: true })[0]).toContain('npmmirror'));
  it('override → 单一(去尾斜杠)', () => expect(registryCandidates({ override: 'https://x/' })).toEqual(['https://x']));
});

describe('resolvePackage', () => {
  it('无版本 → 取 dist-tags.latest', async () => {
    const doc = packument('foo', '1.2.3', 'http://t/foo.tgz', { integrity: 'sha512-abc' });
    const fetchImpl = vi.fn(async () => okResponse(doc)) as any;
    const r = await resolvePackage('foo', undefined, 'https://reg', { fetchImpl });
    expect(r).toMatchObject({ version: '1.2.3', tarball: 'http://t/foo.tgz', integrity: 'sha512-abc' });
  });
  it('dist-tag 映射到具体版本', async () => {
    const doc = { 'dist-tags': { beta: '2.0.0-beta.1' }, versions: { '2.0.0-beta.1': { version: '2.0.0-beta.1', dist: { tarball: 'u' } } } };
    const fetchImpl = vi.fn(async () => okResponse(doc)) as any;
    expect((await resolvePackage('foo', 'beta', 'https://reg', { fetchImpl })).version).toBe('2.0.0-beta.1');
  });
  it('scoped 包名的斜杠编码进 URL', async () => {
    const fetchImpl = vi.fn(async () => okResponse(packument('@s/p', '1.0.0', 'u'))) as any;
    await resolvePackage('@s/p', undefined, 'https://reg', { fetchImpl });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://reg/@s%2fp');
  });
});

describe('installFromTarball', () => {
  it('合法包 → 落位 + 写 .tangu-source.json', async () => {
    const r = await installFromTarball(pluginTgz('demo-plugin'), { source: 'npm', spec: 'npm:demo-plugin', name: 'demo-plugin', version: '1.0.0', registry: 'https://r' }, {});
    expect(r.id).toBe('demo-plugin');
    expect(existsSync(path.join(pluginsDir(), 'demo-plugin', 'index.js'))).toBe(true);
    expect(readInstalledSource('demo-plugin')).toMatchObject({ source: 'npm', name: 'demo-plugin', version: '1.0.0' });
  });

  it('非 Tangu 包(缺 manifest)报错', async () => {
    const tgz = tgzOf([block('package/index.js', 'x')]);
    await expect(installFromTarball(tgz, { source: 'npm', spec: 'x', name: 'x' }, {})).rejects.toThrow(/不是 Tangu 插件包/);
  });

  it('apiVersion 不符报错', async () => {
    await expect(installFromTarball(pluginTgz('x-plugin', '1.0.0', 99), { source: 'npm', spec: 'x', name: 'x' }, {})).rejects.toThrow(/apiVersion/);
  });

  it('entry 文件不在包内报错', async () => {
    const tgz = tgzOf([block('package/tangu-plugin.json', JSON.stringify({ id: 'noentry', name: 'x', version: '1', apiVersion: 1, entry: 'dist/index.js' }))]);
    await expect(installFromTarball(tgz, { source: 'npm', spec: 'x', name: 'x' }, {})).rejects.toThrow(/入口文件不存在/);
  });

  it('穿越路径被拒且不落盘', async () => {
    const tgz = tgzOf([
      block('package/tangu-plugin.json', JSON.stringify({ id: 'evil', name: 'e', version: '1', apiVersion: 1, entry: 'index.js' })),
      block('package/index.js', 'x'),
      block('package/../../../etc/pwned', 'x'),
    ]);
    await expect(installFromTarball(tgz, { source: 'npm', spec: 'x', name: 'x' }, {})).rejects.toThrow(/穿越|非法/);
    expect(existsSync(path.join(pluginsDir(), 'evil'))).toBe(false); // staging 已清、目标未落
  });

  it('原地覆盖同 id 同来源(更新)', async () => {
    await installFromTarball(pluginTgz('demo-plugin', '1.0.0'), { source: 'npm', spec: 's', name: 'demo-plugin', version: '1.0.0' }, {});
    const r = await installFromTarball(pluginTgz('demo-plugin', '2.0.0'), { source: 'npm', spec: 's', name: 'demo-plugin', version: '2.0.0' }, {});
    expect(r.version).toBe('2.0.0');
    expect(readInstalledSource('demo-plugin')?.version).toBe('2.0.0');
  });

  it('同 id 不同来源无 --force 拒绝;--force 覆盖', async () => {
    await installFromTarball(pluginTgz('demo-plugin'), { source: 'npm', spec: 'a', name: 'pkg-a', version: '1.0.0' }, {});
    await expect(installFromTarball(pluginTgz('demo-plugin'), { source: 'npm', spec: 'b', name: 'pkg-b', version: '1.0.0' }, {})).rejects.toThrow(/force/);
    const r = await installFromTarball(pluginTgz('demo-plugin', '2.0.0'), { source: 'npm', spec: 'b', name: 'pkg-b', version: '2.0.0' }, { force: true });
    expect(r.version).toBe('2.0.0');
  });
});

describe('installPlugin (npm registry 回退与 integrity)', () => {
  it('官方 registry 5xx → 回退镜像成功', async () => {
    const tgz = pluginTgz('demo-plugin');
    const doc = packument('demo-plugin', '1.0.0', 'https://registry.npmmirror.com/demo-plugin/-/x.tgz'); // 无 integrity → 警告跳过
    const fetchImpl = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.startsWith('https://registry.npmjs.org')) return okResponse('down', 503);
      if (u.endsWith('.tgz')) return okResponse(tgz);
      return okResponse(doc);
    }) as any;
    const r = await installPlugin({ kind: 'npm', name: 'demo-plugin' }, 'npm:demo-plugin', { fetchImpl });
    expect(r.version).toBe('1.0.0');
    expect(fetchImpl.mock.calls.some((c: any[]) => String(c[0]).startsWith('https://registry.npmjs.org'))).toBe(true);
  });

  it('integrity 不符 → 拒绝(不静默换源)', async () => {
    const tgz = pluginTgz('demo-plugin');
    const doc = packument('demo-plugin', '1.0.0', 'https://registry.npmjs.org/demo-plugin/-/x.tgz', { integrity: 'sha512-WRONGWRONGWRONG' });
    const fetchImpl = vi.fn(async (url: any) => (String(url).endsWith('.tgz') ? okResponse(tgz) : okResponse(doc))) as any;
    await expect(installPlugin({ kind: 'npm', name: 'demo-plugin' }, 'npm:demo-plugin', { fetchImpl })).rejects.toThrow(/integrity/);
  });

  it('confirm 返回 false → InstallCancelled 且不落盘', async () => {
    const tgz = pluginTgz('demo-plugin');
    const doc = packument('demo-plugin', '1.0.0', 'https://registry.npmjs.org/demo-plugin/-/x.tgz');
    const fetchImpl = vi.fn(async (url: any) => (String(url).endsWith('.tgz') ? okResponse(tgz) : okResponse(doc))) as any;
    await expect(installPlugin({ kind: 'npm', name: 'demo-plugin' }, 'npm:demo-plugin', { fetchImpl, confirm: () => false }))
      .rejects.toBeInstanceOf(InstallCancelled);
    expect(existsSync(path.join(pluginsDir(), 'demo-plugin'))).toBe(false);
  });
});

describe('uninstallPlugin', () => {
  it('删用户目录插件 + 清来源', async () => {
    await installFromTarball(pluginTgz('demo-plugin'), { source: 'npm', spec: 's', name: 'demo-plugin', version: '1.0.0' }, {});
    expect(existsSync(path.join(pluginsDir(), 'demo-plugin'))).toBe(true);
    live.calls.length = 0;
    await uninstallPlugin('demo-plugin');
    expect(existsSync(path.join(pluginsDir(), 'demo-plugin'))).toBe(false);
    expect(live.calls).toEqual([{ id: 'demo-plugin', dirExisted: true }]); // 先停(目录还在)再删
  });
  it('未安装 → 报错', async () => {
    await expect(uninstallPlugin('nope-plugin')).rejects.toThrow(/未找到/);
  });
  it('等停用期间同一路径被重装 → 不删新版本(Codex 10-02)', async () => {
    const meta = { source: 'npm', spec: 's', name: 'demo-plugin' } as const;
    await installFromTarball(pluginTgz('demo-plugin'), { ...meta, version: '1.0.0' }, {});
    live.during = () => installFromTarball(pluginTgz('demo-plugin', '2.0.0'), { ...meta, version: '2.0.0' }, {});
    try {
      await expect(uninstallPlugin('demo-plugin')).rejects.toThrow(/重新安装/);
    } finally {
      live.during = null;
    }
    expect(readInstalledSource('demo-plugin')?.version).toBe('2.0.0');
  });
});
