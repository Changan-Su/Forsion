/** 仅 #preview：复用生产 SidebarPane / 消息 / Composer / TOC，无后端即可视觉回归。 */
import { useMemo, useRef, useState } from 'react'
import type { SessionRecord, UiMessage, WorkspaceDescriptor } from '../../types'
import { EditorialMessage } from './EditorialMessage'
import { Composer2 } from './Composer2'
import { SidebarPane } from './SidebarPane'
import { EmptyState2 } from './EmptyState2'
import { RightPanel } from '../../components/RightPanel'
import { registerMessages, useI18n } from '../../i18n'
import './chat2.css'

// ⚠️ 样例数据必须在渲染期用 t() 求值:模块作用域的字面量会在模块加载时冻结,切语言不再更新。
registerMessages({
  'chatpreview.msg.ask': { zh: '帮我把 LCL 的 hash 路由分支理一下,再决定要不要抽成表。', en: 'Walk me through the hash route branches in LCL, then decide whether to pull them into a table.' },
  'chatpreview.msg.reasoning': { zh: '先看 main.tsx 的 hash 分支顺序,确认 #/aion 与 #/tangu 不会被前面的 frame 分支吞掉,再决定是否抽一个 routes 表。整体规模还小,优先可读性。', en: 'Start with the order of the hash branches in main.tsx, confirm that #/aion and #/tangu are not swallowed by the earlier frame branch, then decide whether to extract a routes table. The whole thing is still small, so readability wins.' },
  'chatpreview.todo.read': { zh: '读 main.tsx 路由分支', en: 'Read the route branches in main.tsx' },
  'chatpreview.todo.addRoute': { zh: '加 #/tangu 分支', en: 'Add the #/tangu branch' },
  'chatpreview.todo.navLink': { zh: '补 Navigator 链接', en: 'Add the Navigator link' },
  'chatpreview.todo.build': { zh: '跑 tsc / build', en: 'Run tsc / build' },
  'chatpreview.plan': { zh: '1. 检查 hash 分支顺序\n2. 补路由与导航\n3. 运行 typecheck / build', en: '1. Check the order of the hash branches\n2. Add the route and the navigation link\n3. Run typecheck / build' },
  'chatpreview.msg.answer': { zh: '看完了。当前是 5 条 `if (route.view === …)` 顺序分支,`frame` 在前、`aion/tangu` 在后,互不吞。\n\n```ts\nif (route.view === \'frame\') return <Frame/>\nif (route.view === \'tangu\') return <Tangu/>\n```\n\n规模还小,**暂不必抽表**——超过 ~8 条再说。', en: 'Had a look. Right now there are 5 sequential `if (route.view === …)` branches — `frame` first, then `aion/tangu` — and none of them swallows another.\n\n```ts\nif (route.view === \'frame\') return <Frame/>\nif (route.view === \'tangu\') return <Tangu/>\n```\n\nAt this size a table is **not worth extracting yet** — revisit past ~8 branches.' },
  'chatpreview.msg.buildFirst': { zh: '我先跑一遍构建确认。', en: 'Let me run a build first to confirm.' },
  'chatpreview.inquiry.question': { zh: '路由是抽成表驱动,还是保持 if 分支?', en: 'Should routing become table-driven, or stay as if branches?' },
  'chatpreview.inquiry.optTable': { zh: '抽成 routes 表', en: 'Extract a routes table' },
  'chatpreview.inquiry.optIf': { zh: '保持 if 分支', en: 'Keep the if branches' },
  'chatpreview.session.routing': { zh: '重构 LCL 路由层', en: 'Refactor the LCL routing layer' },
  'chatpreview.session.weekly': { zh: '周报整理', en: 'Compile the weekly report' },
  'chatpreview.session.scraper': { zh: '爬虫脚本调试', en: 'Debug the scraper script' },
  'chatpreview.session.design': { zh: '设计系统对照', en: 'Design system comparison' },
})

type TFn = (key: string, vars?: Record<string, unknown>) => string

function buildSample(t: TFn): UiMessage[] {
  return [
    { id: 'u1', role: 'user', content: t('chatpreview.msg.ask'), attachments: [{ name: 'routes.md', mimeType: 'text/markdown', data: '', size: 128 }], status: 'done', timestamp: 1 },
    {
      id: 'a1', role: 'assistant', agentName: 'Tangu', status: 'done', timestamp: 2,
      systemPrompt: 'You are Tangu, a coding agent. Keep changes scoped and verify them.',
      reasoning: t('chatpreview.msg.reasoning'),
      toolEvents: [
        { id: 't1', name: 'read_file', arguments: 'src/main.tsx', done: true, elapsedMs: 400 },
        { id: 't2', name: 'run_shell', arguments: 'npx tsc --noEmit', done: true, isError: true, elapsedMs: 1200 },
      ],
      todos: [
        { status: 'completed', content: t('chatpreview.todo.read') },
        { status: 'in_progress', content: t('chatpreview.todo.addRoute') },
        { status: 'pending', content: t('chatpreview.todo.navLink') },
        { status: 'pending', content: t('chatpreview.todo.build') },
      ] as UiMessage['todos'],
      planProposal: t('chatpreview.plan'),
      content: t('chatpreview.msg.answer'),
    },
    {
      id: 'a2', role: 'assistant', agentName: 'Tangu', status: 'done', timestamp: 3,
      content: t('chatpreview.msg.buildFirst'),
      approvals: [{ approvalId: 'ap1', runId: 'r1', name: 'run_bash', arguments: JSON.stringify({ command: 'npm run build && npx tsc --noEmit' }), preview: 'npm run build && npx tsc --noEmit', status: 'pending' }],
    },
    {
      id: 'a3', role: 'assistant', agentName: 'Tangu', status: 'done', timestamp: 4, content: '',
      inquiries: [{ inquiryId: 'iq1', runId: 'r1', question: t('chatpreview.inquiry.question'), options: [t('chatpreview.inquiry.optTable'), t('chatpreview.inquiry.optIf')], status: 'pending' }],
    },
  ]
}

