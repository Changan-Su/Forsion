/**
 * Skill packages before they reach the disk (every origin: Forsion store, store sources, the built-in skills.sh source).
 *
 * - SKILL.md must be there with a frontmatter `name` and `description`: the engine lists a skill by those two, and a
 *   package without them used to install and then be skipped without a word.
 * - The adaptation note (`.forsion-adapt.md`, read by the engine before the skill body) never comes from a package: any
 *   copy inside is dropped, and only the note the Forsion server verified for that commit is written (main.ts passes it).
 * - Scripts are counted (files under `scripts/`, script / executable extensions, executable bits) so a third-party skill
 *   that ships them is confirmed one by one before it is installed.
 * The package is rebuilt with the installer's own plan (same root, same paths), so what is checked is what gets written.
 */
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isJunkPath, MARKET_MANIFEST, planZipFiles } from '../shared/marketPackage'
import { ADAPT_FILE } from '../shared/storeSources'

const MAX_SKILL_MD = 256 * 1024
/** Extensions counted as scripts (besides anything under a `scripts/` or `bin/` folder and files with an executable bit). */
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|command|py|pyw|js|mjs|cjs|ts|mts|cts|rb|pl|php|lua|ps1|psm1|bat|cmd|exe|bin|jar|applescript|scpt)$/i
/** Uncompressed size caps (a small archive can inflate to far more; this runs before anything is confirmed). */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024, MAX_TOTAL_BYTES = 256 * 1024 * 1024

/**
 * `name` and `description` from SKILL.md's frontmatter. Accepts a BOM, CRLF, quoted values and YAML block scalars
 * (`description: >-` followed by indented lines). null = no frontmatter, or either field empty.
 */
export function skillFrontmatter(text: string): { name: string; description: string } | null {
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src)
  if (!m) return null
  const lines = m[1].split('\n')
  const out: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*)\s*:(.*)$/.exec(lines[i])
    if (!kv) continue
    const key = kv[1].toLowerCase()
    let v = kv[2].replace(/\s+#.*$/, '').trim()
    if (/^[|>][+-]?\d*$/.test(v) || v === '') {
      // Block scalar or a value on the following indented lines.
      const body: string[] = []
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1].trim() === '')) body.push(lines[++i].trim())
      v = body.join(' ').trim()
    } else if (/^[[{]/.test(v)) {
      v = '' // a YAML list / map is not text
    } else if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)) {
      try { v = JSON.parse(v) } catch { v = v.slice(1, -1) }
    } else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1).replace(/''/g, "'")
    if (!(key in out)) out[key] = typeof v === 'string' ? v.trim() : ''
  }
  return out.name && out.description ? { name: out.name, description: out.description } : null
}

const modeOf = (p: unknown): number | null => {
  if (typeof p === 'number' && Number.isFinite(p)) return p
  if (typeof p === 'string' && /^[0-7]+$/.test(p)) return parseInt(p, 8)
  return null
}
/** Is this package file a script? (`rel` is the path inside the skill folder.) */
export function isSkillScript(rel: string, unixPermissions?: unknown): boolean {
  const mode = modeOf(unixPermissions)
  return /(^|\/)(scripts|bin)\//i.test(rel) || SCRIPT_EXT.test(rel) || (mode !== null && (mode & 0o111) !== 0)
}
const isAdaptFile = (rel: string): boolean => (rel.split('/').pop() || '').toLowerCase() === ADAPT_FILE

/** `tree` = the fingerprint skillTreeHash gives the folder this package extracts to (nothing else in it). */
export interface PreparedSkill { buf: Buffer; name: string; scripts: number; files: number; tree: string }

/** Files that come and go by themselves (Finder, Windows Explorer, Python byte-code) and say nothing about an edit. */
const NOISE = /^(\.DS_Store|Thumbs\.db|desktop\.ini|__pycache__|__MACOSX)$|\.pyc$/
const noisy = (rel: string): boolean => rel.split('/').some((seg) => NOISE.test(seg) || isJunkPath(seg))
/** The same fingerprint skillTreeHash computes, over (path, content) pairs. */
function treeOf(entries: Array<{ rel: string; data: Buffer }>): string {
  const h = createHash('sha256')
  for (const f of [...entries].filter((e) => !noisy(e.rel)).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    h.update(f.rel).update('\0').update(createHash('sha256').update(f.data).digest('hex')).update('\n')
  }
  return h.digest('hex')
}

