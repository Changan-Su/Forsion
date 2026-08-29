/**
 * Composer2 —— 输入区「完全重写」为编辑式新视觉(悬浮圆角卡 + 圆形发送 + 下方药丸 chips),
 * 逻辑与旧 MessageInput 等价、零功能损失:slash 命令 / @ 提及 / 附件(选/粘/拖)/ 云沙箱工作区文件 /
 * /skill chip / 引用 / 模型·Agent·引擎·思考·loop·计划·群聊 / 上下文占比·压缩 / 发送·停止。
 * props 与旧 MessageInput 完全一致 → ChatView 直接换组件即可。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, Square, Mic, X, ClipboardList, Check, ChevronDown, FileText, Folder, PanelsTopLeft, Users, Sparkles,
  Hand, ShieldCheck, ShieldAlert, Settings2, SlidersHorizontal, MessageSquare, Loader2, Clock, Zap, type LucideIcon,
} from 'lucide-react'
import { useVoiceInput } from '../../hooks/useVoiceInput'
import { VoiceRecordingBar } from './VoiceRecordingBar'
import { THINKING_LEVELS } from '../../types'

// context 视图已知注入段 key(与引擎 agentLoop ctxMark 调用一一对应);未知 key 显示原样
const CTX_SEC_KEYS = new Set(['persona', 'harness', 'guidance', 'profile', 'project', 'agentFolder', 'memory', 'skills', 'environment', 'hooks', 'plan'])
import type { AgentConfig, Attachment, CtxInfo, DefaultModelSlot, MessageRecord, ModelInfo, ModelsResponse, NormalAgentDef, SkillInfo } from '../../types'
import { useEdgeNudge, useWorkspace } from '@lcl/engine'
import { ModelPill, type ModelPillGroup } from '../../components/ModelPill'
import { useI18n } from '../../i18n'
import { groupModelsByProvider } from '../../components/ModelGroupList'
import { GroupChatSetup } from '../../components/GroupChatSetup'
import { track } from '../../achievements/store'
import { usePageStore } from '../../amadeus/store/pageStore'
import { ensureAmadeusReady } from '../../amadeusPlugins'
import { noteRefInsert } from '../../components/wikiChat'
import { refToText, type ChatRef } from './chatDragRef'
import { useApp } from '../../stores/appStore'
import { ApprovalRulesModal } from '../../components/ApprovalRulesModal'
import { commandsFor } from '../../commandCatalog'
import { getCustomCommands, expandCustomCommand, listMessages, type CustomCommandInfo } from '../../services/backendService'
import { AddContentMenu, type AddContentReference } from './AddContentMenu'
import './composer2.css'

interface SlashItem { cmd: string; desc: string; run: () => void }
type OpenMenu = 'add' | 'mode' | 'model' | 'ctx' | null
/** [[ 引用候选:note=vault 笔记(p=vault 相对 .md 路径);session=历史会话(p=标题,供打分);
 *  否则工作区文件(p=cwd 相对路径)。 */
type RefCand = { p: string; note?: true; session?: { id: string; title: string; summary?: string | null } }

const MAX_ATTACH_BYTES = 5 * 1024 * 1024
const MAX_INPUT_CHARS = 150_000
const MAX_WS_BYTES = 25 * 1024 * 1024
/** 审批档位:菜单行只放图标 + 标题，说明在 hover / focus 时显示到菜单侧边。顺序 = 从最谨慎到最放手,自定义压轴。
 *  full-auto 标 danger(菜单里染强调色)——这一档是把整台电脑交出去,不该和其余三档长得一样。 */
const APPROVALS = [
  { id: 'readonly', Icon: Hand, key: 'input.approval.readonly', desc: 'input.approval.readonlyDesc' },
  { id: 'auto-edit', Icon: ShieldCheck, key: 'input.approval.autoEdit', desc: 'input.approval.autoEditDesc' },
  { id: 'full-auto', Icon: ShieldAlert, key: 'input.approval.fullAuto', desc: 'input.approval.fullAutoDesc', danger: true },
  { id: 'custom', Icon: Settings2, key: 'input.approval.custom', desc: 'input.approval.customDesc' },
] as const satisfies ReadonlyArray<{ id: NonNullable<AgentConfig['approvalMode']>; Icon: LucideIcon; key: string; desc: string; danger?: boolean }>

/**
 * 输入框上方「已选择」引用条的一条。
 *
 * token = 发送时原样拼回正文的那段文本 —— 与 [[ 选择器 / 拖拽引用**完全同一套契约**
 * (`[[绝对路径|名字]]` / `[[session:id|标题]]` / 本机路径),所以引擎、消息气泡、read_session
 * 这些下游一个字都不用改:变的只是「引用长什么样」,不是「引用是什么」。
 */
export interface RefChip {
  /** 去重键 + 发送时拼回的文本(不带尾空格)。 */
  token: string
  /** 芯片上显示的名字。 */
  name: string
  kind: 'note' | 'file' | 'folder' | 'session' | 'view'
}

const chipBaseName = (p: string): string => p.split(/[\\/]/).pop() || p
/** OS 文件的落区选择器 —— 必须与 ChatView 根节点的类名一致(改一处即断,故有 filesdrop 测试盯着)。 */
export const DROP_ZONE_SEL = '.t2-chat-view'

/**
 * 把 OS 文件的拖放落区从输入框卡片提到**整个聊天区**(用户实报:满屏都在提示可落,只有输入框接得住)。
 * 落区不是本组件渲染的节点 → 只能上原生监听;ChatPreview / 移动端没有 .t2-chat-view 祖先则退回卡片本身。
 * 只吃 'Files';应用内引用拖拽(REF_MIME/PATHS_MIME)仍归 ChatView 的 refdrop,两条路不打架。
 */
export function bindFilesDropZone(
  card: HTMLElement,
  onFiles: (files: FileList) => void,
  setCardDragOver: (on: boolean) => void,
): () => void {
  const zone = (card.closest(DROP_ZONE_SEL) as HTMLElement | null) ?? card
  const hasFiles = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  // 卡片自己当落区时沿用 .dragover 亮边;整片聊天区改用属性驱动虚线框(class 归 ChatView 管,别抢)。
  const mark = (on: boolean): void => {
    if (zone === card) setCardDragOver(on)
    else zone.toggleAttribute('data-filedrop', on)
  }
  const over = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault() // 认领这次拖放:fileDropGuard 看 defaultPrevented 才不去兜底吞掉
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    mark(true)
  }
  const leave = (e: DragEvent): void => { if (!zone.contains(e.relatedTarget as Node)) mark(false) }
  const drop = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    mark(false)
    if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files)
  }
  zone.addEventListener('dragover', over)
  zone.addEventListener('dragleave', leave)
  zone.addEventListener('drop', drop)
  return () => {
    zone.removeEventListener('dragover', over)
    zone.removeEventListener('dragleave', leave)
    zone.removeEventListener('drop', drop)
    mark(false)
  }
}

/** 本机/工作区路径 → 芯片(含空格的路径发送时要加引号,与 refToText 的 file 分支一致)。 */
export const fileChip = (path: string): RefChip => ({
  token: /\s/.test(path) ? `"${path}"` : path,
  name: chipBaseName(path),
  kind: 'file',
})

export const folderChip = (path: string): RefChip => ({
  token: /\s/.test(path) ? `"${path}"` : path,
  name: chipBaseName(path),
  kind: 'folder',
})

/** 没有文件身份的功能 View 仍把稳定 type + 人类标题显式交给模型；不用 [[...]]，避免被气泡当笔记链接。 */
export const viewChip = (type: string, title: string): RefChip => {
  const attr = (value: string): string => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return { token: `<forsion-view type="${attr(type)}" title="${attr(title)}" />`, name: title, kind: 'view' }
}

/** 一条结构化引用 → 芯片。token 由 refToText 生成 = **与行内插入完全同一段文本**,
 *  发送时原样拼回,故引擎/气泡/read_session 收到的东西一个字节都没变。 */
export function refChipOf(ref: ChatRef, vaultRoot: string): RefChip {
  const token = refToText(ref, vaultRoot).trim()
  if (ref.kind === 'session') return { token, name: ref.title || 'Chat', kind: 'session' }
  if (ref.kind === 'note') return { token, name: chipBaseName(ref.path), kind: 'note' }
  return fileChip(ref.path)
}

/** 历史召回的纯索引算术:hist=旧→新,pos 0=草稿、1..N=第 N 条最近发送。
 *  older=true(↑)由新到旧、false(↓)回到草稿。越界返回 null(不动)。 */
export function pickRecall(hist: string[], pos: number, older: boolean, stash: string): { pos: number; val: string } | null {
  if (older) {
    if (pos >= hist.length) return null
    const next = pos + 1
    return { pos: next, val: hist[hist.length - next] }
  }
  if (pos === 0) return null
  const next = pos - 1
  return { pos: next, val: next === 0 ? stash : hist[hist.length - next] }
}

/** token 计数进位:满千 k、满百万 M,一位小数。截断而非四舍五入 —— 999,999 是 999.9k,不是 1000k。 */
export const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${Math.floor(n / 1e5) / 10}M` : n >= 1e3 ? `${Math.floor(n / 100) / 10}k` : String(n)

/**
 * 输入框 autosize 的目标 style.height。**scrollHeight ≤ 0 = 元素当前没被布局**
 * (挂载时机处于 dockview 用 display:none 藏起的非激活面板 / 首启引导期隐藏的外壳里)——
 * 此时**绝不能写成 `0px`**(会把输入区压没、且 autoGrow 只在 draft 变化才重算 → 不自愈,
 * 直到 reload/切走再回来重挂才好)。量不到就留 `auto`(配合 `rows=1` + CSS `min-height` 保底一行)。
 */
export function composerAutoHeight(scrollHeight: number, maxPx = 200): string {
  return scrollHeight > 0 ? `${Math.min(scrollHeight, maxPx)}px` : 'auto'
}

/**
 * 光标处的 slash 命令词:**行首或空白之后**的那个 `/…`(到光标为止),否则 null。
 * 菜单不再只认「草稿以 / 开头」,正文中途也能唤出 —— 但边界规则得跟 @ 提及一致,
 * 否则 `http://`、`src/foo`、除法算式里的斜杠全都会弹菜单。
 */
export function slashTokenAt(text: string, cursor: number): { start: number; token: string } | null {
  const m = /(?:^|\s)(\/\S*)$/.exec(text.slice(0, cursor))
  return m ? { start: cursor - m[1].length, token: m[1] } : null
}

