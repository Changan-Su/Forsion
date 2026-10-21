/** Compile the local instrument with existing esbuild; never download an unpinned TS runner. */
const { buildSync } = require('esbuild')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { unlinkSync } = require('node:fs')
const path = require('node:path')
const output = path.join(__dirname, `.unit-public-${randomUUID()}.mjs`)
try {
  buildSync({ entryPoints: [path.join(__dirname, 'unit-public-extend.e2e.ts')], outfile: output,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' })
  const result = spawnSync(process.execPath, [output], { stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally { try { unlinkSync(output) } catch {} }
