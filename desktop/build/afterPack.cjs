/**
 * electron-builder afterPack 钩子,做两件事:
 *  ① 为打包后 bundled 的 tangu-server 把 better-sqlite3 重建为 **Electron ABI** 的原生二进制。
 *     背景:better-sqlite3 是原生模块,.node 按运行时 ABI 编译;extraResources 只是把父包
 *     `../node_modules`(系统 Node ABI 预编译)原样复制进 app,electron-builder 不会自动 rebuild
 *     extraResources → 加载时 NODE_MODULE_VERSION 不匹配会抛错。故此处就地重建为目标 Electron ABI。
 *     跳过:env TANGU_SKIP_NATIVE_REBUILD=1(仅打包非 SQLite 形态时)。
 *  ② macOS:对 .app 做 **ad-hoc 自签**(codesign --sign -)。本项目无 Apple Developer ID。
 *     完全未签名的 app 在 Apple Silicon 上会被 Gatekeeper 判为「已损坏」(连「仍要打开」都不给,
 *     只能 xattr 去隔离);带一个 ad-hoc 签名后会降级为「未识别开发者」——用户即可在
 *     系统设置 → 隐私与安全性 里点「仍要打开」。彻底无提示仍需 Developer ID + 公证(notarize)。
 *     配合 package.json 的 build.mac.identity=null(electron-builder 跳过自身签名,签名全交本钩子)。
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName, arch } = context;

  // ① better-sqlite3 → Electron ABI 重建
  if (process.env.TANGU_SKIP_NATIVE_REBUILD) {
    console.log('[afterPack] TANGU_SKIP_NATIVE_REBUILD set → 跳过 better-sqlite3 重建');
  } else {
    const { rebuild } = require('@electron/rebuild');
    const { Arch } = require('electron-builder');
    // 定位打包后的 resources 目录(mac 在 .app/Contents/Resources,其余在 resources/)。
    const resourcesDir =
      electronPlatformName === 'darwin'
        ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
        : path.join(appOutDir, 'resources');
    const buildPath = path.join(resourcesDir, 'tangu-server'); // extraResources 落点(含 node_modules)
    // electron-builder 24 的 AfterPackContext:Electron 版本逐级兜底取。
    const electronVersion =
      packager.info?.framework?.version ||
      packager.framework?.version ||
      context.electronVersion;
    if (!electronVersion) throw new Error('[afterPack] 无法解析 Electron 版本(packager.info.framework.version 为空)');
    const archName = Arch[arch]; // 数字枚举 → 'x64' | 'arm64' | 'armv7l'
    console.log(`[afterPack] electron-rebuild better-sqlite3 → Electron ${electronVersion} (${archName}) @ ${buildPath}`);
    await rebuild({ buildPath, electronVersion, arch: archName, onlyModules: ['better-sqlite3'], force: true });
    console.log('[afterPack] better-sqlite3 已为 Electron ABI 重建');
  }

  // ② macOS ad-hoc 自签 —— 必须放在 native rebuild 之后(重建改动了 bundle,签名要最后做,
  //    且 --deep 才能把重建后的 .node 一并签上)。无 Developer ID → Gatekeeper 显「未识别开发者/仍要打开」。
  if (electronPlatformName === 'darwin') {
    const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
    console.log(`[afterPack] codesign ad-hoc(--force --deep --sign -)→ ${appPath}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('[afterPack] ad-hoc 签名完成');
  }
};
