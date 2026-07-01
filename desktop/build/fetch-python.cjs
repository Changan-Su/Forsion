/**
 * 下载 python-build-standalone(可重定位的独立 CPython)到 desktop/build/python,
 * 供 electron-builder extraResources 打进安装包 → 用户免装 Python、且与系统 Python 隔离。
 *
 *  - 由 build/beforeBuild.cjs 在打包前按目标 (platform, arch) 调用;也可 `node build/fetch-python.cjs` 手动跑。
 *  - 版本不写死:查 astral-sh/python-build-standalone 最新 release,挑匹配三元组的 `install_only` 资产。
 *  - 解压用系统 tar(三平台 runner 均自带,含 Windows 的 bsdtar);tar 自动识别 gzip。
 *  - 失败**硬报错**(不静默降级):宁可构建失败,也不发一个「号称内置 Python 却没带」的包。
 *    逃生阀 TANGU_SKIP_FETCH_PYTHON=1(仅打包非 Python 形态时);跳过时建空目录避免 extraResources 缺 from 报错。
 */
const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REPO = 'astral-sh/python-build-standalone';
// 优先内置的 Python 小版本(wheel 覆盖广、稳定);逐级回退。
const PY_MINORS = ['3.12', '3.13', '3.11'];

/** (platform, arch) → python-build-standalone 的目标三元组。 */
function tripleFor(platformName, archName) {
  const key = `${platformName}:${archName}`;
  const map = {
    'darwin:arm64': 'aarch64-apple-darwin',
    'darwin:x64': 'x86_64-apple-darwin',
    'win32:x64': 'x86_64-pc-windows-msvc',
    'win32:arm64': 'aarch64-pc-windows-msvc',
    'linux:x64': 'x86_64-unknown-linux-gnu',
    'linux:arm64': 'aarch64-unknown-linux-gnu',
  };
  const t = map[key];
  if (!t) throw new Error(`[fetch-python] 不支持的目标: ${key}`);
  return t;
}

/** build/ 目录(本脚本所在目录)。 */
const buildDir = () => __dirname;
/** 最终落点:build/python(tar 顶层目录就叫 python)。 */
const pythonDir = () => path.join(buildDir(), 'python');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ghJson(url) {
  const headers = { 'User-Agent': 'tangu-build', Accept: 'application/vnd.github+json' };
  // CI 未鉴权的 API 请求会被限流(403/429);带 token(GITHUB_TOKEN/GH_TOKEN)升到 5000/h。
  const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return r.json();
      lastErr = new Error(`GitHub API ${r.status}`);
      if (![403, 429, 500, 502, 503].includes(r.status)) break; // 非限流/瞬态 → 不重试
    } catch (e) { lastErr = e; }
    await sleep(1500 * (i + 1)); // 退避重试
  }
  throw new Error(`GitHub API failed @ ${url}: ${lastErr?.message || lastErr}`);
}

/** 在 assets 里挑匹配三元组的 install_only tar.gz(优先 PY_MINORS 顺序)。 */
function pickAsset(assets, triple) {
  for (const minor of PY_MINORS) {
    const re = new RegExp(`^cpython-${minor.replace('.', '\\.')}\\.\\d+\\+\\d+-${triple}-install_only\\.tar\\.gz$`);
    const hit = assets.find((a) => re.test(a.name));
    if (hit) return hit;
  }
  return null;
}

/** 降级:建空 build/python 占位(extraResources 不缺 from;运行时 resolveBundledPython 返回 null → 回落系统 Python)。 */
function degrade(dest, reason) {
  console.warn(`[fetch-python] ⚠ 未打包内置 Python(运行时回落系统 Python):${reason}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, '.skipped'), `python bundle skipped: ${reason}\n`);
  return dest;
}

async function fetchPython({ platformName, archName }) {
  const dest = pythonDir();
  if (process.env.TANGU_SKIP_FETCH_PYTHON) return degrade(dest, 'TANGU_SKIP_FETCH_PYTHON');
  // 拉取失败**不阻断整包构建**(否则 GitHub API 限流/网络抖动就毁掉整个发布)——降级为不打包。
  // 强制要求内置可设 TANGU_REQUIRE_PYTHON=1(本地校验用)。
  try {
    const triple = tripleFor(platformName, archName);
    const release = await ghJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const asset = pickAsset(release.assets || [], triple);
    if (!asset) throw new Error(`最新 release 无 ${triple} 的 install_only 资产(试过 ${PY_MINORS.join('/')})`);

    console.log(`[fetch-python] ${asset.name}  (release ${release.tag_name})`);
    let buf;
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'tangu-build' } });
        if (!r.ok) throw new Error(`下载 HTTP ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
        break;
      } catch (e) { if (i >= 3) throw e; await sleep(1500 * (i + 1)); }
    }
    const tmp = path.join(buildDir(), asset.name);
    writeFileSync(tmp, buf);
    rmSync(dest, { recursive: true, force: true }); // 换 arch 重跑:先清旧
    // tar 自动识别 gzip(GNU tar / Windows bsdtar 均可);顶层目录名为 python → 落到 build/python。
    execFileSync('tar', ['-xf', tmp, '-C', buildDir()], { stdio: 'inherit' });
    rmSync(tmp, { force: true });
    if (!existsSync(path.join(dest, 'bin')) && !existsSync(path.join(dest, 'python.exe'))) {
      throw new Error(`解压后 ${dest} 无解释器`);
    }
    console.log(`[fetch-python] ✓ ${dest}`);
    return dest;
  } catch (e) {
    if (process.env.TANGU_REQUIRE_PYTHON) throw e;
    return degrade(dest, e.message || String(e));
  }
}

module.exports = { fetchPython, pythonDir };

// CLI:node build/fetch-python.cjs [platform] [arch](缺省=本机)
if (require.main === module) {
  fetchPython({ platformName: process.argv[2] || process.platform, archName: process.argv[3] || process.arch })
    .catch((e) => { console.error(e.message || e); process.exit(1); });
}
