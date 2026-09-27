#!/usr/bin/env node
/**
 * Muse 自建 Space 能不能被桌面装出 home 视图 —— 与桌面宿主同口径的离线判定(2026-09-27)。
 *   node scripts/muse-space-verdict.mjs [<Space 目录>] [<应用版本>]
 * 缺省目录 = $TANGU_HOME/agents/muse/Space(再缺省 ~/.tangu/…);stdout 最后一行是 JSON {built, ok, text},退出码恒 0。
 * 用处:① 实机一条命令看出「Muse 写了 Space 却渲染不出来」—— 09-27 实机每一版 main.js 都包成 function setup(ctx){…}
 * 不调用 = 零注册零报错,Space 空白 16 天;② live 台架 muse 场景在**子进程**里调它:插件代码的异步炸点只炸这个进程。
 *
 * 口径(desktop electron/amadeus/ipc.ts readAgentSpacePlugins + shared/amadeus/ipc.ts gatePluginManifest / cmpVersion):
 * manifest 必须是 JSON 对象;apiVersion 缺省 1 且必须 =1;minAppVersion 不高于应用版本;代码取 manifest.main(相对、不含 ..)
 * 否则 main.js;整个文件当 setup(ctx) 的函数体跑(内层函数只有 ctx 一个形参,与宿主逐字同形);home 必须带 mount 函数
 * (ViewContribution.mount 必填,缺了宿主渲染「视图加载失败」);宿主给 async 注册 3 秒宽限(desktop builtins/agentSpaceSync),
 * 这里同样等到见着 home 或满 3 秒。ctx 只给 PluginContext 真有的顶层成员(读 desktop types.ts,读不到就宽松);agent Space
 * 不带 capabilities → 没有 ctx.system。浏览器环境**直接做进本进程的全局**:window/self 就是 globalThis;浏览器才有的名字
 * (document / addEventListener / ResizeObserver …)经 globalThis 原型链上的代理一律解析成惰性深代理,Node 自带的(定时器 /
 * console / process)照旧是真的;fetch / navigator 显式盖成惰性的(不真发请求)。然后用与宿主逐字相同的
 * new Function('ctx', code)(ctx) 求值 —— 顶层 `const self = …` 是合法遮蔽、strict 的 this 是 undefined、sloppy 的 this 是
 * 全局(=window),都与宿主一致(Codex 09-27 三轮:当形参注入会撞名、套壳 .call(this) 弄错 strict 的 this、逐个补全局名单
 * 永远补不全)。本进程一次性、判完即退,改全局无妨。代价:`if (window.根本不存在的东西)` 会被判真 —— 只会多放行,不会假红。
 * ponytail: 嵌套一层仍宽松(`ctx.app.不存在的东西` 会被判真);mount 只查在不在、不调用(要调就得在 Node 里仿一整套 DOM)——
 * 这两类真撞上,由桌面的「没注册 home」回写 / 视图挂载失败兜住。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GRACE_MS = 3000;
const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || join(process.env.TANGU_HOME || join(homedir(), '.tangu'), 'agents', 'muse', 'Space');
const appVersion = process.argv[3] || '';
const proc = process; // 下面会把全局 process 藏起来(渲染进程里没有它),本脚本自己用这份
const done = (v) => { console.log(JSON.stringify(v)); proc.exit(0); };
const msg = (e) => String(e?.message || e).slice(0, 160);

/** PluginContext 顶层成员名(与 desktop contractDocs.test 同一抽法);读不到 → null。 */
function ctxMembers() {
  try {
    const src = readFileSync(join(here, '../../desktop/frontend/src/amadeus/plugins/types.ts'), 'utf8');
    const i = src.indexOf('export interface PluginContext ');
    if (i < 0) return null;
    const body = src.slice(i);
    const names = [...body.slice(0, body.search(/\n\}\n/)).matchAll(/^ {2}([A-Za-z_]\w*)\??\s*[:(<]/gm)].map((m) => m[1]);
    // 能力闸成员不注入 agent Space(desktop shared/amadeus/ipc.ts PLUGIN_CAPABILITIES;今天只有 activeWindow → ctx.system)
    return names.length > 10 ? new Set(names.filter((n) => n !== 'system')) : null;
  } catch { return null; }
}
/** 逐字抄 desktop shared/amadeus/ipc.ts cmpVersion(剥前缀 v、任意段数)。 */
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

