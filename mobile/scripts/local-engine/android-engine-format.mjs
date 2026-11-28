// The "This phone" engine package format, the producer half (mobile/android/local-engine/README.md, "Signature").
// The consumer half is EngineSignature.java; EngineSignatureTest reads the constants below and checks they match.
//
// forsion-signed.json = { name, version, line, schemaFiles, schemaFingerprint, files: { path: [sha256hex, size] } }
// forsion-signed.sig  = base64 Ed25519 over CONTEXT + the exact bytes of forsion-signed.json (verified before parsing).
import { createHash, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const CONTEXT = 'forsion-android-engine-v1\n'
export const SIGNED_FILE = 'forsion-signed.json'
export const SIG_FILE = 'forsion-signed.sig'
export const MAX_FILES = 20000
export const MAX_BYTES = 400 * 1024 * 1024
// Every file of the engine that creates or changes tables. The fingerprint is over these; the packer refuses a dist
// with DDL anywhere else (ddlOutsideSchema), so a new place that migrates cannot slip past the rollback rule.
export const SCHEMA_FILES = [
  'dist/adapters/standalone/multiAccountSqliteHost.js',
  'dist/core/dialectDDL.js',
  'dist/db/migrate.js',
  'dist/db/schemaStandalone.js',
]
export const DDL = /\b(?:CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|(?:UNIQUE\s+)?INDEX|VIRTUAL\s+TABLE|TRIGGER|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)|user_version)\b/

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** sha256 hex of the sorted "path:sha256\n" lines (same as EngineSignature.fingerprint). */
export function fingerprint(schemaFiles, files) {
  const lines = [...schemaFiles].sort().map((p) => `${p}:${files[p][0]}\n`).join('')
  return sha256(Buffer.from(lines, 'utf8'))
}

/** dist .js files (relative to root) other than the schema files whose text contains DDL. */
export function ddlOutsideSchema(root) {
  const hits = []
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && /\.m?js$/.test(e.name) && !SCHEMA_FILES.includes(r) && DDL.test(readFileSync(path.join(root, r), 'utf8'))) hits.push(r)
    }
  }
  walk('dist')
  return hits
}

/** Builds the signed table for exactly these files (relative paths) under root, and signs it. */
export function signTable(root, rels, { name, version, line }, privateKey) {
  const files = {}
  for (const r of [...rels].sort()) {
    const b = readFileSync(path.join(root, r))
    files[r] = [sha256(b), b.length]
  }
  for (const s of SCHEMA_FILES) if (!files[s]) throw new Error(`schema file ${s} is not in the package`)
  const table = { name, version, line, schemaFiles: SCHEMA_FILES, schemaFingerprint: fingerprint(SCHEMA_FILES, files), files }
  const bytes = Buffer.from(JSON.stringify(table), 'utf8')
  const sig = edSign(null, Buffer.concat([Buffer.from(CONTEXT, 'utf8'), bytes]), privateKey).toString('base64')
  return { bytes, sig, table }
}

/** Raw 32-byte hex of an Ed25519 public key (PEM / KeyObject). */
const asPublic = (k) => (k?.type === 'public' ? k : createPublicKey(k))
export const rawPublicHex = (pub) => asPublic(pub).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex')

const RELEASE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/**
 * The Node mirror of EngineSignature.verify for a directory (the packer and CI run it on the unpacked tarball).
 * Returns null when fine, otherwise the reason.
 */
export function verifyDir(root, publicKey, { name, version, line }) {
  let bytes, sig
  try {
    bytes = readFileSync(path.join(root, SIGNED_FILE))
    sig = Buffer.from(readFileSync(path.join(root, SIG_FILE), 'ascii').trim(), 'base64')
  } catch { return 'missing signature files' }
  if (!edVerify(null, Buffer.concat([Buffer.from(CONTEXT, 'utf8'), bytes]), asPublic(publicKey), sig)) return 'bad signature'
  const t = JSON.parse(bytes.toString('utf8'))
  if (t.name !== name) return `name ${t.name}`
  if (!RELEASE.test(t.version) || (version && t.version !== version)) return `version ${t.version}`
  if (t.line !== line) return `line ${t.line}`
  const entries = Object.entries(t.files)
  if (entries.length > MAX_FILES) return 'too many files'
  if (entries.reduce((a, [, [, n]]) => a + n, 0) > MAX_BYTES) return 'too large'
  if (fingerprint(t.schemaFiles, t.files) !== t.schemaFingerprint) return 'schema fingerprint'
  const seen = new Set()
  const walk = (rel) => {
    for (const e of readdirSync(path.join(root, rel || '.'))) {
      const r = rel ? `${rel}/${e}` : e
      const st = lstatSync(path.join(root, r))
      if (st.isDirectory()) { const bad = walk(r); if (bad) return bad; continue }
      if (!st.isFile()) return `not a regular file: ${r}`
      if (!rel && (e === SIGNED_FILE || e === SIG_FILE)) continue
      const want = t.files[r]
      if (!want) return `not in the table: ${r}`
      const b = readFileSync(path.join(root, r))
      if (b.length !== want[1] || sha256(b) !== want[0]) return `content ${r}`
      seen.add(r)
    }
    return null
  }
  const bad = walk('')
  if (bad) return bad
  if (seen.size !== entries.length) return `missing ${entries.length - seen.size} files`
  return null
}
