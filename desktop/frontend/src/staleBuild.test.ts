import { describe, expect, it, vi } from 'vitest'
import { createStaleBuildHandler, entryScriptOf, isStaleBuildError } from './staleBuild'

const BASE = 'https://api.example.com/admin/'
const html = (entry: string): string => `<!doctype html><head><base href="/admin/"><script type="module" crossorigin src="./assets/${entry}"></script></head>`
const chunkError = new TypeError('Failed to fetch dynamically imported module: https://api.example.com/admin/assets/x-OLD.js')

function setup(opts: { current?: string | null; served?: string | Error }) {
  let t = 0
  const prompt = vi.fn()
  const fetchIndex = vi.fn(async () => {
    if (opts.served instanceof Error) throw opts.served
    return opts.served ?? html('index-OLD.js')
  })
  const handle = createStaleBuildHandler({
    currentEntry: () => opts.current === undefined ? `${BASE}assets/index-OLD.js` : opts.current,
    fetchIndex,
    base: () => BASE,
    prompt,
  }, () => t)
  return { handle, prompt, fetchIndex, advance: (ms: number) => { t += ms } }
}

describe('staleBuild', () => {
  it('recognises the chunk-load messages of each browser', () => {
    expect(isStaleBuildError(chunkError)).toBe(true)
    expect(isStaleBuildError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isStaleBuildError(new TypeError('error loading dynamically imported module: x.js'))).toBe(true)
    expect(isStaleBuildError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true)
    expect(isStaleBuildError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isStaleBuildError(undefined)).toBe(false)
  })

  it('reads the entry script from served HTML, either attribute order', () => {
    expect(entryScriptOf(html('index-NEW.js'), BASE)).toBe(`${BASE}assets/index-NEW.js`)
    expect(entryScriptOf('<script src="/admin/assets/a.js" type="module"></script>', BASE)).toBe('https://api.example.com/admin/assets/a.js')
    expect(entryScriptOf('<script>inline()</script>', BASE)).toBeNull()
  })

  it('prompts once the server serves a different entry, and again on later failures', async () => {
    const s = setup({ served: html('index-NEW.js') })
    await s.handle(chunkError)
    expect(s.prompt).toHaveBeenCalledTimes(1)
    await s.handle(chunkError)
    expect(s.prompt).toHaveBeenCalledTimes(2)
    expect(s.fetchIndex).toHaveBeenCalledTimes(1) // 确认过换版就不再取 HTML
  })

  it('stays quiet when the entry is unchanged (a network blip, not a deploy)', async () => {
    const s = setup({ served: html('index-OLD.js') })
    await s.handle(chunkError)
    expect(s.prompt).not.toHaveBeenCalled()
    await s.handle(chunkError) // 30 秒内不重查
    expect(s.fetchIndex).toHaveBeenCalledTimes(1)
    s.advance(30_000)
    await s.handle(chunkError)
    expect(s.fetchIndex).toHaveBeenCalledTimes(2)
  })

  it('stays quiet when the HTML cannot be fetched or the error is unrelated', async () => {
    const offline = setup({ served: new TypeError('Failed to fetch') })
    await offline.handle(chunkError)
    expect(offline.prompt).not.toHaveBeenCalled()
    const other = setup({ served: html('index-NEW.js') })
    await other.handle(new Error('boom'))
    expect(other.fetchIndex).not.toHaveBeenCalled()
  })

  it('retries after a short back-off when the check itself failed (deploy mid-swap)', async () => {
    const s = setup({ served: new Error('HTTP 404') })
    await s.handle(chunkError)
    await s.handle(chunkError)
    expect(s.fetchIndex).toHaveBeenCalledTimes(1)
    s.advance(5_000)
    await s.handle(chunkError)
    expect(s.fetchIndex).toHaveBeenCalledTimes(2)
  })

  it('shares one check between concurrent failures', async () => {
    const s = setup({ served: html('index-NEW.js') })
    await Promise.all([s.handle(chunkError), s.handle(chunkError), s.handle(chunkError)])
    expect(s.fetchIndex).toHaveBeenCalledTimes(1)
    expect(s.prompt).toHaveBeenCalledTimes(1)
  })

  it('does nothing in dev pages without a module entry tag', async () => {
    const s = setup({ current: null, served: html('index-NEW.js') })
    await s.handle(chunkError)
    expect(s.fetchIndex).not.toHaveBeenCalled()
  })
})
