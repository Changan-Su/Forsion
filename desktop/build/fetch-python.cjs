/**
 * 下载 python-build-standalone(可重定位的独立 CPython)到 desktop/build/python,
 * 供 electron-builder extraResources 打进安装包 → 用户免装 Python、且与系统 Python 隔离。
 *
 *  - 由 build/beforeBuild.cjs 在打包前按目标 (platform, arch) 调用;也可 `node build/fetch-python.cjs` 手动跑。
 *  - 版本不写死:查 astral-sh/python-build-standalone 最新 release,挑匹配三元组的 `install_only` 资产。
 *  - 解压用系统 tar(三平台 runner 均自带,含 Windows 的 bsdtar);tar 自动识别 gzip。
 *  - 解释器下载失败 → 降级为不打包(运行时回落系统 Python),强制内置设 TANGU_REQUIRE_PYTHON=1。
 *    逃生阀 TANGU_SKIP_FETCH_PYTHON=1(仅打包非 Python 形态时);跳过时建空目录避免 extraResources 缺 from 报错。
 *  - 解释器到手后按 python-requirements.txt 预装办公/数据库(对标 DSH 桌面端开箱即用)。
 *    **装库失败硬报错、不降级**:提示词和内置技能按「库都在」写,有解释器没库的包比没 Python 更坑。
 */
const { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
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
  } catch (e) {
    if (process.env.TANGU_REQUIRE_PYTHON) throw e;
    return degrade(dest, e.message || String(e));
  }
  installPackages(dest); // 在 try 外:装库失败必须让构建挂掉,而不是把解释器也一起降级掉
  return dest;
}

/** 解释器路径:Windows 包是平铺的 python.exe,其余在 bin/python3。 */
const pythonBin = (dir) =>
  existsSync(path.join(dir, 'python.exe')) ? path.join(dir, 'python.exe') : path.join(dir, 'bin', 'python3');

/** 只放行网络类 pip 变量(大陆构建要走 PIP_INDEX_URL 镜像)。 */
const PIP_NET = /^PIP_(INDEX_URL|EXTRA_INDEX_URL|TRUSTED_HOST|CERT|CLIENT_CERT|PROXY|TIMEOUT|RETRIES)$/i;

/** 构建机的 Python/pip 环境不许漏进来:PIP_TARGET/PIP_PREFIX/配置文件里的 target 会把库装到别处,
 *  用户 site / PYTHONPATH 会让 pip 以为「已装」跳过、让 smoke 假绿。所以 PYTHON 与 PIP_ 开头的变量全部丢掉(网络类除外),
 *  pip 配置文件整体屏蔽(用 pip.conf 配镜像的构建机改设 PIP_INDEX_URL)。 */
function pyEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(PYTHON|PIP_)/i.test(k) || PIP_NET.test(k)) env[k] = v;
  return { ...env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PIP_CONFIG_FILE: require('node:os').devNull };
}

/** 预装库的真实 import + 一次真渲染 —— 只查 dist-info 抓不到原生扩展被拷贝过滤器丢掉;
 *  pdfium(pdfplumber 渲染页面图)、cryptography(加密 PDF)、Agg/ft2font(画图)都是用到才加载,得显式碰一下。 */
const SMOKE = [
  'import io, docx, pptx, openpyxl, xlsxwriter, pypdf, pdfplumber, pypdfium2, reportlab.pdfgen.canvas, pandas, numpy',
  'import PIL.Image, lxml.etree, markdown, bs4, tabulate, cryptography.hazmat.primitives.ciphers',
  "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt",
  "plt.plot([1, 2]); plt.savefig(io.BytesIO(), format='png')",
].join('\n');

/** 在 dir 下的内置 Python 里跑 import smoke;失败即抛。afterPack 对打包产物再跑一次。
 *  -I:不把 cwd 放进 sys.path(afterPack 的 cwd 是 desktop/,哪天多个同名目录就假绿)、不看用户 site/PYTHON* 环境;
 *  -B:不写字节码(-I 连 PYTHONDONTWRITEBYTECODE 也忽略,afterPack 在签名前跑,写进去会被封进包)。 */
function smokePython(dir) {
  execFileSync(pythonBin(dir), ['-I', '-B', '-c', SMOKE], { stdio: 'inherit', env: pyEnv() });
}

/** 按 python-requirements.txt 装进内置解释器自己的 site-packages。
 *  用目标解释器本身跑 pip:CI 每行都是本机架构;本地跨架构打包要求本机能执行目标解释器(mac 靠 Rosetta)。 */
function installPackages(dest) {
  const py = pythonBin(dest);
  const scripts = path.join(dest, existsSync(path.join(dest, 'python.exe')) ? 'Scripts' : 'bin');
  const before = new Set(existsSync(scripts) ? readdirSync(scripts) : []);
  const req = path.join(buildDir(), 'python-requirements.txt');
  const lock = path.join(buildDir(), 'python-constraints.txt'); // 传递依赖也锁死:PyPI 上新版本不会悄悄进包
  console.log(`[fetch-python] pip install -r ${path.basename(req)} -c ${path.basename(lock)}`);
  // --no-compile:electron-builder 的拷贝过滤器无条件丢 .pyc/__pycache__,编了也白编;
  // 运行时字节码由 backendManager 的 PYTHONPYCACHEPREFIX 引到包外。
  execFileSync(py, ['-m', 'pip', 'install', '--only-binary=:all:', '--no-compile', '--no-cache-dir',
    '--disable-pip-version-check', '--no-warn-script-location', '-r', req, '-c', lock], { stdio: 'inherit', env: pyEnv() });
  // pip 生成的命令行脚本 shebang 写死了构建机路径,而这个目录在引擎 PATH 最前(composeEnginePath),
  // 留着会遮住用户自己装的同名命令(fonttools/f2py…)。删掉新增的;要用走 `python -m`。
  for (const f of existsSync(scripts) ? readdirSync(scripts) : []) {
    if (!before.has(f)) rmSync(path.join(scripts, f), { recursive: true, force: true });
  }
  // tests 目录是纯死重(实测 ~110MB,pandas 一家过半)。
  execFileSync(py, ['-c', "import pathlib, shutil, sysconfig\n"
    + "root = pathlib.Path(sysconfig.get_paths()['purelib'])\n"
    + "for p in [p for p in root.rglob('tests') if p.is_dir()]: shutil.rmtree(p, ignore_errors=True)"],
  { stdio: 'inherit', env: pyEnv() });
  smokePython(dest);
  console.log('[fetch-python] ✓ 预装库');
}

module.exports = { fetchPython, pythonDir, smokePython };

// CLI:node build/fetch-python.cjs [platform] [arch](缺省=本机)
if (require.main === module) {
  fetchPython({ platformName: process.argv[2] || process.platform, archName: process.argv[3] || process.arch })
    .catch((e) => { console.error(e.message || e); process.exit(1); });
}
