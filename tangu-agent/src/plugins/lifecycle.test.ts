/**
 * 引擎插件生命周期(bootstrap):停用调 deactivate、工具撤下但槽位保留 → 再启用回原位;requiresPlugins 依赖门控与级联;
 * 热路由分发器;原地升级(入口破缓存)与相对 import 的如实需重启;目录消失注销;卸载墓碑;无依赖时启动顺序 = id 序;
 * activate / deactivate 限时与 busy 隔离;provider 归属;指纹覆盖 helper;多文件 ESM 经模块钩子整图换代(没钩子 / CommonJS 如实需重启);
 * 热换代封顶;
 * HTTP 面字段形状。真临时插件目录(tangu-plugin.json + dist/index.js 纯 ESM),TANGU_HOME / TANGU_PLUGINS_DIR 隔离;
 * 每例 vi.resetModules 拿一份全新的宿主模块图(bootstrap / registry / toolRegistry / settingsStore 都有模块级状态)。
 * 插件把 activate/deactivate 记进 globalThis.__lc,测试直接读。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

interface Host {
  boot: typeof import('./bootstrap.js');
  tools: typeof import('../tools/toolRegistry.js');
  registry: typeof import('./registry.js');
}

interface PluginSpec {
  version?: string;
  requires?: unknown;
  defaultEnabled?: boolean;
  /** 新旧代码标记:工具 execute 与路由都回它。 */
  tag?: string;
  /** 注册一条 userRouter GET 路由。 */
  route?: string;
  /** activate 末尾抛错(此前已 registerPlugin)。 */
  throwInActivate?: boolean;
  /** 入口相对 import 一个 helper,工具回 helper 里的标记(证明换代后跑的是新 helper)。 */
  relative?: boolean;
  /** 不登记 meta、只挂裸 provider(forsion-worker 一类:设置页没有开关)。 */
  noMeta?: boolean;
  /** 第一次 activate(登记完之后)吊住,直到 globalThis.__release[id]()。 */
  hangActivateOnce?: boolean;
  /** 第一次 deactivate 吊住,直到 globalThis.__release[id]()。 */
  hangDeactivateOnce?: boolean;
  /** 工具 provider id(缺省 plugin:<id>)。 */
  providerId?: string;
}

const ENV_KEYS = ['TANGU_HOME', 'TANGU_PLUGINS', 'TANGU_PLUGINS_DIR', 'TANGU_BUNDLE_DIRS', 'TANGU_PLUGIN_GRAPH_SWAP'];
const savedEnv: Record<string, string | undefined> = {};
let tmp: string;
let pluginsRoot: string;
const lc = (): string[] => (globalThis as any).__lc;
const toolOf = (id: string): string => `${id.replace(/-/g, '_')}_tool`;

// 冷启动要转译整张核心模块图(bootstrap → index.js,数秒);先热一遍转译缓存,之后每例 resetModules 只付求值成本。
// 求值本身每例也要 1-2s(全量并行跑时更久),超时放宽到 20s —— 这是真实成本,不是在掩盖漏定时器。
vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import('./bootstrap.js');
  await import('../routes/plugins.js');
}, 120_000);

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tangu-lifecycle-')));
  pluginsRoot = path.join(tmp, 'plugins');
  mkdirSync(pluginsRoot, { recursive: true });
  mkdirSync(path.join(tmp, 'home'), { recursive: true });
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.TANGU_HOME = path.join(tmp, 'home');
  process.env.TANGU_PLUGINS_DIR = pluginsRoot;
  (globalThis as any).__lc = [];
  (globalThis as any).__lcImports = {};
  (globalThis as any).__hung = {};
  (globalThis as any).__release = {};
  vi.resetModules();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

async function host(): Promise<Host> {
  return {
    boot: await import('./bootstrap.js'),
    tools: await import('../tools/toolRegistry.js'),
    registry: await import('./registry.js'),
  };
}