export const Composer2: React.FC<{
  /** 缺省 = 跟随 appStore.activeId;`null` = 明确按新对话语义跑(主页复用时用)。 */
  sessionId?: string | null
  /** 只给桌面首页等高意图入口开;触屏不应自动弹软键盘。 */
  autoFocus?: boolean
  disabled: boolean
  running: boolean
  execConfig: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>
  models?: ModelInfo[] | null
  /** 全量模型目录（含生图模型）+ app 级默认槽；主模型列表仍走上面的会话可见过滤。 */
  modelsResponse?: ModelsResponse | null
  modelId?: string
  onModelChange?: (modelId: string) => void
  engines?: Array<{ id: string; name: string }>
  engineId?: string
  engineModels?: Array<{ id: string; name: string; description?: string }>
  engineModelId?: string
  onEngineModelChange?: (id: string) => void
  engineCommands?: Array<{ name: string; description: string; hint?: string }>
  thinkingLevel?: AgentConfig['thinkingLevel']
  onThinkingChange?: (level: NonNullable<AgentConfig['thinkingLevel']>) => void
  defaultModelIds?: Partial<Record<DefaultModelSlot, string>>
  onDefaultModelChange?: (slot: DefaultModelSlot, modelId: string) => void
  maxIterations?: number
  onMaxIterationsChange?: (n: number) => void
  /** 验证回路(/verify,host-only):收尾前引擎自动跑的命令;空=未配置。 */
  verifyCommand?: string
  onVerifyCommandChange?: (cmd: string) => void
  planMode?: boolean
  onPlanModeChange?: (on: boolean) => void
  voiceMode?: boolean
  onVoiceModeChange?: (on: boolean) => void
  groupChat?: boolean
  groupAgents?: string[]
  groupTempAgents?: NormalAgentDef[]
  groupIntensity?: AgentConfig['groupIntensity']
  groupMaxRounds?: number
  onGroupChange?: (patch: Pick<AgentConfig, 'groupChat' | 'groupAgents' | 'groupTempAgents' | 'groupIntensity' | 'groupMaxRounds'>) => void
  skills?: SkillInfo[] | null
  agents?: NormalAgentDef[]
  onNewSession?: () => void
  onBranch?: () => void
  onOpenSettings?: () => void
  onExecConfigChange: (patch: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>) => void
  onSend: (text: string, attachments: Attachment[], workspaceFiles?: Attachment[], skillIds?: string[], mentions?: { priorityAgent?: string; mentionAgents?: string[] }) => Promise<boolean>
  onStop: () => void
  quotedText?: string
  onClearQuote?: () => void
  contextWindow?: number
  ctxTokens?: number
  sessionTokens?: number
  /** 本 run 累计成本(点)与上限(TANGU_MAX_RUN_COST;0=关闭):引擎 usage 事件下发,无 run 时 undefined。 */
  runCost?: number
  costLimit?: number
  /** 引擎 context_info(窗口来源/注入段分解/指令文件/历史规模);未跑过 run 时 null。 */
  ctxInfo?: CtxInfo | null
  onCompact?: () => void
  /** 外部预填草稿(反馈诊断/对话建 agent 等 via-chat 入口);非空时 mount/变更即写入输入框并回调清空。 */
  seedText?: string | null
  onSeedConsumed?: () => void
  /** 拖引用进聊天(工作区侧栏 / 笔记树 / 会话列表):直接挂到输入框上方的「已选择」芯片条。
   *  seq 让连拖同一条也能触发;消费后由宿主清空。 */
  appendRefs?: { refs: ChatRef[]; seq: number } | null
  onAppendRefsConsumed?: () => void
  /** 聊天开在侧栏(left/right)时为 true:自动把**主区当前打开的那篇笔记**作为默认引用挂上
   *  「已选择」条(用户可 ×,换一篇即复活)。聊天自己就是主区时无「另一个主区文件」可言,恒 false。 */
  autoRefFromMain?: boolean
  /** 本会话已发送的用户消息(旧→新);输入框空/首行按 ↑↓ 召回,类 shell / codex / claude code。 */
  sentHistory?: string[]
  /** steer 等待区:run 跑动中已发出、还没被引擎注入的消息(注入即从这里消失并上屏)。 */
  pendingSteer?: Array<{ id: string; text: string }>
  /** 删除一条等待中的插话(文本仍留在 ↑ 历史)。 */
  onCancelSteer?: (msgId: string) => void
  /** ↑ 撤回:取回最新一条等待中的插话放回输入框。返回文本;来不及则 null。 */
  onWithdrawSteer?: (msgId: string) => Promise<string | null>
  /** 「立即插话」:打断当前 run,把等待区消息强发。 */
  onSteerNow?: () => void
}> = ({
  sessionId, autoFocus, disabled, running, execConfig,
  models, modelsResponse, modelId, onModelChange, engines, engineId,
  engineModels, engineModelId, onEngineModelChange, engineCommands,
  thinkingLevel, onThinkingChange,
  defaultModelIds, onDefaultModelChange,
  maxIterations, onMaxIterationsChange,
  verifyCommand, onVerifyCommandChange,
  planMode, onPlanModeChange, voiceMode, onVoiceModeChange, skills,
  groupChat, groupAgents, groupTempAgents, groupIntensity, groupMaxRounds, onGroupChange,
  agents, onNewSession, onBranch, onOpenSettings,
  onExecConfigChange, onSend, onStop,
  quotedText, onClearQuote,
  contextWindow, ctxTokens, sessionTokens, runCost, costLimit, ctxInfo, onCompact,
  seedText, onSeedConsumed, appendRefs, onAppendRefsConsumed, autoRefFromMain, sentHistory,
  pendingSteer, onCancelSteer, onWithdrawSteer, onSteerNow,
}) => {
  const { t, locale } = useI18n()
  const [draft, setDraft] = useState('')
  /** 自定义命令(~/.tangu/commands/*.md);拉不到就是空表,输入框照常可用。 */
  const [customCommands, setCustomCommands] = useState<CustomCommandInfo[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [wsFiles, setWsFiles] = useState<Attachment[]>([])
  /** 「已选择」引用条(显式加的:[[ 选择器 / 拖进来 / 粘贴本机文件)。自动那条不进这里,见 autoChip。 */
  const [refChips, setRefChips] = useState<RefChip[]>([])
  /** 被 × 掉的自动引用(值 = 那条引用的 token):主区换一个文件即复活,不是永久关闭。 */
  const [autoRefOff, setAutoRefOff] = useState<string | null>(null)
  /** 加引用:按 token 去重 —— 既比已有的,也比**这一批内部**的(多选拖拽可能带重复行:
   *  只比 prev 的话两条同 token 会一起进来,React key 撞车且发送时正文里重复一遍)。 */
  const addRefChips = (next: RefChip[]): void =>
    setRefChips((prev) => {
      const seen = new Set(prev.map((c) => c.token))
      const add: RefChip[] = []
      for (const c of next) if (!seen.has(c.token)) { seen.add(c.token); add.push(c) }
      return add.length ? [...prev, ...add] : prev
    })
  const [pinnedSkills, setPinnedSkills] = useState<SkillInfo[]>([])
  const [hint, setHint] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  /** /model 子菜单(模型清单)。存锚点是因为它的「词」里有空格,slashTokenAt 那条正则跟不到。 */
  const [slashSubMenu, setSlashSubMenu] = useState<{ start: number } | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  /** 当前命令词在草稿里的区间。slashItems 是带缓存的 memo,里面的 run() 捕获的是旧渲染的闭包,
   *  替换范围只能从 ref 读实时值(直接闭包会用上一次的 start,插到错位置)。 */
  const slashSpan = useRef<{ start: number; end: number } | null>(null)
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [groupSetupOpen, setGroupSetupOpen] = useState(false)
  const [cursorPos, setCursorPos] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentionedSlug, setMentionedSlug] = useState('')
  const [mentionAgents, setMentionAgents] = useState<string[]>([])
  const [refIndex, setRefIndex] = useState(0)
  const [refDismissed, setRefDismissed] = useState(false)
  const [refFiles, setRefFiles] = useState<string[] | null>(null) // [[ 文件引用候选(工作区相对路径);null=未构建
  const refFilesFor = useRef('')
  const [dragOver, setDragOver] = useState(false)
  const [histPos, setHistPos] = useState(0) // 历史召回位置:0=当前草稿;1..N=第 N 条最近发送
  const histStash = useRef('') // 进入召回时暂存的草稿(↓ 回到 0 时原样取回)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  /** 命令描述直接取 catalog 的 zh/en —— 不再另建一套 input.slash.* key(那正是两端文案漂移的来源)。 */
  const describe = useMemo(() => {
    const byName = new Map(commandsFor('desktop').map((c) => [c.name, c]))
    return (name: string): string => {
      const c = byName.get(name)
      return c ? (locale === 'en' ? c.en : c.zh) : name
    }
  }, [locale])

  useEffect(() => {
    let alive = true
    void getCustomCommands(useApp.getState().cfg).then((list) => { if (alive) setCustomCommands(list) })
    return () => { alive = false }
  }, [])

  const copyLastReply = async (): Promise<void> => {
    const st = useApp.getState()
    const sid = activeSessionId
    const msgs = sid ? st.messagesBySession[sid] || [] : []
    const last = [...msgs].reverse().find((m) => m.role === 'assistant')
    const text = (last?.content || '').trim()
    if (!text) { st.toast(t('input.slash.nothingToCopy'), true); return }
    try {
      await navigator.clipboard.writeText(text)
      st.toast(t('input.slash.copied'))
    } catch { st.toast(t('input.slash.nothingToCopy'), true) }
  }

  const retryLastMessage = async (): Promise<void> => {
    const st = useApp.getState()
    const sid = activeSessionId
    const msgs = sid ? st.messagesBySession[sid] || [] : []
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    if (!lastUser) { st.toast(t('input.slash.nothingToRetry'), true); return }
    st.regenerate(lastUser.id, sid)
  }

  // /export 高保真:经 REST 拉全量消息(含 tool_calls;内存 messagesBySession 只是渲染态切片),
  // frontmatter 元数据(标题/摘要/模型)+ 逐消息正文 + 工具调用一行摘要。接口失败回落内存切片。
  const exportSession = async (): Promise<void> => {
    const st = useApp.getState()
    const sid = activeSessionId
    if (!sid) { st.toast(t('input.slash.nothingToExport'), true); return }
    const sess = st.sessions.find((x) => x.id === sid)
    let msgs: Array<Pick<MessageRecord, 'role' | 'content' | 'tool_calls' | 'attachments'> & { timestamp?: number }> = []
    try {
      // 服务端单页硬限 500 且只回最近一页 —— 长会话必须用 before 游标向前翻页,否则早期内容静默丢失。
      let before = 0
      for (let page = 0; page < 20; page++) { // 防御上限 1 万条
        const batch = await listMessages(st.cfg, sid, 500, before || undefined)
        if (!batch.length) break
        msgs = [...batch, ...msgs]
        if (batch.length < 500) break
        before = Number(batch[0]?.timestamp) || 0
        if (!before) break
      }
    } catch { /* 离线/云端不可达 → 退回内存切片 */ }
    if (!msgs.length) msgs = (st.messagesBySession[sid] || []) as any
    if (!msgs.length) { st.toast(t('input.slash.nothingToExport'), true); return }
    const title = sess?.title || 'Tangu Session'
    const md = [
      '---',
      `id: ${sid}`,
      `title: ${JSON.stringify(title)}`,
      ...(sess?.summary ? [`summary: ${JSON.stringify(sess.summary)}`] : []),
      ...(sess?.model_id ? [`model: ${sess.model_id}`] : []),
      `exported_at: ${new Date().toISOString()}`,
      '---',
      '',
      `# ${title}`,
      '',
    ]
    for (const m of msgs) {
      const role = m.role === 'model' ? 'assistant' : m.role
      if (role !== 'user' && role !== 'assistant') continue
      const body = (m.content || '').trim()
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
      if (!body && !calls.length) continue
      md.push(role === 'user' ? '## 我' : '## Tangu', '')
      if (body) md.push(body, '')
      for (const c of calls) {
        const name = c?.function?.name || (c as any)?.name || 'tool'
        let args = ''
        try { args = String(typeof c?.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c?.function?.arguments ?? '')) } catch { args = '' }
        args = args.replace(/\s+/g, ' ').trim()
        md.push(`> 🔧 \`${name}\`${args && args !== '{}' ? ` ${args.length > 200 ? args.slice(0, 200) + '…' : args}` : ''}`)
      }
      if (calls.length) md.push('')
      const atts = Array.isArray((m as any).attachments) ? (m as any).attachments : []
      if (atts.length) md.push(`> 📎 ${atts.length} attachment(s)`, '')
    }
    const blob = new Blob([md.join('\n')], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `tangu-${String(sid).slice(0, 8)}.md`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  // 桌面级共享语音输入 hook:转写文本追加进草稿(不绑聊天,Amadeus 等可复用同一 hook)。
  const voice = useVoiceInput((text) => {
    setDraft((d) => (d ? d.replace(/\s+$/, '') + ' ' + text : text))
    setHistPos(0)
    requestAnimationFrame(autoGrow)
  })
  const voiceActive = voice.recording || voice.busy
  // 录音条上点 ↑:先停止转写(文字落草稿),转写结束后自动发送(用户选「转写并立即发送」)。
  const sendAfterVoiceRef = useRef(false)
  const voiceSend = () => { sendAfterVoiceRef.current = true; voice.toggle() }
  useEffect(() => {
    if (!sendAfterVoiceRef.current || voice.recording || voice.busy) return
    sendAfterVoiceRef.current = false
    if (draft.trim()) send()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.recording, voice.busy])

  const isHost = execConfig.execMode === 'host'
  const approval = execConfig.approvalMode || 'auto-edit'
  // 视口兜底:这些菜单是 absolute-in-relative + 固定宽度,窄屏时仍可能被边缘夹住。
  // mode 的外层会先占住 224px 最终宽度,避免胶囊展开时 right:0 锚点横移。见 menuAnchor.useEdgeNudge。
  const modeFix = useEdgeNudge(openMenu === 'mode', { boundary: '.t2-chat-view' })
  // 上下文占比的详情浮层:同款 absolute + 固定宽,窄屏也会捅出边缘。
  const ctxPopFix = useEdgeNudge(openMenu === 'ctx', { boundary: '.t2-chat-view' })

  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.('[data-cmenu]')) return
      setOpenMenu(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  const autoGrow = () => {
    const ta = taRef.current
    if (!ta) return
    // 空草稿一律交还给 CSS(rows=1 + min-height:1.6em)。不管上一次量高是在什么怪状态下发生的
    // ——面板隐藏、宽度为 0、折叠动画中途——只要内容空了就一定收得回一行:用户报的正是
    // 「明明 chat box 是空的却撑到最高档」。内联 height 是这个 bug 唯一的落脚点,清掉即根治症状。
    if (!ta.value) { ta.style.height = ''; return }
    ta.style.height = 'auto'
    ta.style.height = composerAutoHeight(ta.scrollHeight)
  }

  // 宽度变了要重量:autoGrow 只挂在 draft 上,而换行行数是宽度的函数 —— 拖侧栏、开关右栏、
  // 缩窗口都会让旧高度失真(在错误宽度下量到的高也是这么留下的)。只认**宽度**变化:
  // autoGrow 自己就在改高度,听高度会自激成循环。
  useEffect(() => {
    const ta = taRef.current
    if (!ta || typeof ResizeObserver === 'undefined') return
    let w = ta.clientWidth
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth === w) return
      w = ta.clientWidth
      autoGrow()
    })
    ro.observe(ta)
    return () => ro.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 草稿变化后同步高度(含发送清空后回缩):useLayoutEffect 在 React 把新值提交到 DOM 之后、绘制之前跑,
  // 量到的是当前文本;此前散落的 rAF(autoGrow) 会早于提交跑而量到旧文本 → 发送长文后输入框不回缩(本次修的 bug)。
  useLayoutEffect(autoGrow, [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  // 历史召回:older=true→↑ 取更旧、false→↓ 取更新;越过最新回到暂存草稿。光标置末尾。
  const recallHistory = (older: boolean) => {
    if (older && histPos === 0) histStash.current = draft // 首次进入:暂存当前草稿
    const r = pickRecall(sentHistory || [], histPos, older, histStash.current)
    if (!r) return
    setHistPos(r.pos)
    setDraft(r.val)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = r.val.length; setCursorPos(r.val.length) }
      autoGrow()
    })
  }

  // 外部 via-chat 入口预填草稿:seedText 非空 → 写入输入框(覆盖当前)+ 聚焦 + 回调清空,只消费一次。
  useEffect(() => {
    if (!seedText) return
    setDraft(seedText)
    onSeedConsumed?.()
    requestAnimationFrame(() => { taRef.current?.focus(); autoGrow() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedText])

  // 划线引用落入当前承载后，光标直接交给输入框：侧栏展开即可继续输入问题。
  useEffect(() => {
    if (!quotedText) return
    requestAnimationFrame(() => taRef.current?.focus())
  }, [quotedText])

  // 从工作区/笔记树/会话列表拖进来的引用 → 上方「已选择」芯片(2026-08-14 起;此前是往草稿里塞
  // 一长串 [[路径]] 文本)。消费后回调清空。
  useEffect(() => {
    if (!appendRefs?.refs.length) return
    addRefChips(appendRefs.refs.map((r) => refChipOf(r, vaultRoot || '')))
    onAppendRefsConsumed?.()
    requestAnimationFrame(() => { taRef.current?.focus(); autoGrow() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendRefs?.seq])

  /** 把光标处那个命令词换成 text(空串=删掉),返回它的起点。
   *  命令项一律走它 —— 斜杠不再必然在开头,直接 setDraft('') 会连带抹掉用户已写好的正文。 */
  const replaceSlash = (text: string): number => {
    const span = slashSpan.current
    const start = span?.start ?? 0
    const end = span?.end ?? Infinity // 无 span(理论上不会有):退回旧行为,整份换掉
    setDraft((d) => d.slice(0, start) + text + d.slice(end))
    const caret = start + text.length
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = caret; setCursorPos(caret) }
      autoGrow()
    })
    return start
  }

  const slashItems = useMemo<SlashItem[]>(() => {
    const close = () => { replaceSlash(''); setSlashSubMenu(null) }
    const app = useApp.getState
    /** 命令名 → 本端实现。**没有条目 = 本端不露出该命令**(catalog 里声明了也不显示)。
     *  加命令:先进 tangu-agent 的 core/commandCatalog(TUI 一起吃到),再在这里补 handler。 */
    const handlers: Record<string, (() => void) | undefined> = {
      '/stop': running ? () => { onStop(); close() } : undefined,
      '/new': onNewSession ? () => { onNewSession(); close() } : undefined,
      '/branch': onBranch ? () => { onBranch(); close() } : undefined,
      '/compact': onCompact ? () => { onCompact(); close() } : undefined,
      '/plan': onPlanModeChange ? () => { onPlanModeChange(!planMode); close() } : undefined,
      '/voice': onVoiceModeChange ? () => { onVoiceModeChange(!voiceMode); close() } : undefined,
      '/model': onModelChange && models?.length
        ? () => { setSlashSubMenu({ start: replaceSlash('/model ') }); setSlashIndex(0) }
        : undefined,
      '/loop': onMaxIterationsChange
        ? () => { replaceSlash('/loop '); setSlashIndex(0) }
        : undefined,
      // 验证回路仅 host 会话(引擎在本机 cwd 跑命令;沙箱会话没有本机工作区)。
      '/verify': isHost && onVerifyCommandChange
        ? () => { replaceSlash('/verify '); setSlashIndex(0) }
        : undefined,
      '/think': onThinkingChange ? () => { replaceSlash('/think '); setSlashIndex(0) } : undefined,
      // /refine:插入原文让用户可补充说明,回车走普通发送——引擎检测 /refine 前缀注入复盘指令(agentLoop)。
      // 仅 host 会话(工作笔记写在本机 agent 目录,manage_harness 也是 host-only);运行中不露出——
      // 此时发送会变成 steer 注入,引擎的 refine 检测只在 run 开头跑一次,steer 进去的 /refine 不生效。
      '/refine': isHost && !running ? () => { replaceSlash('/refine '); setSlashIndex(0) } : undefined,
      '/approval': () => { setOpenMenu('mode'); close() },
      // 下面这些在桌面端等价于「打开对应面板」——TUI 里是打印一段文本,GUI 里就该跳过去。
      '/help': () => { app().openSettings('about'); close() },
      '/skills': () => { app().openSettings('skills'); close() },
      '/tools': () => { app().openSettings('agents'); close() },
      '/agents': () => { app().openSettings('agents'); close() },
      '/agent': () => { app().openSettings('agents'); close() },
      '/mcp': () => { app().openSettings('mcp'); close() },
      '/plugins': () => { app().openSettings('plugins'); close() },
      '/memory': () => { app().openSettings('sync'); close() },
      '/config': () => { app().openSettings('general'); close() },
      '/login': () => { app().openSettings('connection'); close() },
      // Historian / Muse 的桌面入口在「特殊 Agent」名册页(没有各自独立的视图)。
      '/historian': () => { app().setActiveSpecial('agents'); close() },
      '/muse': () => { app().setActiveSpecial('agents'); close() },
      '/groupchat': onGroupChange ? () => { setGroupSetupOpen(true); close() } : undefined,
      '/sessions': () => { app().setActiveId(null); close() },
      '/cost': () => {
        const st = app()
        st.pushNotice(
          `${(sessionTokens ?? 0).toLocaleString()} tokens · ${t('input.ctxLabel')} ${(ctxTokens ?? 0).toLocaleString()}/${(contextWindow ?? 0).toLocaleString()}` +
            (runCost != null && costLimit != null && costLimit > 0
              ? ` · ${t('input.runCost', { used: Math.round(runCost).toLocaleString(), limit: costLimit.toLocaleString() })}`
              : ''),
        )
        close()
      },
      '/status': () => {
        const st = app()
        st.pushNotice(
          [
            `${t('input.slash.status')}`,
            `model=${modelId || '-'}`,
            `think=${thinkingLevel || 'medium'}${ctxInfo?.thinkingRequested === (thinkingLevel || 'medium') && ctxInfo.thinkingEffective && ctxInfo.thinkingEffective !== ctxInfo.thinkingRequested ? `→${ctxInfo.thinkingEffective}` : ''}`,
            `approval=${execConfig.approvalMode || '-'}`,
            `cwd=${execConfig.cwd || '-'}`,
            `loop=${maxIterations || 90}`,
            `verify=${verifyCommand || '-'}`,
            `tokens=${(sessionTokens ?? 0).toLocaleString()}`,
            `cost=${runCost != null ? Math.round(runCost).toLocaleString() : '-'}${costLimit != null && costLimit > 0 ? `/${costLimit.toLocaleString()}` : ''}`,
          ].join('\n  '),
        )
        close()
      },
      '/copy': () => { void copyLastReply(); close() },
      '/retry': () => { void retryLastMessage(); close() },
      '/export': () => { void exportSession(); close() },
    }

    const items: SlashItem[] = []
    if (running) {
      const stop = handlers['/stop']
      if (stop) items.push({ cmd: '/stop', desc: describe('/stop'), run: stop })
    }
    // 外部引擎接管时:命令来自引擎自身(ACP),只保留 /new 免得两套语义打架。
    if (engineId) {
      if (onNewSession) items.push({ cmd: '/new', desc: describe('/new'), run: () => { onNewSession(); close() } })
      for (const c of engineCommands || []) {
        items.push({
          cmd: `/${c.name}`,
          desc: c.hint ? `${c.description} · ${c.hint}` : c.description,
          run: () => { replaceSlash(`/${c.name} `); setSlashIndex(0) },
        })
      }
      return items
    }
    // 思考档位:每档一条,直接点选(比先 /think 再敲档位快)。
    if (onThinkingChange) {
      // 外部引擎会话:modelId 是 Tangu 侧回退值,不是引擎实际用的模型——不标注,免得标错方向
      const supported = engineId ? undefined : models?.find((m) => m.id === modelId)?.thinkingLevels
      for (const lv of THINKING_LEVELS) {
        const unsupported = !!supported && !supported.includes(lv)
        items.push({
          cmd: `/think ${lv}`,
          desc: `${t('input.slash.thinkDesc', { level: lv })}${unsupported ? ` ${t('pill.thinkUnsupported')}` : ''}${thinkingLevel === lv ? t('input.slash.current') : ''}`,
          run: () => { onThinkingChange(lv); close() },
        })
      }
    }
    for (const c of commandsFor('desktop')) {
      if (c.name === '/stop' || c.name === '/think') continue // 上面已单独处理
      const run = handlers[c.name]
      if (!run) continue
      items.push({ cmd: c.arg ? `${c.name} ${c.arg}` : c.name, desc: describe(c.name), run })
    }
    // 用户自定义命令(~/.tangu/commands/*.md):展开成普通消息发出去。
    for (const c of customCommands) {
      items.push({
        cmd: c.argHint ? `/${c.name} ${c.argHint}` : `/${c.name}`,
        desc: c.description,
        run: () => { replaceSlash(`/${c.name} `); setSlashIndex(0) },
      })
    }
    if (skills?.length) {
      for (const s of skills) {
        items.push({
          cmd: `/skill:${s.id}`,
          desc: t('input.slash.skillUse', { name: s.name }),
          run: () => { setPinnedSkills((prev) => (prev.some((p) => p.id === s.id) ? prev : [...prev, s])); close() },
        })
      }
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, onStop, planMode, voiceMode, onVoiceModeChange, thinkingLevel, maxIterations, onMaxIterationsChange, verifyCommand, onVerifyCommandChange, models, modelId, skills, onPlanModeChange, onThinkingChange, onModelChange, onNewSession, onBranch, onCompact, onGroupChange, engineId, engineCommands, customCommands, describe, execConfig, sessionTokens, ctxTokens, contextWindow, runCost, costLimit, ctxInfo])

  const slash = useMemo(() => {
    if (disabled || slashDismissed) return null
    const before = draft.slice(0, cursorPos)
    // 子菜单开着 → 词从锚点算起(带得动空格和参数);锚点上的字没了就自动落回普通命令词。
    if (slashSubMenu && before.startsWith('/model ', slashSubMenu.start)) {
      return { start: slashSubMenu.start, token: before.slice(slashSubMenu.start), sub: 'model' as const }
    }
    const m = slashTokenAt(draft, cursorPos)
    return m ? { ...m, sub: null } : null
  }, [draft, cursorPos, disabled, slashDismissed, slashSubMenu])
  slashSpan.current = slash ? { start: slash.start, end: cursorPos } : null

  const slashMatches = useMemo<SlashItem[]>(() => {
    if (!slash) return []
    if (slash.sub === 'model') {
      const filter = slash.token.slice('/model '.length).toLowerCase()
      return (models || [])
        .filter((m) => !filter || m.id.toLowerCase().includes(filter) || m.name.toLowerCase().includes(filter))
        .slice(0, 12)
        .map((m) => ({
          cmd: m.id === modelId ? `● ${m.name}` : m.name,
          desc: `${m.source === 'direct' ? t('input.directPrefix') : ''}${m.provider} · ${m.id}`,
          run: () => { onModelChange?.(m.id); replaceSlash(''); setSlashSubMenu(null) },
        }))
    }
    const q = slash.token.toLowerCase()
    return slashItems.filter((it) => it.cmd.toLowerCase().startsWith(q) || (q.length > 1 && it.desc.toLowerCase().includes(q.slice(1)))).slice(0, 10)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slash, slashItems, models, modelId])
  // 只有真弹出来的菜单才压住 @ / [[ ——「有个斜杠词」还不够:敲 `/Users/me/[[` 时命令词一直在,
  // 但一条都匹配不上,此时该让文件引用菜单出来。
  const slashOpen = !!slash && slashMatches.length > 0
  // 换了个命令词(或改了过滤词)→ 高亮回第一条,与 @ 提及同规矩;光标挪到别处的 `/` 上也不会带着旧下标。
  useEffect(() => { setSlashIndex(0) }, [slash?.start, slash?.token])

  const inGroup = !!groupChat && (groupAgents?.length || 0) >= 2
  const mentionPool = useMemo<NormalAgentDef[]>(() => {
    if (!inGroup) return agents || []
    const saved = (agents || []).filter((a) => groupAgents!.includes(a.slug))
    const seen = new Set(saved.map((a) => a.slug))
    return [...saved, ...(groupTempAgents || []).filter((a) => !seen.has(a.slug))]
  }, [inGroup, agents, groupAgents, groupTempAgents])
  const mention = useMemo(() => {
    if (disabled || slashOpen || mentionDismissed) return null
    const m = /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, cursorPos))
    return m ? { query: m[1], start: cursorPos - m[1].length - 1 } : null
  }, [draft, cursorPos, disabled, slashOpen, mentionDismissed])
  const mentionMatches = useMemo<NormalAgentDef[]>(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    return mentionPool.filter((a) => !q || a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q)).slice(0, 10)
  }, [mention, mentionPool])
  const mentionActive = !!mention && mentionMatches.length > 0
  useEffect(() => { setMentionIndex(0) }, [mention?.start, mention?.query])

  const pickMention = (a: NormalAgentDef) => {
    if (!mention) return
    const before = draft.slice(0, mention.start)
    const insert = `@${a.name} `
    const next = before + insert + draft.slice(cursorPos)
    setDraft(next)
    if (inGroup) setMentionedSlug(a.slug)
    else setMentionAgents((prev) => (prev.includes(a.slug) ? prev : [...prev, a.slug]))
    const caret = before.length + insert.length
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = caret; setCursorPos(caret) }
      autoGrow()
    })
  }

  // ── [[ 引用:工作区文件(插入相对路径,与拖放/粘贴同契约)+ Amadeus 笔记(插入 [[绝对路径|名字]],
  //    气泡显示名字、agent 读到路径)+ 历史会话([[session:id|标题]],read_session 读)。
  //    门控拆分:菜单本身全模式可用(会话引用 host/cloud 通吃);笔记/文件候选仅 host 会话
  //    (云端/沙箱读不到本机路径)。文件候选 = listDir 惰性 BFS。
  const fileRefCtx = useMemo(() => {
    if (disabled || slashOpen || refDismissed) return null
    const m = /\[\[([^\]\n]*)$/.exec(draft.slice(0, cursorPos))
    return m ? { query: m[1], start: cursorPos - m[1].length - 2 } : null
  }, [draft, cursorPos, disabled, slashOpen, refDismissed])
  useEffect(() => {
    if (!fileRefCtx || !isHost) return // 本地文件/笔记候选仅 host;云端会话只出会话候选
    if (window.amadeus) ensureAmadeusReady() // 懒引导 vault(幂等):聊天先于 Amadeus 打开时,笔记候选也在
    const root = execConfig.cwd
    // 只认 refFilesFor(已发射标记):打字使 fileRefCtx 每键变化,若依赖 refFiles 是否就绪,
    // 首次 BFS 完成前每个字符都会重复发射一整轮 BFS(listDir 风暴)。
    if (!root || refFilesFor.current === root) return
    refFilesFor.current = root
    setRefFiles(null) // 换工作区先清旧候选,避免过渡期显示上一工作区的文件
    const IGNORE = new Set(['node_modules', 'dist', 'build', 'out', 'target', '.git', '.venv', 'venv', '__pycache__'])
    const run = async (): Promise<string[]> => {
      const found: string[] = []
      const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }]
      while (queue.length && found.length < 2000) {
        const { dir, rel, depth } = queue.shift()!
        let entries: Array<{ name: string; isDir: boolean; path: string }> = []
        try { entries = (await window.tangu?.listDir?.(dir)) || [] } catch { continue }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue
          if (e.isDir) { if (depth < 8 && !IGNORE.has(e.name)) queue.push({ dir: e.path, rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 }) }
          else { found.push(rel ? `${rel}/${e.name}` : e.name); if (found.length >= 2000) break }
        }
      }
      return found
    }
    void run().then((list) => { if (refFilesFor.current === root) setRefFiles(list) }).catch(() => {})
  }, [fileRefCtx, execConfig.cwd, isHost])
  const vaultPages = usePageStore((s) => s.pages)
  const vaultRoot = usePageStore((s) => s.vaultRoot)
  const pageIcons = usePageStore((s) => s.icons)
  const chatSessions = useApp((s) => s.sessions)
  const storeActiveSessionId = useApp((s) => s.activeId)
  const activeSessionId = sessionId === undefined ? storeActiveSessionId : sessionId
  const refMatches = useMemo<RefCand[]>(() => {
    if (!fileRefCtx) return []
    const q = fileRefCtx.query.toLowerCase()
    // 笔记在前(sort 稳定 → 同分保持此序),工作区文件次之,历史会话最后(与拖拽引用同契约,
    // agent 经 read_session 读)。笔记/文件仅 host(云端读不到本机路径);会话候选全模式可用。
    // 当前会话不列(引用自己无意义)。
    const cands: RefCand[] = [
      ...(isHost ? vaultPages.map((p) => ({ p, note: true as const })) : []),
      ...(isHost ? (refFiles ?? []).map((p) => ({ p })) : []),
      ...chatSessions
        .filter((s) => s.id !== activeSessionId)
        .slice(0, 300)
        .map((s) => ({ p: s.title || 'New Chat', session: { id: s.id, title: s.title || 'New Chat', summary: s.summary } })),
    ]
    const pool = q ? cands.filter((c) => c.p.toLowerCase().includes(q)) : cands
    // 文件名前缀命中 > 文件名包含 > 仅路径包含;同档路径短者先。
    const score = (c: RefCand): number => {
      const base = (c.note ? c.p.replace(/\.md$/i, '') : c.p).split('/').pop()!.toLowerCase()
      return (base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2) * 10000 + c.p.length
    }
    return [...pool].sort((a, b) => score(a) - score(b)).slice(0, 10)
  }, [fileRefCtx, refFiles, vaultPages, chatSessions, activeSessionId, isHost])
  const refActive = !!fileRefCtx && refMatches.length > 0
  useEffect(() => { setRefIndex(0) }, [fileRefCtx?.start, fileRefCtx?.query])

  /** 选中一条候选 → 变成上方「已选择」芯片,并把触发用的 `[[查询` 从草稿里抹掉。
   *  发送时 token 原样拼回正文,故对引擎/气泡而言与旧的行内插入完全等价(见 RefChip)。 */
  const pickRef = (c: RefCand) => {
    if (!fileRefCtx) return
    const token = (c.session
      ? refToText({ kind: 'session', id: c.session.id, title: c.session.title }, vaultRoot || '') // [[session:id|标题]]:与拖拽同契约(session 分支不用 vaultRoot)
      : c.note && vaultRoot
      ? noteRefInsert(vaultRoot, c.p) // [[绝对路径|名字]]:气泡渲染名字,agent 读到路径
      : /\s/.test(c.p) ? `"${c.p}"` : c.p // 含空格加引号,与粘贴本机路径一致
    ).trim()
    addRefChips([{ token, name: c.session ? c.session.title : chipBaseName(c.p), kind: c.session ? 'session' : c.note ? 'note' : 'file' }])
    const before = draft.slice(0, fileRefCtx.start)
    setDraft(before + draft.slice(cursorPos))
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = before.length; setCursorPos(before.length) }
      autoGrow()
    })
  }

  /** 主区当前打开的那篇**笔记**。pageStore 门面在编辑器子树**之外**解析到「活动编辑器面板」那份,
   *  正是「当前这篇」的语义,主区换 tab / 就地换笔记都会自动跟上(见 pageStore 的作用域一节)。 */
  const mainNote = usePageStore((s) => s.activePage ?? s.activeNotePath) // v4 笔记不设 activePage
  /** 主区聚焦的那个 tab 承载的文件(笔记以外的:工作区文件预览 wsfile 等)。
   *  ⚠️ `mainTabs[].active` 比的是**全局** activePanel —— 焦点在侧栏(本功能的常态)时主区一个
   *  active 都没有,只看它必然恒空。故:主区有焦点就按焦点那个判,没焦点就在主区里挑一个带文件的
   *  (编辑器优先 —— 它的实时路径由 activePage 提供,比 tab 参数准)。 */
  const mainRefKey = useWorkspace((w) => {
    const tabs = w.mainTabs
    // 焦点在侧栏(本功能的常态)时主区一个 active 都没有 → 退到主区**自己的前台 tab**(front),
    // 而不是「第一个类型对得上的」——后者在主区开着两个 tab 时会引用后台那篇(评审 M4)。
    const cand = tabs.find((t) => t.active) ?? tabs.find((t) => t.front) ?? tabs.find((t) => t.type === 'amadeus-editor') ?? tabs.find((t) => t.filePath)
    if (!cand) return ''
    if (cand.type === 'amadeus-editor') return 'note' // 具体哪一篇由 activePage 说了算(就地换笔记也跟得上)
    return cand.filePath ? `file:${cand.filePath}` : ''
  }) // 选择器返回**字符串**:zustand v5 没有 equalityFn,返回新对象会每次都判「变了」→ 无限重渲
  const autoChip = useMemo<RefChip | null>(() => {
    // 仅 host 会话:引用是一条**本机绝对路径**,云端/沙箱会话的 agent 读不到 —— 挂上去就是
    // 「显示了路径但模型读不到」,与 [[ 候选、粘贴本机文件那两处的门控同一条理由。
    if (!isHost || !autoRefFromMain || !mainRefKey) return null
    const chip = mainRefKey === 'note'
      ? (mainNote && vaultRoot ? refChipOf({ kind: 'note', path: mainNote }, vaultRoot) : null)
      : fileChip(mainRefKey.slice('file:'.length))
    if (!chip || autoRefOff === chip.token) return null
    if (refChips.some((c) => c.token === chip.token)) return null // 用户已显式引过同一个 → 不重复挂
    return chip
  }, [isHost, autoRefFromMain, mainRefKey, mainNote, vaultRoot, autoRefOff, refChips])
  const allRefChips = autoChip ? [autoChip, ...refChips] : refChips

  const send = () => {
    const text = draft.trim()
    // 只挂引用不写字也算一条消息:芯片化之前拖引用会往草稿塞文本,所以「拖完直接回车」是能发的;
    // 不放行的话按回车毫无反应 = 哑火(评审 M2)。斜杠命令那几段都要求 text,故只在这之后判空。
    if (!text && !allRefChips.length) return
    const loopMatch = /^\/loop(?:\s+(\d+))?$/i.exec(text)
    if (loopMatch && onMaxIterationsChange) {
      if (loopMatch[1]) {
        const n = Math.min(Math.max(1, parseInt(loopMatch[1], 10)), 200)
        onMaxIterationsChange(n)
        setHint(t('input.slash.loopSet', { n }))
      } else {
        setHint(t('input.slash.loop', { current: maxIterations || 90 }))
      }
      setDraft('')
      requestAnimationFrame(autoGrow)
      return
    }
    // /verify <命令|off>:设/清本会话验证命令(收尾闸门;引擎收尾前自动跑,不绿不许收)。
    const verifyMatch = /^\/verify(?:\s+([\s\S]+))?$/i.exec(text)
    if (verifyMatch && isHost && onVerifyCommandChange) {
      const arg = (verifyMatch[1] || '').trim()
      if (!arg) {
        setHint(t('input.slash.verifyUsage', { current: verifyCommand || t('input.slash.verifyNone') }))
      } else if (/^(off|clear|关闭)$/i.test(arg)) {
        onVerifyCommandChange('')
        setHint(t('input.slash.verifyCleared'))
      } else {
        onVerifyCommandChange(arg)
        setHint(t('input.slash.verifySet', { cmd: arg }))
      }
      setDraft('')
      requestAnimationFrame(autoGrow)
      return
    }
    if (onVoiceModeChange && /^\/(voice|text)$/i.test(text)) {
      const on = /^\/voice$/i.test(text)
      onVoiceModeChange(on)
      setHint(on ? t('input.slash.voiceOnHint') : t('input.slash.voiceOffHint'))
      setDraft('')
      requestAnimationFrame(autoGrow)
      return
    }
    // /think|/effort <档位>:敲完回车直接生效(菜单点选之外的键盘路径)。
    const thinkMatch = /^\/(?:think|effort)(?:\s+(\S+))?$/i.exec(text)
    if (thinkMatch && onThinkingChange) {
      const lv = (thinkMatch[1] || '').toLowerCase() as NonNullable<AgentConfig['thinkingLevel']>
      if (THINKING_LEVELS.includes(lv)) {
        onThinkingChange(lv)
        setHint(t('input.slash.thinkSet', { level: lv }))
      } else {
        setHint(t('input.slash.thinkUsage', { levels: THINKING_LEVELS.join('|') }))
      }
      setDraft('')
      requestAnimationFrame(autoGrow)
      return
    }
    // 用户自定义命令:服务端展开($ARGUMENTS/$1..$9)后当普通消息发出去。
    const customMatch = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text)
    if (customMatch && customCommands.some((c) => c.name === customMatch[1].toLowerCase())) {
      const name = customMatch[1].toLowerCase()
      const args = customMatch[2] || ''
      setDraft('')
      requestAnimationFrame(autoGrow)
      void expandCustomCommand(useApp.getState().cfg, name, args)
        .then((expanded) => onSend(expanded, [], [], undefined, undefined))
        .catch((e: any) => setHint(String(e?.message || e)))
      return
    }
    if (disabled) return
    const quoted = quotedText ? `${quotedText.split('\n').map((l) => `> ${l}`).join('\n')}\n\n` : ''
    // 「已选择」芯片 → 正文最前面的一行引用 token。行内位置在芯片化之后不再存在,统一前置(= 上下文在前)。
    const refs = allRefChips.length ? allRefChips.map((c) => c.token).join(' ') + '\n' : ''
    const outgoing = refs + quoted + text
    if (outgoing.length > MAX_INPUT_CHARS) {
      setHint(t('input.tooLong', { len: outgoing.length.toLocaleString(), max: MAX_INPUT_CHARS.toLocaleString() }))
      return
    }
    setHint(null)
    const mentions = inGroup
      ? { priorityAgent: mentionedSlug || undefined }
      : { mentionAgents: mentionAgents.length ? mentionAgents : undefined }
    void onSend(outgoing, attachments, wsFiles, pinnedSkills.map((s) => s.id), mentions).then((accepted) => {
      if (!accepted) return
      setDraft('')
      setHistPos(0)
      setAttachments([])
      setWsFiles([])
      setRefChips([]) // 自动那条不在这里面 —— 它是 activePage 的派生量,下一条消息照旧自动挂上
      setPinnedSkills([])
      setMentionedSlug('')
      setMentionAgents([])
      onClearQuote?.()
      requestAnimationFrame(autoGrow)
    })
  }

  const pickFiles = async (files: FileList | null) => {
    if (!files) return
    const next: Attachment[] = []
    const skipped: string[] = []
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) { skipped.push(t('input.skip.notImage', { name: f.name })); continue }
      if (f.size > MAX_ATTACH_BYTES) { skipped.push(t('input.skip.tooBig', { name: f.name, mb: String(Math.round(MAX_ATTACH_BYTES / 1024 / 1024)) })); continue }
      const buf = await f.arrayBuffer()
      let bin = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      next.push({ name: f.name, mimeType: f.type, data: btoa(bin), size: f.size })
    }
    setHint(skipped.length ? t('input.skip.imageHint', { items: skipped.join('、') }) : null)
    setAttachments((prev) => [...prev, ...next])
  }

  const pickWsFiles = async (files: FileList | null) => {
    if (!files) return
    const next: Attachment[] = []
    const skipped: string[] = []
    for (const f of Array.from(files)) {
      if (f.size > MAX_WS_BYTES) { skipped.push(t('input.skip.tooBig', { name: f.name, mb: String(Math.round(MAX_WS_BYTES / 1024 / 1024)) })); continue }
      const buf = await f.arrayBuffer()
      let bin = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      next.push({ name: f.name, mimeType: f.type || 'application/octet-stream', data: btoa(bin), size: f.size })
    }
    setHint(skipped.length ? t('input.skip.simple', { items: skipped.join('、') }) : null)
    setWsFiles((prev) => [...prev, ...next])
  }

  /** OS 文件落下:host 走本机路径芯片,其余上传成工作区附件。 */
  const onFilesDrop = (files: FileList): void => {
    if (!files.length) return
    if (isHost && window.tangu?.getPathForFile) {
      const paths = Array.from(files)
        .map((f) => { try { return window.tangu!.getPathForFile!(f) } catch { return '' } })
        .filter(Boolean)
      if (paths.length) {
        addRefChips(paths.map(fileChip)) // 上方「已选择」芯片,不再往输入框里塞一串裸路径
        requestAnimationFrame(() => { taRef.current?.focus(); autoGrow() })
        return
      }
    }
    void pickWsFiles(files)
  }
  const filesDropRef = useRef(onFilesDrop)
  filesDropRef.current = onFilesDrop

  // 落区 = **整个聊天区**(与侧栏拖引用同一片,见 ChatView 的 refdrop),不用瞄准输入框。
  useEffect(() => {
    const card = cardRef.current
    return card ? bindFilesDropZone(card, (f) => filesDropRef.current(f), setDragOver) : undefined
  }, [])

  /** Web / 云端回退：一个系统文件选择动作里，图片仍进 vision 附件，其余文件仍进工作区附件。 */
  const pickMixedFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length) return
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'))
    const others = Array.from(files).filter((f) => !f.type.startsWith('image/'))
    if (images.length) {
      const dt = new DataTransfer()
      images.forEach((f) => dt.items.add(f))
      await pickFiles(dt.files)
    }
    if (others.length) {
      const dt = new DataTransfer()
      others.forEach((f) => dt.items.add(f))
      await pickWsFiles(dt.files)
    }
  }

  /** Electron 原生「文件或文件夹」：文件读成原有附件格式；文件夹与超大文件保留为路径引用。 */
  const pickHostPaths = async (items: Array<{ path: string; isDirectory: boolean }>): Promise<void> => {
    const nextImages: Attachment[] = []
    const nextFiles: Attachment[] = []
    const nextRefs: RefChip[] = []
    for (const item of items) {
      if (item.isDirectory) { nextRefs.push(folderChip(item.path)); continue }
      try {
        const file = await window.tangu?.readHostFile?.(item.path)
        if (!file || file.tooLarge) { nextRefs.push(fileChip(item.path)); continue }
        const attachment = { name: chipBaseName(item.path), mimeType: file.mimeType, data: file.content, size: file.size }
        if (file.mimeType.startsWith('image/') && file.size <= MAX_ATTACH_BYTES) nextImages.push(attachment)
        else if (file.size <= MAX_WS_BYTES) nextFiles.push(attachment)
        else nextRefs.push(fileChip(item.path))
      } catch {
        // 路径仍是有效上下文；读盘失败不该让用户刚选的文件无声消失。
        nextRefs.push(fileChip(item.path))
      }
    }
    if (nextImages.length) setAttachments((prev) => [...prev, ...nextImages])
    if (nextFiles.length) setWsFiles((prev) => [...prev, ...nextFiles])
    if (nextRefs.length) addRefChips(nextRefs)
  }

  const addContentReference = (ref: AddContentReference): void => {
    addRefChips([ref.kind === 'view' ? viewChip(ref.type, ref.title) : refChipOf(ref, vaultRoot || '')])
    requestAnimationFrame(() => taRef.current?.focus())
  }

  const [rulesOpen, setRulesOpen] = useState(false)
  // 订阅而非 getState() 快照:cfg(token/backendUrl)刷新时弹层要跟着拿到新的
  const liveCfg = useApp((s) => s.cfg)
  const setApproval = (m: NonNullable<AgentConfig['approvalMode']>) => {
    onExecConfigChange({ execMode: 'host', approvalMode: m, cwd: execConfig.cwd })
    setOpenMenu(null)
  }

  const modelGroups = useMemo(() => groupModelsByProvider(models || []), [models])
  const groupActive = !!groupChat && (groupAgents?.length || 0) >= 2
  const curApproval = APPROVALS.find((a) => a.id === approval) || APPROVALS[1]
  const modeLabel = groupActive
    ? t('group.modeLabel', { n: groupAgents!.length })
    : planMode ? t('input.planMode') : (isHost ? t(curApproval.key) : t('input.normal'))
  // 收窄时药丸只剩图标,故图标随当前模式变(群聊/计划/审批档位),窄屏也能一眼看出状态。
  const ModeIcon = groupActive ? Users
    : planMode ? ClipboardList
    : isHost ? curApproval.Icon
    : MessageSquare
  const showModeChip = !!onPlanModeChange || isHost || !!onGroupChange
  const currentEngine = (engines || []).find((e) => e.id === engineId)
  const engineLabel = currentEngine?.name || t('input.engineDefault')
  const isEngine = !!engineId
  const modelPillGroups: ModelPillGroup[] = isEngine
    ? [{ label: engineLabel, options: engineModels || [] }]
    : modelGroups.map((g) => ({
        label: g.provider + (g.source === 'direct' ? ` · ${t('model.group.direct')}` : g.source === 'forsion' ? ` · ${t('model.group.forsion')}` : ''),
        options: g.models.map((m) => ({ id: m.id, name: m.name, description: `${m.provider} · ${m.id}` })),
      }))
  const showModelPill = isEngine || !!onModelChange || !!onThinkingChange

  return (
    <div className="t2c">
      {groupSetupOpen && (
        <GroupChatSetup
          agents={agents || []}
          models={models}
          initialAgents={groupAgents || []}
          initialTempAgents={groupTempAgents}
          initialIntensity={groupIntensity}
          initialRounds={groupMaxRounds}
          active={groupActive}
          onConfirm={(r) => { onGroupChange?.({ groupChat: true, ...r }); setGroupSetupOpen(false); track('chat.group') }}
          onDisable={() => onGroupChange?.({ groupChat: false })}
          onClose={() => setGroupSetupOpen(false)}
        />
      )}
      <div className="t2c-inner">
        {/* steer 等待区:run 跑动中发出的消息在这里排队,引擎注入(turn_boundary)即上屏。
          * 每条可删(文本仍留在 ↑ 历史);「立即插话」=打断当前 run 强发;↑ 撤回最新一条回输入框。 */}
        {!!pendingSteer?.length && (
          <div className="t2c-steer" role="status" aria-label={t('input.steer.waiting')}>
            {pendingSteer.map((p) => (
              <div className="t2c-steer-item" key={p.id}>
                <Clock size={12} className="t2c-steer-ic" />
                <span className="t2c-steer-text" title={p.text}>{p.text}</span>
                <button className="t2c-steer-x" title={t('input.steer.remove')} onClick={() => onCancelSteer?.(p.id)}><X size={12} /></button>
              </div>
            ))}
            <div className="t2c-steer-foot">
              <span className="t2c-steer-hint">{t('input.steer.hint')}</span>
              {onSteerNow && (
                <button className="t2c-steer-now" onClick={onSteerNow}><Zap size={11} /> {t('input.steer.now')}</button>
              )}
            </div>
          </div>
        )}
        <div ref={cardRef} className={`t2c-card${dragOver ? ' dragover' : ''}`}>
          {hint && <div className="t2c-hint">{hint}</div>}
          {quotedText && (
            <div className="t2c-quote">
              <span className="t2c-quote-text">{quotedText.length > 280 ? `${quotedText.slice(0, 280)}…` : quotedText}</span>
              <button title={t('input.remove')} onClick={() => onClearQuote?.()} className="t2c-quote-x"><X size={12} /></button>
            </div>
          )}
          {allRefChips.length > 0 && (
            <div className="t2c-chiprow t2c-refrow">
              <span className="t2c-reflabel">{t('input.ref.selected')}</span>
              {allRefChips.map((c) => (
                <span className="attach-chip" key={c.token} title={c.token}>
                  {c.kind === 'session'
                    ? <MessageSquare size={13} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />
                    : c.kind === 'folder'
                    ? <Folder size={13} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />
                    : c.kind === 'view'
                    ? <PanelsTopLeft size={13} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />
                    : <FileText size={13} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />}
                  <span>{c.name}</span>
                  <button
                    title={t('input.remove')}
                    onClick={() => {
                      // 自动那条不在 refChips 里,× 它 = 记下「这一篇先别挂」(换篇即复活)。
                      if (autoChip && c.token === autoChip.token) setAutoRefOff(c.token)
                      else setRefChips((prev) => prev.filter((x) => x.token !== c.token))
                    }}
                  ><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="t2c-chiprow">
              {attachments.map((a, i) => (
                <span className="attach-chip" key={`${a.name}-${i}`}>
                  {a.mimeType.startsWith('image/') && <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />}
                  <span>{a.name}</span>
                  <button title={t('input.remove')} onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          {wsFiles.length > 0 && (
            <div className="t2c-chiprow">
              {wsFiles.map((a, i) => (
                <span className="attach-chip" key={`ws-${a.name}-${i}`} title={t('input.wsUploadTitle', { name: a.name })}>
                  {a.mimeType.startsWith('image/')
                    ? <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
                    : <FileText size={14} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />}
                  <span>{a.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)', flexShrink: 0 }}>{t('input.toWorkspace')}</span>
                  <button title={t('input.remove')} onClick={() => setWsFiles(wsFiles.filter((_, j) => j !== i))}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          {pinnedSkills.length > 0 && (
            <div className="t2c-chiprow">
              {pinnedSkills.map((s) => (
                <span className="attach-chip" key={`skill-${s.id}`} title={t('input.skillChipTitle')}>
                  <Sparkles size={13} style={{ color: 'var(--accent-ink)', flexShrink: 0 }} />
                  <span>{s.name}</span>
                  <button title={t('input.remove')} onClick={() => setPinnedSkills(pinnedSkills.filter((x) => x.id !== s.id))}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            className="t2c-ta"
            rows={1}
            autoFocus={autoFocus}
            value={draft}
            placeholder={disabled ? t('input.placeholderDisabled') : t('input.placeholder')}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value)
              setCursorPos(e.target.selectionStart || 0)
              setSlashDismissed(false)
              setMentionDismissed(false)
              setRefDismissed(false)
              if (histPos) setHistPos(0) // 用户实际打字 → 退出历史召回态
              if (!e.target.value.includes('@')) { setMentionedSlug(''); setMentionAgents([]) }
              autoGrow()
            }}
            onSelect={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart || 0)}
            onPaste={(e) => {
              const files = e.clipboardData?.files
              if (!files?.length) return // 纯文本粘贴照常,不拦
              e.preventDefault()
              const all = Array.from(files)
              const images = all.filter((f) => f.type.startsWith('image/'))
              const others = all.filter((f) => !f.type.startsWith('image/'))
              // 非图片文件 → 本质上粘贴其绝对路径(本机文件);桌面端 webUtils.getPathForFile 提供路径。
              const leftover: File[] = []
              if (others.length) {
                const paths: string[] = []
                for (const f of others) {
                  // 仅 host 会话才引用本机绝对路径(与 onDrop 一致);云端/沙箱会话模型读不到本机路径,
                  // 一律回退上传到会话工作区,避免「显示了路径但模型读不到、文件也没进工作区」。
                  let p = ''
                  if (isHost) { try { p = window.tangu?.getPathForFile?.(f) || '' } catch { p = '' } }
                  if (p) paths.push(p)
                  else leftover.push(f) // 无路径(云端/网页/剪贴板非磁盘文件)→ 上传工作区
                }
                if (paths.length) {
                  addRefChips(paths.map(fileChip)) // 粘贴的本机文件同样走「已选择」芯片
                  requestAnimationFrame(() => { taRef.current?.focus(); autoGrow() })
                }
              }
              if (images.length) { const dt = new DataTransfer(); images.forEach((f) => dt.items.add(f)); void pickFiles(dt.files) }
              if (leftover.length) { const dt = new DataTransfer(); leftover.forEach((f) => dt.items.add(f)); void pickWsFiles(dt.files) }
            }}
            onKeyDown={(e) => {
              if (refActive) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setRefIndex((i) => (i + 1) % refMatches.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setRefIndex((i) => (i - 1 + refMatches.length) % refMatches.length); return }
                if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); pickRef(refMatches[Math.min(refIndex, refMatches.length - 1)]); return }
                if (e.key === 'Escape') { e.preventDefault(); setRefDismissed(true); return }
              }
              if (mentionActive) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMatches.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return }
                if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); pickMention(mentionMatches[Math.min(mentionIndex, mentionMatches.length - 1)]); return }
                if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return }
              }
              if (slashOpen) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return }
                if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); slashMatches[Math.min(slashIndex, slashMatches.length - 1)]?.run(); return }
                if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); setSlashSubMenu(null); return }
              }
              // steer 撤回优先于历史召回:等待区有货且未进召回态,空/首行 ↑ 先取回最新一条插话
              // (prepend 进草稿,类 pi 的 Alt+Up;再按 ↑ 继续取更早的,取完自然落回历史召回)。
              if (e.key === 'ArrowUp' && pendingSteer?.length && onWithdrawSteer && histPos === 0
                && e.currentTarget.selectionStart === e.currentTarget.selectionEnd
                && draft.slice(0, e.currentTarget.selectionStart).indexOf('\n') === -1) {
                e.preventDefault()
                const last = pendingSteer[pendingSteer.length - 1]
                void onWithdrawSteer(last.id).then((text) => {
                  if (!text) return // 来不及(已注入/run 已收尾):等待区由事件流收拾,这里不动草稿
                  setDraft((d) => (d.trim() ? `${text}\n\n${d}` : text))
                  requestAnimationFrame(() => {
                    const ta = taRef.current
                    if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = text.length; setCursorPos(text.length) }
                    autoGrow()
                  })
                })
                return
              }
              // 历史召回:走到这里说明无浮层消费方向键(菜单激活时已 return)。空/首行 ↑ 取更旧、末行 ↓ 取更新。
              if (e.key === 'ArrowUp' && e.currentTarget.selectionStart === e.currentTarget.selectionEnd
                && draft.slice(0, e.currentTarget.selectionStart).indexOf('\n') === -1 && sentHistory?.length) {
                e.preventDefault(); recallHistory(true); return
              }
              if (e.key === 'ArrowDown' && histPos > 0 && e.currentTarget.selectionStart === e.currentTarget.selectionEnd
                && draft.slice(e.currentTarget.selectionStart).indexOf('\n') === -1) {
                e.preventDefault(); recallHistory(false); return
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
            }}
          />
          {slashOpen && (
            <div className="t2c-menu">
              {slashMatches.map((it, i) => (
                <button
                  key={`${it.cmd}-${i}`}
                  className="t2c-menu-item"
                  data-active={i === Math.min(slashIndex, slashMatches.length - 1) || undefined}
                  onMouseEnter={() => setSlashIndex(i)}
                  onClick={() => it.run()}
                >
                  <span className="t2c-menu-cmd">{it.cmd}</span>
                  <span className="t2c-menu-desc">{it.desc}</span>
                </button>
              ))}
            </div>
          )}
          {mentionActive && !refActive && ( /* [[ 内打 @ 时两菜单可同时命中,文件引用优先(与 onKeyDown 一致) */
            <div className="t2c-menu">
              <div className="t2c-menu-sec">{inGroup ? t('input.mention.groupNote') : t('input.mention.delegateNote')}</div>
              {mentionMatches.map((a, i) => (
                <button
                  key={a.slug}
                  className="t2c-menu-item"
                  data-active={i === Math.min(mentionIndex, mentionMatches.length - 1) || undefined}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => pickMention(a)}
                >
                  <span className="t2c-menu-cmd">@{a.name}</span>
                  <span className="t2c-menu-desc">{a.description || a.slug}</span>
                </button>
              ))}
            </div>
          )}
          {refActive && (
            <div className="t2c-menu">
              <div className="t2c-menu-sec">{t('input.fileref.note')}</div>
              {refMatches.map((c, i) => (
                <button
                  key={c.session ? `s:${c.session.id}` : (c.note ? 'n:' : 'f:') + c.p}
                  className="t2c-menu-item"
                  data-active={i === Math.min(refIndex, refMatches.length - 1) || undefined}
                  onMouseEnter={() => setRefIndex(i)}
                  onClick={() => pickRef(c)}
                >
                  <span className="t2c-menu-cmd">
                    {c.session
                      ? `💬 ${c.session.title}`
                      : c.note
                      ? `${pageIcons[c.p] ? `${pageIcons[c.p]} ` : ''}${c.p.split('/').pop()!.replace(/\.md$/i, '')}`
                      : c.p.split('/').pop()}
                  </span>
                  <span className="t2c-menu-desc">{c.session ? (c.session.summary || t('input.fileref.session')) : c.p}</span>
                </button>
              ))}
            </div>
          )}

          <div className="t2c-row">
            <AddContentMenu
              open={openMenu === 'add'}
              disabled={disabled}
              activeSessionId={activeSessionId}
              canUsePathPicker={isHost}
              onOpenChange={(next) => setOpenMenu(next ? 'add' : null)}
              onNewSession={onNewSession}
              onPickPaths={pickHostPaths}
              onPickFiles={pickMixedFiles}
              onAddReference={addContentReference}
            />
            {voiceActive ? (
              <VoiceRecordingBar analyser={voice.analyser} recording={voice.recording} busy={voice.busy} onStop={voice.toggle} onSend={voiceSend} t={t} />
            ) : (<>
            {showModeChip && (
              <span className={`mode-pill-wrap t2c-capsule-peer${openMenu === 'mode' ? ' is-open' : ''}`} data-cmenu>
                <button
                  className={`t2c-pill mode-pill-btn${openMenu === 'mode' ? ' is-open' : ''}${planMode ? ' active' : ''}`}
                  title={t('input.modeChipTitle')}
                  aria-expanded={openMenu === 'mode'}
                  onClick={() => setOpenMenu((m) => (m === 'mode' ? null : 'mode'))}
                >
                  <ModeIcon size={13} />
                  <span className="t2c-pill-label">{modeLabel}</span>
                  <ChevronDown size={10} />
                </button>
                {openMenu === 'mode' && (
                  <div ref={modeFix.ref} className="composer-menu composer-menu--mode" style={modeFix.style}>
                    {onPlanModeChange && (
                      <>
                        <div className="menu-section">{t('input.planMode')}</div>
                        <button className={`menu-item${planMode ? ' active' : ''}`} onClick={() => { onPlanModeChange(!planMode); setOpenMenu(null) }}>
                          <ClipboardList size={14} />
                          <span className="grow">{planMode ? t('input.planModeOn') : t('input.planModeEnable')}</span>
                          {planMode && <Check size={13} />}
                        </button>
                      </>
                    )}
                    {onGroupChange && !isEngine && (
                      <>
                        <div className="menu-section">{t('group.menu.section')}</div>
                        <button className={`menu-item${groupActive ? ' active' : ''}`} onClick={() => { setGroupSetupOpen(true); setOpenMenu(null) }}>
                          <Users size={14} />
                          <span className="grow">{groupActive ? t('group.menu.configured', { n: groupAgents!.length }) : t('group.menu.enable')}</span>
                          {groupActive && <Check size={13} />}
                        </button>
                      </>
                    )}
                    {isHost && (
                      <>
                        <div className="menu-section">{t('input.approvalSection')}</div>
                        {APPROVALS.map(({ id, Icon, key, desc, ...a }) => (
                          <button
                            key={id}
                            className={`menu-item approval-item${approval === id ? ' active' : ''}${'danger' in a ? ' danger' : ''}`}
                            aria-describedby={`approval-mode-desc-${id}`}
                            onClick={() => setApproval(id)}
                          >
                            <Icon size={15} className="approval-ic" />
                            <span className="grow approval-title">{t(key)}</span>
                            {approval === id && <Check size={13} className="approval-ck" />}
                            <span id={`approval-mode-desc-${id}`} role="tooltip" className="approval-hover-desc">{t(desc)}</span>
                          </button>
                        ))}
                        {/* 选了自定义才给编辑入口:没选这一档时打开它没有意义(规则不参与判定) */}
                        {approval === 'custom' && (
                          <button
                            className="menu-item approval-item"
                            aria-describedby="approval-edit-rules-desc"
                            onClick={() => { setRulesOpen(true); setOpenMenu(null) }}
                          >
                            <SlidersHorizontal size={15} className="approval-ic" />
                            <span className="grow approval-title">{t('input.approval.editRules')}</span>
                            <span id="approval-edit-rules-desc" role="tooltip" className="approval-hover-desc">{t('input.approval.editRulesDesc')}</span>
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </span>
            )}
            <span className="t2c-grow" />
            {!!contextWindow && contextWindow > 0 && (() => {
              const pct = Math.min(100, Math.round(((ctxTokens || 0) / contextWindow) * 100))
              const warn = pct >= 80
              const R = 9
              const CIRC = 2 * Math.PI * R
              return (
                <span className={`t2c-ctxring t2c-collapse-on-capsule-open${openMenu === 'ctx' ? ' is-open' : ''}`} data-warn={warn || undefined} data-cmenu>
                  <button
                    type="button"
                    className="t2c-ctxring-btn"
                    aria-expanded={openMenu === 'ctx'}
                    aria-label={`${t('input.ctxLabel')} ${pct}%`}
                    onClick={() => setOpenMenu((m) => (m === 'ctx' ? null : 'ctx'))}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                      <circle className="t2c-ctxring-track" cx="12" cy="12" r={R} />
                      <circle className="t2c-ctxring-fill" cx="12" cy="12" r={R} style={{ strokeDasharray: CIRC, strokeDashoffset: CIRC * (1 - pct / 100) }} />
                    </svg>
                  </button>
                  {/* 点击详情:token 占用 / 会话累计 / 压缩(替代旧的横条+文字,平时只留进度圈) */}
                  <span ref={ctxPopFix.ref} className="t2c-ctxring-pop" style={ctxPopFix.style}>
                    <span className="t2c-ctxring-pct">{t('input.ctxLabel')} {pct}%</span>
                    <span>{fmtTokens(ctxTokens || 0)} / {fmtTokens(contextWindow)} tokens</span>
                    {!!sessionTokens && sessionTokens > 0 && <span>{t('input.sessionTokens', { n: fmtTokens(sessionTokens) })}</span>}
                    {runCost != null && costLimit != null && costLimit > 0 && (
                      <span data-warn={runCost >= costLimit * 0.8 || undefined}>{t('input.runCost', { used: Math.round(runCost).toLocaleString(), limit: costLimit.toLocaleString() })}</span>
                    )}
                    {/* context 视图(H5/H8/B2):窗口来源(family/default=猜的要标注)、注入段分解、指令文件、历史 */}
                    {ctxInfo && (
                      <>
                        <span className="t2c-ctxinfo-src">
                          {t(`ctx.windowSource.${['override', 'model', 'learned', 'family', 'default'].includes(ctxInfo.ctxWindowSource) ? ctxInfo.ctxWindowSource : 'default'}`)}
                        </span>
                        {(ctxInfo.sections.length > 0 || ctxInfo.historyTokens > 0) && (
                          <div className="t2c-ctxinfo-secs">
                            {[...ctxInfo.sections].sort((a, b) => b.tokens - a.tokens).map((sec) => (
                              <span key={sec.k} className="t2c-ctxinfo-row">
                                {/* 未来引擎新增的段 key 直接显示 key 本身,别渲染成 'ctx.sec.xxx' 原始键 */}
                                <span>{CTX_SEC_KEYS.has(sec.k) ? t(`ctx.sec.${sec.k}`) : sec.k}</span><span>~{fmtTokens(sec.tokens)}</span>
                              </span>
                            ))}
                            {ctxInfo.historyTokens > 0 && (
                              <span className="t2c-ctxinfo-row">
                                <span>{t('ctx.sec.history', { n: ctxInfo.historyCount })}</span><span>~{fmtTokens(ctxInfo.historyTokens)}</span>
                              </span>
                            )}
                          </div>
                        )}
                        {/* 空态也要说话:不显示这一节时,「这个工作区没有指令文件」和「这功能坏了」长得一模一样
                            —— 2026-08-18 真机走查就据此报了一条假 ❌。 */}
                        <div className="t2c-ctxinfo-files">
                          <span className="t2c-ctxinfo-label">{t('ctx.files.label')}{ctxInfo.filesTruncated ? ` ${t('ctx.files.truncated')}` : ''}</span>
                          {ctxInfo.files.length > 0
                            ? ctxInfo.files.map((f) => (
                              <span key={f} className="t2c-ctxinfo-file" title={f}>{f.split(/[/\\]/).slice(-2).join('/')}</span>
                            ))
                            : <span className="t2c-ctxinfo-file dim">{t('ctx.files.none')}</span>}
                        </div>
                      </>
                    )}
                    {onCompact && <button className="t2c-ctxring-compact" onClick={() => { onCompact(); setOpenMenu(null) }}>{t('input.slash.compact')}</button>}
                  </span>
                </span>
              )
            })()}
            {showModelPill && (
              <ModelPill
                className="t2c-capsule-peer"
                open={openMenu === 'model'}
                onOpenChange={(next) => setOpenMenu(next ? 'model' : null)}
                disabled={disabled}
                modelId={isEngine ? engineModelId : modelId}
                groups={modelPillGroups}
                onSelect={isEngine ? (id) => onEngineModelChange?.(id) : (id) => onModelChange?.(id)}
                thinkingLevel={isEngine ? undefined : thinkingLevel}
                onThinkingChange={isEngine ? undefined : onThinkingChange}
                supportedThinking={isEngine ? undefined : models?.find((m) => m.id === modelId)?.thinkingLevels}
                effectiveThinking={
                  // 只在 requested 与当前选档一致时才显示生效档——刚改档还没跑新 run 时,旧 effective 不对应当前选择
                  isEngine ? undefined : (ctxInfo?.thinkingRequested === (thinkingLevel || 'medium') ? ctxInfo?.thinkingEffective : undefined)
                }
                modelsResponse={isEngine ? undefined : modelsResponse}
                defaultModelIds={isEngine ? undefined : defaultModelIds}
                onDefaultModelChange={isEngine ? undefined : onDefaultModelChange}
                emptyLabel={isEngine ? t('input.engineModelDefault') : undefined}
                footnote={!isEngine && !isHost ? t('input.cloudModelHint') : undefined}
              />
            )}
            <button
              className={`t2c-iconbtn t2c-mic-control t2c-collapse-on-capsule-open${voice.recording ? ' recording' : ''}`}
              title={voice.busy ? t('input.micBusy') : voice.recording ? t('input.micStop') : voice.error || t('input.micStart')}
              disabled={disabled || voice.busy || !voice.supported}
              onClick={voice.toggle}
            >
              {voice.busy ? <Loader2 size={14} className="spin" /> : <Mic size={14} />}
            </button>
            {running ? (
              <>
                {(!!draft.trim() || allRefChips.length > 0) && (
                  <button className="t2c-send" onClick={send} disabled={disabled} title={t('input.send')}><ArrowUp size={16} /></button>
                )}
                <button className="t2c-stop" onClick={onStop}><Square size={10} /> {t('input.stop')}</button>
              </>
            ) : (
              // 只挂了引用、一个字没写也可发(与 send() 的放行条件同源;不同步的话按钮灰着 = 哑火)
              <button className="t2c-send" onClick={send} disabled={disabled || (!draft.trim() && !allRefChips.length)} title={t('input.send')}><ArrowUp size={16} /></button>
            )}
            </>)}
          </div>
          {voice.error && !voice.recording && !voice.busy && (
            <div className="t2c-hint" style={{ marginTop: 6, marginBottom: 0 }}>{voice.error}</div>
          )}
        </div>
      </div>
      {rulesOpen && <ApprovalRulesModal cfg={liveCfg} onClose={() => setRulesOpen(false)} />}
    </div>
  )
}
