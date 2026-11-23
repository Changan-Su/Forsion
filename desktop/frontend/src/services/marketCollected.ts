/**
 * Store items from sources, as the store page and the chat cards install them: who published an item (the label next to
 * the author), which prerequisites a collected skill brings, and what the user confirms item by item before installing
 * (scripts, an audit warning). Pure: no window, no React — the chat card imports it, and node tests import chat messages.
 * Main counts scripts again from the package and refuses what wasn't confirmed (`install: confirm-needed …`).
 */
import { auditWarns, BUILTIN_SKILLS_SH, isSourceCardId, splitSourceCardId, type StoreSourceInfo, type StoreSourceInstall } from '../../../shared/storeSources'
import type { MarketCard } from '../types'

/** 会运行代码的类型:插件本身、可带工具 / MCP 命令的 Agent、可捆插件的 Space。每项第一次装前都确认。 */
export const CODE_TYPES = new Set(['plugin', 'amadeus-plugin', 'agent', 'space'])

export const isBuiltinCard = (c: Pick<MarketCard, 'id'>): boolean => splitSourceCardId(c.id)?.source === BUILTIN_SKILLS_SH.id

/** The label next to the author: Forsion official / developer, skills.sh, a source that isn't reviewed, or a source that is gone. */
export type PublisherLabel =
  | { kind: 'official' | 'developer' | 'builtin' }
  | { kind: 'source'; title: string }
  | { kind: 'removed' }

/**
 * `publisher` / `origin` only upgrade or name a label; whether an item comes from a source is read off its id
 * (a chat card's Forsion row can carry `origin: { kind: 'forsion' }`). `sources` = the desktop's own source table
 * (missing = not known here, e.g. web: the item's own source title stands in).
 */
export function publisherOf(c: Pick<MarketCard, 'id' | 'publisher'> & { origin?: { sourceId?: string; sourceTitle?: string; kind?: string; publisher?: string } }, sources?: StoreSourceInfo[], removed?: boolean): PublisherLabel {
  const parts = splitSourceCardId(c.id)
  if (!parts) return c.publisher === 'official' || c.origin?.publisher === 'official' ? { kind: 'official' } : { kind: 'developer' }
  if (removed) return { kind: 'removed' }
  if (parts.source === BUILTIN_SKILLS_SH.id) return { kind: 'builtin' }
  const s = sources?.find((x) => x.id === parts.source)
  if (sources && !s) return { kind: 'removed' }
  return { kind: 'source', title: s?.title || c.origin?.sourceTitle || '' }
}

/** One install, ready to run: what it is and what the user confirms for it (from the catalog; main counts again). */
export interface InstallStep { id: string; type: MarketCard['type']; name: string; installSlug: string; scripts: number; audit: boolean }
const stepOf = (c: MarketCard): InstallStep => ({ id: c.id, type: c.type, name: c.name, installSlug: c.installSlug, scripts: c.collected?.scripts ?? 0, audit: auditWarns(c.collected) })

/**
 * The installs for one item: prerequisites that aren't installed yet (theirs first, transitively, each once) and the item
 * last. `lookup` reads a card of the same source from what is already in hand (the store's catalog; for a chat card,
 * `fetchPlanCards` first). Prerequisites the catalog doesn't have are reported, not installed.
 */
export function installPlan(c: MarketCard, o: { installed: (slug: string) => boolean; lookup: (cardId: string) => MarketCard | null | undefined }): { steps: InstallStep[]; missing: string[] } {
  if (!isSourceCardId(c.id) || c.type !== 'skill' || !c.prereqs?.length) return { steps: [stepOf(c)], missing: [] }
  const seen = new Set<string>([c.id]), order: InstallStep[] = [], missing: string[] = []
  const visit = (card: MarketCard, depth: number): void => {
    for (const p of card.prereqs ?? []) {
      if (seen.has(p.id) || seen.size > 24) continue
      seen.add(p.id)
      if (p.missing) { missing.push(p.name); continue }
      const full = o.lookup(p.id) ?? null
      if (full && depth < 4) visit(full, depth + 1)
      if (!o.installed(p.installSlug)) order.push(full ? stepOf(full) : { id: p.id, type: 'skill', name: p.name, installSlug: p.installSlug, scripts: p.scripts, audit: p.auditWarn })
    }
  }
  visit(c, 0)
  return { steps: [...order, stepOf(c)], missing }
}

/** The prerequisite cards an install plan reads, fetched one level at a time (for callers without the catalog in hand). */
export async function fetchPlanCards(c: MarketCard, fetchCard: (cardId: string) => Promise<MarketCard | null>): Promise<Map<string, MarketCard>> {
  const got = new Map<string, MarketCard>()
  let level = (c.prereqs ?? []).filter((p) => !p.missing).map((p) => p.id)
  for (let depth = 0; depth < 4 && level.length && got.size < 24; depth++) {
    const cards = await Promise.all(level.filter((id) => !got.has(id) && id !== c.id).map((id) => fetchCard(id).catch(() => null)))
    level = []
    for (const card of cards) if (card && !got.has(card.id)) { got.set(card.id, card); level.push(...(card.prereqs ?? []).filter((p) => !p.missing).map((p) => p.id)) }
  }
  return got
}

