const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const root = path.resolve(__dirname, '../..');
const workflow = name => YAML.parse(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
test('engine candidate tests and sync checks precede access to signing key', () => {
  const steps = workflow('publish-engine.yml').jobs.publish.steps;
  const sign = steps.findIndex(s => s.env?.TANGU_ENGINE_SIGNING_KEY);
  const before = steps.slice(0, sign).map(s => s.run || '').join('\n');
  assert.ok(sign > 0);
  assert.match(before, /npm ci/); assert.match(before, /npm run typecheck/); assert.match(before, /npm test/);
  assert.match(before, /git rev-parse HEAD/); assert.match(before, /GITHUB_SHA/);
  assert.ok(steps.some(s => /engine-overlay.e2e/.test(s.run || '')));
});
test('required PR check is stable and cannot be skipped by a documentation path filter', () => {
  const workflowData = workflow('critical-contracts.yml');
  assert.equal(workflowData.on.pull_request.paths, undefined);
  assert.equal(workflowData.on.pull_request['paths-ignore'], undefined);
  assert.equal(workflowData.jobs['critical-contracts'].name, 'critical-contracts');
  assert.equal(workflowData.jobs['critical-contracts'].if, undefined);
});
test('release input policy freezes installs and limits write permissions to publishing', () => {
  const desktop = workflow('build-desktop.yml');
  assert.equal(desktop.permissions.contents, 'read');
  assert.equal(desktop.jobs.release.permissions.contents, 'write');
  assert.equal(desktop.jobs.build.env.FORSION_RELEASE_BUILD, '1');
  for (const name of ['build-desktop.yml','publish-engine.yml']) {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps || []) {
        assert.doesNotMatch(step.run || '', /npm install --no-audit/);
        if (step.uses?.startsWith('actions/')) assert.match(step.uses, /@[a-f0-9]{40}$/);
      }
    }
  }
});
