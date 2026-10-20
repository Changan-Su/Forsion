/** One session with repeated actual moves; fail immediately without retrying. */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const result = spawnSync(process.execPath, [path.join(__dirname, 'note-move-assets.e2e.cjs')], {
  env: { ...process.env, NOTEMOVE_ROUNDTRIPS: process.env.NOTEMOVE_ROUNDTRIPS || '5' },
  stdio: 'inherit', windowsHide: true,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
