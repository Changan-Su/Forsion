import { contentStorageKey } from '@lcl/engine/contentStorageScope'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { amadeus } from '../api'
import { pluginNoteOwnership } from '../plugins/pluginStore'
import { flushNoteForReplace, holdLegacyForReplace, usePageStore } from '../store/pageStore'
import { announceUnifiedWrite, hasDirtyUnifiedPath } from '../unified/lifecycle'
import { readNoteLocked } from '../unified/viewMemory'
import { readDraft } from '../unified/writeSafety'
import { isReplaceNotePath, noteReplaceMatches, prepareLiteralReplacement, spliceNoteText, type ReplaceFile } from './noteReplaceMatches'

export type { ReplaceFile, ReplaceMatch } from './noteReplaceMatches'

export interface ReplacePlan { id: string; root: string; scope: string; query: string; files: ReplaceFile[]; unavailable: string[] }
export type ReplaceStatus = 'pending' | 'applied' | 'undone' | 'changed' | 'failed' | 'skipped' | 'unsafe'
export interface ReplaceBatch {
  id: string
  root: string
  direction: 'apply' | 'undo'
  files: { path: string; count: number; status: ReplaceStatus }[]
}

interface JournalFile { path: string; fileId?: string; encoded?: string; unsafe?: boolean; before: string; after: string; offsets: number[] }
interface Journal {
  id: string
  root: string
  scope: string
  query: string
  replacement: string
  files: JournalFile[]
}
interface Progress {
  stage: Exclude<ReplaceStatus, 'failed'> | 'writing' | 'undoing'
  failed?: boolean
}

function scopeOf(root: string): string {
  // A browser origin may serve several Units, each with the same local vault path.
  return contentStorageKey('amadeus.noteReplace.v1:' + JSON.stringify([location.pathname, root]))
}

function checkScope(root: string, scope: string, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  if (usePageStore.getState().vaultRoot !== root || scopeOf(root) !== scope) {
    throw new Error('The active vault or account changed')
  }
}

function eligible(root: string, path: string): boolean {
  return isReplaceNotePath(path) && !readNoteLocked(root, path)
}

async function readSource(path: string): Promise<{source: string; fileId?: string} | null> {
  if (amadeus.readNoteReplaceSource) return amadeus.readNoteReplaceSource(path)
  const source = await amadeus.readTextFile(path)
  return source == null ? null : { source }
}

export async function previewNoteReplace(root: string, query: string, signal?: AbortSignal): Promise<ReplacePlan> {
  const scope = scopeOf(root)
  const plan: ReplacePlan = { id: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''), root, scope, query, files: [], unavailable: [] }
  checkScope(root, scope, signal)
  if (!query.trim() || /[\r\n]/.test(query)) return plan

  // Flush before asking the index, so the last uncommitted keystrokes can be found too.
  await flushNoteForReplace()
  checkScope(root, scope, signal)
  const paths = amadeus.noteReplaceCandidates ? await amadeus.noteReplaceCandidates(query) : await amadeus.listPages()
  const managed = pluginNoteOwnership(root)
  const candidates = Array.from(new Set(paths)).filter(path => eligible(root, path) && !managed(path)).sort()
  const groupSize = amadeus.readNoteReplaceSources ? 24 : 6
  for (let i = 0; i < candidates.length; i += groupSize) {
    checkScope(root, scope, signal)
    const group = candidates.slice(i, i + groupSize)
    let snapshots: Map<string, { source: string; fileId?: string } | null>
    if (amadeus.readNoteReplaceSources) {
      const rows = await amadeus.readNoteReplaceSources(group)
      snapshots = new Map(rows.map(row => [row.path, row]))
    } else {
      snapshots = new Map(await Promise.all(group.map(async path =>
        [path, await readSource(path).catch(() => null)] as const)))
    }
    checkScope(root, scope, signal)
    for (const path of group) {
      const snapshot = snapshots.get(path)
      if (!snapshot) { plan.unavailable.push(path); continue }
      const { source, fileId } = snapshot
      if (!source.includes(query)) continue
      const matches = noteReplaceMatches(path, source, query)
      if (matches.length) plan.files.push({ path, source, fileId, matches })
    }
  }
  checkScope(root, scope, signal)
  return plan
}

