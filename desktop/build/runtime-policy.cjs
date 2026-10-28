const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const path = require('node:path');
const manifest = require('./runtime-manifest.json');

function runtimeRequired(kind, platform, env = process.env) {
  if (kind === 'git' && platform === 'linux') return false;
  // Packaging is complete by default. Degradation is an explicit local development choice.
  return env[`TANGU_REQUIRE_${kind.toUpperCase()}`] === '1'
    || env.FORSION_RELEASE_BUILD === '1' || env.FORSION_ALLOW_INCOMPLETE_DEV_BUILD !== '1';
}
function assertSkipAllowed(kind, platform, env = process.env) {
  if (runtimeRequired(kind, platform, env)) throw new Error(`Required bundled ${kind} cannot be skipped`);
}
function pinnedRuntime(kind, platform, arch) {
  const item = manifest.runtimes[kind]?.[`${platform}:${arch}`];
  if (!item || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`No pinned ${kind} for ${platform}:${arch}`);
  return item;
}
function verifyArchive(bytes, item) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== item.sha256) {
    const error = new Error(`Runtime integrity mismatch for ${item.name}: expected ${item.sha256}, got ${actual}`);
    error.code = 'RUNTIME_INTEGRITY';
    throw error;
  }
  return bytes;
}
function assertPackagedRuntime(root, kind, platform) {
  if (existsSync(path.join(root, '.skipped'))) assertSkipAllowed(kind, platform);
  else if (!existsSync(root)) throw new Error(`Missing packaged ${kind}: ${root}`);
}
module.exports = { runtimeRequired, assertSkipAllowed, pinnedRuntime, verifyArchive, assertPackagedRuntime };
