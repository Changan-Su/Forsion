/**
 * electron-builder beforeBuild 钩子:打包前按目标 (platform, arch) 拉取内置 Python 到 build/python。
 * beforeBuild 早于 pack(extraResources 拷贝)执行,故此处下好后 extraResources 的 build/python 才有内容。
 * CI 每个 matrix 行只构建单一 arch(--mac --arm64 / --win / --linux),context.arch 即目标 arch。
 *
 * ⚠️ 必须 `return true`:electron-builder 语义是「beforeBuild 返回 falsy = node_modules 由外部处理」
 * (packager.js: _nodeModulesHandledExternally = !返回值),undefined 会让 asar 里一个 node_modules
 * 都不打 → 安装版启动即 ERR_MODULE_NOT_FOUND(v2.3.3~v2.6.0 三平台全部中招)。
 */
const { fetchPython } = require('./fetch-python.cjs');
const { fetchNode } = require('./fetch-node.cjs');

exports.default = async function beforeBuild(context) {
  const productId = process.env.FORSION_PRODUCT || 'forsion';
  const product = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'products', `${productId}.json`), 'utf8'));
  if (!product.agentBackend) return true; // 本变体不捆后端 → 不拉内置运行时;true=保留默认依赖处理
  const platformName = context.platform.nodeName; // 'darwin' | 'win32' | 'linux'
  const archName = context.arch;                   // 'x64' | 'arm64' | 'armv7l'
  await fetchPython({ platformName, archName });
  await fetchNode({ platformName, archName });
  return true; // 保留 electron-builder 默认依赖安装/打包(见文件头警告)
};
