/**
 * electron-builder afterPack 钩子:为打包后 bundled 的 tangu-server 把 better-sqlite3
 * 重建为 **Electron ABI** 的原生二进制。
 *
 * 背景:better-sqlite3 是原生模块,其 .node 二进制按运行时 ABI 编译。desktop 的 managed 后端
 * 在打包态经 Electron(process.execPath + ELECTRON_RUN_AS_NODE)跑,而 extraResources 只是把
 * 父包的 `../node_modules`(系统 Node ABI 预编译)原样**复制**进 app,electron-builder 不会
 * 自动 rebuild extraResources → 加载时 NODE_MODULE_VERSION 不匹配会抛错。此钩子在复制完成后
 * 就地把 bundled 的 better-sqlite3 重建为本次目标 Electron 的 ABI。
 *
 * 跳过:设 env TANGU_SKIP_NATIVE_REBUILD=1(仅打包非 SQLite 形态时)。
 */
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (process.env.TANGU_SKIP_NATIVE_REBUILD) {
    console.log('[afterPack] TANGU_SKIP_NATIVE_REBUILD set → 跳过 better-sqlite3 重建');
    return;
  }
  const { rebuild } = require('@electron/rebuild');
  const { Arch } = require('electron-builder');
  const { appOutDir, packager, electronPlatformName, arch } = context;

  // 定位打包后的 resources 目录(mac 在 .app/Contents/Resources,其余在 resources/)。
  const resourcesDir =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
  const buildPath = path.join(resourcesDir, 'tangu-server'); // extraResources 落点(含 node_modules)
  // electron-builder 24 的 AfterPackContext:framework 在 packager.info.framework(packager.framework 为 undefined)。
  // 兼容不同版本,逐级兜底取 Electron 版本。
  const electronVersion =
    packager.info?.framework?.version ||
    packager.framework?.version ||
    context.electronVersion;
  if (!electronVersion) throw new Error('[afterPack] 无法解析 Electron 版本(packager.info.framework.version 为空)');
  const archName = Arch[arch]; // 数字枚举 → 'x64' | 'arm64' | 'armv7l'

  console.log(`[afterPack] electron-rebuild better-sqlite3 → Electron ${electronVersion} (${archName}) @ ${buildPath}`);
  await rebuild({
    buildPath,
    electronVersion,
    arch: archName,
    onlyModules: ['better-sqlite3'],
    force: true,
  });
  console.log('[afterPack] better-sqlite3 已为 Electron ABI 重建');
};