function writePlugin(id: string, spec: PluginSpec = {}): void {
  const dir = path.join(pluginsRoot, id);
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  const manifest: Record<string, unknown> = { id, name: id, version: spec.version ?? '1.0.0', apiVersion: 1, entry: 'dist/index.js' };
  if (spec.requires !== undefined) manifest.requiresPlugins = spec.requires;
  writeFileSync(path.join(dir, 'tangu-plugin.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  const tag = JSON.stringify(spec.tag ?? 'v1');
  const tool = toolOf(id);
  if (spec.relative) writeFileSync(path.join(dir, 'dist', 'helper.js'), `export const helperTag = ${tag};\n`);
  const provider = `{ id: '${spec.providerId ?? `plugin:${id}`}', tools: () => [{
        name: '${tool}',
        definition: { type: 'function', function: { name: '${tool}', description: 'x', parameters: { type: 'object', properties: {} } } },
        execute: () => ${spec.relative ? 'helperTag' : 'tag'},
      }] }`;
  writeFileSync(path.join(dir, 'dist', 'index.js'), `${spec.relative ? "import { helperTag } from './helper.js';\n" : ''}
const g = globalThis;
g.__lcImports['${id}'] = (g.__lcImports['${id}'] || 0) + 1;
const tag = ${tag};
export default {
  activate(ctx) {
    g.__lc.push('activate:${id}:' + tag);
    ${spec.noMeta
      ? `ctx.registerToolProvider(${provider});`
      : `ctx.registerPlugin({ id: '${id}', name: '${id}', description: 'x', defaultEnabled: ${spec.defaultEnabled ?? true}, toolProvider: ${provider} });`}
    ${spec.route ? `ctx.registerRoutes((r) => r.userRouter.get('${spec.route}', (_req, res) => res.json({ tag })));` : ''}
    ${spec.throwInActivate ? "throw new Error('boom');" : ''}
    ${spec.hangActivateOnce ? `if (!g.__hung['a:${id}']) { g.__hung['a:${id}'] = 1; return new Promise((r) => { g.__release['${id}'] = r; }); }` : ''}
  },
  deactivate() {
    g.__lc.push('deactivate:${id}:' + tag);
    ${spec.hangDeactivateOnce ? `if (!g.__hung['d:${id}']) { g.__hung['d:${id}'] = 1; return new Promise((r) => { g.__release['${id}'] = r; }); }` : ''}
  },
};
`);
}

/** 本机 host 模式下模型可见的插件工具(按喂给 LLM 的顺序)。configureTangu 用桩:内置工具门禁读 deps() 不至于抛。 */
async function visibleTools(h: Host): Promise<string[]> {
  const { configureTangu } = await import('../seams/runtime.js');
  const { createTanguProfile } = await import('../profiles/index.js');
  const profile = createTanguProfile({ sandboxMode: 'none' });
  const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
  const ctx: any = { userId: 'u1', sessionId: 's1', appId: profile.appId, profile, execMode: 'host', cwd: tmp };
  return [...h.tools.resolveTools(profile, ctx).keys()].filter((n) => n.startsWith('lc_'));
}

async function execTool(h: Host, name: string): Promise<string> {
  const t = h.tools.listToolProviders().flatMap((p) => p.tools()).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.execute({}, {} as any);
}

async function listen(app: any): Promise<{ base: string; server: Server }> {
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe('启停', () => {
  it('停用 → 调 deactivate、工具撤下(槽位保留);再启用 → 同一模块再 activate、工具回到原位', async () => {
    writePlugin('lc-a');
    writePlugin('lc-b');
    writePlugin('lc-off', { defaultEnabled: false });
    const h = await host();
    await h.boot.activateAllPlugins();
    // 未启用的启动期也激活一次(meta / defaultEnabled 只有激活后才知道),随即休眠
    expect(lc()).toEqual(['activate:lc-a:v1', 'activate:lc-b:v1', 'activate:lc-off:v1', 'deactivate:lc-off:v1']);
    expect(await visibleTools(h)).toEqual(['lc_a_tool', 'lc_b_tool']);
    expect(h.registry.getPluginMeta('lc-off')).toMatchObject({ id: 'lc-off', name: 'lc-off' }); // 休眠仍列出
    expect(h.registry.getPluginMeta('lc-off')!.toolProvider).toBeUndefined();

    await h.boot.setPluginEnabledLive('lc-a', false);
    expect(lc().at(-1)).toBe('deactivate:lc-a:v1');
    expect(await visibleTools(h)).toEqual(['lc_b_tool']);
    expect(h.tools.listToolProviders().map((p) => p.id).filter((id) => id.startsWith('plugin:lc'))).toEqual(['plugin:lc-a', 'plugin:lc-b', 'plugin:lc-off']); // 槽位还在(空)
    expect(h.boot.pluginStatus('lc-a')).toEqual({ active: false, version: '1.0.0' }); // 是停用不是等前置:没有 waitingFor

    await h.boot.setPluginEnabledLive('lc-a', true);
    expect(lc().at(-1)).toBe('activate:lc-a:v1');
    expect(await visibleTools(h)).toEqual(['lc_a_tool', 'lc_b_tool']); // 回原位,不是追加到 lc_b 之后
    expect((globalThis as any).__lcImports['lc-a']).toBe(1); // 再启用复用同一模块对象,没重 import

    await h.boot.setPluginEnabledLive('lc-off', true);
    expect(await visibleTools(h)).toEqual(['lc_a_tool', 'lc_b_tool', 'lc_off_tool']);
    expect(h.boot.pluginStatus('lc-off').active).toBe(true);
  });

  it('绕过 setPluginEnabledLive 直接落盘开关(通道开语音那条路)→ 照样当场激活 / 休眠', async () => {
    writePlugin('lc-direct', { defaultEnabled: false });
    const h = await host();
    await h.boot.activateAllPlugins();
    expect(h.boot.pluginStatus('lc-direct').active).toBe(false);
    const store = await import('./settingsStore.js');
    await store.setPluginEnabled('lc-direct', true);
    await vi.waitFor(() => expect(h.boot.pluginStatus('lc-direct').active).toBe(true));
    expect(await visibleTools(h)).toEqual(['lc_direct_tool']);
    await store.setPluginEnabled('lc-direct', false);
    await vi.waitFor(() => expect(h.boot.pluginStatus('lc-direct').active).toBe(false));
    expect(await visibleTools(h)).toEqual([]);
  });

  it('activate 抛错:半截注册回滚、休眠带 lastError、调一次 deactivate 收尾;重扫不重试,显式拨开关才重试', async () => {
    writePlugin('lc-bad', { throwInActivate: true });
    const h = await host();
    await h.boot.activateAllPlugins();
    expect(lc()).toEqual(['activate:lc-bad:v1', 'deactivate:lc-bad:v1']);
    expect(await visibleTools(h)).toEqual([]); // 抛错前 registerPlugin 带进来的工具已撤
    expect(h.registry.getPluginMeta('lc-bad')).toBeDefined(); // 仍列出,好让用户看到 lastError
    expect(h.boot.pluginStatus('lc-bad')).toMatchObject({ active: false, lastError: 'boom' });

    await h.boot.rescanPlugins(); // 代码没变 → 不自动重试
    expect(lc()).toHaveLength(2);
    await h.boot.setPluginEnabledLive('lc-bad', true); // 显式拨开关 → 重试(仍抛)
    expect(lc().filter((x) => x.startsWith('activate:'))).toHaveLength(2);
    expect(h.boot.pluginStatus('lc-bad').lastError).toBe('boom');
  });
});

describe('限时、隔离与归属(Codex 10-02)', () => {
  it('activate 吊死:不堵生命周期链,超时记失败;那次没落定前拨开关也不叠第二份,落定后才起', async () => {
    writePlugin('lc-hang', { hangActivateOnce: true });
    writePlugin('lc-ok');
    const h = await host();
    h.boot.lifecycleTimeouts.activateMs = 150;
    await h.boot.activateAllPlugins(); // 没被吊住
    expect(h.boot.pluginStatus('lc-hang')).toMatchObject({ active: false, lastError: 'activate timed out after 150ms' });
    expect(await visibleTools(h)).toEqual(['lc_ok_tool']); // 吊住前登记的工具已撤
    await h.boot.setPluginEnabledLive('lc-ok', false); // 链没被堵
    await h.boot.setPluginEnabledLive('lc-hang', true); // 显式重试:上一次 activate 还挂着 → 不起第二份
    expect(h.boot.pluginStatus('lc-hang')).toEqual({ active: false, version: '1.0.0', settling: true });
    expect(lc().filter((x) => x.startsWith('activate:lc-hang'))).toHaveLength(1);
    (globalThis as any).__release['lc-hang']();
    await vi.waitFor(() => expect(h.boot.pluginStatus('lc-hang').active).toBe(true));
    expect(lc().filter((x) => x.startsWith('activate:lc-hang'))).toHaveLength(2);
    expect(await visibleTools(h)).toEqual(['lc_hang_tool']);
  });

  it('deactivate 超时:照常拆完;那次没落定前再启用不起(迟到的收尾会清掉新实例),落定后才起', async () => {
    writePlugin('lc-slow', { hangDeactivateOnce: true });
    const h = await host();
    h.boot.lifecycleTimeouts.deactivateMs = 150;
    await h.boot.activateAllPlugins();
    await h.boot.setPluginEnabledLive('lc-slow', false);
    expect(await visibleTools(h)).toEqual([]); // 超时也照常撤
    await h.boot.setPluginEnabledLive('lc-slow', true);
    expect(h.boot.pluginStatus('lc-slow')).toEqual({ active: false, version: '1.0.0', settling: true });
    expect(lc()).toEqual(['activate:lc-slow:v1', 'deactivate:lc-slow:v1']);
    (globalThis as any).__release['lc-slow']();
    await vi.waitFor(() => expect(h.boot.pluginStatus('lc-slow').active).toBe(true));
    expect(lc()).toEqual(['activate:lc-slow:v1', 'deactivate:lc-slow:v1', 'activate:lc-slow:v1']);
  });

  it('两个插件撞了同一个 provider id:后注册的覆盖;前者停用不清掉后者的工具', async () => {
    writePlugin('lc-a', { providerId: 'plugin:shared' });
    writePlugin('lc-b', { providerId: 'plugin:shared' });
    const h = await host();
    await h.boot.activateAllPlugins();
    expect(await visibleTools(h)).toEqual(['lc_b_tool']);
    await h.boot.setPluginEnabledLive('lc-a', false);
    expect(await visibleTools(h)).toEqual(['lc_b_tool']);
    await h.boot.setPluginEnabledLive('lc-b', false);
    expect(await visibleTools(h)).toEqual([]);
  });

  it('只改 helper(入口与版本都没动)也算换了代码:整图换代,工具读到新 helper', async () => {
    writePlugin('lc-rel', { relative: true });
    const h = await host();
    await h.boot.activateAllPlugins();
    writeFileSync(path.join(pluginsRoot, 'lc-rel', 'dist', 'helper.js'), 'export const helperTag = "v2-changed";\n');
    expect(await h.boot.rescanPlugins()).toMatchObject({ reloadedIds: ['lc-rel'], needsRestart: false });
    expect(await execTool(h, 'lc_rel_tool')).toBe('v2-changed');
  });

  it('热升级判定:单文件照热升;多文件 ESM 有模块钩子才热升;CommonJS / 自带 node_modules / 没钩子时引入写法再隐蔽也认得出', async () => {
    const { cannotHotSwap } = await import('./loader.js');
    const probe = (code: string, extra: { files?: Record<string, string>; esm?: boolean } = {}): boolean => {
      const dir = mkdtempSync(path.join(tmp, 'hs-'));
      writeFileSync(path.join(dir, 'index.js'), code);
      if (extra.esm !== false) writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
      for (const [name, body] of Object.entries(extra.files ?? {})) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), body);
      }
      return cannotHotSwap({ dir, entryUrl: pathToFileURL(path.join(dir, 'index.js')).href } as any);
    };
    const single = "import fs from 'node:fs'; await import('node:path'); console.log(import.meta.url)";
    expect(probe(single)).toBe(false);
    expect(probe("import { a } from /* c */ './h.js'", { files: { 'h.js': 'export const a = 1' } })).toBe(false); // 钩子整图换代
    expect(probe("import { a } from './h.js'", { esm: false, files: { 'h.js': 'exports.a = 1' } })).toBe(true); // 非 module 作用域
    expect(probe("import h from './h.cjs'", { files: { 'h.cjs': 'module.exports = 1' } })).toBe(true);
    expect(probe("import { a } from './h.js'", { files: { 'h.js': "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); export const a = require('./x.json')" } })).toBe(true);
    expect(probe("import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); require('node:fs')")).toBe(false); // esbuild banner 那种
    expect(probe(single, { files: { 'node_modules/dep/index.js': '' } })).toBe(true);
    process.env.TANGU_PLUGIN_GRAPH_SWAP = '0'; // 没钩子:只认单文件
    expect(probe("import { a } from /* c */ './h.js'")).toBe(true);
    expect(probe("await import(/* c */ './h.js')")).toBe(true);
    expect(probe('const m = await import(url)')).toBe(true);
    expect(probe(single)).toBe(false);
  });

  it('热换代封顶:本进程换代满 20 次后按需重启处理(旧模块卸不掉)', async () => {
    writePlugin('lc-gen');
    const h = await host();
    await h.boot.activateAllPlugins();
    let n = 0;
    for (; n < 25; n++) {
      writePlugin('lc-gen', { tag: `g${n}`, version: `1.0.${n + 1}` });
      if ((await h.boot.rescanPlugins()).needsRestart) break;
    }
    expect(n).toBe(20);
    expect(await execTool(h, 'lc_gen_tool')).toBe('g19'); // 老实例照跑
  });
});