// A single immutable manifest stores only the two words, offsets and version fingerprints. Progress is a
// small record per file so advancing a large batch doesn't rewrite the entire manifest on every step.
// Native Web Locks serialize all windows on this origin. Without Web Locks a window owns its journal.
function storage(): Storage {
  return navigator.locks ? localStorage : sessionStorage
}
// Alternate manifest slots so a fully skipped attempt cannot discard the last undoable batch.
type Slot = 0 | 1
const slotKey = (scope: string, slot: Slot): string => slot === 0 ? scope : scope + ':alternate'
const other = (slot: Slot): Slot => slot === 0 ? 1 : 0
const headKey = (scope: string): string => scope + ':head'
function headSlot(scope: string): Slot { return storage().getItem(headKey(scope)) === '1' ? 1 : 0 }
function journalFor(scope: string, slot: Slot): Journal | null {
  const raw = storage().getItem(slotKey(scope, slot))
  if (raw == null) return null
  const j: Journal = JSON.parse(raw)
  if (j?.scope !== scope || typeof j.root !== 'string' || typeof j.id !== 'string' ||
    typeof j.query !== 'string' || !j.query || typeof j.replacement !== 'string' ||
    !Array.isArray(j.files) || !j.files.length || !j.files.every(f =>
      typeof f?.path === 'string' && typeof f.before === 'string' && typeof f.after === 'string' &&
      Array.isArray(f.offsets) && f.offsets.length && f.offsets.every((at, i) =>
        Number.isSafeInteger(at) && at >= 0 && (!i || at >= f.offsets[i - 1] + j.query.length)))) {
    throw new Error('Invalid replacement journal')
  }
  return j
}
const progressKey = (j: Journal, index: number): string => j.scope + ':' + j.id + ':' + index
const stages = new Set<Progress['stage']>(['pending', 'writing', 'applied', 'undoing', 'undone', 'changed', 'skipped', 'unsafe'])
function progressOf(j: Journal, index: number): Progress {
  const raw = storage().getItem(progressKey(j, index))
  if (raw == null) return { stage: 'pending' }
  const progress: Progress = JSON.parse(raw)
  if (!stages.has(progress?.stage)) throw new Error('Invalid replacement progress')
  return progress
}
function retained(scope: string): { slot: Slot; journal: Journal | null } {
  const slot = headSlot(scope)
  const journal = journalFor(scope, slot)
  if (journal && journal.files.every((f, i) => {
    const p = progressOf(journal, i)
    return f.unsafe || p.stage === 'changed' || p.stage === 'skipped' || (p.stage === 'pending' && p.failed)
  })) {
    const prior = journalFor(scope, other(slot))
    if (prior?.files.some((_, i) => ['applied','writing','undoing'].includes(progressOf(prior, i).stage))) {
      return { slot: other(slot), journal: prior }
    }
  }
  return { slot, journal }
}
function forgetProgress(j: Journal): void {
  for (let i = -1; i < j.files.length; i++) storage().removeItem(progressKey(j, i))
}
function checkpoint(j: Journal, index: number, stage: Progress['stage'], failed = false): void {
  storage().setItem(progressKey(j, index), JSON.stringify({ stage, failed }))
}
function directionOf(j: Journal): ReplaceBatch['direction'] {
  return storage().getItem(progressKey(j, -1)) === 'undo' ? 'undo' : 'apply'
}
function present(j: Journal): ReplaceBatch {
  return { id: j.id, root: j.root, direction: directionOf(j), files: j.files.map((file, i) => {
    const { stage, failed } = progressOf(j, i)
    const status = file.unsafe ? 'unsafe' : failed ? 'failed' : stage === 'writing' || stage === 'undoing' ? 'pending' : stage
    return { path: file.path, count: file.offsets.length, status }
  }) }
}
export function loadNoteReplaceBatch(root: string): ReplaceBatch | null {
  try {
    const { journal } = retained(scopeOf(root))
    return journal ? present(journal) : null
  } catch { return null } // Storage may be denied or corrupt. Writes still require a working journal.
}

const inFlight = new Map<string, Promise<unknown>>()
async function exclusively<T>(scope: string, task: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request(scope, task)
  const prior = inFlight.get(scope)
  const next = (prior || Promise.resolve()).then(task, task)
  inFlight.set(scope, next)
  try { return await next } finally { if (inFlight.get(scope) === next) inFlight.delete(scope) }
}


export async function applyNoteReplace(plan: ReplacePlan, replacement: string, selected: ReadonlySet<string>): Promise<ReplaceBatch> {
  return exclusively(plan.scope, async () => {
    checkScope(plan.root, plan.scope)
    const head = journalFor(plan.scope, headSlot(plan.scope))
    if (head?.id === plan.id) return present(head) // repeated submit of the same frozen preview
    if (plan.query === replacement || /[\r\n]/.test(replacement)) throw new Error('Choose a different single-line replacement')
    const files: JournalFile[] = []
    for (const file of plan.files) {
      const offsets = file.matches.filter(match => selected.has(match.id)).map(match => match.from)
      if (!offsets.length) continue
      const write = prepareLiteralReplacement(file.source, offsets, plan.query, replacement)
      files.push({ path: file.path, fileId: file.fileId, offsets, before: textFingerprint(file.source),
        after: write ? textFingerprint(write.after) : '', encoded: write?.encoded, unsafe: !write })
    }
    if (!files.length) throw new Error('No matches selected')
    const journal: Journal = { id: plan.id, root: plan.root, scope: plan.scope, query: plan.query, replacement, files }
    // Persist the plan before the first write. A quota or storage failure leaves the notes untouched.
    const previous = retained(plan.scope)
    const slot = previous.journal ? other(previous.slot) : previous.slot
    const superseded = journalFor(plan.scope, slot)
    storage().setItem(slotKey(plan.scope, slot), JSON.stringify(journal))
    storage().setItem(headKey(plan.scope), String(slot))
    if (superseded) forgetProgress(superseded)
    return execute(journal)
  })
}

