import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const { mergeBuildMaterials } = createRequire(import.meta.url)('./release-merge-materials.cjs')

function fixture(builds) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-materials-'))
  const inDir = path.join(dir, 'in'), outDir = path.join(dir, 'out')
  fs.mkdirSync(inDir)
  for (const [name, { commit = 'abc', sbom = 'same', extra = {} }] of Object.entries(builds)) {
    fs.writeFileSync(path.join(inDir, `build-${name}-materials.json`), JSON.stringify({ commit, collector: { role: name }, artifacts: [{ name: `${name}.exe`, sha256: 'x' }], ...extra }))
    if (sbom !== null) fs.writeFileSync(path.join(inDir, `build-${name}-sbom.json`), JSON.stringify({ components: [sbom] }))
  }
  return { inDir, outDir }
}

test('identical SBOMs: one merged file, no per-platform SBOM, every input kept verbatim', () => {
  const { inDir, outDir } = fixture({ 'Linux-default': { extra: { runtimes: { node: '24' } } }, 'Windows-no-extend': {}, android: {} })
  const r = mergeBuildMaterials(inDir, outDir)
  assert.deepEqual(fs.readdirSync(outDir), ['build-materials.json'])
  assert.equal(r.identical, true)
  const merged = JSON.parse(fs.readFileSync(path.join(outDir, 'build-materials.json'), 'utf8'))
  assert.equal(merged.commit, 'abc')
  assert.equal(merged.sbom.identical, true)
  assert.equal(merged.sbom.builds.length, 3)
  assert.deepEqual(Object.keys(merged.platforms).sort(), ['Linux-default', 'Windows-no-extend', 'android'])
  for (const name of Object.keys(merged.platforms)) {
    assert.deepEqual(merged.platforms[name], JSON.parse(fs.readFileSync(path.join(inDir, `build-${name}-materials.json`), 'utf8')))
  }
})

test('differing SBOMs: every per-platform SBOM is kept', () => {
  const { inDir, outDir } = fixture({ 'macOS-default': {}, 'Linux-default': { sbom: 'other' } })
  const r = mergeBuildMaterials(inDir, outDir)
  assert.equal(r.identical, false)
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['build-Linux-default-sbom.json', 'build-macOS-default-sbom.json', 'build-materials.json'])
  const merged = JSON.parse(fs.readFileSync(path.join(outDir, 'build-materials.json'), 'utf8'))
  assert.equal(merged.sbom.identical, false)
  assert.equal(merged.sbom.files.length, 2)
})

test('fails closed on mixed commits, a missing SBOM, or no materials', () => {
  let f = fixture({ a: {}, b: { commit: 'def' } })
  assert.throws(() => mergeBuildMaterials(f.inDir, f.outDir), /different commits/)
  f = fixture({ a: {}, b: { sbom: null } })
  assert.throws(() => mergeBuildMaterials(f.inDir, f.outDir), /Missing SBOM for: b/)
  f = fixture({})
  assert.throws(() => mergeBuildMaterials(f.inDir, f.outDir), /No build-\*-materials/)
})
