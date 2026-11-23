import JSZip from 'jszip'
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractZipToDir, MARKET_MANIFEST } from './marketInstall'
import { prepareSkillPackage, skillTreeHash } from './skillPackage'
import { createSourceSkillUpdater, isSkillStageOf, type SkillUpdateDownload } from './sourceSkillUpdates'

const ID = 'src_25aae625_trailmap', SLUG = 'src-25aae625-trailmap'
const SKILL = (v: string) => `---\nname: trailmap\ndescription: v${v}\n---\nbody ${v}\n`
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
const download = vi.fn(async (): Promise<SkillUpdateDownload> => ({ info: { type: 'skill', installSlug: SLUG, version: latest }, buf: await zipOf(pkg), origin: 'github:lanternworks/skills', commit: 'a'.repeat(40), path: 'skills/trailmap', adaptNote: note, auditWarn: audit }))
const make = (enabled = true) => createSourceSkillUpdater({
  sources: {
    installs: async () => [{ cardId: ID, type: 'skill', slug: SLUG, name: 'trailmap', version: rec.version, sourceId: '25aae625', sourceTitle: 'skills.sh', removed }],
    installRecord: async () => rec,
    lookup: async () => { if (lookupFails) throw lookupFails; return { id: ID, name: 'trailmap', type: 'skill', installSlug: SLUG, latestVersion: latest, summary: '', author: 'lanternworks' } },
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
    expect(recordInstall).toHaveBeenCalledWith(expect.objectContaining({ version: latest, path: 'skills/trailmap', tree: await skillTreeHash(dir) }))
    expect(changed).toHaveBeenCalledTimes(1)
    // No staging copies left next to it; the version before is kept once as `.previous` (a file saved into the folder
    // while the swap ran would be in there, not gone) and the next update replaces it.
    expect((await readdir(root)).sort()).toEqual([`.skill-stage-${SLUG}.previous`, SLUG])
    expect(await readFile(join(root, `.skill-stage-${SLUG}.previous`, 'old.md'), 'utf8')).toBe('old')
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

  it('puts back a folder an interrupted update left missing even with automatic updates off, but not after an uninstall', async () => {
    await rename(dir, join(root, `.skill-stage-${SLUG}.old-1234`))
    expect(await make(false).check()).toEqual([])
    expect(await readFile(join(dir, 'old.md'), 'utf8')).toBe('old')
    // Uninstalled after the pass listed it (record gone by the time the queue runs): a leftover copy is not brought back.
    await rename(dir, join(root, `.skill-stage-${SLUG}.old-5678`))
    const listed = [{ cardId: ID, type: 'skill', slug: SLUG, name: 'trailmap', version: rec.version, sourceId: '25aae625', sourceTitle: 'skills.sh', removed: false }]
    await createSourceSkillUpdater({
      sources: { installs: async () => listed, installRecord: async () => null, lookup: async () => { throw new Error('unused') }, updatesPaused: () => false, recordInstall } as never,
      download, skillDir: () => dir, enabled: () => false, exclusive: (fn) => fn(), changed,
    }).check()
    expect(await readdir(root)).toEqual([`.skill-stage-${SLUG}.old-5678`])
  })

  it('reads the record again inside the install queue: a manual reinstall in between decides, not the stale copy', async () => {
    let calls = 0
    const stale = rec
    const updater = createSourceSkillUpdater({
      sources: {
        installs: async () => [{ cardId: ID, type: 'skill', slug: SLUG, name: 'trailmap', version: stale.version, sourceId: '25aae625', sourceTitle: 'skills.sh', removed: false }],
        // first read (outside the queue) = the old record; inside the queue a reinstall has replaced it (new consent, same tree)
        installRecord: async () => (++calls <= 1 ? stale : { ...stale, version: '2026.11.19-200000', ack: { scripts: 0, audit: false } }),
        lookup: async () => ({ id: ID, name: 'trailmap', type: 'skill', installSlug: SLUG, latestVersion: latest, summary: '', author: 'lanternworks' }),
        updatesPaused: () => false,
        recordInstall,
      } as never,
      download, skillDir: () => dir, enabled: () => true, exclusive: (fn) => fn(), changed,
    })
    expect(await updater.check()).toEqual([{ cardId: ID, outcome: 'paused' }])
    expect(download).not.toHaveBeenCalled()
  })

  it('names only the update folders of that exact skill', () => {
    expect(isSkillStageOf(`.skill-stage-${SLUG}.previous`, SLUG)).toBe(true)
    expect(isSkillStageOf(`.skill-stage-${SLUG}.old-0b7e3a52-8f8e-4c51-9d55-2f0c5b1d6a10`, SLUG)).toBe(true)
    expect(isSkillStageOf(`.skill-stage-${SLUG}-two.previous`, SLUG)).toBe(false)
    expect(isSkillStageOf(`.skill-stage-${SLUG}.notes`, SLUG)).toBe(false)
    expect(isSkillStageOf(SLUG, SLUG)).toBe(false)
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
