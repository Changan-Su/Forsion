/**
 * 电脑操作(Computer Use)在 Windows 上的 helper 链路冒烟 —— 由 .github/workflows/cu-windows-smoke.yml 调用。
 * 用安装包自带的运行时(Forsion.exe + ELECTRON_RUN_AS_NODE=1)像引擎那样驱动已播种的捆绑包:
 * 首次调用自动装 helper → find_roots 找到记事本 → observe_ui 读出 UIA 大纲。argv[2] = 播种后的捆绑包目录。
 * 「引擎默认就给出 CU 工具」由 workflow 直接问真引擎验;这里固定启用,只管 helper 这一半。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = path.join(process.argv[2], 'tangu-plugins', 'computer-use', 'dist', 'index.js');
const plugin = (await import(pathToFileURL(entry).href)).default;
let meta;
await plugin.activate({
  registerPlugin: (m) => { meta = m; },
  registerCommand() {},
  log: (msg) => console.log(`[plugin] ${msg}`),
  sdk: { pluginStore: { isPluginEnabledSync: () => true, getScopeSettings: () => ({}) } },
});
const tools = meta.toolProvider.tools().filter((t) => t.isEnabledFor({ capabilities: { hostExec: true } }));
const call = async (name, args) => {
  const out = String(await tools.find((t) => t.name === name).execute(args, { cwd: process.cwd(), signal: AbortSignal.timeout(170_000) }));
  console.log(`=== ${name}(${JSON.stringify(args)})\n${out.slice(0, 4000)}\n`);
  return out;
};

const root = (await call('find_roots', { text: 'Notepad' })).match(/@r\d+/)?.[0];
const ok = !!root && /Outline \(\d+ nodes/.test(await call('observe_ui', { root, mode: 'semantic' }));
console.log(ok ? 'CU Windows smoke: OK' : 'CU Windows smoke: FAILED');
process.exit(ok ? 0 : 1);
