/**
 * 下载 Node.js 官方独立构建到 desktop/build/node,供 electron-builder extraResources 打进安装包
 * → 用户免装 Node/npm。与 fetch-python.cjs 同构(同一套下载/解压/降级纪律)。
 *
 *  - 由 build/beforeBuild.cjs 在打包前按目标 (platform, arch) 调用;也可 `node build/fetch-node.cjs` 手动跑。
 *  - 版本不写死:查 nodejs.org 的 index.json 取最新 LTS。
 *  - 解压:非 Windows 用系统 tar(.tar.gz),Windows 用 .zip(bsdtar 也能解 zip,三平台 runner 自带)。
 *  - **拉取失败不阻断整包构建**(照 Python 的降级纪律:GitHub/nodejs.org 抖动不该毁掉整个发布),
 *    降级为不打包 → 运行时 resolveBundledNode 返回 null → 回落系统 Node。强制内置设 TANGU_REQUIRE_NODE=1。
 *  - 逃生阀 TANGU_SKIP_FETCH_NODE=1。
 */
const { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** 国内镜像(与 desktop 的 mirror 开关无关:这是构建机下载,按 env 切)。 */
const BASE = process.env.NODE_MIRROR || 'https://nodejs.org/dist';

/** (platform, arch) → Node 官方发行包的名字片段与后缀。 */
function targetFor(platformName, archName) {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'win' }[platformName];
  const arch = { x64: 'x64', arm64: 'arm64', armv7l: 'armv7l' }[archName];
  if (!os || !arch) throw new Error(`[fetch-node] 不支持的目标: ${platformName}:${archName}`);
  return { slug: `${os}-${arch}`, ext: os === 'win' ? 'zip' : 'tar.gz' };
}

const buildDir = () => __dirname;
/** 最终落点:build/node(内含 bin/node、bin/npm…;Windows 是 node.exe + npm.cmd 平铺)。 */
const nodeDir = () => path.join(buildDir(), 'node');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'tangu-build' } });
      if (r.ok) return r.json();
      lastErr = new Error(`HTTP ${r.status}`);
      if (![403, 429, 500, 502, 503].includes(r.status)) break; // 非瞬态 → 不重试
    } catch (e) { lastErr = e; }
    await sleep(1500 * (i + 1));
  }
  throw new Error(`索引拉取失败 @ ${url}: ${lastErr?.message || lastErr}`);
}

/** index.json 里最新的 LTS 版本号(形如 v22.14.0);lts 字段是 codename 或 false。 */
async function latestLts() {
  const list = await fetchJson(`${BASE}/index.json`);
  const hit = list.find((v) => v.lts);
  if (!hit) throw new Error('index.json 里没有 LTS 版本');
  return hit.version;
}

/**
 * 瘦身:官方包解压 ~196MB,其中 include/(62MB C++ addon 头文件)+ 文档/man 是纯粹的死重。
 * node-gyp 编译原生模块时是自己去 nodejs.org 下头文件的(除非显式 --nodedir),删掉不影响它。
 * ponytail: 只删这几处确定无用的;真要再瘦得动 bin/node 本身(小 ICU 构建),官方不发那种包。
 */
function prune(dest) {
  const dead = ['include', 'share', 'CHANGELOG.md', 'README.md',
    path.join('lib', 'node_modules', 'npm', 'docs'), path.join('lib', 'node_modules', 'npm', 'man')];
  for (const rel of dead) rmSync(path.join(dest, rel), { recursive: true, force: true });
}

function degrade(dest, reason) {
  console.warn(`[fetch-node] ⚠ 未打包内置 Node(运行时回落系统 Node):${reason}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, '.skipped'), `node bundle skipped: ${reason}\n`);
  return dest;
}

async function fetchNode({ platformName, archName }) {
  const dest = nodeDir();
  if (process.env.TANGU_SKIP_FETCH_NODE) return degrade(dest, 'TANGU_SKIP_FETCH_NODE');
  try {
    const { slug, ext } = targetFor(platformName, archName);
    const version = await latestLts();
    const name = `node-${version}-${slug}`;
    const url = `${BASE}/${version}/${name}.${ext}`;

    console.log(`[fetch-node] ${name}.${ext}`);
    let buf;
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'tangu-build' } });
        if (!r.ok) throw new Error(`下载 HTTP ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
        break;
      } catch (e) { if (i >= 3) throw e; await sleep(1500 * (i + 1)); }
    }
    const tmp = path.join(buildDir(), `${name}.${ext}`);
    writeFileSync(tmp, buf);
    rmSync(dest, { recursive: true, force: true }); // 换 arch 重跑:先清旧
    // tar 自动识别 gzip 与 zip(Windows runner 的 bsdtar 同样能解 zip)。顶层目录是 node-<ver>-<slug>。
    execFileSync('tar', ['-xf', tmp, '-C', buildDir()], { stdio: 'inherit' });
    rmSync(tmp, { force: true });
    const extracted = path.join(buildDir(), name);
    if (!existsSync(extracted)) {
      // 顶层名与预期不符(镜像重打包过)→ 找唯一的 node-* 目录兜底。
      const cand = readdirSync(buildDir()).filter((d) => d.startsWith('node-') && d !== 'node');
      if (cand.length !== 1) throw new Error(`解压后找不到唯一顶层目录(候选 ${cand.length} 个)`);
      renameSync(path.join(buildDir(), cand[0]), dest);
    } else {
      renameSync(extracted, dest);
    }
    const bin = platformName === 'win32' ? path.join(dest, 'node.exe') : path.join(dest, 'bin', 'node');
    if (!existsSync(bin)) throw new Error(`解压后 ${dest} 无 node 可执行文件`);
    prune(dest);
    console.log(`[fetch-node] ✓ ${dest} (${version})`);
    return dest;
  } catch (e) {
    if (process.env.TANGU_REQUIRE_NODE) throw e;
    return degrade(dest, e.message || String(e));
  }
}

module.exports = { fetchNode, nodeDir };

// CLI:node build/fetch-node.cjs [platform] [arch](缺省=本机)
if (require.main === module) {
  fetchNode({ platformName: process.argv[2] || process.platform, archName: process.argv[3] || process.arch })
    .catch((e) => { console.error(e.message || e); process.exit(1); });
}
