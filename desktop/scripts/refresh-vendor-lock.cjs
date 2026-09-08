#!/usr/bin/env node
// 抄自 server/scripts/refresh-vendor-lock.cjs(同一个坑:npm 不刷新 file: tgz 的 integrity);desktop 这边默认包是内置的 Computer Use 捆绑包。
/*
 * Forces npm to recompute the integrity (and dependency subtree) for a vendored
 * `file:` tarball dependency in package-lock.json.
 *
 * Why this exists: `npm install --package-lock-only` does NOT refresh an
 * existing `file:` entry's integrity — it silently keeps the stale hash. That
 * is exactly how a stale integrity for @forsion/tangu-computer-use got committed and
 * broke production `npm ci` with EINTEGRITY (lock "wanted" the old hash, the
 * rebuilt tarball "got" a new one). Deleting the lock entries first forces npm
 * to fully re-resolve the package from the tarball on the subsequent
 * `npm install --package-lock-only`.
 *
 * Usage: node scripts/refresh-vendor-lock.cjs [@scope/name]
 *        (defaults to @forsion/tangu-computer-use)
 * Run BEFORE `npm install --package-lock-only`.
 */
const fs = require('fs');
const path = require('path');

const pkgName = process.argv[2] || '@forsion/tangu-computer-use';
const lockPath = path.resolve(__dirname, '..', 'package-lock.json');
const prefix = `node_modules/${pkgName}`;

const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
let removed = 0;
for (const key of Object.keys(lock.packages || {})) {
  if (key === prefix || key.startsWith(`${prefix}/`)) {
    delete lock.packages[key];
    removed += 1;
  }
}
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(
  `[refresh-vendor-lock] cleared ${removed} lock entr${removed === 1 ? 'y' : 'ies'} for ${pkgName}; ` +
    'now run `npm install --package-lock-only` to regenerate the integrity.',
);