describe('requiresPlugins 依赖', () => {
  it('前置停用 → 依赖者(及其下游)先于前置休眠(off / waiting);前置启用 → 按拓扑序级联回来;missing / version / cycle', async () => {
    writePlugin('lc-base', { version: '1.5.0' });
    writePlugin('lc-dep', { requires: ['lc-base'] });
    writePlugin('lc-top', { requires: ['lc-dep'] });
    writePlugin('lc-ver', { requires: [{ id: 'lc-base', minVersion: '2.0.0', market: 'ignored' }] });
    writePlugin('lc-miss', { requires: ['lc-nope'] });
    writePlugin('lc-cy1', { requires: ['lc-cy2'] });
    writePlugin('lc-cy2', { requires: ['lc-cy1'] });
    const h = await host();
    await h.boot.activateAllPlugins();
    const st = h.boot.pluginStatus;

    expect(await visibleTools(h)).toEqual(['lc_base_tool', 'lc_dep_tool', 'lc_top_tool']);
    expect(st('lc-dep')).toEqual({ active: true, version: '1.0.0', requiresPlugins: [{ id: 'lc-base' }] });
    expect(st('lc-ver').waitingFor).toEqual([{ id: 'lc-base', reason: 'version', minVersion: '2.0.0', have: '1.5.0' }]);
    expect(st('lc-miss').waitingFor).toEqual([{ id: 'lc-nope', reason: 'missing' }]);
    expect(st('lc-cy1').waitingFor).toEqual([{ id: 'lc-cy2', reason: 'cycle' }]);
    expect(st('lc-cy2').waitingFor).toEqual([{ id: 'lc-cy1', reason: 'cycle' }]);
    for (const id of ['lc-ver', 'lc-miss', 'lc-cy1', 'lc-cy2']) expect(lc()).toContain(`deactivate:${id}:v1`);

    let mark = lc().length;
    await h.boot.setPluginEnabledLive('lc-base', false);
    expect(lc().slice(mark)).toEqual(['deactivate:lc-top:v1', 'deactivate:lc-dep:v1', 'deactivate:lc-base:v1']); // 依赖者先停
    expect(st('lc-dep')).toMatchObject({ active: false, waitingFor: [{ id: 'lc-base', reason: 'off' }] });
    expect(st('lc-top')).toMatchObject({ active: false, waitingFor: [{ id: 'lc-dep', reason: 'waiting' }] });
    expect(st('lc-base').waitingFor).toBeUndefined(); // 自己被关的不给 waitingFor
    expect(await visibleTools(h)).toEqual([]);

    mark = lc().length;
    await h.boot.setPluginEnabledLive('lc-base', true);
    expect(lc().slice(mark)).toEqual(['activate:lc-base:v1', 'activate:lc-dep:v1', 'activate:lc-top:v1']);
    expect(await visibleTools(h)).toEqual(['lc_base_tool', 'lc_dep_tool', 'lc_top_tool']);

    // 装上缺的前置 → 依赖者自动激活
    writePlugin('lc-nope');
    const r = await h.boot.rescanPlugins();
    expect(r.addedIds).toEqual(['lc-nope']);
    expect(st('lc-miss')).toMatchObject({ active: true });
    expect(st('lc-miss').waitingFor).toBeUndefined();
  });
});

