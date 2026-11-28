#!/usr/bin/env node
// Regenerates the JVM test fixture for EngineSignatureTest: a tiny engine package signed by the Node producer
// (android-engine-format.mjs) with a throwaway key that exists only for this run (the private key is not kept).
//   node mobile/scripts/local-engine/make-test-fixture.mjs
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCHEMA_FILES, SIGNED_FILE, SIG_FILE, rawPublicHex, signTable } from './android-engine-format.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(here, '../../android/app/src/test/resources/local-engine-fixture')
const root = path.join(out, 'package')
rmSync(out, { recursive: true, force: true })
const files = {
  'package.json': JSON.stringify({ name: '@forsion/tangu-engine-android-arm64', version: '2.14.10' }) + '\n',
  'dist/standalone/main.js': "console.log('fixture')\n",
  'node_modules/dep/index.js': 'module.exports = 1\n',
  'skills/a/SKILL.md': '# a/b ü\n',
  ...Object.fromEntries(SCHEMA_FILES.map((f) => [f, `// ${f}\nCREATE TABLE IF NOT EXISTS t (id TEXT)\n`])),
}
for (const [rel, text] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const { bytes, sig } = signTable(root, Object.keys(files), { name: '@forsion/tangu-engine-android-arm64', version: '2.14.10', line: 1 }, privateKey)
writeFileSync(path.join(root, SIGNED_FILE), bytes)
writeFileSync(path.join(root, SIG_FILE), sig + '\n')
writeFileSync(path.join(out, 'test-key.hex'), rawPublicHex(publicKey) + '\n')
console.log(out)
