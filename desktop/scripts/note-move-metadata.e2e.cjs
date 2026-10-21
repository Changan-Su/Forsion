/** Real main-process config rename failure after physical relocation. */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const result = spawnSync(process.execPath, [path.join(__dirname, 'note-move-assets.e2e.cjs')], {
  env: { ...process.env, NOTEMOVE_CONFIG_RENAME_FAULT: '1', NOTEMOVE_FILLER: process.env.NOTEMOVE_FILLER ?? '100' },
  stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
