/** Real Electron destination read and write-ack races, with deterministic gates.
 * A release is never retried to turn a red result green. Every phase must pass.
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
for (const phase of ['read', 'write']) {
  console.log(`\nHANDOVER PHASE ${phase}`)
  const result = spawnSync(process.execPath, [path.join(__dirname, 'note-move-assets.e2e.cjs')], {
    env: { ...process.env, NOTEMOVE_HANDOVER_PHASE: phase, NOTEMOVE_FILLER: process.env.NOTEMOVE_FILLER ?? '100' },
    stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
