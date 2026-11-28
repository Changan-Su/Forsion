#!/usr/bin/env node
// Bench packages for local-engine-npm-emu.cjs, made from one real engine tarball (build-android-engine.sh output).
// Every variant is re-signed with a THROWAWAY test key (accepted only by a debug APK built with
// -PlocalEngineTestKey=<its public hex>); the production key never signs a bench fixture.
//
//   node make-bench-packages.mjs <good.tgz> <out-dir> <test-key.pem>     (run on Linux: tar keeps the exact tree)
//
//   2.14.11            same code, newer version: a plain update (same schema fingerprint)
//   2.14.11-tampered   2.14.11 with one dependency byte changed after signing (served as 2.14.11 by a bad mirror)
//   2.14.9             older than the APK's minimum (a stale mirror's dist-tag)
//   2.14.12-linked     a symlink entry in the tarball (refused while unpacking, before the signature is read)
//   2.14.13            crashes on a real start (when /root/.tangu/.crash-me exists; the self-test home never has it)
//                      and has other schema code (a comment in dist/db/migrate.js): another fingerprint
import { execFileSync } from 'node:child_process'
import { createPrivateKey } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SIGNED_FILE, SIG_FILE, signTable } from './android-engine-format.mjs'

const [good, out, keyFile] = process.argv.slice(2)
if (!good || !out || !keyFile) { console.error('usage: make-bench-packages.mjs <good.tgz> <out-dir> <test-key.pem>'); process.exit(2) }
const key = createPrivateKey(readFileSync(keyFile, 'utf8'))
const work = '/tmp/bench-pkgs'
rmSync(work, { recursive: true, force: true })
mkdirSync(path.join(work, 'good'), { recursive: true })
mkdirSync(out, { recursive: true })
execFileSync('tar', ['-xzf', good, '-C', path.join(work, 'good')])
const table = JSON.parse(readFileSync(path.join(work, 'good/package', SIGNED_FILE), 'utf8'))

function variant(version, edit, after) {
  const dir = path.join(work, version)
  cpSync(path.join(work, 'good'), dir, { recursive: true })
  const root = path.join(dir, 'package')
  const pj = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  pj.version = version.replace(/-.*$/, '')
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pj, null, 2) + '\n')
  if (edit) edit(root)
  const { bytes, sig, table: t } = signTable(root, Object.keys(table.files), { name: table.name, version: pj.version, line: table.line }, key)
  writeFileSync(path.join(root, SIGNED_FILE), bytes)
  writeFileSync(path.join(root, SIG_FILE), sig + '\n')
  if (after) after(root)
  const file = path.join(out, `${version}.tgz`)
  execFileSync('tar', ['-czf', file, '-C', dir, 'package'])
  console.log(`${version}: ${file} fingerprint ${t.schemaFingerprint}`)
}

variant('2.14.11')
variant('2.14.11-tampered', null, (root) => {
  const f = path.join(root, 'node_modules/better-sqlite3/lib/database.js')
  const b = readFileSync(f)
  b[b.length - 2] ^= 0x01 // same size, other bytes
  writeFileSync(f, b)
})
variant('2.14.9')
// a link in the archive (written before the signature is checked): the strict extractor must refuse the whole unpack
variant('2.14.12-linked', null, (root) => { execFileSync('ln', ['-s', '/data/data', path.join(root, 'node_modules/evil')]) })
variant('2.14.13', (root) => {
  const main = path.join(root, 'dist/standalone/main.js')
  const src = readFileSync(main, 'utf8')
  const bang = src.startsWith('#!') ? src.slice(0, src.indexOf('\n') + 1) : ''
  writeFileSync(main, bang + "import { existsSync as __benchCrash } from 'node:fs';\nif (__benchCrash('/root/.tangu/.crash-me')) process.exit(0);\n" + src.slice(bang.length))
  appendFileSync(path.join(root, 'dist/db/migrate.js'), '\n// bench: other schema code\n')
})
cpSync(good, path.join(out, '2.14.10.tgz'))