/** What a set of installs asks the user to confirm (items with scripts or an audit warning), or null. */
export function confirmOf(steps: InstallStep[], found: Record<string, { scripts: number; audit: boolean }> = {}): { scripts: number; audit: boolean; items: InstallStep[] } | null {
  const items = steps.map((s) => (found[s.id] ? { ...s, scripts: Math.max(s.scripts, found[s.id].scripts), audit: s.audit || found[s.id].audit } : s)).filter((s) => isSourceCardId(s.id) && (s.scripts > 0 || s.audit))
  if (!items.length) return null
  return { scripts: items.reduce((n, s) => n + s.scripts, 0), audit: items.some((s) => s.audit), items }
}

/** Main found scripts / an audit warning nobody confirmed for this item: the counts it found (null = another error). */
export function confirmNeededOf(e: unknown): { scripts: number; audit: boolean } | null {
  const msg = typeof e === 'string' ? e : (e as { raw?: string })?.raw || (e as Error)?.message || String(e)
  const m = /install: confirm-needed scripts=(\d+) audit=([01])/.exec(msg)
  return m ? { scripts: Number(m[1]), audit: m[2] === '1' } : null
}

/** What the user confirmed for one step (main compares it with what it counts in the package). */
export const ackOf = (s: InstallStep, found?: { scripts: number; audit: boolean }): { scripts: number; audit: boolean } =>
  ({ scripts: Math.max(s.scripts, found?.scripts ?? 0), audit: s.audit || !!found?.audit })

/** Built-in items whose source record says the upstream copy is gone. */
export const upstreamGone = (c: MarketCard, installs: StoreSourceInstall[]): boolean =>
  !!c.collected?.upstreamDeleted || installs.some((r) => r.cardId === c.id && r.upstreamDeleted)

/** What a chat card's item may carry beyond the base fields (newer engines / servers; contract §3.3). */
export interface ChatItemExtras {
  publisher?: 'official' | 'developer'
  origin?: { kind: 'forsion' | 'collected' | 'source'; sourceId?: string; sourceTitle?: string; publisher?: 'official' | 'developer' }
  downloads?: number
  requirements?: { cli: boolean; apiKeys: string[]; desktopOnly: boolean; scripts: number; auditWarn: boolean }
}
const PUBLISHERS = new Set(['official', 'developer'])
/**
 * The optional `publisher` / `origin` / `downloads` / `requirements` of a store item in a chat message, each kept only when
 * it has the expected shape (older engines drop them, older servers never send them: then the item reads as a Forsion
 * developer's, and nothing else changes).
 */
export function chatItemExtras(raw: unknown): ChatItemExtras {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: ChatItemExtras = {}
  if (typeof r.publisher === 'string' && PUBLISHERS.has(r.publisher)) out.publisher = r.publisher as 'official' | 'developer'
  const o = r.origin as Record<string, unknown> | null | undefined
  if (o && typeof o === 'object' && (o.kind === 'forsion' || o.kind === 'collected' || o.kind === 'source')) {
    out.origin = o.kind === 'forsion'
      ? { kind: 'forsion', ...(typeof o.publisher === 'string' && PUBLISHERS.has(o.publisher) ? { publisher: o.publisher as 'official' | 'developer' } : {}) }
      : { kind: o.kind, ...(typeof o.sourceId === 'string' && /^[0-9a-f]{8}$/.test(o.sourceId) ? { sourceId: o.sourceId } : {}), ...(typeof o.sourceTitle === 'string' && o.sourceTitle.trim() ? { sourceTitle: o.sourceTitle.trim().slice(0, 80) } : {}) }
  }
  if (typeof r.downloads === 'number' && Number.isFinite(r.downloads) && r.downloads >= 0) out.downloads = Math.floor(r.downloads)
  const q = r.requirements as Record<string, unknown> | null | undefined
  if (q && typeof q === 'object') {
    const n = typeof q.scripts === 'number' && Number.isFinite(q.scripts) && q.scripts >= 0 ? Math.min(Math.floor(q.scripts), 10000) : 0
    out.requirements = {
      cli: q.cli === true, desktopOnly: q.desktopOnly === true, auditWarn: q.auditWarn === true, scripts: n,
      apiKeys: Array.isArray(q.apiKeys) ? q.apiKeys.filter((k): k is string => typeof k === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(k)).slice(0, 8) : [],
    }
  }
  return out
}

/** Compact count for a card corner: 1.7M / 167 万 (a space before 万 / 亿, as the store writes counts). */
export function compactCount(n: number, locale: string): string {
  const zh = locale.startsWith('zh')
  try { return new Intl.NumberFormat(zh ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: zh && n >= 1e6 ? 0 : 1 }).format(n).replace(/(\d)\s*([万亿])$/, '$1 $2') } catch { return String(n) }
}
