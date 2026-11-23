/**
 * Automatic updates for skills installed from store sources (the built-in skills.sh source and user sources).
 * The plugin updater (marketPluginUpdates.ts) only knows JSON manifests; a skill is a folder of files the engine re-reads
 * on its own, so an update here is: download by origin → the same skill checks as a manual install → replace the folder.
 *
 * It leaves an item alone (it still shows under "Updates available", where the user updates by hand) when:
 * - its source is off or gone, or the last catalog read no longer lists it;
 * - the package moved (another repository or folder: storeSources.download with `auto`);
 * - the folder isn't what the store installed (the user edited it, or it predates the fingerprint);
 * - the new version brings scripts or an audit warning beyond what the user confirmed.
 * A failed catalog read is not "removed": lookup throws, the item is skipped this round.
 */
import { randomUUID } from 'node:crypto'
import { rename, rm } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { compareMarketVersions } from '../shared/marketPluginUpdates'
import { MARKET_MANIFEST, extractZipToDir } from './marketInstall'
import { prepareSkillPackage, skillTreeHash } from './skillPackage'
import type { StoreSources } from './storeSources'

export type SkillUpdateOutcome = 'updated' | 'current' | 'paused' | 'edited' | 'needs-confirm' | 'error'
export interface SkillUpdateDownload {
  info: { type: string; installSlug: string; version?: string }
  buf: Buffer
  origin?: string
  commit?: string | null
  path?: string
  adaptNote?: string | null
  auditWarn?: boolean
}

export function createSourceSkillUpdater(o: {
  sources: Pick<StoreSources, 'installs' | 'installRecord' | 'lookup' | 'updatesPaused' | 'recordInstall'>
  /** storeSources.download with `auto: true` + the host's package checks + the adaptation note. */
  download: (cardId: string) => Promise<SkillUpdateDownload>
  /** The installed folder of a skill slug (null = refused). */
  skillDir: (slug: string) => string | null
  /** The store's global automatic-update switch. */
  enabled: () => boolean
  /** The install / uninstall queue (manual installs and these updates never write the same folder at once). */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>
  /** Something was updated: tell the windows (skills list) and the engine re-reads on its own. */
  changed: () => void
}) {
  let running: Promise<Array<{ cardId: string; outcome: SkillUpdateOutcome; error?: string }>> | undefined

  async function one(cardId: string): Promise<{ outcome: SkillUpdateOutcome; error?: string }> {
    if (o.sources.updatesPaused(cardId)) return { outcome: 'paused' }
    const rec = await o.sources.installRecord(cardId)
    if (!rec || rec.type !== 'skill') return { outcome: 'paused' }
    const latest = await o.sources.lookup(cardId)
    if ((compareMarketVersions(latest.latestVersion, rec.version) ?? 0) <= 0) return { outcome: 'current' }
    const dir = o.skillDir(rec.slug)
    if (!dir) return { outcome: 'paused' }
    // Only a folder that is still exactly what the store installed (no fingerprint = installed before it was kept).
    if (!rec.tree || await skillTreeHash(dir) !== rec.tree) return { outcome: 'edited' }
    return o.exclusive(async () => {
      const dl = await o.download(cardId)
      if (dl.info.type !== 'skill' || dl.info.installSlug !== rec.slug) throw new Error('resolve: market identity changed')
      if ((compareMarketVersions(dl.info.version, rec.version) ?? 0) <= 0) return { outcome: 'current' as const }
      const skill = await prepareSkillPackage(dl.buf, { note: dl.adaptNote ?? null })
      if (skill.scripts > (rec.ack?.scripts ?? 0) || (dl.auditWarn && !rec.ack?.audit)) return { outcome: 'needs-confirm' as const }
      // Read again inside the queue: an edit between the first look and the download still wins.
      if (await skillTreeHash(dir) !== rec.tree) return { outcome: 'edited' as const }
      // Replace the whole folder (an update may drop files); the old one comes back if the swap fails.
      const staging = join(dirname(dir), `.${basename(dir)}.update-${randomUUID()}`), old = join(dirname(dir), `.${basename(dir)}.old-${randomUUID()}`)
      try {
        await extractZipToDir(skill.buf, staging, MARKET_MANIFEST.skill)
        await rename(dir, old)
        try { await rename(staging, dir) } catch (e) { await rename(old, dir).catch(() => {}); throw e }
      } finally { await rm(staging, { recursive: true, force: true }).catch(() => {}) }
      await rm(old, { recursive: true, force: true }).catch(() => {})
      await o.sources.recordInstall({
        cardId, type: 'skill', slug: rec.slug, name: latest.name || rec.slug, version: dl.info.version ?? latest.latestVersion ?? null,
        origin: dl.origin ?? '', commit: dl.commit, ...(dl.path !== undefined ? { path: dl.path } : {}), summary: latest.summary, author: latest.author,
        tree: await skillTreeHash(dir),
      })
      return { outcome: 'updated' as const }
    })
  }

  /** One pass over every source-installed skill. Concurrent calls share the running pass. */
  function check(): Promise<Array<{ cardId: string; outcome: SkillUpdateOutcome; error?: string }>> {
    if (running) return running
    running = (async () => {
      if (!o.enabled()) return []
      const out: Array<{ cardId: string; outcome: SkillUpdateOutcome; error?: string }> = []
      for (const r of await o.sources.installs()) {
        // Off / removed sources pause; an item the catalog no longer lists fails its lookup (and stays as it is).
        if (r.type !== 'skill' || r.removed) continue
        try { out.push({ cardId: r.cardId, ...(await one(r.cardId)) }) }
        catch (e) { out.push({ cardId: r.cardId, outcome: 'error', error: e instanceof Error ? e.message : String(e) }) }
      }
      if (out.some((x) => x.outcome === 'updated')) o.changed()
      return out
    })().finally(() => { running = undefined })
    return running
  }
  return { check }
}
