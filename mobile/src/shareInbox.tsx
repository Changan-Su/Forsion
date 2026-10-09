import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { MessageSquarePlus, MessagesSquare, NotebookPen } from 'lucide-react'
import { runNativeSheetMenu, setActiveSpace, useSpaceStore, type SheetMenuItem } from '@lcl/engine'
import { registerMessages, translate } from '@/i18n'
import { blankNewChat } from '@/bootstrapEngine'
import { useApp } from '@/stores/appStore'
import { openSession } from '@/sessionNav'
import { displaySessionTitle } from '@/sessionTitle'
import { amadeusAvailable } from '@/features/runtime'
import { navigateToNote } from '@/amadeus/store/pageStore'
import { splitNoteTitle, writeFresh } from '@/views/chat2/chatToNote'
import { loadPickedFiles } from './pickedFiles'
import { whenShellReady } from './liveIsland'

/** Android share target: "Share → Forsion" in another app's share sheet (Kotlin: ShareInboxPlugin, the SEND /
 *  SEND_MULTIPLE filters on AppActivity). What was shared lands on a native sheet that asks where it goes:
 *  a new chat, the chat the user was last in, or a note. A chat gets it in its message box — text appended to the
 *  draft, documents as attachments through the same intake (and caps) as "Add files". Nothing is sent: what another app hands
 *  over is not ours to forward to an agent, the user reads it and presses send.
 *  The event is retained natively until this listener exists, so a share that cold-starts the app is not lost.
 *  Refused documents (another app's `file:` path, too large, too many, unreadable) are reported, never dropped silently
 *  (the message is nativeFiles.ts's). */
registerMessages({
  'mobile.share.title': { zh: '分享到 Forsion', en: 'Share to Forsion' },
  'mobile.share.newChat': { zh: '发到新会话', en: 'Send to a new chat' },
  'mobile.share.toSession': { zh: '发到「{name}」', en: 'Send to “{name}”' },
  'mobile.share.toNote': { zh: '存为笔记', en: 'Save as a note' },
  'mobile.share.note': { zh: '发到会话 = 放进输入框，由你来发。', en: 'A chat gets it in the message box — you press send.' },
  'mobile.share.files': { zh: '{n} 个文件', en: '{n} file(s)' },
  'mobile.share.saved': { zh: '已存为笔记「{name}」', en: 'Saved as the note “{name}”' },
  'mobile.share.saveFailed': { zh: '没能存为笔记：{reason}', en: 'Couldn’t save the note: {reason}' },
  'mobile.share.nameTaken': { zh: '同名笔记太多', en: 'too many notes with that name' },
})

interface ShareInboxPlugin {
  addListener(event: 'shared', cb: (e: SharedEvent) => void): Promise<PluginListenerHandle>
}
interface SharedEvent { text?: unknown; files?: unknown; skipped?: unknown }

/** Into a chat's message box: `sessionId` = that chat, null = a new one. The text goes after whatever is already
 *  typed there (the box is one across chats), it never replaces it. */
function toChat(sessionId: string | null, text: string, files: File[]): void {
  // Home has no chat view of its own (tanguProbe.startChat does the same).
  if (useSpaceStore.getState().activeSpaceId !== 'tangu') setActiveSpace('tangu')
  if (sessionId) openSession(sessionId)
  else blankNewChat()
  useApp.getState().setPendingShare({ text, files })
}

/** A new note holding the text as it came. Named after its first line; a bare link gets the default name. */
async function toNote(text: string): Promise<void> {
  const app = useApp.getState()
  try {
    const first = text.split('\n').map((l) => l.trim()).find(Boolean) || ''
    const { title } = splitNoteTitle(/^https?:\/\//i.test(first) ? '' : `# ${first}`, translate('amadeus.default.note'))
    const path = await writeFresh(title, text.trimEnd() + '\n')
    if (!path) throw new Error(translate('mobile.share.nameTaken'))
    app.toast(translate('mobile.share.saved', { name: path.replace(/\.md$/i, '') }))
    navigateToNote(path)
  } catch (e) {
    app.toast(translate('mobile.share.saveFailed', { reason: e instanceof Error ? e.message : String(e) }), true)
  }
}

/** Arrival order, and the newest share that got as far as asking where it goes. The newest wins: its sheet replaces
 *  an earlier one's unanswered sheet (the native side shows one sheet), and an earlier share that was still reading
 *  its documents does not come up over it afterwards. Not a queue — one document that never finishes reading would
 *  hold every later share back. */
let arrived = 0
let asked = 0

async function receive(e: SharedEvent): Promise<void> {
  const mine = ++arrived
  const text = typeof e.text === 'string' ? e.text : ''
  // The bytes first: the read grant belongs to this activity and the documents may be gone later (same as a pick).
  const loaded = await loadPickedFiles(e.files, {
    toUrl: (uri) => Capacitor.convertFileSrc(uri),
    fetch: (url) => window.fetch(url),
  })
  const refused = Array.isArray(e.skipped) ? e.skipped.filter((x): x is string => typeof x === 'string') : []
  const skipped = [...refused, ...loaded.skipped]
  const files = loaded.files
  if (skipped.length) useApp.getState().toast(translate('mobile.files.skipped', { n: skipped.length, names: skipped.slice(0, 5).join(', ') }), true)
  if (!text && !files.length) return
  // A share that cold-starts the app gets here before the shell restored its layout: opening a view first would make
  // it skip the restore (the user's tabs gone), so wait like the live island's "open session" does.
  whenShellReady(() => {
    if (mine < asked) return // reading took a while and something shared since is already on screen
    asked = mine
    const app = useApp.getState()
    const last = app.sessions.find((s) => s.id === app.activeId) ?? app.sessions[0]
    const items: SheetMenuItem[] = [
      { id: 'new-chat', label: translate('mobile.share.newChat'), icon: <MessageSquarePlus size={18} />, run: () => toChat(null, text, files) },
      ...(last ? [{ id: 'session', label: translate('mobile.share.toSession', { name: [...displaySessionTitle(last.title, translate)].slice(0, 24).join('') }), icon: <MessagesSquare size={18} />, run: () => toChat(last.id, text, files) }] : []),
      // A note is its text: a share that carries documents has no note form here.
      ...(text && !files.length && amadeusAvailable() ? [{ id: 'note', label: translate('mobile.share.toNote'), icon: <NotebookPen size={18} />, run: () => { void toNote(text) } }] : []),
    ]
    // What is being shared, one line: the start of the text, or how many documents.
    const what = [[...text.replace(/\s+/g, ' ').trim()].slice(0, 60).join(''), files.length ? translate('mobile.share.files', { n: files.length }) : ''].filter(Boolean).join(' · ')
    void runNativeSheetMenu({ title: translate('mobile.share.title'), sections: [{ title: what, items, footer: translate('mobile.share.note') }] })
      .then((shown) => { if (!shown) toChat(null, text, files) }, () => toChat(null, text, files)) // no sheet to ask on → the plain destination
  })
}

let installed = false
export function installShareInbox(): void {
  if (installed || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('ShareInbox')) return
  installed = true
  const plugin = registerPlugin<ShareInboxPlugin>('ShareInbox')
  void plugin.addListener('shared', (e) => { void receive(e).catch(() => { /* a share is never worth an unhandled rejection */ }) }).catch(() => {})
}
