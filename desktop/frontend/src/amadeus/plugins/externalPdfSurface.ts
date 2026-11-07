import type { AmadeusApi } from '@amadeus-shared/ipc'
import type { PluginFileIO } from './types'

/** The mount owns access to precisely one source and its sidecar. ctx.app's
 * general file methods keep their existing vault boundary. */
export function externalPdfSurface(pdfPath: string, bridge: Pick<AmadeusApi, 'readExternalPdf' | 'writeExternalPdfAnnotations' | 'exportExternalPdf'>): { io: PluginFileIO; dispose(): void } {
  let live = true
  const pdf = pdfPath.replace(/\\/g, '/')
  const slash = pdf.lastIndexOf('/')
  const sidecar = `${pdf.slice(0, slash + 1)}.${pdf.slice(slash + 1)}.annot.json`
  const check = (): void => { if (!live) throw new Error('File view closed') }
  return {
    io: {
      async saveCopy(name, bytes) {
        check()
        if (!bridge.exportExternalPdf) throw new Error('PDF export unavailable')
        return bridge.exportExternalPdf(pdfPath, name, bytes)
      },
      async readBytes(p) {
        check()
        const n = p.replace(/\\/g, '/')
        if (n !== pdf && n !== sidecar) throw new Error('Path outside this file view')
        if (!bridge.readExternalPdf) throw new Error('External PDFs unavailable')
        const bytes = await bridge.readExternalPdf(pdfPath, n === sidecar)
        check()
        return bytes
      },
      async writeBytes(p, bytes) {
        check()
        const n = p.replace(/\\/g, '/')
        const backup = n.startsWith(`${sidecar}.broken-`) ? n.slice(sidecar.length + 8) : ''
        if (n !== sidecar && !/^[1-9]\d*$/.test(backup)) throw new Error('Only the annotation sidecar is writable')
        if (!bridge.writeExternalPdfAnnotations) throw new Error('External annotations unavailable')
        await bridge.writeExternalPdfAnnotations(pdfPath, bytes, backup ? Number(backup) : undefined)
      },
    },
    dispose() { live = false },
  }
}
