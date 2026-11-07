/** External PDF access for file views. The source is read-only; writes can only
 * create its hidden annotation sidecar (or a timestamped recovery copy). */
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

async function paths(pdf: string): Promise<{ pdf: string; sidecar: string }> {
  if (typeof pdf !== 'string' || !path.isAbsolute(pdf) || path.extname(pdf).toLowerCase() !== '.pdf') throw new Error('Expected an absolute PDF path')
  const dir = await fs.realpath(path.dirname(pdf))
  const source = path.join(dir, path.basename(pdf))
  const st = await fs.lstat(source)
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('Expected a regular PDF file')
  return { pdf: await fs.realpath(source), sidecar: path.join(dir, `.${path.basename(pdf)}.annot.json`) }
}

export async function readExternalPdf(pdf: string, annotations = false): Promise<Uint8Array | null> {
  const p = await paths(pdf)
  let f
  try {
    f = await fs.open(annotations ? p.sidecar : p.pdf, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    if (!(await f.stat()).isFile()) throw new Error('Expected a regular file')
    return new Uint8Array(await f.readFile())
  } catch (e) {
    if (annotations && (e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  } finally { await f?.close() }
}

export async function writeExternalPdfAnnotations(pdf: string, bytes: Uint8Array, backup?: number): Promise<void> {
  const p = await paths(pdf)
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected bytes')
  if (backup !== undefined && (!Number.isSafeInteger(backup) || backup <= 0)) throw new Error('Invalid recovery timestamp')
  const dest = backup === undefined ? p.sidecar : `${p.sidecar}.broken-${backup}`
  const st = await fs.lstat(dest).catch((e) => { if (e.code !== 'ENOENT') throw e; return null })
  if (st && (!st.isFile() || st.isSymbolicLink())) throw new Error('Expected a regular sidecar')
  const tmp = `${dest}.tmp-${randomUUID()}`
  try {
    await fs.writeFile(tmp, bytes, { flag: 'wx' })
    await fs.rename(tmp, dest)
  } finally { await fs.unlink(tmp).catch(() => {}) }
}

/** Destination is chosen in the native save dialog. The original remains read-only. */
export async function exportExternalPdfCopy(pdf: string, dest: string, bytes: Uint8Array): Promise<void> {
  const source = await paths(pdf)
  const target = await fs.realpath(dest).catch((e) => { if (e.code !== 'ENOENT') throw e; return path.resolve(dest) })
  const original = await fs.stat(source.pdf)
  const existing = await fs.stat(target).catch((e) => { if (e.code !== 'ENOENT') throw e; return null })
  if (target === source.pdf || (existing && existing.dev === original.dev && existing.ino === original.ino)) throw new Error('Cannot overwrite the source PDF')
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected bytes')
  const tmp = `${dest}.tmp-${randomUUID()}`
  try { await fs.writeFile(tmp, bytes, { flag: 'wx' }); await fs.rename(tmp, dest) }
  finally { await fs.unlink(tmp).catch(() => {}) }
}
