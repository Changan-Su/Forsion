import JSZip from 'jszip'
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractZipToDir, MARKET_MANIFEST } from './marketInstall'
import { prepareSkillPackage, skillTreeHash } from './skillPackage'
import { createSourceSkillUpdater, type SkillUpdateDownload } from './sourceSkillUpdates'

const ID = 'src_25aae625_wayfinder', SLUG = 'src-25aae625-wayfinder'
const SKILL = (v: string) => `---\nname: wayfinder\ndescription: v${v}\n---\nbody ${v}\n`
async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const z = new JSZip()
  for (const [k, v] of Object.entries(files)) z.file(k, v)
  return z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' })
}

let root: string, dir: string
let rec: { version: string | null; type: string; slug: string; ack?: { scripts: number; audit: boolean }; tree?: string }
let latest: string, pkg: Record<string, string>, audit: boolean, note: string | null
let lookupFails: Error | null, removed: boolean, paused: boolean
const recordInstall = vi.fn(async (r: { version: string | null; tree?: string | null }) => { rec = { ...rec, version: r.version, ...(r.tree ? { tree: r.tree } : {}) } })
const changed = vi.fn()
const download = vi.fn(async (): Promise<SkillUpdateDownload> => ({ info: { type: 'skill', installSlug: SLUG, version: latest }, buf: await zipOf(pkg), origin: 'github:mattpocock/skills', commit: 'a'.repeat(40), path: 'skills/wayfinder', adaptNote: note, auditWarn: audit }))
const make = (enabled = true) => createSourceSkillUpdater({
  sources: {
    installs: async () => [{ cardId: ID, type: 'skill', slug: SLUG, name: 'wayfinder', version: rec.version, sourceId: '25aae625', sourceTitle: 'skills.sh', removed }],
    installRecord: async () => rec,
    lookup: async () => { if (lookupFails) throw lookupFails; return { id: ID, name: 'wayfinder', type: 'skill', installSlug: SLUG, latestVersion: latest, summary: '', author: 'mattpocock' } },
    updatesPaused: () => paused,
    recordInstall,
  } as never,
  download, skillDir: () => dir, enabled: () => enabled, exclusive: (fn) => fn(), changed,
})
/** Install v1 the way the store does and remember the folder's fingerprint. */
async function installV1(files: Record<string, string> = { 'SKILL.md': SKILL('1'), 'old.md': 'old' }) {
  const prepared = await prepareSkillPackage(await zipOf(files), { note: 'v1 note' })
  await extractZipToDir(prepared.buf, dir, MARKET_MANIFEST.skill)
  rec = { version: '2026.11.19-100000', type: 'skill', slug: SLUG, ack: { scripts: 0, audit: false }, tree: (await skillTreeHash(dir))! }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-upd-')); dir = join(root, SLUG)
  latest = '2026.11.20-148210'; pkg = { 'SKILL.md': SKILL('2'), 'new.md': 'new' }; audit = false; note = 'v2 note'
  lookupFails = null; removed = false; paused = false
  recordInstall.mockClear(); changed.mockClear(); download.mockClear()
  await installV1()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('source skill updates', () => {
  it('replaces an unedited folder with the new version (files it dropped go), writes the new note and records the fingerprint', async () => {
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'updated' }])
    expect((await readdir(dir)).sort()).toEqual(['.forsion-adapt.md', 'SKILL.md', 'new.md'])
    expect(await readFile(join(dir, '.forsion-adapt.md'), 'utf8')).toBe('v2 note\n')
    expect(recordInstall).toHaveBeenCalledWith(expect.objectContaining({ version: latest, path: 'skills/wayfinder', tree: await skillTreeHash(dir) }))
    expect(changed).toHaveBeenCalledTimes(1)
    // No staging / old copies left next to it.
    expect(await readdir(root)).toEqual([SLUG])
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'current' }])
  })

  it('a recorded version that fails to save puts the old folder back', async () => {
    recordInstall.mockRejectedValueOnce(new Error('disk full'))
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'error', error: 'disk full' }])
    expect(await readFile(join(dir, 'old.md'), 'utf8')).toBe('old')
    expect(await skillTreeHash(dir)).toBe(rec.tree)
    expect(await readdir(root)).toEqual([SLUG])
  })

  it('an update cut off between its two renames is put back before anything else', async () => {
    await rename(dir, join(root, `.skill-stage-${SLUG}.old-1234`))
    latest = rec.version!
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'current' }])
    expect(await readFile(join(dir, 'old.md'), 'utf8')).toBe('old')
  })

  it('leaves a folder the user edited alone (no download)', async () => {
    await writeFile(join(dir, 'SKILL.md'), `${SKILL('1')}my change\n`)
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'edited' }])
    expect(download).not.toHaveBeenCalled()
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toMatch(/my change/)
  })

  it('a folder installed before fingerprints were kept is not updated automatically', async () => {
    delete rec.tree
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'edited' }])
  })

  it('waits for the user when the new version brings scripts or an audit warning they did not confirm', async () => {
    pkg = { 'SKILL.md': SKILL('2'), 'scripts/run.sh': 'echo' }
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'needs-confirm' }])
    expect(await readFile(join(dir, 'old.md'), 'utf8')).toBe('old')
    pkg = { 'SKILL.md': SKILL('2') }; audit = true
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'needs-confirm' }])
    rec.ack = { scripts: 0, audit: true }
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'updated' }])
  })

  it('refuses a package without a valid SKILL.md and keeps the installed copy', async () => {
    pkg = { 'README.md': '# not a skill' }
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'error', error: 'install: skill-invalid' }])
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(SKILL('1'))
  })

  it('a failed catalog read, a paused or removed source, or the switch off: nothing is touched', async () => {
    lookupFails = new Error('resolve: source-item-removed')
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'error', error: 'resolve: source-item-removed' }])
    lookupFails = null; paused = true
    expect(await make().check()).toEqual([{ cardId: ID, outcome: 'paused' }])
    paused = false; removed = true
    expect(await make().check()).toEqual([])
    removed = false
    expect(await make(false).check()).toEqual([])
    expect(download).not.toHaveBeenCalled()
    expect(await readFile(join(dir, 'old.md'), 'utf8')).toBe('old')
  })
})
