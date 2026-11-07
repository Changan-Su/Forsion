import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPackage } from '../../unit/packages'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function pack(manifest: Record<string, unknown>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'unit-requires-')))
  roots.push(root)
  await writeFile(join(root, 'main.js'), 'ui')
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ id: 'fixture', version: '1.0.0', apiVersion: 1, main: 'main.js', ...manifest }))
  return root
}

describe('readPackage requires', () => {
  it('keeps the array form exactly as it was', async () => {
    const p = await readPackage(await pack({ requires: ['tangu'] }))
    expect(p.manifest.requires).toEqual(['tangu'])
    expect(p.ui).not.toHaveProperty('entitlement')
  })

  it('normalizes the object form to the string list every other reader expects', async () => {
    const p = await readPackage(await pack({ requires: { plugins: ['tangu'], entitlement: 'business' } }))
    expect(p.manifest.requires).toEqual(['tangu'])
  })

  it('accepts an object with only an entitlement', async () => {
    const p = await readPackage(await pack({ requires: { entitlement: 'business' } }))
    expect(p.manifest.requires).toEqual([])
  })

  it('loads a package whose entitlement is malformed: one bad optional field cannot stop Unit starting', async () => {
    const p = await readPackage(await pack({ requires: { plugins: ['tangu'], entitlement: null } }))
    expect(p.manifest.requires).toEqual(['tangu'])
    expect(p.ui?.entitlement).toBeUndefined()
  })

  it('publishes the entitlement through the UI whitelist, so the page can ask about it', async () => {
    const p = await readPackage(await pack({ requires: { entitlement: 'business' } }))
    expect(p.ui?.entitlement).toBe('business')
  })

  it('leaves the projection unchanged for a plugin that declares none', async () => {
    const p = await readPackage(await pack({}))
    expect(p.ui).not.toHaveProperty('entitlement')
    expect(p.manifest.requires).toBeUndefined()
  })

  it.each([
    ['a string', 'tangu'],
    ['plugins not a list', { plugins: 'tangu' }],
    ['a bad plugin id', { plugins: ['Not Valid'] }],
    ['a bad array entry', ['Not Valid']],
  ])('refuses %s', async (_name, requires) => {
    await expect(readPackage(await pack({ requires }))).rejects.toThrow('Invalid plugin dependencies')
  })
})
