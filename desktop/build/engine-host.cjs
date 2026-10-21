// Package-local host identity, shared by the updater and terminal launcher through checkOverlay.
// Keep it outside the engine manifest: bundling the same engine with a newer shell does not change engine identity.
const fs = require('node:fs')
const path = require('node:path')
exports.writeEngineHost = (engineRoot, version) => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid desktop version: ${version}`)
  if (!fs.existsSync(path.join(engineRoot, 'package.json'))) throw new Error('Bundled engine package.json is missing')
  fs.writeFileSync(path.join(engineRoot, 'desktop-host.json'), JSON.stringify({ version }, null, 2) + '\n')
}
