const fs = require('node:fs')
const path = require('node:path')

// Bridge is an independent plugin repository, not part of the Desktop checkout.
module.exports = function bridgeRoot() {
  const verify = root => fs.existsSync(path.join(root, 'plugin/manifest.json')) && fs.existsSync(path.join(root, 'package.json'))
  if (process.env.OBSIDIAN_BRIDGE_ROOT) {
    const root = path.resolve(process.env.OBSIDIAN_BRIDGE_ROOT)
    if (verify(root)) return root
    throw Error('OBSIDIAN_BRIDGE_ROOT must point to the forsion-plugin-obsidian-bridge checkout')
  }
  for (let dir = path.resolve(__dirname, '../..'); ; dir = path.dirname(dir)) {
    const root = path.join(dir, 'Forsion-Instrumentality-Project/forsion-plugin-obsidian-bridge')
    if (verify(root)) return root
    if (dir === path.dirname(dir)) break
  }
  throw Error('Clone Changan-Su/forsion-plugin-obsidian-bridge under Forsion-Instrumentality-Project, or set OBSIDIAN_BRIDGE_ROOT')
}
