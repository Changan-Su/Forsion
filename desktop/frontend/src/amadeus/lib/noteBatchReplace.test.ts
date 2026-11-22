import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setContentStorageScope } from '@lcl/engine/contentStorageScope'
import { textFingerprint } from '@amadeus-shared/writeConflict'
import { prepareLiteralReplacement, noteReplaceMatches } from './noteReplaceMatches'

const world = vi.hoisted(() => ({
  root: '/v', ids: new Map<string, string>(), disk: new Map<string, string>(), pending: new Map<string, string>(),
  managed: new Set<string>(), locked: new Set<string>(), notify: vi.fn(), beforeWrite: vi.fn<(path: string) => void>(),
  afterWrite: vi.fn<(path: string) => void>(),
}))
vi.mock('../api', () => ({ amadeus: {
  listPages: async () => [...world.disk.keys()],
  readNoteReplaceSource: async (p: string) => world.disk.has(p) ? { source: world.disk.get(p)!, fileId: world.ids.get(p) } : null,
  readTextFile: async (p: string) => world.disk.get(p) ?? null,
  writeTextFile: async (p: string, text: string, opts: { base: string; expectedRoot: string; strictExisting: boolean }) => {
    world.beforeWrite(p)
    expect(opts.strictExisting).toBe(true)
    if (opts.expectedRoot !== world.root) throw Error('wrong vault')
    const current = world.disk.get(p) ?? null
    if (current == null || textFingerprint(current) !== opts.base) return { ok: false, current }
    world.disk.set(p, text)
    world.afterWrite(p)
    return { ok: true }
  },
} }))
vi.mock('../plugins/pluginStore', () => ({pluginNoteOwnership: () => (path: string) => world.managed.has(path)}))
vi.mock('../store/pageStore', () => ({
  usePageStore: { getState: () => ({ vaultRoot: world.root }) },
  flushNoteForReplace: async (path?: string) => {
    for (const [p, text] of world.pending) if (!path || path === p) { world.disk.set(p, text); world.pending.delete(p) }
  },
  holdLegacyForReplace: async () => ({ dirty: () => false, release: async () => {} }),
}))
vi.mock('../unified/lifecycle', () => ({ announceUnifiedWrite: world.notify, hasDirtyUnifiedPath: (p: string) => world.pending.has(p) }))
vi.mock('../unified/viewMemory', () => ({ readNoteLocked: (_: string, p: string) => world.locked.has(p) }))
vi.mock('../unified/writeSafety', () => ({ readDraft: () => null }))
import { previewNoteReplace, applyNoteReplace, resumeNoteReplace, undoNoteReplace, loadNoteReplaceBatch } from './noteBatchReplace'

beforeEach(() => {
  world.root = '/v'
  world.managed.clear(); world.ids.clear(); world.disk.clear(); world.pending.clear(); world.locked.clear()
  world.beforeWrite.mockReset(); world.afterWrite.mockReset(); world.notify.mockClear()
  setContentStorageScope('account-A')
  const map = new Map<string,string>()
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) }
  vi.stubGlobal('sessionStorage',storage); vi.stubGlobal('localStorage',storage)
  vi.stubGlobal('location',{ pathname: '/unit/A/' }); vi.stubGlobal('navigator',{})
})
afterEach(() => { vi.unstubAllGlobals(); setContentStorageScope('') })

describe('literal Markdown replacement', () => {
  it('takes UTF-16 offsets only from body leaves, including labels and quoted paragraphs', () => {
    const source = ['\ufeff---', 'title: old', '---', '😀**old** [old](old "old") ![old](old) [[old|old]] `old` $old$',
      '> old', '> old', '', '~~~', 'old', '~~~', '', '<!-- old -->', '[ref]: old', '',
      'https://old.example <code>old</code> old ^old', '', 'old &amp; old'].join('\r\n')
    const matches = noteReplaceMatches('a.md', source, 'old')
    expect(matches.map(m => source.slice(m.from,m.to))).toEqual(Array(7).fill('old'))
    expect(matches.filter(m=>m.quote)).toHaveLength(2)
    expect(matches[0].from).toBe(source.indexOf('old**'))
    expect(matches[1].from).toBe(source.indexOf('[old]')+1)
    expect(noteReplaceMatches('a.md', source, 'amp')).toEqual([])
    expect(noteReplaceMatches('a.md', source, '>')).toEqual([])
  })
  it('preserves visible punctuation, link destinations, and paragraph structure at line start', () => {
    const unsafe = prepareLiteralReplacement('old# Title', [0], 'old', '')
    expect(unsafe).toBeNull()
    const link = prepareLiteralReplacement('[old](original)', [1], 'old', '](other)')
    expect(link?.after).toBe('[\\]\\(other\\)](original)')
    expect(prepareLiteralReplacement('old. item', [0], 'old', '1')?.after).toBe('&#49;. item')
    expect(prepareLiteralReplacement('old', [0], 'old', '0.20 mg/L')?.after).toBe('0.20 mg/L')
  })
  it('protects syntax interpreted by the editor after Markdown decoding', () => {
    for (const replacement of ['[[notes]]','![[note.png]]','^anchor','[!tip|blue]', '$x$']) {
      expect(prepareLiteralReplacement('old', [0], 'old', replacement)).toBeNull()
    }
    expect(noteReplaceMatches('a.md','> [!tip|🚀 blue wide] prose', 'wide')).toEqual([])
    expect(noteReplaceMatches('a.md','> [!tip|blue] prose', 'blue')).toEqual([])
    expect(prepareLiteralReplacement('Visible old**Missing**]] tail', [8], 'old', '[[')).toBeNull()
    expect(prepareLiteralReplacement('old is normal', [0], 'old', '$20')?.after).toBe('$20 is normal')
  })
  it('skips reserved paths, plugin metadata and newer formats but supports legacy prose', () => {
    expect(noteReplaceMatches('Demo.dashboard.md', 'old', 'old')).toEqual([])
    expect(noteReplaceMatches('Demo.md', '---\nmindmap: tree\n---\nold', 'old')).toEqual([])
    expect(noteReplaceMatches('Demo.md', '---\namadeus_schema: amadeus.page/9\n---\nold', 'old')).toEqual([])
    expect(noteReplaceMatches('Demo.fd.md', '---\namadeus_page: page1\n---\n<!-- a old -->\n\nold', 'old')).toHaveLength(1)
    expect(noteReplaceMatches('a.md', '[old][] [old][r]\n\n[old]: /old\n[r]: /old', 'old')).toHaveLength(1)
  })
})

