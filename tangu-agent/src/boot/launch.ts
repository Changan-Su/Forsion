/**
 * 引擎启动器(2026-10-12):`node dist/boot/launch.js <standalone|tui> [参数…]`。
 *
 * 桌面拉起后端、终端里的 `tangu` 命令都先到这里。它住在安装包里,自己不热更新 —— 「跑哪一份引擎」的决定权
 * 必须在安装包手里。有合格的新版(overlay.ts)就跑新版的 dist,否则跑身边这份。
 *
 * 新版只有 dist,没有 node_modules:它在用户目录里,往上找不到安装包的依赖(ESM 不认 NODE_PATH)。所以挑中新版时
 * 挂一个解析钩子,把新版文件里的裸包名一律改到安装包这份包根去解析 —— 是「一律」而不是「找不到才退回」:
 * 用户目录往上若有野的 node_modules(~/node_modules 很常见),退回式会先命中它,原生模块的 ABI 就对不上了。
 *
 * 环境变量 TANGU_ENGINE_OVERLAY:off = 只跑安装包自带的;verbose = 终端里的 tangu 也把挑选过程打出来。
 */
import * as nodeModule from 'node:module';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { forsionSharedDir } from '../core/tanguHome.js';
import { ENGINE_ENTRIES, engineOverlayRoot, markBad, selectOverlay, type SelectedOverlay } from './overlay.js';

type ResolveResult = { url: string; shortCircuit?: boolean; format?: string | null };
type ResolveContext = { parentURL?: string; conditions?: string[] };
type ResolveHooks = { resolve(specifier: string, context: ResolveContext, next: (s: string, c: ResolveContext) => ResolveResult): ResolveResult };

const which = process.argv[2] as keyof typeof ENGINE_ENTRIES;
if (!Object.hasOwn(ENGINE_ENTRIES, which ?? '')) {
  console.error(`usage: launch.js <${Object.keys(ENGINE_ENTRIES).join('|')}> [args…]`);
  process.exit(2);
}
const bundledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 终端里的 tangu 是全屏界面:常态的「没有可用新版」不往上打字,只有验签不过这种该让人知道的才说。
const log = (m: string, always = false): void => {
  if (always || which === 'standalone' || process.env.TANGU_ENGINE_OVERLAY === 'verbose') console.error(`[engine-overlay] ${m}`);
};

/** 把 overlayDir 里的文件发出的裸包名改到安装包这份包根去解析。运行时没有同步钩子(Node < 22.15)就返回 false。 */
function redirectBareImports(overlayDir: string): boolean {
  const registerHooks = (nodeModule as unknown as { registerHooks?: (hooks: ResolveHooks) => unknown }).registerHooks;
  if (typeof registerHooks !== 'function') return false;
  const overlayUrl = pathToFileURL(overlayDir + path.sep).href;
  const anchor = pathToFileURL(path.join(bundledRoot, 'package.json')).href;
  const anchorRequire = nodeModule.createRequire(anchor);
  const bare = (s: string): boolean =>
    !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('#') && !nodeModule.isBuiltin(s) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s);
  registerHooks({
    resolve(specifier, context, next) {
      if (!context.parentURL?.startsWith(overlayUrl) || !bare(specifier)) return next(specifier, context);
      // require() 走的是 CJS 解析,不认改过的 parentURL:直接从安装包那份包根解析出文件。
      if (!context.conditions?.includes('import')) return { url: pathToFileURL(anchorRequire.resolve(specifier)).href, shortCircuit: true };
      return next(specifier, { ...context, parentURL: anchor });
    },
  });
  return true;
}

let overlay: SelectedOverlay | null = null;
const engineRoot = engineOverlayRoot(forsionSharedDir());
if (process.env.TANGU_ENGINE_OVERLAY !== 'off') {
  try {
    overlay = selectOverlay(engineRoot, bundledRoot, {
      onReject: (version, code, reason) => log(`${version} skipped (${code}): ${reason}`, code === 'signature'),
    });
  } catch (e) {
    log(`cannot look for engine updates: ${(e as Error)?.message || e}`);
  }
}

let root = bundledRoot;
if (overlay) {
  // 模块的 URL 是按真实路径算的,钩子的前缀也得是真实路径(家目录经符号链接到达时两者不同)。
  const dir = realpathSync(overlay.dir);
  if (redirectBareImports(dir)) {
    root = dir;
    // 新版里凡是要找「安装包那份」的地方(随包的 Chrome 扩展、要保护的依赖目录)读这个。
    process.env.TANGU_BUNDLED_ROOT = bundledRoot;
    log(`running ${overlay.version} from ${dir}`);
  } else {
    log(`this runtime (Node ${process.versions.node}) cannot load engine updates; running the bundled engine`);
  }
}

const entry = path.join(root, ENGINE_ENTRIES[which]);
process.argv.splice(1, 2, entry); // 入口按 argv[2] 起解析参数,argv[1] 该是它自己
try {
  await import(pathToFileURL(entry).href);
} catch (e) {
  // 只把「装不起来」记成坏版本(缺文件、语法错);入口自己运行时抛的错与新版无关,原样往上抛。
  const code = (e as NodeJS.ErrnoException)?.code ?? '';
  if (overlay && root !== bundledRoot && (e instanceof SyntaxError || /^(ERR_)?MODULE_NOT_FOUND$|^ERR_(PACKAGE_|UNSUPPORTED_DIR_IMPORT|INVALID_MODULE_SPECIFIER|UNKNOWN_FILE_EXTENSION)/.test(code))) {
    markBad(engineRoot, overlay.version, `failed to load: ${(e as Error)?.message || e}`);
    log(`${overlay.version} failed to load and will not be used again: ${(e as Error)?.message || e}`, true);
    process.exit(70);
  }
  throw e;
}
