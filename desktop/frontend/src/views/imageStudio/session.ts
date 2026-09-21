import { useApp, applyPreset, stickyDefaults } from '../../stores/appStore'
import { useImageStudio } from '../../stores/imageStudioStore'
import { createSession } from '../../services/backendService'
import type { Attachment } from '../../types'
import { useWorkspace } from '@lcl/engine'

const pending = new Map<string, Promise<string>>()
export async function ensureImageSession(boardId: string): Promise<string> {
  const board = useImageStudio.getState().boards[boardId]
  if (!board) throw new Error('Project no longer available')
  if (board.sessionId) return board.sessionId
  const existing = pending.get(boardId)
  if (existing) return existing
  const task = (async () => {
    const app = useApp.getState()
    const config = { ...applyPreset({ ...stickyDefaults(app.desktopConfig, false), execMode: 'sandbox' }, undefined), agentSlug: app.defaultAgentSlug }
    const session = await createSession(app.cfg, { title: board.name, projectless: true, agent_config: config })
    app.adoptSession({ ...session, agent_config: session.agent_config || config }, { fresh: true })
    useImageStudio.getState().update(boardId, b => ({ ...b, sessionId: session.id }), false)
    return session.id
  })()
  pending.set(boardId, task)
  try { return await task } finally { pending.delete(boardId) }
}
export async function promptImageStudio(boardId: string, text: string, attachments: Attachment[] = []): Promise<void> {
  const sessionId = await ensureImageSession(boardId)
  if (useImageStudio.getState().activeId !== boardId) return
  useWorkspace.getState().openView('image-studio-chat', {}, 'left')
  useImageStudio.getState().queue(sessionId, text, attachments)
}
