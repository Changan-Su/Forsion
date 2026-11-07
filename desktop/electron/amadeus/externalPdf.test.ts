import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exportExternalPdfCopy, readExternalPdf, writeExternalPdfAnnotations } from './externalPdf'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((p) => fs.rm(p, { recursive: true, force: true }))) })
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'external-pdf-')); homes.push(home)
  const pdf = path.join(home, 'Paper.PDF')
  await fs.writeFile(pdf, '%PDF-source')
  return { home, pdf, sidecar: path.join(home, '.Paper.PDF.annot.json') }
}
describe('external PDF source and sidecar', () => {
  it('reads without a vault, writes only the sidecar, and preserves recovery copies', async () => {
    const f = await fixture(), bytes = new TextEncoder().encode('{"version":1}')
    expect(new TextDecoder().decode((await readExternalPdf(f.pdf))!)).toBe('%PDF-source')
    expect(await readExternalPdf(f.pdf, true)).toBeNull()
    await writeExternalPdfAnnotations(f.pdf, bytes)
    expect(await readExternalPdf(f.pdf, true)).toEqual(bytes)
    await writeExternalPdfAnnotations(f.pdf, bytes, 123)
    expect(await fs.readFile(`${f.sidecar}.broken-123`, 'utf8')).toBe('{"version":1}')
    expect(await fs.readFile(f.pdf, 'utf8')).toBe('%PDF-source')
    expect((await fs.readdir(f.home)).some((s) => s.includes('.tmp-'))).toBe(false)
  })
  it('rejects non-PDF sources, directories and symlink sidecars without touching their target', async () => {
    const f = await fixture(), secret = path.join(f.home, 'secret')
    await fs.writeFile(secret, 'keep')
    await expect(readExternalPdf(secret)).rejects.toThrow()
    await fs.symlink(secret, f.sidecar)
    await expect(readExternalPdf(f.pdf, true)).rejects.toThrow()
    await expect(writeExternalPdfAnnotations(f.pdf, new Uint8Array([1]))).rejects.toThrow()
    expect(await fs.readFile(secret, 'utf8')).toBe('keep')
  })
  it('refuses to overwrite a case alias of the source on case-insensitive volumes', async ({ skip }) => {
    const f = await fixture()
    const alias = path.join(f.home, 'paper.pdf')
    if (!(await fs.stat(alias).catch(() => null))) { skip(); return }
    await expect(exportExternalPdfCopy(alias, f.pdf, new Uint8Array([8]))).rejects.toThrow('source PDF')
    expect(await fs.readFile(f.pdf, 'utf8')).toBe('%PDF-source')
  })
  it('exports a copy and refuses the original even through a symlink destination', async () => {
    const f = await fixture(), bytes = new Uint8Array([1, 2])
    const dest = path.join(f.home, 'copy.pdf')
    await exportExternalPdfCopy(f.pdf, dest, bytes)
    expect(new Uint8Array(await fs.readFile(dest))).toEqual(bytes)
    await expect(exportExternalPdfCopy(f.pdf, f.pdf, bytes)).rejects.toThrow('source PDF')
    const link = path.join(f.home, 'alias.pdf'); await fs.symlink(f.pdf, link)
    await expect(exportExternalPdfCopy(f.pdf, link, bytes)).rejects.toThrow('source PDF')
    expect(await fs.readFile(f.pdf, 'utf8')).toBe('%PDF-source')
  })
})