const now = new Date().toISOString()
const SESSION_TITLE_KEYS = ['chatpreview.session.routing', 'chatpreview.session.weekly', 'chatpreview.session.scraper', 'chatpreview.session.design']

function buildSessions(t: TFn): SessionRecord[] {
  return SESSION_TITLE_KEYS.map((key, i) => ({
    id: `s${i + 1}`, title: t(key), model_id: null, archived: false, emoji: null, agent_config: null,
    project_path: '/tangu', project_name: t('app.defaultWorkspace'), created_at: now, updated_at: now,
  }))
}

function buildWorkspaces(t: TFn): WorkspaceDescriptor[] {
  return [
    { key: '__cloud__', name: t('app.cloudWorkspace'), kind: 'cloud', path: null, system: true },
    { key: '/tangu', name: t('app.defaultWorkspace'), kind: 'local', path: '/tangu', system: true },
  ]
}

const CFG = { backendUrl: 'http://localhost:8787', token: '', modelId: '' }

export function ChatPreview() {
  const { t } = useI18n()
  const [empty, setEmpty] = useState(false)
  const [action, setAction] = useState('')
  const streamRef = useRef<HTMLDivElement>(null)
  const sample = useMemo(() => buildSample(t), [t])
  const sessions = useMemo(() => buildSessions(t), [t])
  const workspaces = useMemo(() => buildWorkspaces(t), [t])
  return (
    <div className="t2-preview-shell">
      <div className="t2-preview-side">
        <SidebarPane
          collapsed={false} sessions={sessions} archivedSessions={[]} activeId="s1"
          runningIds={new Set(['s2'])} unreadIds={new Set(['s3'])} cfg={CFG} modelId="" activeSession={sessions[0]}
          workspaces={workspaces} onSelect={() => {}} onNewInWorkspace={() => {}} onAddWorkspace={() => {}}
          onRenameWorkspace={() => {}} onRemoveWorkspace={() => {}} onRename={() => {}} onArchive={() => {}} onDelete={() => {}}
          onOpenSettings={() => {}} showSpecial onNewChat={() => setEmpty(true)}
          onOpenWorkspace={() => {}}
        />
      </div>
      <div className="t2-preview-main t2-chat-view">
        <div className="t2-toolbar">
          <div className="t2-toolbar-title">{sessions[0].title}</div>
          <span className="t2-toolbar-grow" />
          <button className="t2-pill" onClick={() => setEmpty(false)} style={{ fontWeight: empty ? 400 : 600 }}>{t('workbench.chat')}</button>
          <button className="t2-pill" onClick={() => setEmpty(true)} style={{ fontWeight: empty ? 600 : 400 }}>{t('chat.emptyHint')}</button>
          {action && <span className="t2-toolbar-pill" data-preview-action>{action}</span>}
        </div>
        {empty ? (
          <EmptyState2 />
        ) : (
          <div className="t2-stream" ref={streamRef}>
            <div className="t2-stream-inner">
              {sample.map((m) => (
                <EditorialMessage
                  key={m.id}
                  msg={m}
                  handlers={{
                    onApproval: (_id, decision, args) => setAction(`approval:${decision}:${String(args?.command || '')}`),
                    onInquiry: (_id, answer) => setAction(`inquiry:${answer}`),
                  }}
                />
              ))}
            </div>
          </div>
        )}
        <Composer2
          disabled={false}
          running={false}
          execConfig={{ execMode: 'host', approvalMode: 'auto-edit' }}
          models={null}
          modelId=""
          onModelChange={() => {}}
          planMode={false}
          onPlanModeChange={() => {}}
          onExecConfigChange={() => {}}
          onSend={async () => true}
          onStop={() => {}}
          contextWindow={200000}
          ctxTokens={84000}
          sessionTokens={12000}
          onCompact={() => {}}
        />
      </div>
      <div className="t2-preview-right">
        <div className="t2-preview-right-title">{t('panel.tab.toc')}</div>
        <RightPanel
          view="toc" cfg={CFG} sessionId="s1" sessionConfig={{}} running={false} messages={empty ? [] : sample}
          chatScrollRef={streamRef} onToast={() => {}} onOpenPreview={() => {}} subChats={[]}
        />
      </div>
    </div>
  )
}
