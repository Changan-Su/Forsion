const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const suites = {
  'tangu-agent': [
    'src/tools/customHttp.security.test.ts', 'test/publicHttp.security.test.ts',
    'test/webFetch.test.ts', 'src/standalone/diagnostics.test.ts',
    'src/mcp/redirects.test.ts', 'src/mcp/manager.test.ts',
    'src/tools/registryCancellation.test.ts', 'src/tools/registrySandbox.test.ts',
    'src/tools/registryArgs.test.ts', 'test/taskOutcomes.test.ts',
  ],
  desktop: [
    'electron/remotesync/uploadConsistency.test.ts', 'frontend/src/services/cloudHttpBody.test.ts',
    'frontend/src/services/cloudBridgeCas.test.ts',
    'electron/amadeus/fs/vaultIntegrity.test.ts', 'electron/amadeus/fs/trashLock.test.ts', 'electron/amadeus/fs/textWriteCas.test.ts',
    'electron/amadeus/fs/renameAtomic.test.ts', 'electron/amadeus/fs/watcher.ledger.test.ts',
    'electron/amadeus/ipc.unitEvents.test.ts',
    'frontend/src/amadeus/store/fileIdentity.test.ts', 'frontend/src/amadeus/store/drawingCas.test.ts',
    'frontend/src/amadeus/store/drawingStore.test.ts', 'frontend/src/amadeus/store/dbStore.test.ts', 'frontend/src/amadeus/store/dbStore.readFailure.test.ts',
    'frontend/src/amadeus/store/pageStore.vaultswitch.test.ts',
    'frontend/src/amadeus/store/pageStore.filespending.test.ts',
    'frontend/src/services/workbookParser.test.ts', 'frontend/src/services/workbookBudget.review.test.ts', 'frontend/src/services/workbookPreview.test.ts',
  ],
};
function run(project, args) {
  const result = spawnSync(process.execPath, args, { cwd: path.join(root, project), stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
for (const [project, files] of Object.entries(suites)) {
  for (const file of files) if (!fs.existsSync(path.join(root, project, file))) throw new Error(`Missing required contract: ${project}/${file}`);
  if (process.argv.includes('--list')) console.log(project, files);
  else run(project, ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2', ...files]);
}
if (!process.argv.includes('--list')) {
  run('desktop', ['--test', 'build/runtime-policy.test.cjs', 'scripts/dependency-security.test.cjs', 'scripts/release-security.test.cjs']);
}
