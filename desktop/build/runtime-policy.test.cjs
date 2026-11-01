const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createHash } = require('node:crypto');
const policy = require('./runtime-policy.cjs');

test('release and explicit require reject skip even when development degradation is enabled', () => {
  for (const kind of ['node', 'python', 'git']) {
    for (const env of [{}, { FORSION_RELEASE_BUILD: '1', FORSION_ALLOW_INCOMPLETE_DEV_BUILD: '1' },
      { [`TANGU_REQUIRE_${kind.toUpperCase()}`]: '1', FORSION_ALLOW_INCOMPLETE_DEV_BUILD: '1' }]) {
      assert.throws(() => policy.assertSkipAllowed(kind, 'win32', env), /cannot be skipped/);
    }
    assert.doesNotThrow(() => policy.assertSkipAllowed(kind, 'win32', { FORSION_ALLOW_INCOMPLETE_DEV_BUILD: '1' }));
  }
  assert.doesNotThrow(() => policy.assertSkipAllowed('git', 'linux', {}));
});

for (const kind of ['node', 'python', 'git']) {
  test(`${kind}: network failure, explicit skip and altered bytes fail before extraction`, async () => {
    for (const mode of ['network', 'skip', 'corrupt']) {
      let extractions = 0, writes = 0;
      const fakeFs = { ...fs, writeFileSync() { writes++; }, rmSync() {}, mkdirSync() {} };
      const module = { exports: {} };
      const req = (name) => name === 'node:fs' ? fakeFs : name === 'node:child_process'
        ? { execFileSync() { extractions++; }, spawnSync() { throw Error('unexpected probe'); } }
        : name === './runtime-policy.cjs' ? { ...policy,
          runtimeRequired: (k,p) => policy.runtimeRequired(k,p,{}),
          assertSkipAllowed: (k,p) => policy.assertSkipAllowed(k,p,{}) } : require(name);
      const context = { require: req, module, exports: module.exports, __dirname, console,
        Buffer, setTimeout: fn => fn(), process: { env: mode === 'skip' ? { [`TANGU_SKIP_FETCH_${kind.toUpperCase()}`]: '1' } : {}, platform: 'win32', arch: 'x64' },
        fetch: async () => { if (mode === 'network') throw Error('synthetic network failure'); return { ok:true, arrayBuffer: async () => Buffer.from('altered archive') }; } };
      vm.runInNewContext(fs.readFileSync(path.join(__dirname, `fetch-${kind}.cjs`), 'utf8'), context);
      const fn = module.exports[`fetch${kind[0].toUpperCase()}${kind.slice(1)}`];
      await assert.rejects(fn({ platformName: 'win32', archName:'x64' }), /failure|cannot be skipped|integrity mismatch/);
      assert.equal(extractions, 0); assert.equal(writes, 0);
    }
  });
}
test('pinned checksum accepts original bytes and rejects a one-byte mutation', () => {
  const original = Buffer.from('official fixture');
  const item = { name:'fixture', sha256: createHash('sha256').update(original).digest('hex') };
  policy.verifyArchive(original, item);
  const changed = Buffer.from(original); changed[0] ^= 1;
  assert.throws(() => policy.verifyArchive(changed, item), /integrity mismatch/);
  assert.equal(policy.pinnedRuntime('node', 'win32', 'x64').version, 'v24.22.1');
});
