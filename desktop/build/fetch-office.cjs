/**
 * 把 LibreOffice 转换引擎装到 desktop/build/office,供 electron-builder extraResources 打进安装包
 * → read_document 在没装 LibreOffice 的机器上也能把 docx/xlsx/pptx 转成 PDF、按真页码读。
 *
 *  - 引擎 = @deepseek-ai/libreoffice-kit(MPL-2.0,DeepSeek Harness 桌面端同款的精简预编译 LibreOffice)。
 *    npm 按 --os/--cpu 只装目标平台那一份:mac/win 原生(解压 150~190MB),linux 走 WASM(~150MB)。
 *  - 包里的 licenses/ 与 sources/(源码配方 + 补丁)原样保留:MPL-2.0 再分发要带着。
 *  - 与 fetch-python 同构:由 beforeBuild.cjs 按目标 (platform, arch) 调用;也可 `npm run fetch-office` 手动跑。
 *  - **失败硬报错**:用户拍板要内置,没带上就别发。逃生阀 TANGU_SKIP_FETCH_OFFICE=1(建空目录 + .skipped)。
 */
const { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const KIT = '@deepseek-ai/libreoffice-kit@0.1.2';
/** kit 0.1.2 的 optionalDependencies 原样(npm 已发布版本不可变);装完按 kit 的声明对账。
 *  必须显式装引擎包:引擎包声明 engines node>=22.19,而构建机 npm 跑在 Node 20(CI setup-node)——
 *  npm 对**可选**依赖遇 engines 不符会整个跳过(只剩 17 个包、没有引擎),显式依赖则只告警照装。
 *  运行时是 Electron 自带的 Node 24,不受这条约束。 */
const ENGINE_VERSIONS = {
  'libreoffice-kit-darwin-arm64': '0.1.1', 'libreoffice-kit-darwin-x64': '0.1.1',
  'libreoffice-kit-win32-x64': '0.1.2', 'libreoffice-kit-win32-arm64': '0.1.2', 'libreoffice-kit-wasm': '0.1.1',
};

const officeDir = () => path.join(__dirname, 'office');

/** 目标平台用的那份引擎包(kit 自己按同样规则挑:mac/win 只认原生,linux 只认 WASM)。 */
const enginePackage = (platformName, archName) =>
  platformName === 'linux' ? 'libreoffice-kit-wasm' : `libreoffice-kit-${platformName}-${archName}`;

/**
 * Windows 引擎 exe 动态依赖 VC++ 运行库(MSVCP140 与 VCRUNTIME140 两族),包里没带;干净的 Windows 没装
 * VC++ Redistributable 就起不来,而 CI runner 装着 → 闸永远假绿。按微软的 app-local 部署做法,
 * 从 Visual Studio 的 Redist 目录把这 5 个 DLL 放到 exe 旁边(exe 所在目录在 DLL 搜索顺序里排第一)。
 * TANGU_VC_REDIST_DIR 可直接指向 Microsoft.VC14x.CRT 目录(没装 VS 的构建机)。
 */
const VC_DLLS = ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
function vcRedistDir(archName) {
  if (process.env.TANGU_VC_REDIST_DIR) return process.env.TANGU_VC_REDIST_DIR;
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  // -requires:只挑装了对应 C++ 工具集(带 Redist)的实例,别被更新但没装 C++ 的实例抢走(微软 Find-VC 示例的写法);
  // -utf8:输出进管道时默认按控制台代码页编码,安装路径含中文会被解坏。
  const tools = archName === 'arm64' ? 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' : 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64';
  const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', tools, '-property', 'installationPath', '-utf8'],
    { encoding: 'utf8' }).trim();
  if (!vs) throw new Error(`[fetch-office] vswhere 没找到装了 ${tools} 的 Visual Studio;可设 TANGU_VC_REDIST_DIR`);
  const root = path.join(vs, 'VC', 'Redist', 'MSVC');
  const num = (v) => v.split('.').map(Number);
  const ver = readdirSync(root).filter((d) => /^\d+\.\d+\.\d+$/.test(d))
    .sort((a, b) => { const [x, y] = [num(a), num(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).pop();
  if (!ver) throw new Error(`[fetch-office] ${root} 下没有 VC Redist 版本目录`);
  const archDir = path.join(root, ver, archName);
  const crt = readdirSync(archDir).find((d) => /^Microsoft\.VC\d+\.CRT$/.test(d));
  if (!crt) throw new Error(`[fetch-office] ${archDir} 下没有 Microsoft.VC*.CRT`);
  return path.join(archDir, crt);
}

function fetchOffice({ platformName, archName }) {
  const dest = officeDir();
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.join(dest, 'node_modules'), { recursive: true }); // extraResources 的 from 恒在
  if (process.env.TANGU_SKIP_FETCH_OFFICE) {
    console.warn('[fetch-office] ⚠ TANGU_SKIP_FETCH_OFFICE → 不打包 LibreOffice 转换引擎');
    writeFileSync(path.join(dest, '.skipped'), 'office engine skipped\n');
    return dest;
  }
  const engineName = enginePackage(platformName, archName);
  if (!ENGINE_VERSIONS[engineName]) throw new Error(`[fetch-office] 不支持的目标 ${platformName}-${archName}`);
  const engineSpec = `@deepseek-ai/${engineName}@${ENGINE_VERSIONS[engineName]}`;
  console.log(`[fetch-office] npm install ${KIT} ${engineSpec}`);
  // win32 上 npm 是 .cmd shim,不经 shell 起不来;路径里可能有空格,所以 shell 时自己加引号。
  const win = process.platform === 'win32';
  // 跨平台/跨架构打包:npm 对**显式**依赖按本机实际 os/cpu 校验(--os/--cpu 只管可选依赖的挑选),
  // 目标不是本机就得 --force 跳过这道校验。CI 每行都是本机架构,走不到这里。
  const cross = platformName !== process.platform || archName !== process.arch ? ['--force'] : [];
  execFileSync(win ? 'npm.cmd' : 'npm', ['install', '--prefix', win ? `"${dest}"` : dest, '--no-save', '--no-package-lock',
    '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${platformName}`, `--cpu=${archName}`, ...cross, KIT, engineSpec],
  { stdio: 'inherit', shell: win });
  const engine = path.join(dest, 'node_modules', '@deepseek-ai', engineName);
  if (!existsSync(path.join(engine, 'prebuilds.json'))) throw new Error(`[fetch-office] 装完缺引擎包 ${engine}`);
  const want = require(path.join(dest, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'package.json')).optionalDependencies?.[`@deepseek-ai/${engineName}`];
  if (want !== ENGINE_VERSIONS[engineName]) throw new Error(`[fetch-office] kit 要 ${engineName}@${want},这里写的是 ${ENGINE_VERSIONS[engineName]}:升 kit 时同步 ENGINE_VERSIONS`);
  if (platformName === 'win32') {
    const from = vcRedistDir(archName);
    for (const dll of VC_DLLS) copyFileSync(path.join(from, dll), path.join(engine, 'bin', dll));
    console.log(`[fetch-office] VC++ 运行库 app-local ← ${from}`);
  }
  console.log(`[fetch-office] ✓ ${dest}`);
  return dest;
}

/** 随包 kit 的入口模块(backendManager 与 afterPack 闸共用这一个布局约定)。 */
const kitEntry = (officeRoot) => path.join(officeRoot, 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js');

module.exports = { fetchOffice, officeDir, kitEntry, VC_DLLS, enginePackage };

// CLI:node build/fetch-office.cjs [platform] [arch](缺省=本机)
if (require.main === module) {
  try { fetchOffice({ platformName: process.argv[2] || process.platform, archName: process.argv[3] || process.arch }); }
  catch (e) { console.error(e.message || e); process.exit(1); }
}
