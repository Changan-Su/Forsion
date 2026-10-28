import { parseWorkbook } from './workbookParser'
self.onmessage = (event: MessageEvent<Uint8Array>) => {
  try { self.postMessage({ result: parseWorkbook(event.data) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'workbook-invalid' }) }
}
