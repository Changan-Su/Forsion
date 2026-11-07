/** 胶囊 preload 为了打成单文件,把通道名和流式转写桥抄了一份(见 dictationPreload.ts 文件头):这里钉住它们没漂。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DICTATION_CAPSULE_CHANNELS } from '../shared/dictation'

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8')

describe('dictation capsule preload', () => {
  const capsule = read('dictationPreload.ts')
  it('uses the capsule channels from shared/dictation.ts', () => {
    for (const [k, v] of Object.entries(DICTATION_CAPSULE_CHANNELS)) expect(capsule).toContain(`${k}: '${v}'`)
  })
  it('keeps the same streaming bridge as the main preload', () => {
    const grab = (src: string) => {
      const start = src.indexOf('const openVoiceInput: OpenVoiceInput')
      return src.slice(start, src.indexOf('\n}\n', start) + 2)
    }
    const mine = grab(capsule)
    expect(mine.length).toBeGreaterThan(200)
    expect(mine).toBe(grab(read('preload.ts')))
  })
  it('imports only types at runtime-shared boundaries (single-file bundle)', () => {
    const imports = capsule.split('\n').filter((l) => l.startsWith('import '))
    expect(imports.filter((l) => !l.startsWith('import type') && !l.includes("from 'electron'"))).toEqual([])
  })
})
