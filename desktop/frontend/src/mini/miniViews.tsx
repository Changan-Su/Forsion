import { miniFeatureAvailable } from '../features/runtime'
/** Native adapters share domain data/editors; each owns its compact interactions. */
import { lazy, Suspense, useEffect, useState } from 'react'
import { Bot, ListTodo, NotebookText, Phone } from 'lucide-react'
import { registerView, useMiniChrome, type ViewProps } from '@lcl/engine'
import { useApp } from '../stores/appStore'
import { usePageStore } from '../amadeus/store/pageStore'
import { useI18n, registerMessages, translate } from '../i18n'
import { AmadeusOverlays } from '../amadeusOverlays'
import { VoiceCallView } from './VoiceCallView'
import './miniViews.css'

const Chat = lazy(() => import('@tangu/ui/views/ChatView').then((m) => ({ default: m.ChatView })))
const Editor = lazy(() => import('../amadeusViews').then((m) => ({ default: m.AmadeusEditorView })))
const Todos = lazy(() => import('../views/TodoListView').then((m) => ({ default: m.TodoListView })))
registerMessages({
  'mini.chat': { zh: '对话', en: 'Chat' },
  'mini.newChat': { zh: '新会话', en: 'New session' },
  'mini.notes': { zh: '笔记', en: 'Notes' },
  'mini.chooseNote': { zh: '选择笔记', en: 'Choose a note' },
  'mini.newNote': { zh: '新建笔记', en: 'New note' },
  'mini.noteHint': { zh: '选择或新建一篇笔记', en: 'Choose a note or create one' },
  'mini.chatHint': { zh: '有什么需要帮忙的？', en: 'How can I help?' },
})

/** Under the Suspense boundary: acknowledge only once the actual Chat has mounted. */
function MiniChat(props: ViewProps) {
  const sessionId = props.params.sessionId
  useEffect(() => {
    if (typeof sessionId === 'string') window.tangu?.miniSessionReady?.(sessionId)
  }, [sessionId])
  return <Chat {...props} />
}

function MiniTangu({ leaf, params }: ViewProps) {
  const { t } = useI18n()
  const sessions = useApp((s) => s.sessions)
  const activeId = useApp((s) => s.activeId)
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : activeId
  const select = (id: string): void => {
    useApp.getState().setActiveId(id || null)
    leaf.setParams({ sessionId: id || undefined, followActive: !id })
  }
  // 会话下拉 + 新会话登记进宿主的胶囊顶栏(lcl/engine/miniChrome.ts),不再自己画一条栏
  useMiniChrome({ label: t('mini.chat'), placeholder: t('mini.newChat'), value: sessionId ?? '', onSelect: select,
    items: [...(sessionId && !sessions.some((s) => s.id === sessionId) ? [{ id: sessionId, label: t('mini.chat') }] : []),
      ...sessions.map((s) => ({ id: s.id, label: s.title || t('mini.chat') }))],
    create: { label: t('mini.newChat'), onCreate: () => select('') } })
  return <div className="mini-native mini-tangu">
    <Suspense fallback={null}><MiniChat leaf={{ ...leaf, type: 'chat' }} params={{ ...params, miniSurface: true }} /></Suspense>
  </div>
}

function MiniAmadeus({ leaf, params }: ViewProps) {
  const { t } = useI18n()
  const pages = usePageStore((s) => s.pages)
  const vault = usePageStore((s) => s.vaultRoot)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const notePath = typeof params.notePath === 'string' ? params.notePath : ''
  const select = (path: string): void => leaf.setParams({ notePath: path || undefined })
  const create = async (): Promise<void> => {
    setError(''); setCreating(true)
    try { await usePageStore.getState().createPage() } catch (e) { setError(String(e)) }
    finally { setCreating(false) }
  }
  useMiniChrome({ label: t('mini.chooseNote'), placeholder: t('mini.chooseNote'), value: notePath, onSelect: select,
    items: pages.map((path) => ({ id: path, label: path.replace(/\.md$/i, '') })),
    create: { label: t('mini.newNote'), disabled: !vault || creating, onCreate: () => void create() } })
  return <div className="mini-native mini-amadeus">
    {/* Editing event routes/dialogs are independent of workspace navigation chrome. */}
    <AmadeusOverlays />
    {error && <div role="alert" className="mini-native-error">{error}</div>}
    {notePath ? <Suspense fallback={null}><Editor leaf={{ ...leaf, type: 'amadeus-editor', params: { ...params, miniSurface: true } }} params={params} /></Suspense>
      : <div className="mini-panel-empty">{t('mini.noteHint')}</div>}
  </div>
}

export function registerMiniViews(): void {
  if (miniFeatureAvailable('tangu')) registerView({ type: 'mini-tangu', kind: 'aux', displayName: () => translate('mini.chat'), icon: Bot, factory: (p) => <MiniTangu {...p} /> })
  if (miniFeatureAvailable('amadeus')) registerView({ type: 'mini-amadeus', kind: 'aux', displayName: () => translate('mini.notes'), icon: NotebookText, factory: (p) => <MiniAmadeus {...p} /> })
  // 语音通话只开在 Mini 里(输入框电话键 → openMini 直达);桌面独有,靠 openMini 判在不在 Electron。
  if (miniFeatureAvailable('tangu') && window.tangu?.openMini) registerView({ type: 'voice-call', kind: 'aux', displayName: () => translate('livecall.title'), icon: Phone, factory: (p) => <VoiceCallView {...p} /> })
  if (miniFeatureAvailable('calendar')) registerView({ type: 'mini-todo', kind: 'aux', displayName: 'ToDo List', icon: ListTodo,
    factory: ({ params, leaf }) => <div className="mini-native mini-todo"><Suspense fallback={null}><Todos params={{ ...params, miniSurface: true }} leaf={leaf} /></Suspense></div> })
}
