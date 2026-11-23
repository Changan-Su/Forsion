import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { filesWithCR } from './check-dist-lf.mjs'

test('filesWithCR: finds CRLF text output (nested), ignores LF files and binaries', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dist-lf-'))
  try {
    mkdirSync(path.join(dir, 'db'))
    writeFileSync(path.join(dir, 'index.js'), 'export const a = 1\n')
    writeFileSync(path.join(dir, 'db', 'migrate.js'), 'const sql = `\r\nCREATE TABLE x (id INTEGER)\r\n`\n')
    writeFileSync(path.join(dir, 'db', 'migrate.d.ts'), 'export {}\r\n')
    writeFileSync(path.join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    assert.deepEqual(filesWithCR(dir), ['db/migrate.d.ts', 'db/migrate.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
