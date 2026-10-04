/** lcl/(LCL 引擎层)无自有 node_modules:软链到 desktop/node_modules,让 lcl 源文件的裸 import
 *  (zustand/react/dockview…)经目录 walk-up 解析。Windows 用 junction 免管理员权限。
 *  web 容器构建无需此链(依赖装在公共祖先 /app,见 web/Dockerfile)。 */
const fs = require('fs')
const path = require('path')

function ensureLclLink(link, target) {
  let st
  try { st = fs.lstatSync(link) } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (st) {
    if (st.isSymbolicLink()) {
      try { if (fs.statSync(link).isDirectory()) return } catch { /* broken or Windows file symlink to directory */ }
      fs.unlinkSync(link) // Remove only the link, never the directory it points to.
    } else if (st.isDirectory()) {
      return // Preserve a real dependency directory.
    } else if (st.isFile() && fs.readFileSync(link, 'utf8').trim().replace(/\\/g, '/') === '../desktop/node_modules') {
      fs.unlinkSync(link) // Git core.symlinks=false checks out the old link as a text file.
    } else {
      throw new Error(`Refusing to replace unexpected file: ${link}`)
    }
  }
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

module.exports = { ensureLclLink }
if (require.main === module) {
  const link = path.join(__dirname, '..', '..', 'lcl', 'node_modules')
  const target = path.join(__dirname, '..', 'node_modules')
  try {
    ensureLclLink(link, target)
    console.log('[link-lcl] lcl/node_modules ->', target)
  } catch (e) {
    console.error('[link-lcl] 创建软链失败(lcl 依赖解析可能失败):', e.message)
    process.exitCode = 1
  }
}
