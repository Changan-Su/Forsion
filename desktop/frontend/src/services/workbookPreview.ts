import type { WorkbookPreview } from './workbookParser'
// Keep limits here too so the main thread never imports the parser bundle.
const MAX_BYTES = 20 * 1024 * 1024
const TIMEOUT_MS = 5000
export function loadWorkbook(bytes: Uint8Array, signal?: AbortSignal): Promise<WorkbookPreview> {
  if (bytes.byteLength > MAX_BYTES) return Promise.reject(new Error('workbook-too-large'))
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workbook.worker.ts', import.meta.url), { type: 'module' })
    const finish = (error?: Error, value?: WorkbookPreview) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate()
      if (error) reject(error); else resolve(value!)
    }
    const abort = () => finish(new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('workbook-timeout')), TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = () => finish(new Error('workbook-invalid'))
    worker.onmessage = event => event.data.error ? finish(new Error(event.data.error)) : finish(undefined, event.data.result)
    // Copy before transfer: other previews/downloads still own the original bytes.
    const copy = bytes.slice(); worker.postMessage(copy, [copy.buffer])
  })
}
