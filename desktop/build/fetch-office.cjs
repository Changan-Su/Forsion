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
  const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
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
  console.log(`[fetch-office] npm install ${KIT} (${platformName}-${archName})`);
  // win32 上 npm 是 .cmd shim,不经 shell 起不来;路径里可能有空格,所以 shell 时自己加引号。
  const win = process.platform === 'win32';
  execFileSync(win ? 'npm.cmd' : 'npm', ['install', '--prefix', win ? `"${dest}"` : dest, '--no-save', '--no-package-lock',
    '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${platformName}`, `--cpu=${archName}`, KIT],
  { stdio: 'inherit', shell: win });
  const engine = path.join(dest, 'node_modules', '@deepseek-ai', enginePackage(platformName, archName));
  if (!existsSync(path.join(engine, 'prebuilds.json'))) throw new Error(`[fetch-office] 装完缺引擎包 ${engine}`);
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