/**
 * Check a skill package and rebuild it rooted at its SKILL.md: refuses a missing / unreadable SKILL.md (`install:
 * skill-invalid`) and two entries landing on one path; drops every `.forsion-adapt.md`; writes `note` as the adaptation
 * when given. Throws before anything is written.
 */
export async function prepareSkillPackage(buf: Buffer, opts: { note?: string | null } = {}): Promise<PreparedSkill> {
  const zip = await JSZip.loadAsync(buf)
  const plan = planZipFiles(Object.values(zip.files), MARKET_MANIFEST.skill)
  const seen = new Set<string>()
  for (const p of plan) {
    const key = p.rel.toLowerCase()
    if (seen.has(key)) throw new Error('install: duplicate path in archive')
    seen.add(key)
  }
  // Case-insensitive like the installer's root finding (and the disks it writes to on macOS / Windows).
  const md = plan.find((p) => p.rel.toLowerCase() === 'skill.md')
  const entry = md && zip.file(md.name)
  if (!entry) throw new Error('install: skill-invalid')
  const raw = await entry.async('nodebuffer')
  if (raw.length > MAX_SKILL_MD) throw new Error('install: skill-invalid')
  const fm = skillFrontmatter(raw.toString('utf8'))
  if (!fm) throw new Error('install: skill-invalid')
  const out = new JSZip()
  const written: Array<{ rel: string; data: Buffer }> = []
  let scripts = 0, files = 0, total = 0
  for (const p of plan) {
    if (isAdaptFile(p.rel)) continue
    const f = zip.files[p.name]
    const declared = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    if (typeof declared === 'number' && (declared > MAX_ENTRY_BYTES || total + declared > MAX_TOTAL_BYTES)) throw new Error('install: package too large')
    if (isSkillScript(p.rel, f.unixPermissions)) scripts++
    files++
    const data = await f.async('nodebuffer')
    total += data.length
    if (data.length > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new Error('install: package too large')
    // The skill's file under the name the engine opens (SKILL.md, also on case-sensitive disks); the permission bits
    // stay (helpers stay executable).
    const rel = p === md ? 'SKILL.md' : p.rel
    out.file(rel, data, { unixPermissions: f.unixPermissions ?? undefined })
    written.push({ rel, data })
  }
  if (opts.note) {
    const note = Buffer.from(`${opts.note.trim()}\n`, 'utf8')
    out.file(ADAPT_FILE, note)
    written.push({ rel: ADAPT_FILE, data: note })
  }
  return { buf: await out.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }), name: fm.name, scripts, files, tree: treeOf(written) }
}

const MAX_TREE_FILES = 2000
const MAX_TREE_BYTES = 50 * 1024 * 1024

/**
 * Fingerprint of an installed skill folder (paths + contents, the adaptation note included). The store records it only
 * when the folder is exactly the package it installed; an automatic update only replaces a folder that still has it (the
 * user didn't edit or add anything). null = can't tell (missing, a link, or too large to read).
 */
export async function skillTreeHash(dir: string): Promise<string | null> {
  const files: Array<{ rel: string; abs: string }> = []
  const walk = async (d: string, rel: string): Promise<boolean> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (NOISE.test(e.name) || isJunkPath(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) return false
      if (e.isDirectory()) { if (!await walk(join(d, e.name), r)) return false }
      else if (e.isFile()) { files.push({ rel: r, abs: join(d, e.name) }); if (files.length > MAX_TREE_FILES) return false }
    }
    return true
  }
  try {
    if (!(await lstat(dir)).isDirectory()) return null
    if (!await walk(dir, '')) return null
  } catch { return null }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const h = createHash('sha256')
  let total = 0
  for (const f of files) {
    const data = await readFile(f.abs).catch(() => null)
    if (!data) return null
    total += data.length
    if (total > MAX_TREE_BYTES) return null
    h.update(f.rel).update('\0').update(createHash('sha256').update(data).digest('hex')).update('\n')
  }
  return h.digest('hex')
}