describe('热路由', () => {
  it('mount 之前激活的插件路由在 mount 时补挂;mount 之后经 rescan 激活的即时可达;停用后落空(404),再启用回来', async () => {
    writePlugin('lc-early', { route: '/agent/lc-early' });
    const h = await host();
    const mount = await h.boot.activateAllPlugins();
    const express = (await import('express')).default;
    const routers = { userRouter: express.Router(), dataRouter: express.Router(), adminRouter: express.Router() };
    routers.userRouter.get('/agent/core', (_req, res) => { res.json({ core: true }); });
    mount(routers);
    const app = express();
    app.use('/', routers.userRouter);
    app.use('/', routers.dataRouter);
    const { base, server } = await listen(app);
    try {
      expect(await (await fetch(`${base}/agent/lc-early`)).json()).toEqual({ tag: 'v1' });
      expect((await fetch(`${base}/agent/lc-hot`)).status).toBe(404);

      writePlugin('lc-route', { route: '/agent/lc-hot' });
      const r = await h.boot.rescanPlugins();
      expect(r).toEqual({ addedIds: ['lc-route'], reloadedIds: [], removedIds: [], needsRestart: false });
      expect(h.registry.pluginsNeedingRestart.size).toBe(0);
      const res = await fetch(`${base}/agent/lc-hot`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tag: 'v1' });
      expect((await fetch(`${base}/agent/core`)).status).toBe(200); // 核心路由不受影响

      await h.boot.setPluginEnabledLive('lc-route', false);
      expect((await fetch(`${base}/agent/lc-hot`)).status).toBe(404);
      expect((await fetch(`${base}/agent/lc-early`)).status).toBe(200);
      await h.boot.setPluginEnabledLive('lc-route', true);
      expect((await fetch(`${base}/agent/lc-hot`)).status).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('与磁盘同步(rescan)', () => {
  it('原地升级:改写代码 → 热换代(旧 deactivate 先于新 activate);入口相对引入的 helper 也是新一代', async () => {
    writePlugin('lc-up');
    writePlugin('lc-rel', { relative: true });
    writePlugin('lc-sub', { requires: ['lc-up'] });
    const h = await host();
    await h.boot.activateAllPlugins();
    expect(await execTool(h, 'lc_up_tool')).toBe('v1');

    writePlugin('lc-up', { tag: 'v2', version: '1.1.0' });
    writePlugin('lc-rel', { tag: 'v2', version: '1.1.0', relative: true });
    const mark = lc().length;
    const r = await h.boot.rescanPlugins();
    expect(r).toEqual({ addedIds: [], reloadedIds: ['lc-rel', 'lc-up'], removedIds: [], needsRestart: false });
    expect(await execTool(h, 'lc_up_tool')).toBe('v2');
    expect(await execTool(h, 'lc_rel_tool')).toBe('v2'); // helper 跟着换代,不是 ESM 缓存里的旧 helper
    // 依赖者随前置换代重启:先停依赖者,再停旧版本;新版本起来后依赖者再起
    expect(lc().slice(mark)).toEqual([
      'deactivate:lc-sub:v1', 'deactivate:lc-up:v1', 'deactivate:lc-rel:v1', 'activate:lc-rel:v2', 'activate:lc-up:v2', 'activate:lc-sub:v1',
    ]);
    expect(h.registry.pluginsNeedingRestart.size).toBe(0);
    expect(h.boot.pluginStatus('lc-up')).toMatchObject({ active: true, version: '1.1.0' });
    expect(await visibleTools(h)).toEqual(['lc_rel_tool', 'lc_up_tool', 'lc_sub_tool']); // 启动拓扑序的槽位,换代不挪位

    const r2 = await h.boot.rescanPlugins(); // 代码没再变 → 不重复换代
    expect(r2).toEqual({ addedIds: [], reloadedIds: [], removedIds: [], needsRestart: false });
  });

  it('运行时没有模块钩子(或 TANGU_PLUGIN_GRAPH_SWAP=0):多文件插件不热升,老实例照跑、如实需重启', async () => {
    process.env.TANGU_PLUGIN_GRAPH_SWAP = '0';
    writePlugin('lc-rel', { relative: true });
    const h = await host();
    await h.boot.activateAllPlugins();
    writePlugin('lc-rel', { tag: 'v2', version: '1.1.0', relative: true });
    expect(await h.boot.rescanPlugins()).toEqual({ addedIds: [], reloadedIds: [], removedIds: [], needsRestart: true });
    expect(await execTool(h, 'lc_rel_tool')).toBe('v1');
    expect(h.registry.pluginsNeedingRestart.has('lc-rel')).toBe(true);
  });

  it('目录消失 → 注销(removedIds),调 deactivate,工具与 meta 都没了;卸载后目录未删前的重扫不复活,重装新代码才回来', async () => {
    writePlugin('lc-gone');
    writePlugin('lc-keep');
    writePlugin('lc-del');
    const h = await host();
    await h.boot.activateAllPlugins();

    rmSync(path.join(pluginsRoot, 'lc-gone'), { recursive: true, force: true });
    const r = await h.boot.rescanPlugins();
    expect(r).toEqual({ addedIds: [], reloadedIds: [], removedIds: ['lc-gone'], needsRestart: false });
    expect(lc()).toContain('deactivate:lc-gone:v1');
    expect(h.registry.getPluginMeta('lc-gone')).toBeUndefined();
    expect(await visibleTools(h)).toEqual(['lc_del_tool', 'lc_keep_tool']);

    await h.boot.removePluginLive('lc-del'); // DELETE 路由的生命周期半截
    expect(lc().at(-1)).toBe('deactivate:lc-del:v1');
    expect(h.registry.getPluginMeta('lc-del')).toBeUndefined();
    expect(await visibleTools(h)).toEqual(['lc_keep_tool']);
    expect((await h.boot.rescanPlugins()).addedIds).toEqual([]); // 目录还没删:不复活

    writePlugin('lc-del', { tag: 'v2', version: '1.0.1' }); // 同路径重装新代码
    expect((await h.boot.rescanPlugins()).addedIds).toEqual(['lc-del']);
    expect(await execTool(h, 'lc_del_tool')).toBe('v2'); // 破了入口缓存,不是旧模块
  });
});

describe('启动顺序', () => {
  it('无依赖 = id 字母序(工具顺序不变);没登记 meta 的插件常开;有依赖按拓扑、同层 id 序;前置声明消毒', async () => {
    writePlugin('lc-c');
    writePlugin('lc-a');
    writePlugin('lc-b', { noMeta: true });
    const h = await host();
    await h.boot.activateAllPlugins();
    expect(lc()).toEqual(['activate:lc-a:v1', 'activate:lc-b:v1', 'activate:lc-c:v1']); // 没有 deactivate:lc-b(无开关 = 常开)
    expect(await visibleTools(h)).toEqual(['lc_a_tool', 'lc_b_tool', 'lc_c_tool']);

    const { discoverPlugins } = await import('./loader.js');
    // 与桌面 sanitizeRequiresPlugins 同口径:依赖自己 / 非 kebab / 重复丢弃;minVersion 非点分数字只丢 minVersion
    writePlugin('lc-a', { requires: ['lc-c', { id: 'lc-b', minVersion: 'v1.0', name: 'B', market: 'x' }, 'Bad_Id', 'lc-a', 'lc-c', 42, { id: 'lc-d', minVersion: '1.x' }] });
    const found = discoverPlugins();
    expect(found.map((d) => d.manifest.id)).toEqual(['lc-b', 'lc-c', 'lc-a']);
    expect(found.find((d) => d.manifest.id === 'lc-a')!.requiresPlugins).toEqual([{ id: 'lc-c' }, { id: 'lc-b', minVersion: 'v1.0' }, { id: 'lc-d' }]);
  });

  it('compareVersions:前导 v 忽略、缺段按 0', async () => {
    const { compareVersions } = await import('./loader.js');
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.5.0', '2.0.0')).toBe(-1);
  });
});

describe('HTTP 面(routes/plugins.ts)', () => {
  it('GET 列表带 active / version / requiresPlugins / waitingFor;PUT 级联并回带列表;rescan / DELETE 形状', async () => {
    writePlugin('lc-base');
    writePlugin('lc-dep', { requires: [{ id: 'lc-base', minVersion: '1.0.0' }] });
    const h = await host();
    await h.boot.activateAllPlugins();
    const { configureTangu } = await import('../seams/runtime.js');
    const { createTanguProfile } = await import('../profiles/index.js');
    const auth: any = new Proxy({ authMiddleware: (_q: any, _s: any, next: any) => next() }, {
      get: (t: any, k) => (k in t ? t[k] : () => { throw new Error('stub'); }),
    });
    const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
    configureTangu({ host: auth, brain: stub, billing: stub, profile: createTanguProfile({ sandboxMode: 'none' }) });
    const express = (await import('express')).default;
    const pluginsRouter = (await import('../routes/plugins.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/', pluginsRouter);
    const { base, server } = await listen(app);
    const call = async (method: string, p: string, body?: unknown): Promise<any> => {
      const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(res.status).toBe(200);
      return res.json();
    };
    try {
      const list = await call('GET', '/agent/plugins');
      const dep = list.plugins.find((p: any) => p.id === 'lc-dep');
      expect(dep).toMatchObject({ enabled: true, needsRestart: false, active: true, version: '1.0.0', requiresPlugins: [{ id: 'lc-base', minVersion: '1.0.0' }], source: 'folder' });
      expect(dep.waitingFor).toBeUndefined();

      const put = await call('PUT', '/agent/plugins/lc-base/enabled', { enabled: false });
      expect(put).toMatchObject({ ok: true, enabled: false, active: false });
      expect(put.plugins.find((p: any) => p.id === 'lc-dep')).toMatchObject({ active: false, waitingFor: [{ id: 'lc-base', reason: 'off' }] });

      const rescan = await call('POST', '/agent/plugins/rescan');
      expect(rescan).toMatchObject({ ok: true, addedIds: [], reloadedIds: [], removedIds: [], needsRestart: false });
      expect(Array.isArray(rescan.plugins)).toBe(true);

      expect(await call('DELETE', '/agent/plugins/lc-base')).toEqual({ ok: true, restartRequired: false });
      const after = await call('GET', '/agent/plugins');
      expect(after.plugins.map((p: any) => p.id)).toEqual(['lc-dep']);
      expect(after.plugins[0].waitingFor).toEqual([{ id: 'lc-base', reason: 'missing', minVersion: '1.0.0' }]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
