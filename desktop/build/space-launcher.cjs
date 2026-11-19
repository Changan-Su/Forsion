const { execFileSync } = require('node:child_process')
const path = require('node:path')

// A universal helper also survives replacing an Intel Forsion install with a
// native Apple Silicon build. There is no compiler dependency on users' Macs.
exports.buildSpaceLauncher = function buildSpaceLauncher(output) {
  execFileSync('/usr/bin/xcrun', [
    'clang', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.0',
    '-fobjc-arc', '-O2', '-framework', 'AppKit',
    path.join(__dirname, '../native/space-launcher.m'), '-o', output,
  ], { stdio: 'inherit' })
}
