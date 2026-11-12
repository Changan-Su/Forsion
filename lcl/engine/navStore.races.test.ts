import { describe, expect, it, vi } from 'vitest'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('navigation restoration transactions', () => {
  it('an asynchronous back in one View does not swallow another View navigation', async () => {
    vi.resetModules()
    const { useNav } = await import('./navStore')
    const n = useNav.getState(), pending = deferred()
    n.record('left', { key: 'a', restore: () => pending.promise })
    n.record('left', { key: 'b', restore: () => undefined })
    n.record('right', { key: 'x', restore: () => undefined })
    n.back('left')
    n.record('right', { key: 'y', restore: () => undefined })
    pending.resolve()
    await pending.promise
    expect(useNav.getState().stacks.right.entries.map(e => e.key)).toEqual(['x', 'y'])
  })

  it('late completion of an earlier back cannot replace the most recent destination', async () => {
    vi.resetModules()
    const { useNav } = await import('./navStore')
    const n = useNav.getState(), slow = deferred(), fast = deferred()
    let shown = 'c'
    n.record('view', { key: 'a', restore: async () => { await fast.promise; shown = 'a' } })
    n.record('view', { key: 'b', restore: async () => { await slow.promise; shown = 'b' } })
    n.record('view', { key: 'c', restore: () => { shown = 'c' } })
    n.back('view')
    n.back('view')
    fast.resolve()
    await fast.promise
    slow.resolve()
    await slow.promise
    await vi.waitFor(() => expect(shown).toBe('a'))
    expect(useNav.getState().stacks.view.idx).toBe(0)
  })

  it('a throwing restore does not consume history or disable future recording', async () => {
    vi.resetModules()
    const { useNav } = await import('./navStore')
    const n = useNav.getState()
    n.record('view', { key: 'a', restore: () => { throw new Error('Missing file') } })
    n.record('view', { key: 'b', restore: () => undefined })
    try { n.back('view') } catch { /* negative control: old implementation throws */ }
    await Promise.resolve()
    expect(useNav.getState().stacks.view.idx).toBe(1)
    n.record('view', { key: 'c', restore: () => undefined })
    expect(useNav.getState().stacks.view.entries.map(e => e.key)).toEqual(['a', 'b', 'c'])
  })

  it('Back, Back, Forward restarts an aborted restore to the latest requested destination', async () => {
    vi.resetModules()
    const { useNav } = await import('./navStore')
    const n = useNav.getState(), slow = deferred(); let shown = 'c', attempts = 0
    n.record('view', { key: 'a', restore: () => { shown = 'a' } })
    n.record('view', { key: 'b', restore: async context => {
      attempts++
      if (attempts === 1) await slow.promise
      context?.signal.throwIfAborted()
      shown = 'b'
    } })
    n.record('view', { key: 'c', restore: () => { shown = 'c' } })
    n.back('view'); n.back('view'); n.forward('view')
    slow.resolve(); await slow.promise
    await vi.waitFor(() => expect(shown).toBe('b'))
    expect(attempts).toBe(2)
    expect(useNav.getState().stacks.view).toMatchObject({ idx: 1, error: false })
  })
  it('a restore that changes content before failing rolls content back with the cursor', async () => {
    vi.resetModules()
    const { useNav } = await import('./navStore')
    const n = useNav.getState(); let shown = 'chat'
    n.record('view', { key: 'note', restore: async () => { shown = 'note-loading'; throw new Error('Missing note') } })
    n.record('view', { key: 'chat', restore: () => { shown = 'chat' } })
    n.back('view')
    await vi.waitFor(() => expect(useNav.getState().stacks.view.idx).toBe(1))
    expect(shown).toBe('chat')
    expect(useNav.getState().stacks.view.error).toBe(true)
  })
  it('a new request during asynchronous rollback still wins', async () => {
    vi.resetModules()
    const { useNav } = await import('./navStore')
    const n = useNav.getState(), restoringSource = deferred(); let shown = 'c', rollbackStarted = false
    n.record('view', { key: 'a', restore: () => { shown = 'a' } })
    n.record('view', { key: 'b', restore: () => { shown = 'b-loading'; throw new Error('Missing') } })
    n.record('view', { key: 'c', restore: async context => {
      rollbackStarted = true; await restoringSource.promise
      if (context?.isCurrent()) shown = 'c'
    } })
    n.back('view')
    expect(rollbackStarted).toBe(true)
    n.back('view'); restoringSource.resolve()
    await vi.waitFor(() => expect(shown).toBe('a'))
    expect(useNav.getState().stacks.view).toMatchObject({ idx: 0, error: false })
  })
  it('an unavailable rollback source stops once and releases the View transaction', async () => {
    vi.resetModules()
    const { useNav } = await import('./navStore')
    const n = useNav.getState(), missing = vi.fn(() => { throw new Error('Missing source too') })
    n.record('view', { key: 'a', restore: () => { throw new Error('Missing target') } })
    n.record('view', { key: 'b', restore: missing }); n.back('view')
    await Promise.resolve()
    expect(missing).toHaveBeenCalledTimes(1)
    expect(useNav.getState().stacks.view).toMatchObject({ idx: 1, error: true })
    n.record('view', { key: 'c', restore: () => undefined })
    expect(useNav.getState().stacks.view.entries.at(-1)?.key).toBe('c')
  })
})

describe('Space history ownership', () => {
  it('keeps same-named Views separate across Spaces and ignores layout teardown', async () => {
    vi.resetModules()
    const { useNav, beginNavSpace, finishNavSpace } = await import('./navStore')
    const n = useNav.getState(), restore = () => undefined
    n.record('view#1', { key: 'a1', restore }); n.record('view#1', { key: 'a2', restore })
    beginNavSpace('A', 'B'); n.drop('view#1'); n.reset(); finishNavSpace(['view#1'])
    expect(useNav.getState().stacks['view#1']).toBeUndefined()
    n.record('view#1', { key: 'b1', restore }); n.record('view#1', { key: 'b2', restore })
    beginNavSpace('B', 'A'); n.reset(); finishNavSpace(['view#1'])
    expect(useNav.getState().stacks['view#1'].entries.map(e => e.key)).toEqual(['a1', 'a2'])
    n.drop('view#1'); beginNavSpace('A', 'B'); finishNavSpace(['view#1'])
    expect(useNav.getState().stacks['view#1'].entries.map(e => e.key)).toEqual(['b1', 'b2'])
    beginNavSpace('B', 'A'); finishNavSpace(['view#1'])
    expect(useNav.getState().stacks['view#1']).toBeUndefined()
  })
  it('aborts an in-flight restore before another Space reuses the same View id', async () => {
    vi.resetModules()
    const { useNav, beginNavSpace, finishNavSpace } = await import('./navStore')
    const n = useNav.getState(), pending = deferred(); let shown = 'current'
    n.record('view', { key: 'old', restore: async context => { await pending.promise; if (context?.isCurrent()) shown = 'old' } })
    n.record('view', { key: 'current', restore: () => undefined }); n.back('view')
    beginNavSpace('old-space', 'new-space'); finishNavSpace(['view'])
    n.record('view', { key: 'new', restore: () => undefined }); shown = 'new'
    pending.resolve(); await pending.promise
    expect(shown).toBe('new'); expect(useNav.getState().stacks.view.entries.map(e => e.key)).toEqual(['new'])
  })
})
