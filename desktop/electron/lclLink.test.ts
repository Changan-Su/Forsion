import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { ensureLclLink } = createRequire(import.meta.url)('../build/link-lcl.cjs')

describe('LCL dependency link on fresh Windows checkouts', () => {
  let root: string, link: string, target: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forsion-lcl-link-'))
    link = join(root, 'node_modules')
    target = join(root, 'dependencies')
    mkdirSync(target)
    writeFileSync(join(target, 'marker'), 'dependency')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  it('creates a usable directory link and is idempotent', () => {
    ensureLclLink(link, target)
    ensureLclLink(link, target)
    expect(statSync(link).isDirectory()).toBe(true)
    expect(readFileSync(join(link, 'marker'), 'utf8')).toBe('dependency')
  })
  it('repairs the text placeholder from core.symlinks=false', () => {
    writeFileSync(link, '../desktop/node_modules')
    ensureLclLink(link, target)
    expect(readFileSync(join(link, 'marker'), 'utf8')).toBe('dependency')
  })
  it('repairs a dangling directory link without deleting dependencies', () => {
    symlinkSync(join(root, 'missing'), link, process.platform === 'win32' ? 'junction' : 'dir')
    ensureLclLink(link, target)
    expect(readFileSync(join(link, 'marker'), 'utf8')).toBe('dependency')
  })
  it('preserves real directories and rejects unrelated files', () => {
    mkdirSync(link)
    writeFileSync(join(link, 'user-file'), 'keep')
    ensureLclLink(link, target)
    expect(readFileSync(join(link, 'user-file'), 'utf8')).toBe('keep')
    const other = join(root, 'unrelated')
    writeFileSync(other, 'keep')
    expect(() => ensureLclLink(other, target)).toThrow(/Refusing/)
    expect(readFileSync(other, 'utf8')).toBe('keep')
  })
})
