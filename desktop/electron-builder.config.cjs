/** 产品档案驱动的 electron-builder 配置(原 package.json build 段迁出至此)。
 *  FORSION_PRODUCT 选 products/<id>.json(缺省 forsion=全家桶,值与迁出前一致,零行为变化);
 *  agentBackend=false 的单品变体不捆 tangu-server 与内置 Python(约 -265MB),
 *  beforeBuild(fetch-python)/afterPack(better-sqlite3 重建)按同一档案短路。 */
const { readFileSync } = require('fs')
const { join } = require('path')

const id = process.env.FORSION_PRODUCT || 'forsion'
const product = JSON.parse(readFileSync(join(__dirname, 'products', `${id}.json`), 'utf8'))
if (product.id !== id) throw new Error(`products/${id}.json 的 id 与文件名不一致`)

module.exports = {
  appId: product.appId,
  productName: product.productName,
  beforeBuild: 'build/beforeBuild.cjs',
  afterPack: 'build/afterPack.cjs',
  // 更新 feed:仅全家桶(M2 给各单品建独立 release 仓后按档案配置;无 publish 则不产 latest*.yml)。
  ...(product.id === 'forsion'
    ? { publish: { provider: 'github', owner: 'Changan-Su', repo: 'Forsion' } }
    : {}),
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
  asarUnpack: [
    '**/node_modules/sherpa-onnx-node/**',
    '**/node_modules/sherpa-onnx-{darwin,linux,win}-*/**',
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
