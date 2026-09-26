/**
 * 下载便携 git 到 desktop/build/git,供 electron-builder extraResources 打进安装包 → 没装 git 的机器上
 * agent 的 run_bash 与 Coding Studio 版本历史照样有 git。与 fetch-node.cjs 同一套下载/降级纪律。
 *
 *  - Windows:官方 **MinGit**(Git for Windows 专供应用内嵌的精简版,可重定位;cmd/git.exe 自己接好 mingw64)。
 *    不带 ssh.exe(走 Windows 10+ 自带的 OpenSSH)、不带 LFS;带 Git Credential Manager(私有仓 HTTPS 登录靠它)。
 *  - macOS:**dugite-native**(GitHub Desktop 用的便携构建)。它不是 runtime-prefix 构建(`--exec-path` 编死成
 *    `/libexec/git-core`),所以 bin/git 换成 sh 包装,只在自己进程里设 GIT_EXEC_PATH / GIT_TEMPLATE_DIR ——
 *    这俩绝不能进引擎全局 env:用户自己的 git 继承了会加载到另一个版本的 git-core。
 *    精简:删 Git Credential Manager(自带整套 .NET 运行时 ~120MB)、git-lfs、scalar,148MB → ~23MB。
 *  - Linux:不捆(git 几乎人人有),写 .skipped → 运行时 resolveBundledGit 返回 null。
 *  - 下载失败降级为不打包(运行时回落系统 git);强制内置设 TANGU_REQUIRE_GIT=1;逃生阀 TANGU_SKIP_FETCH_GIT=1。
 *    **下载成功但冒烟失败 = 硬报错**:坏的内置 git 会被放到 PATH 上(mac 还是前置),比没有更糟。
 *  - 许可:git 是 GPLv2。MinGit 自带 LICENSE.txt;mac 另取对应 tag 的 COPYING;两边都写 SOURCE.txt 指向源码。
 */
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { ghJson } = require('./fetch-python.cjs');

const gitDir = () => path.join(__dirname, 'git');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** (platform, arch) → 发行仓 + 资产名匹配;linux 不捆 → null。 */
function sourceFor(platformName, archName) {
  if (platformName === 'win32') {
    const a = { x64: '64-bit', arm64: 'arm64' }[archName];
    if (a) return { repo: 'git-for-windows/git', asset: new RegExp(`^MinGit-[\\d.]+-${a}\\.zip$`) };
  }
  if (platformName === 'darwin') {
    const a = { x64: 'x64', arm64: 'arm64' }[archName];
    if (a) return { repo: 'desktop/dugite-native', asset: new RegExp(`-macOS-${a}\\.tar\\.gz$`) };
  }
  if (platformName === 'linux') return null;
  throw new Error(`[fetch-git] 不支持的目标: ${platformName}:${archName}`);
}

/** 打包后的 git 入口(PATH 上要挂的是它所在目录)。 */
const gitBin = (root, platformName = process.platform) =>
  platformName === 'win32' ? path.join(root, 'cmd', 'git.exe') : path.join(root, 'bin', 'git');

