import { afterAll, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const desktop = resolve(__dirname, '..')
const fixture = mkdtempSync(join(tmpdir(), 'forsion-distribution-'))
const app = join(fixture, 'desktop')
mkdirSync(join(app, 'build'), { recursive: true })
mkdirSync(join(app, 'electron'))
mkdirSync(join(app, 'unit-web-dist'))
mkdirSync(join(fixture, 'tangu-agent'))
for (const file of ['electron-builder.config.cjs', 'build/distribution.cjs', 'build/backend-dependencies.cjs', 'build/dmg-layout.cjs', 'electron/builtinBundles.json']) {
  cpSync(join(desktop, file), join(app, file))
}
cpSync(join(desktop, 'products'), join(app, 'products'), { recursive: true })
cpSync(join(desktop, '../tangu-agent/package-lock.json'), join(fixture, 'tangu-agent/package-lock.json'))
writeFileSync(join(app, 'unit-web-dist/index.html'), '')
afterAll(() => rmSync(fixture, { recursive: true, force: true }))

function config(value?: string) {
  const env = { ...process.env }
  delete env.FORSION_PRODUCT
  delete env.FORSION_BUNDLE_EXTEND
  if (value !== undefined) env.FORSION_BUNDLE_EXTEND = value
  return JSON.parse(execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./electron-builder.config.cjs")))'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString())
}

describe('desktop distributions', () => {
  it('default installers retain Extend and the existing filenames/feed', () => {
    const c = config()
    expect(c.artifactName).toBe('Forsion-${version}-${arch}.${ext}')
    expect(c.publish.channel).toBe('latest')
    expect(c.extraMetadata.forsionBundleExtend).toBe(true)
    expect(c.extraResources.some((r: { to: string }) => r.to === 'bundled-plugins/extend')).toBe(true)
    expect(config('1')).toEqual(c)
  })

  it('NoExtend excludes the plugin from resources and asar, keeps the backend/CU and isolates its feed', () => {
    const c = config('0')
    expect(c.artifactName).toBe('Forsion-NoExtend-${version}-${arch}.${ext}')
    expect(c.publish.channel).toBe('latest-no-extend')
    expect(c.extraMetadata.forsionBundleExtend).toBe(false)
    const resources = c.extraResources.map((r: { to: string }) => r.to)
    expect(resources).not.toContain('bundled-plugins/extend')
    expect(resources).toContain('bundled-plugins/tangu-computer-use')
    expect(resources).toContain('tangu-server/dist')
    expect(c.files).toContain('!node_modules/@forsion/extend/**')
  })

  it('rejects misspelled variant values instead of silently shipping the default', () => {
    expect(() => config('false')).toThrow('FORSION_BUNDLE_EXTEND must be 0')
  })
})
