import type { IpcMainInvokeEvent } from 'electron'
import { createDocumentTaskClaims } from './documentTaskClaims'

export function registerDocumentTaskIpc(
  ipc: { handle(channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown): void },
  file: string,
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean,
): void {
  // Lazy loading keeps a damaged receipt file from blocking app startup. Submission fails closed.
  let claims: ReturnType<typeof createDocumentTaskClaims> | undefined
  const watched = new Set<number>()
  const guard = (e: IpcMainInvokeEvent) => {
    if (!isTrustedSender(e)) throw new Error('forbidden')
    claims ??= createDocumentTaskClaims(file)
    const owner = e.sender.id
    if (!watched.has(owner)) {
      watched.add(owner)
      e.sender.once('destroyed', () => { claims?.releaseOwner(owner); watched.delete(owner) })
      e.sender.on('render-process-gone', () => claims?.releaseOwner(owner))
      e.sender.on('did-navigate', () => claims?.releaseOwner(owner))
    }
    return claims
  }
  ipc.handle('documentTasks:claim', (e, key: string, signature: string) => guard(e).claim(e.sender.id, key, signature))
  ipc.handle('documentTasks:complete', (e, key: string, token: string, sessionId: string) => guard(e).complete(e.sender.id, key, token, sessionId))
  ipc.handle('documentTasks:release', (e, key: string, token: string) => guard(e).release(e.sender.id, key, token))
}
