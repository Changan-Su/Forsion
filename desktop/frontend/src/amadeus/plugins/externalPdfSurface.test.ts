import { describe, expect, it, vi } from 'vitest'
import { externalPdfSurface } from './externalPdfSurface'

describe('per-file external PDF access', () => {
  it.each(['/tmp/Paper.pdf', String.raw`C:\docs\Paper.pdf`])('scopes source, sidecar and recovery for %s', async (pdf) => {
    const readExternalPdf = vi.fn(async () => new Uint8Array([1]))
    const writeExternalPdfAnnotations = vi.fn(async () => {})
    const s = externalPdfSurface(pdf, { readExternalPdf, writeExternalPdfAnnotations })
    const n = pdf.replace(/\\/g, '/'), i = n.lastIndexOf('/'), sidecar = `${n.slice(0, i + 1)}.${n.slice(i + 1)}.annot.json`
    await s.io.readBytes(n); await s.io.readBytes(sidecar)
    expect(readExternalPdf.mock.calls).toEqual([[pdf, false], [pdf, true]])
    await expect(s.io.readBytes('/private/other.pdf')).rejects.toThrow('outside')
    await expect(s.io.writeBytes(pdf, new Uint8Array())).rejects.toThrow('sidecar')
    await s.io.writeBytes(`${sidecar}.broken-123`, new Uint8Array([2]))
    expect(writeExternalPdfAnnotations).toHaveBeenCalledWith(pdf, new Uint8Array([2]), 123)
    s.dispose()
    await expect(s.io.readBytes(n)).rejects.toThrow('closed')
    await expect(s.io.writeBytes(sidecar, new Uint8Array())).rejects.toThrow('closed')
  })
})