async function download(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'tangu-build' } });
      if (!r.ok) throw new Error(`下载 HTTP ${r.status} @ ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { if (i >= 3) throw e; await sleep(1500 * (i + 1)); }
  }
}

/** mac 的包装脚本:`$0` 经 PATH 查到时就是绝对路径;pwd -P 解软链,装在带空格的路径下也成立;
 *  CDPATH 置空:相对路径调用(`./git`)时 cd 否则会把目录打印到 stdout,混进 d。 */
const WRAPPER = `#!/bin/sh
# Forsion bundled git (dugite-native). Exec path is set here only, never in the engine env:
# a user's own git inheriting GIT_EXEC_PATH would load this version's git-core.
d="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
GIT_EXEC_PATH="$d/libexec/git-core"
GIT_TEMPLATE_DIR="\${GIT_TEMPLATE_DIR:-$d/share/git-core/templates}"
export GIT_EXEC_PATH GIT_TEMPLATE_DIR
exec "$d/libexec/git-core/git" "$@"
`;

/** dugite 的 libexec/git-core 里混着整套 GCM(.NET dll/dylib/本地化目录/createdump):只留 git 自己的东西。 */
function slimDarwin(dest) {
  const core = path.join(dest, 'libexec', 'git-core');
  for (const name of readdirSync(core)) {
    const keep = (name.startsWith('git') || name === 'mergetools') && name !== 'git-lfs' && !name.startsWith('git-credential-manager');
    if (!keep) rmSync(path.join(core, name), { recursive: true, force: true });
  }
  // bin/git 是 libexec/git-core/git 的一份整拷贝(3MB),换成包装;etc/gitconfig 只在设 GIT_CONFIG_SYSTEM 时生效,不用。
  for (const rel of [path.join('bin', 'scalar'), path.join('bin', 'git'), 'etc']) rmSync(path.join(dest, rel), { recursive: true, force: true });
  writeFileSync(path.join(dest, 'bin', 'git'), WRAPPER);
  chmodSync(path.join(dest, 'bin', 'git'), 0o755);
}

/** 干净环境:剥掉构建机 / 用户的 GIT_*(GIT_DIR 泄进来会把命令指到别的仓),HOME 指临时目录免读个人配置。 */
function cleanEnv(home) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return { ...env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * 对一份内置 git 真跑一遍:版本、init(模板找得到)、add + commit、以及 https 远程助手在位
 * (连一个必然拒绝的本地端口:助手缺失报 `remote-https is not a git command`,在位才会报 unable to access)。
 * fetch 后与 afterPack(对打包产物)各跑一次 —— 拷贝过滤器丢文件只有对产物跑才抓得到。
 */
function smokeGit(root, platformName = process.platform) {
  const bin = gitBin(path.resolve(root), platformName); // 命令在临时目录里跑,相对路径会落空
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'forsion-git-gate-'));
  const env = cleanEnv(tmp);
  const git = (args, cwd = tmp) => {
    const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (r.error) throw new Error(`[git-gate] 起不来 ${bin}: ${r.error.message}`);
    return r;
  };
  const must = (args, cwd) => {
    const r = git(args, cwd);
    if (r.status !== 0) throw new Error(`[git-gate] git ${args.join(' ')} → ${r.status}: ${(r.stderr || r.stdout).trim()}`);
    return r;
  };
  try {
    const version = must(['--version']).stdout.trim();
    const init = must(['init', '-q', 'repo']);
    if (/templates not found/i.test(init.stderr)) throw new Error(`[git-gate] 模板目录没接上: ${init.stderr.trim()}`);
    const repo = path.join(tmp, 'repo');
    writeFileSync(path.join(repo, 'gate.txt'), 'Forsion git gate\n');
    must(['add', 'gate.txt'], repo);
    must(['-c', 'user.name=gate', '-c', 'user.email=gate@forsion.invalid', 'commit', '-q', '-m', 'gate'], repo);
    if (!must(['log', '--oneline'], repo).stdout.includes('gate')) throw new Error('[git-gate] commit 后 log 里没有它');
    const remote = git(['ls-remote', 'https://127.0.0.1:9/gate.git']);
    if (!/unable to access/i.test(remote.stderr)) throw new Error(`[git-gate] https 远程助手不在位: ${remote.stderr.trim()}`);
    console.log(`[git-gate] ${version} ✓ (init/commit/https helper)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function degrade(dest, reason, warn = true) {
  if (warn) console.warn(`[fetch-git] ⚠ 未打包内置 git(运行时回落系统 git):${reason}`);
  else console.log(`[fetch-git] 不打包内置 git:${reason}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true }); // extraResources 的源目录占位
  writeFileSync(path.join(dest, '.skipped'), `git bundle skipped: ${reason}\n`);
  return dest;
}

async function fetchGit({ platformName, archName }) {
  const dest = gitDir();
  const src = sourceFor(platformName, archName);
  if (!src) return degrade(dest, `${platformName} 用系统 git`, false);
  if (process.env.TANGU_SKIP_FETCH_GIT) return degrade(dest, 'TANGU_SKIP_FETCH_GIT');
  try {
    const rel = await ghJson(`https://api.github.com/repos/${src.repo}/releases/latest`);
    const asset = (rel.assets || []).find((a) => src.asset.test(a.name));
    if (!asset) throw new Error(`${src.repo}@${rel.tag_name} 没有匹配 ${src.asset} 的资产`);
    console.log(`[fetch-git] ${asset.name}`);
    const buf = await download(asset.browser_download_url);
    const tmp = path.join(__dirname, asset.name);
    writeFileSync(tmp, buf);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    // 两种包都没有顶层目录,直接解进 dest;tar 同时认 gzip 与 zip(Windows runner 的 bsdtar)。
    execFileSync('tar', ['-xf', tmp, '-C', dest], { stdio: 'inherit' });
    rmSync(tmp, { force: true });
    if (platformName === 'darwin') {
      slimDarwin(dest);
      // dugite 的 tag 形如 v2.53.0-4 → git 上游 v2.53.0 的 COPYING。
      const ver = /^v(\d+\.\d+\.\d+)/.exec(rel.tag_name)?.[1];
      if (!ver) throw new Error(`认不出 dugite 的 git 版本: ${rel.tag_name}`);
      writeFileSync(path.join(dest, 'COPYING'), await download(`https://raw.githubusercontent.com/git/git/v${ver}/COPYING`));
      writeFileSync(path.join(dest, 'SOURCE.txt'), `Git ${ver} (GPLv2, see COPYING).\nSource: https://github.com/git/git/tree/v${ver}\nBuild: https://github.com/${src.repo}/releases/tag/${rel.tag_name}\n`);
    } else {
      writeFileSync(path.join(dest, 'SOURCE.txt'), `MinGit (GPLv2, see LICENSE.txt).\nSource and build: https://github.com/${src.repo}/releases/tag/${rel.tag_name}\n`);
    }
    if (!existsSync(gitBin(dest, platformName))) throw new Error(`解压后 ${dest} 无 git 可执行文件`);
    console.log(`[fetch-git] ✓ ${dest} (${rel.tag_name})`);
  } catch (e) {
    if (process.env.TANGU_REQUIRE_GIT) throw e;
    return degrade(dest, e.message || String(e));
  }
  // 冒烟在 try 外:下载到了却跑不起来 = 硬错(见文件头)。跨架构打包本机跑不了,留给 afterPack 对产物跑。
  if (platformName === process.platform && archName === process.arch) smokeGit(dest, platformName);
  return dest;
}

module.exports = { fetchGit, gitDir, smokeGit, gitBin, WRAPPER };

// CLI:node build/fetch-git.cjs [platform] [arch](缺省=本机)
if (require.main === module) {
  fetchGit({ platformName: process.argv[2] || process.platform, archName: process.argv[3] || process.arch })
    .catch((e) => { console.error(e.message || e); process.exit(1); });
}
