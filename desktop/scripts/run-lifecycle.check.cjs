/** Offline regression gate: real agent loop + SQLite, renderer store and HTTP failures.
 * Synthetic attachments only; no credentials, provider calls, or user sessions are needed.
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const desktop = path.resolve(__dirname, '..')
const engine = path.resolve(desktop, '../tangu-agent')
for (const [cwd, tests] of [
  [engine, ['test/contextImageBudget.test.ts', 'test/contextBudget.test.ts', 'src/services/contextBudget.test.ts', 'test/agentLoopRuntimeSafety.test.ts', 'src/services/compactionRuntime.test.ts', 'src/services/historyReplay.test.ts', 'src/tools/builtin/loadTools.test.ts', 'src/tools/shellPrompt.test.ts']],
  [desktop, ['frontend/src/stores/appStore.stop.test.ts', 'frontend/src/stores/appStore.test.ts',
    'frontend/src/services/agentRunService.stop.test.ts', 'frontend/src/services/agentRunService.client.test.ts',
    'frontend/src/i18nCoverage.test.ts']],
]) {
  const result = spawnSync(process.execPath, [path.join(cwd, 'node_modules/vitest/vitest.mjs'), 'run', ...tests], { cwd, stdio: 'inherit' })
  if (result.error) { console.error(result.error); process.exit(1) }
  if (result.status !== 0) process.exit(result.status || 1)
}
