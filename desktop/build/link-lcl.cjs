/** lcl/(LCL 引擎层)无自有 node_modules:软链到 desktop/node_modules,让 lcl 源文件的裸 import
 *  (zustand/react/dockview…)经目录 walk-up 解析。Windows 用 junction 免管理员权限。
 *  web 容器构建无需此链(依赖装在公共祖先 /app,见 web/Dockerfile)。 */
const fs = require('fs')
const path = require('path')
const link = path.join(__dirname, '..', '..', 'lcl', 'node_modules')
const target = path.join(__dirname, '..', 'node_modules')
try {
  const st = fs.lstatSync(link)
  if (st.isSymbolicLink() || st.isDirectory()) process.exit(0) // 已存在(链或真目录)即幂等退出
} catch { /* 不存在 → 创建 */ }
try {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  console.log('[link-lcl] lcl/node_modules ->', target)
} catch (e) {
  console.warn('[link-lcl] 创建软链失败(lcl 依赖解析可能失败):', e.message)
}
