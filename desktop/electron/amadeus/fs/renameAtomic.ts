import { promises as fs } from 'node:fs'

/** Windows readers/virus scanners can briefly deny replacement of an open file.
 * Retry the same atomic rename; never unlink the destination or fall back to copy. */
export async function renameAtomic(from: string, to: string, platform: NodeJS.Platform = process.platform, rename = fs.rename, pause = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))): Promise<void> {
  const delays = [20, 50, 100, 200]
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return }
    catch (error: any) {
      if (platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= delays.length) throw error
      await pause(delays[attempt])
    }
  }
}