let m;
try { m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch {
  done(existsSync(join(dir, 'main.js')) ? { built: true, ok: false, text: 'manifest.json 缺失或坏' } : { built: false, ok: true, text: '未建' });
}
if (!m || typeof m !== 'object' || Array.isArray(m)) done({ built: true, ok: false, text: 'manifest.json 不是对象' });
if ((m.apiVersion === undefined ? 1 : m.apiVersion) !== 1) done({ built: true, ok: false, text: `被门禁挡:apiVersion ${JSON.stringify(m.apiVersion)}` });
if (typeof m.minAppVersion === 'string' && m.minAppVersion && appVersion && cmpVersion(appVersion, m.minAppVersion) < 0) {
  done({ built: true, ok: false, text: `被门禁挡:minAppVersion ${m.minAppVersion} > ${appVersion}` });
}
const main = typeof m.main === 'string' && m.main.trim() ? m.main.trim().slice(0, 120) : '';
const rel = main && !main.includes('..') && !isAbsolute(main) ? main : 'main.js';
let code = '';
try { code = readFileSync(join(dir, rel), 'utf8'); } catch { done({ built: true, ok: false, text: `${rel} 读不到` }); }

const known = ctxMembers();
const views = [];
const errors = []; // 插件的异步报错:宿主里只是控制台一行,这里记下来,没注册出 home 时一并报
process.on('unhandledRejection', (e) => errors.push(e));
process.on('uncaughtException', (e) => errors.push(e));
// 深代理:怎么点、怎么调、怎么 new 都不炸;拼字符串时当空串、迭代时当空(否则 `'Muse ' + ctx.getLocale()` 会假红)
const deep = () => new Proxy(function () {}, {
  get: (_, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? function* () {} : deep()),
  apply: () => deep(),
  construct: () => deep(),
});
const ctx = new Proxy({}, { get: (_, k) => (k === 'registerView' ? (v) => { views.push(v); return deep(); } : !known || known.has(k) ? deep() : undefined) });
const homeOf = () => views.find((v) => v?.id === 'home');
const proto = Object.getPrototypeOf(globalThis);
// 浏览器里本来就没有的名字必须照样不存在:UMD / CommonJS 守卫(`typeof exports !== 'undefined'` 就导出、否则 setup(ctx))
// 在渲染进程(contextIsolation + 无 nodeIntegration)走 else 分支,这里若说「有」就会走错分支、假红(Codex 09-27 第七轮)。
const NOT_BROWSER = ['exports', 'module', 'require', 'define', 'global', 'process', 'Buffer', 'setImmediate', 'clearImmediate', '__dirname', '__filename'];
Object.setPrototypeOf(globalThis, new Proxy(proto, {
  has: (t, k) => !NOT_BROWSER.includes(k) || k in t,
  get: (t, k, rcv) => (k in t || NOT_BROWSER.includes(k) ? Reflect.get(t, k, rcv) : deep()),
}));
const browser = {
  window: globalThis, self: globalThis, navigator: deep(), fetch: deep(), requestAnimationFrame: (fn) => setTimeout(fn, 16), cancelAnimationFrame: clearTimeout,
  global: undefined, process: undefined, Buffer: undefined, setImmediate: undefined, clearImmediate: undefined, // Node 自带、渲染进程没有
};
for (const [k, v] of Object.entries(browser)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
let r;
try { r = new Function('ctx', code)(ctx); } catch (e) { done({ built: true, ok: false, text: `求值抛错:${msg(e)}` }); }
Promise.resolve(r).catch((e) => errors.push(e));
const t0 = Date.now();
while (!homeOf() && Date.now() - t0 < GRACE_MS) await new Promise((res) => setTimeout(res, 50));
const home = homeOf();
const ok = typeof home?.mount === 'function';
done({
  built: true, ok,
  text: `注册视图 [${views.map((v) => v?.id).join(',') || '无'}]${home && !ok ? ';home 缺 mount' : ''}` +
    `${!ok && errors.length ? `;异步报错:${msg(errors[0])}` : ''}${known ? '' : '(ctx 成员表读不到,宽松判定)'}`,
});