const selected = (p: Awaited<ReturnType<typeof previewNoteReplace>>) => new Set(p.files.flatMap(f => f.matches.filter(m=>!m.quote).map(m=>m.id)))

describe('guarded note replacement and recovery', () => {
  it('writes four occurrences across two homonymous files, keeps citation, CRLF, formatting and post-edit on undo', async () => {
    const crlf = '\ufeff---\r\ntitle: old\r\n---\r\n😀 **old** + old\r\n'
    world.disk.set('A/n.md', crlf); world.disk.set('B/n.md', 'old and old'); world.disk.set('quote.md','> old')
    const p = await previewNoteReplace('/v','old')
    expect(p.files).toHaveLength(3)
    const batch = await applyNoteReplace(p,'new',selected(p))
    expect(batch.files.map(f=>[f.count,f.status])).toEqual([[2,'applied'],[2,'applied']])
    expect(world.disk.get('A/n.md')).toBe('\ufeff---\r\ntitle: old\r\n---\r\n😀 **new** + new\r\n')
    expect(world.disk.get('quote.md')).toBe('> old')
    world.pending.set('B/n.md','new and new plus later input')
    const undo = await undoNoteReplace(loadNoteReplaceBatch('/v')!)
    expect(undo.files.map(f=>f.status)).toEqual(['undone','changed'])
    expect(world.disk.get('A/n.md')).toBe(crlf)
    expect(world.disk.get('B/n.md')).toBe('new and new plus later input')
  })
  it('recovers a lost write acknowledgement, never reapplies it, and undoes adjacent deletions', async () => {
    world.disk.set('a.md','oldold'); world.disk.set('b.md','old')
    const p = await previewNoteReplace('/v','old')
    world.afterWrite.mockImplementationOnce(()=>{throw Error('ack lost')})
    const initial = await applyNoteReplace(p,'',selected(p))
    expect(initial.files.map(f=>f.status)).toEqual(['failed','applied'])
    const resumed = await resumeNoteReplace(loadNoteReplaceBatch('/v')!)
    expect(resumed.files.map(f=>f.status)).toEqual(['applied','applied'])
    expect(world.beforeWrite).toHaveBeenCalledTimes(2)
    expect((await undoNoteReplace(resumed)).files.map(f=>f.status)).toEqual(['undone','undone'])
    expect(world.disk.get('a.md')).toBe('oldold')
  })
  it('flushes unsaved input for discovery, rejects a stale preview, skips a locked and a vanished note', async () => {
    for (const p of ['a.md','b.md','c.md','d.md']) world.disk.set(p,'old')
    world.pending.set('e.md','unsaved old'); world.locked.add('d.md')
    const p = await previewNoteReplace('/v','old')
    expect(p.files.map(f=>f.path)).toEqual(['a.md','b.md','c.md','e.md'])
    world.pending.set('a.md','edited old'); world.locked.add('b.md'); world.disk.delete('c.md')
    const b = await applyNoteReplace(p,'new',selected(p))
    expect(b.files.map(f=>f.status)).toEqual(['changed','changed','changed','applied'])
    expect(world.disk.get('a.md')).toBe('edited old'); expect(world.disk.has('c.md')).toBe(false)
  })
  it('will not take credit for a concurrent writer, cross account/vault, or replace previous undo on empty input', async () => {
    world.disk.set('a.md','old')
    const p = await previewNoteReplace('/v','old')
    world.beforeWrite.mockImplementationOnce(path=>world.disk.set(path,'new'))
    expect((await applyNoteReplace(p,'new',selected(p))).files[0].status).toBe('changed')
    const fresh = await previewNoteReplace('/v','new')
    await expect(applyNoteReplace(fresh,'x',new Set())).rejects.toThrow()
    expect(loadNoteReplaceBatch('/v')?.id).toBe(p.id)
    setContentStorageScope('other')
    expect(loadNoteReplaceBatch('/v')).toBeNull()
    await expect(applyNoteReplace(fresh,'x',selected(fresh))).rejects.toThrow()
    world.root = '/changed'
    await expect(previewNoteReplace('/v','new')).rejects.toThrow()
    expect(world.disk.get('a.md')).toBe('new')
  })
  it('keeps the replacement scoped to the exact reviewed cloud file after same-byte delete and recreate', async () => {
    world.ids.set('a.md', 'original'); world.disk.set('a.md', 'old')
    const p = await previewNoteReplace('/v', 'old')
    world.ids.set('a.md', 'independent-new-file')
    expect((await applyNoteReplace(p, 'new', selected(p))).files[0].status).toBe('changed')
    expect(world.beforeWrite).not.toHaveBeenCalled()
  })
  it('retains the previous undo after fully conflicting and fully unsafe attempts, including reloads', async () => {
    world.disk.set('a.md', 'original')
    const first = await previewNoteReplace('/v', 'original')
    await applyNoteReplace(first, 'modified', selected(first))
    world.disk.set('b.md', 'old# title')
    let next = await previewNoteReplace('/v', 'old')
    expect((await applyNoteReplace(next, '', selected(next))).files[0].status).toBe('unsafe')
    expect(loadNoteReplaceBatch('/v')?.id).toBe(first.id)
    next = await previewNoteReplace('/v', 'old')
    world.disk.set('b.md', 'changed old# title')
    expect((await applyNoteReplace(next, 'new', selected(next))).files[0].status).toBe('changed')
    expect(loadNoteReplaceBatch('/v')?.id).toBe(first.id)
    expect((await undoNoteReplace(loadNoteReplaceBatch('/v')!)).files[0].status).toBe('undone')
    expect(world.disk.get('a.md')).toBe('original')
    expect(world.disk.get('b.md')).toBe('changed old# title')
  })
  it('skips files claimed by plugins since preview and rejects malformed persistent manifests', async () => {
    world.disk.set('a.md', 'old')
    world.disk.set('plugin.md', 'old')
    world.managed.add('plugin.md')
    const p = await previewNoteReplace('/v', 'old')
    expect(p.files.map(f => f.path)).toEqual(['a.md'])
    world.managed.add('a.md')
    expect((await applyNoteReplace(p, 'new', selected(p))).files[0].status).toBe('changed')
    const fresh = await previewNoteReplace('/v', 'old')
    sessionStorage.setItem(fresh.scope, JSON.stringify({files:[]}))
    expect(loadNoteReplaceBatch('/v')).toBeNull()
    await expect(applyNoteReplace(fresh, 'x', selected(fresh))).rejects.toThrow('Invalid replacement journal')
    expect(world.beforeWrite).not.toHaveBeenCalled()
  })
  it('restores every byte after a literal replacement containing Markdown punctuation', async () => {
    world.disk.set('a.md', '[old](original) old')
    const p = await previewNoteReplace('/v', 'old')
    const batch = await applyNoteReplace(p,'](other)',selected(p))
    expect(batch.files[0].status).toBe('applied')
    expect((await undoNoteReplace(batch)).files[0].status).toBe('undone')
    expect(world.disk.get('a.md')).toBe('[old](original) old')
  })
  it('previews 220 cloud notes in ten bounded requests without individual source reads', async () => {
    const { amadeus } = await import('../api')
    for (let i = 0; i < 220; i++) world.disk.set('cloud-' + i + '.md', 'old')
    const groups = vi.fn(async (paths: string[]) => paths.map(path => ({ path, source: 'old', fileId: path })))
    amadeus.readNoteReplaceSources = groups
    const fixture = amadeus as Required<Pick<typeof amadeus, 'readNoteReplaceSource'>>
    const individual = vi.spyOn(fixture, 'readNoteReplaceSource')
    try {
      const plan = await previewNoteReplace('/v', 'old')
      expect(plan.files).toHaveLength(220)
      expect(plan.unavailable).toEqual([])
      expect(groups).toHaveBeenCalledTimes(10)
      expect(groups.mock.calls.every(([paths]) => paths.length <= 24)).toBe(true)
      expect(individual).not.toHaveBeenCalled()
    } finally {
      delete amadeus.readNoteReplaceSources
      individual.mockRestore()
    }
  })
  it('searches beyond fifty paths, aborts before reading, and refuses to commit without a saved journal', async () => {
    for (let i=0;i<64;i++) world.disk.set(`p${i}.md`,'tag:#test')
    const p=await previewNoteReplace('/v','tag:#test')
    expect(p.files.length).toBe(64)
    await expect(previewNoteReplace('/v','x',AbortSignal.abort())).rejects.toThrow()
    vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:()=>{throw Error('quota')}})
    await expect(applyNoteReplace(p,'other',selected(p))).rejects.toThrow('quota')
    expect(world.beforeWrite).not.toHaveBeenCalled()
  })
})