async function execute(j: Journal): Promise<ReplaceBatch> {
  checkScope(j.root, j.scope)
  const reverse = directionOf(j) === 'undo'
  const pages = new Set(await amadeus.listPages()) // plugin ownership / deleted or renamed since preview
  for (let i = 0; i < j.files.length; i++) {
    checkScope(j.root, j.scope)
    const file = j.files[i]
    const { stage } = progressOf(j, i)
    if (file.unsafe || stage === 'changed' || stage === 'undone' || stage === 'skipped' || (!reverse && stage === 'applied')) continue
    if (reverse && stage === 'pending') { checkpoint(j, i, 'skipped'); continue }
    if (!pages.has(file.path) || !eligible(j.root, file.path)) { checkpoint(j, i, 'changed'); continue }
    let nextStage: Progress['stage'] = stage
    let held: Awaited<ReturnType<typeof holdLegacyForReplace>> | undefined
    let wrote = false
    try {
      await flushNoteForReplace(file.path)
      checkScope(j.root, j.scope)
      held = await holdLegacyForReplace(file.path)
      const snapshot = await readSource(file.path)
      const current = snapshot?.source
      checkScope(j.root, j.scope)
      const fingerprint = current == null ? null : textFingerprint(current)
      const expected = reverse ? file.after : file.before
      const target = reverse ? file.before : file.after
      if (current == null || file.fileId !== snapshot?.fileId || held.dirty() || hasDirtyUnifiedPath(file.path) || readDraft(j.root, file.path, undefined, () => false) || !eligible(j.root, file.path) || pluginNoteOwnership(j.root)(file.path)) {
        nextStage = 'changed'
      } else if (fingerprint === target && (stage === 'writing' || stage === 'undoing')) {
        // The renderer died or lost the acknowledgement between the CAS and its checkpoint.
        nextStage = reverse ? (stage === 'writing' ? 'skipped' : 'undone') : 'applied'
        wrote = nextStage !== 'skipped'
      } else if (fingerprint !== expected) {
        nextStage = 'changed'
      } else {
        const next = spliceNoteText(current, file.offsets, j.query, file.encoded ?? j.replacement, reverse)
        if (textFingerprint(next) !== target) throw new Error('Invalid replacement journal')
        nextStage = reverse ? 'undoing' : 'writing'
        checkpoint(j, i, nextStage)
        const result = await amadeus.writeTextFile(file.path, next, { base: expected, expectedRoot: j.root, expectedFileId: file.fileId, strictExisting: true })
        if (!result) throw new Error('The host did not acknowledge the guarded write')
        nextStage = result.ok ? reverse ? 'undone' : 'applied' : 'changed'
        wrote = result.ok
      }
    } catch {
      checkpoint(j, i, nextStage, true)
      continue
    } finally {
      const sameScope = usePageStore.getState().vaultRoot === j.root && scopeOf(j.root) === j.scope
      await held?.release(wrote && sameScope)
      if (wrote && sameScope) announceUnifiedWrite(file.path, {})
    }
    checkpoint(j, i, nextStage)
  }
  checkScope(j.root, j.scope)
  const result = present(j)
  if (result.files.some(file => file.status === 'applied' || file.status === 'undone')) {
    const obsoleteSlot = other(headSlot(j.scope))
    const obsolete = journalFor(j.scope, obsoleteSlot)
    if (obsolete) {
      storage().removeItem(slotKey(j.scope, obsoleteSlot))
      forgetProgress(obsolete)
    }
  }
  return result
}

function continueBatch(batch: ReplaceBatch, undo: boolean): Promise<ReplaceBatch> {
  const scope = scopeOf(batch.root)
  return exclusively(scope, async () => {
    checkScope(batch.root, scope)
    const slot = headSlot(scope)
    let journal = journalFor(scope, slot)
    if (journal?.id !== batch.id) {
      const previous = retained(scope)
      if (previous.journal?.id !== batch.id) throw new Error('The latest replacement batch changed')
      journal = previous.journal
      storage().setItem(headKey(scope), String(previous.slot))
    }
    if (undo) storage().setItem(progressKey(journal, -1), 'undo')
    return execute(journal)
  })
}
export const resumeNoteReplace = (batch: ReplaceBatch): Promise<ReplaceBatch> => continueBatch(batch, false)
export const undoNoteReplace = (batch: ReplaceBatch): Promise<ReplaceBatch> => continueBatch(batch, true)
