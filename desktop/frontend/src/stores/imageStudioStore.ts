import { create } from 'zustand'
import type { Attachment } from '../types'
import { newBoard, type ImageBoard } from '../views/imageStudio/model'
import { generationBoxes, type GenerationPlaceholder, type GenerationRequest } from '../views/imageStudio/generation'
import { loadBoards, saveBoard } from '../views/imageStudio/storage'

interface ImageStudioState {
  boards: Record<string, ImageBoard>
  activeId: string | null
  ready: boolean
  error: string
  saving: boolean
  selection: string[]
  past: Record<string, ImageBoard[]>
  future: Record<string, ImageBoard[]>
  /** Runtime-only image jobs. They never enter undo history or the persisted project. */
  placeholders: Record<string, GenerationPlaceholder[]>
  /** Tool calls already associated with this runtime, including completed or dismissed jobs. */
  generationTools: Record<string, string[]>
  pending: { sessionId: string; text: string; attachments: Attachment[]; seq: number } | null
  hydrate(): Promise<void>
  create(name: string): string
  open(id: string): void
  update(id: string, edit: (board: ImageBoard) => ImageBoard, history?: boolean): void
  undo(id: string, redo?: boolean): void
  flush(): Promise<void>
  queue(sessionId: string, text: string, attachments?: Attachment[]): void
  consume(seq: number): boolean
  beginGeneration(boardId: string, sessionId: string, request: GenerationRequest): string[]
  activateGeneration(ids: string[]): void
  bindGenerationTool(boardId: string, sessionId: string, toolId: string, request: GenerationRequest): void
  failGeneration(boardId: string, match: { ids?: string[]; sessionId?: string; toolId?: string }): void
  takeGeneration(boardId: string, sessionId: string): GenerationPlaceholder | undefined
  removeGeneration(boardId: string, id: string): void
}
let hydration: Promise<void> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let sequence = 0
const dirty = new Set<string>()
let writing: Promise<void> | undefined
function schedule(id: string): void {
  dirty.add(id)
  useImageStudio.setState({ saving: true })
  clearTimeout(timer)
  timer = setTimeout(() => void useImageStudio.getState().flush(), 250)
}
export const useImageStudio = create<ImageStudioState>((set, get) => ({
  boards: {}, activeId: null, ready: false, error: '', saving: false, selection: [], past: {}, future: {}, placeholders: {}, generationTools: {}, pending: null,
  hydrate: () => hydration ??= (async () => {
    try {
      const boards = await loadBoards()
      let activeId: string | null = null
      try { activeId = localStorage.getItem('image-studio.active') } catch { /* optional preference */ }
      set({ boards: Object.fromEntries(boards.map(b => [b.id, b])), activeId: boards.find(b => b.id === activeId)?.id || boards.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null, ready: true, error: '' })
    } catch (e) { set({ error: String(e), ready: false }); hydration = undefined }
  })(),
  create: name => {
    if (!get().ready) return ''
    const board = newBoard(name)
    set(s => ({ boards: { ...s.boards, [board.id]: board } }))
    get().open(board.id); schedule(board.id)
    return board.id
  },
  open: id => {
    if (!get().boards[id]) return
    set({ activeId: id, selection: [], pending: null })
    try { localStorage.setItem('image-studio.active', id) } catch { /* board data uses IndexedDB */ }
  },
  update: (id, edit, history = true) => {
    const board = get().boards[id]
    if (!board) return
    const next = edit(board)
    if (next === board) return
    set(s => ({ boards: { ...s.boards, [id]: { ...next, updatedAt: Date.now() } },
      ...(history ? { past: { ...s.past, [id]: [...(s.past[id] || []).slice(-29), board] }, future: { ...s.future, [id]: [] } } : {}) }))
    schedule(id)
  },
  undo: (id, redo = false) => {
    const from = redo ? 'future' : 'past', to = redo ? 'past' : 'future'
    const stack = get()[from][id] || [], old = get().boards[id], next = stack.at(-1)
    if (!old || !next) return
    // Session ownership and acknowledged outputs are durable facts, never editor history.
    set(s => ({ boards: { ...s.boards, [id]: { ...next, sessionId: old.sessionId, collected: old.collected, updatedAt: Date.now() } },
      [from]: { ...s[from], [id]: stack.slice(0, -1) }, [to]: { ...s[to], [id]: [...(s[to][id] || []), old] }, selection: [] }))
    schedule(id)
  },
  flush: async () => {
    clearTimeout(timer)
    if (writing) return writing
    writing = (async () => {
      try {
        while (dirty.size) {
          const id = dirty.values().next().value!
          const board = get().boards[id]
          dirty.delete(id)
          try { if (board) await saveBoard(board) } catch (e) { dirty.add(id); throw e }
        }
        set({ saving: false, error: '' })
      } catch (e) { set({ saving: false, error: String(e) }) }
    })()
    try { await writing } finally { writing = undefined }
  },
  queue: (sessionId, text, attachments = []) => set(s => ({ pending: {
    sessionId, text: s.pending?.sessionId === sessionId ? `${s.pending.text}\n\n${text}` : text,
    attachments: [...(s.pending?.sessionId === sessionId ? s.pending.attachments : []), ...attachments], seq: ++sequence,
  } })),
  consume: seq => { if (get().pending?.seq !== seq) return false; set({ pending: null }); return true },
  beginGeneration: (boardId, sessionId, request) => {
    const board = get().boards[boardId]
    if (!board) return []
    const existing = get().placeholders[boardId] || []
    const boxes = generationBoxes(board, request, existing)
    const generationId = crypto.randomUUID(), createdAt = Date.now()
    const placeholders = boxes.map((box, index): GenerationPlaceholder => ({
      ...box, id: crypto.randomUUID(), generationId, boardId, sessionId,
      sourceIds: request.sourceIds || [], kind: request.kind, status: 'preparing',
      aspect: request.aspect, ratio: request.ratio, index, count: boxes.length, createdAt,
    }))
    set(s => ({ placeholders: { ...s.placeholders, [boardId]: [...(s.placeholders[boardId] || []), ...placeholders] } }))
    return placeholders.map(item => item.id)
  },
  activateGeneration: ids => {
    const wanted = new Set(ids)
    set(s => ({ placeholders: Object.fromEntries(Object.entries(s.placeholders).map(([boardId, items]) => [boardId,
      items.map(item => wanted.has(item.id) && item.status === 'preparing' ? { ...item, status: 'running' as const } : item),
    ])) }))
  },
  bindGenerationTool: (boardId, sessionId, toolId, request) => {
    if ((get().generationTools[boardId] || []).includes(toolId)) return
    set(s => ({ generationTools: {
      ...s.generationTools,
      [boardId]: [...(s.generationTools[boardId] || []).slice(-199), toolId],
    } }))
    const current = get().placeholders[boardId] || []
    const candidate = current.find(item => item.sessionId === sessionId && !item.toolId && item.status !== 'failed')
    if (candidate) {
      set(s => ({ placeholders: { ...s.placeholders, [boardId]: (s.placeholders[boardId] || []).map(item =>
        item.generationId === candidate.generationId ? { ...item, toolId, status: 'running' as const } : item) } }))
      return
    }
    const ids = get().beginGeneration(boardId, sessionId, request), wanted = new Set(ids)
    set(s => ({ placeholders: { ...s.placeholders, [boardId]: (s.placeholders[boardId] || []).map(item =>
      wanted.has(item.id) ? { ...item, toolId, status: 'running' as const } : item) } }))
  },
  failGeneration: (boardId, match) => {
    const ids = match.ids ? new Set(match.ids) : null
    set(s => ({ placeholders: { ...s.placeholders, [boardId]: (s.placeholders[boardId] || []).map(item => {
      const matches = (!ids || ids.has(item.id)) && (!match.sessionId || item.sessionId === match.sessionId) && (!match.toolId || item.toolId === match.toolId)
      return matches ? { ...item, status: 'failed' as const } : item
    }) } }))
  },
  takeGeneration: (boardId, sessionId) => {
    const items = get().placeholders[boardId] || []
    const item = items.filter(value => value.sessionId === sessionId && value.status !== 'failed').sort((a, b) => a.createdAt - b.createdAt || a.index - b.index)[0]
    if (!item) return undefined
    set(s => ({ placeholders: { ...s.placeholders, [boardId]: (s.placeholders[boardId] || []).filter(value => value.id !== item.id) } }))
    return item
  },
  removeGeneration: (boardId, id) => set(s => ({ placeholders: { ...s.placeholders, [boardId]: (s.placeholders[boardId] || []).filter(item => item.id !== id) } })),
}))
