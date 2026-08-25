/** 产品档案驱动的 electron-builder 配置(原 package.json build 段迁出至此)。
 *  FORSION_PRODUCT 选 products/<id>.json(缺省 forsion=全家桶,值与迁出前一致,零行为变化);
 *  agentBackend=false 的单品变体不捆 tangu-server 与内置 Python(约 -265MB),
 *  beforeBuild(fetch-python)/afterPack(better-sqlite3 重建)按同一档案短路。 */
const { readFileSync } = require('fs')
const { join } = require('path')

const id = process.env.FORSION_PRODUCT || 'forsion'
const product = JSON.parse(readFileSync(join(__dirname, 'products', `${id}.json`), 'utf8'))
if (product.id !== id) throw new Error(`products/${id}.json 的 id 与文件名不一致`)

// 设备互联的「设备页」web 构建(unitWeb 静态壳):agent 变体必捆。缺产物直接失败而不是静默跳过 ——
// 装机版出「本机未捆构建」提示页是死路(用户没有仓库脚本可跑)。dist/pack 链已前置 build:unitweb;
// 其他入口(手敲 electron-builder)由这里兜底。
const { existsSync } = require('fs')
if (product.agentBackend && !existsSync(join(__dirname, 'unit-web-dist', 'index.html'))) {
  throw new Error('缺 unit-web-dist(设备页 web 构建):先跑 node scripts/build-unit-web.mjs')
}

module.exports = {
  appId: product.appId,
  productName: product.productName,
  beforeBuild: 'build/beforeBuild.cjs',
  afterPack: 'build/afterPack.cjs',
  // 更新 feed:仅全家桶(M2 给各单品建独立 release 仓后按档案配置;无 publish 则不产 latest*.yml)。
  ...(product.id === 'forsion'
    ? { publish: { provider: 'github', owner: 'Changan-Su', repo: 'Forsion' } }
    : {}),
  // ⚠️ 这里**完全不产生 beta*.yml**,而且这是对的 —— 别照着「版本号带 -beta.1 就该写 beta.yml」去改。
  // 2026-07-31 发 v2.7.4-beta.1 时读源码 + 看真实产物实证的三段机制:
  //  ① electron-builder:`detectUpdateChannel`(默认开)确实从版本号 prerelease 段算出 'beta',但
  //     `PublishManager.getResolvedPublishConfig()` **只把它写回 generic(与暴露 checkAndResolveOptions 的
  //     provider)的 options.channel**;github 那条分支直接 return,`options.channel` 始终 undefined
  //     → `computeChannelNames()` 拿到 'latest' → **无论正式版还是 beta,产物都是 latest*.yml**。
  //  ② 客户端 electron-updater 自己补上:beta 用户(allowPrerelease=true)遇到 prerelease tag 会先试
  //     `beta.yml`,404 之后有一条显式回退到 `latest.yml`(GitHubProvider.js 里的注释原文
  //     "Allow fallback to `latest.yml`")。所以 beta 包照样装得上,也照样能升到后续正式版。
  //  ③ 正式版用户看不见 beta,靠的**不是**清单文件分流,而是 allowPrerelease=false 时走
  //     `getLatestTagName()` → GitHub 的 `/releases/latest` 端点按定义排除 prerelease。
  // 于是本开关对我们是空转的(`computeChannelNames()` 第一行就对 provider==='github' 返回单通道),
  // 留着只是为了将来换 generic 更新服务器时不必重想。
  generateUpdatesFilesForAllChannels: true,
  // forsion:// deep link:mac 写进 Info.plist CFBundleURLTypes;win 由运行时 setAsDefaultProtocolClient
  // 写注册表(NSIS 装机即生效);linux AppImage 无自动 .desktop 安装,用户需自行集成(appimaged 等)——
  // electron-builder 会把 protocols 合入生成的 .desktop 的 MimeType(x-scheme-handler/forsion)。
  protocols: [{ name: 'Forsion', schemes: ['forsion'] }],
  artifactName: product.artifactPrefix + '-${version}-${arch}.${ext}',
  files: [
    'out/**/*',
    'node_modules/**/*',
    '!node_modules/.bin',
    '!node_modules/**/*.{d.ts,map,md,markdown}',
    '!node_modules/typescript/**',
    '!node_modules/vite/**',
    '!node_modules/vitest/**',
    '!node_modules/@vitest/**',
    '!node_modules/@vitejs/**',
    '!node_modules/electron/**',
    '!node_modules/electron-builder/**',
    '!node_modules/electron-vite/**',
    '!node_modules/app-builder-lib/**',
    '!node_modules/dmg-builder/**',
    '!node_modules/esbuild/**',
    '!node_modules/@esbuild/**',
    '!node_modules/rollup/**',
    '!node_modules/@rollup/**',
    '!node_modules/@types/**',
  ],
  // sherpa-onnx-node(本地语音识别)是原生插件:.node + onnxruntime 动态库不能从 asar 内加载,整体解包。
  // node-pty(内置终端)同理,且它还要 **exec** spawn-helper / winpty-agent.exe —— asar 里的文件不能执行。
  asarUnpack: [
    '**/node_modules/sherpa-onnx-node/**',
    '**/node_modules/sherpa-onnx-{darwin,linux,win}-*/**',
    '**/node_modules/node-pty/**',
  ],
  // ⚠️extraResources 只能有这一处(对象字面量重复键=后者静默覆盖前者,v2.6.8 曾因此丢 LICENSE)。
  extraResources: [
    // remotesync 层含 Apache-2.0 改编代码(remotely-save):分发包必须携带其 LICENSE/NOTICE(License 4(a)/4(d))
    { from: 'electron/remotesync/LICENSE', to: 'licenses/remotesync/LICENSE' },
    { from: 'electron/remotesync/NOTICE.md', to: 'licenses/remotesync/NOTICE.md' },
    // 托盘/菜单栏图标:运行时主进程读 resources/tray.png(build/ 不进包,故显式复制)。
    { from: 'build/icon.png', to: 'tray.png' },
    ...(product.agentBackend
      ? [
          { from: '../tangu-agent/dist', to: 'tangu-server/dist' },
          { from: '../tangu-agent/node_modules', to: 'tangu-server/node_modules' },
          { from: '../tangu-agent/package.json', to: 'tangu-server/package.json' },
          { from: '../tangu-agent/skills', to: 'tangu-server/skills' },
          { from: '../tangu-agent/agent-skills', to: 'tangu-server/agent-skills' },
          { from: 'build/python', to: 'python' },
          { from: 'build/node', to: 'node' },
          // 设备页 web 构建(unitWeb 静态壳;webDistDir 读 resourcesPath/unit-web)
          { from: 'unit-web-dist', to: 'unit-web' },
        ]
      : []),
  ],
  linux: { target: 'AppImage', icon: 'build/icon.png' },
  mac: { target: 'dmg', icon: 'build/icon.icns', identity: null, extendInfo: { NSMicrophoneUsageDescription: 'Forsion 需要访问麦克风以进行语音输入(将语音转写为文字)。' } },
  dmg: {
    window: { width: 560, height: 440 },
    contents: [
      { x: 150, y: 200 },
      { x: 410, y: 200, type: 'link', path: '/Applications' },
      { x: 280, y: 372, type: 'file', path: 'build/打不开请先读我.txt' },
    ],
  },
  win: { target: 'nsis', icon: 'build/icon.ico' },
  // 卸载时询问是否清除用户数据(~/.forsion、~/Forsion、%APPDATA%\Forsion);见 build/installer.nsh。
  nsis: { include: 'build/installer.nsh' },
}
