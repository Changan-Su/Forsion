import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
const { writeEngineHost } = createRequire(import.meta.url)('../build/engine-host.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
it('stamps the shell identity without changing the independently versioned engine manifest', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'engine-host-')); roots.push(root)
  const manifest = JSON.stringify({ name: '@forsion/tangu-agent', version: '9.0.0' })
  writeFileSync(path.join(root, 'package.json'), manifest)
  await writeEngineHost(root, '2.13.6')
  expect(JSON.parse(readFileSync(path.join(root, 'desktop-host.json'), 'utf8'))).toEqual({ version: '2.13.6' })
  expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(manifest)
  await writeEngineHost(root, '2.13.7')
  expect(JSON.parse(readFileSync(path.join(root, 'desktop-host.json'), 'utf8')).version).toBe('2.13.7')
  for (const version of ['2.13.7+build.10', '2.13.8-rc.1+build.2']) {
    await writeEngineHost(root, version)
    expect(JSON.parse(readFileSync(path.join(root, 'desktop-host.json'), 'utf8')).version).toBe(version)
  }
  await expect(writeEngineHost(root, 'undefined')).rejects.toThrow('Invalid desktop version')
})
it('fails packaging if the engine copy is missing', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'engine-host-')); roots.push(root)
  await expect(writeEngineHost(root, '2.13.6')).rejects.toThrow('missing')
})
