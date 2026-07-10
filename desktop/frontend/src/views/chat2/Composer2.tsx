/**
 * Composer2 —— 输入区「完全重写」为编辑式新视觉(悬浮圆角卡 + 圆形发送 + 下方药丸 chips),
 * 逻辑与旧 MessageInput 等价、零功能损失:slash 命令 / @ 提及 / 附件(选/粘/拖)/ 云沙箱工作区文件 /
 * /skill chip / 引用 / 模型·Agent·引擎·思考·loop·计划·群聊 / 上下文占比·压缩 / 发送·停止。
 * props 与旧 MessageInput 完全一致 → ChatView 直接换组件即可。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp, Square, Plus, Mic, ImagePlus, X, ClipboardList, Check, ChevronDown, FileText, Users, Sparkles,
} from 'lucide-react'
import type { AgentConfig, Attachment, ModelInfo, NormalAgentDef, SkillInfo } from '../../types'
import { ModelPill, type ModelPillGroup } from '../../components/ModelPill'
import { useI18n } from '../../i18n'
import { groupModelsByProvider } from '../../components/ModelGroupList'
import { GroupChatSetup } from '../../components/GroupChatSetup'
import { track } from '../../achievements/store'
import './composer2.css'

interface SlashItem { cmd: string; desc: string; run: () => void }
type OpenMenu = 'add' | 'mode' | null

const MAX_ATTACH_BYTES = 5 * 1024 * 1024
const MAX_INPUT_CHARS = 150_000
const MAX_WS_BYTES = 25 * 1024 * 1024
const approvalLabelKey = { readonly: 'input.approval.readonly', 'auto-edit': 'input.approval.autoEdit', 'full-auto': 'input.approval.fullAuto' } as const

export const Composer2: React.FC<{
  disabled: boolean
  running: boolean
  execConfig: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>
  models?: ModelInfo[] | null
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
  maxIterations?: number
  onMaxIterationsChange?: (n: number) => void
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
  onCompact?: () => void
}> = ({
  disabled, running, execConfig,
  models, modelId, onModelChange, engines, engineId,
  engineModels, engineModelId, onEngineModelChange, engineCommands,
  thinkingLevel, onThinkingChange,
  maxIterations, onMaxIterationsChange,
  planMode, onPlanModeChange, voiceMode, onVoiceModeChange, skills,
  groupChat, groupAgents, groupTempAgents, groupIntensity, groupMaxRounds, onGroupChange,
  agents, onNewSession, onBranch, onOpenSettings,
  onExecConfigChange, onSend, onStop,
  quotedText, onClearQuote,
  contextWindow, ctxTokens, sessionTokens, onCompact,
}) => {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [wsFiles, setWsFiles] = useState<Attachment[]>([])
  const [pinnedSkills, setPinnedSkills] = useState<SkillInfo[]>([])
  const [hint, setHint] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashSubMenu, setSlashSubMenu] = useState<'model' | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
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
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const isHost = execConfig.execMode === 'host'
  const approval = execConfig.approvalMode || 'auto-edit'

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
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }

  const slashItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = []
    const close = () => { setDraft(''); setSlashSubMenu(null); requestAnimationFrame(autoGrow) }
    if (running) items.push({ cmd: '/stop', desc: t('input.slash.stop'), run: () => { onStop(); close() } })
    if (engineId) {
      if (onNewSession) items.push({ cmd: '/new', desc: t('input.slash.new'), run: () => { onNewSession(); close() } })
      for (const c of engineCommands || []) {
        items.push({
          cmd: `/${c.name}`,
          desc: c.hint ? `${c.description} · ${c.hint}` : c.description,
          run: () => { setDraft(`/${c.name} `); setSlashIndex(0); requestAnimationFrame(autoGrow) },
        })
      }
      return items
    }
    if (onPlanModeChange) {
      items.push({ cmd: '/plan', desc: planMode ? t('input.slash.planOff') : t('input.slash.planOn'), run: () => { onPlanModeChange(!planMode); close() } })
    }
    if (onVoiceModeChange) {
      items.push({ cmd: voiceMode ? '/text' : '/voice', desc: voiceMode ? t('input.slash.voiceOff') : t('input.slash.voiceOn'), run: () => { onVoiceModeChange(!voiceMode); close() } })
    }
    if (onThinkingChange) {
      for (const lv of ['off', 'low', 'medium', 'high'] as const) {
        items.push({ cmd: `/think ${lv}`, desc: `${t('input.slash.thinkDesc', { level: lv })}${thinkingLevel === lv ? t('input.slash.current') : ''}`, run: () => { onThinkingChange(lv); close() } })
      }
    }
    if (onModelChange && models?.length) {
      items.push({ cmd: '/model', desc: t('input.slash.model'), run: () => { setDraft('/model '); setSlashSubMenu('model'); setSlashIndex(0) } })
    }
    if (onMaxIterationsChange) {
      items.push({ cmd: '/loop', desc: t('input.slash.loop', { current: maxIterations || 90 }), run: () => { setDraft('/loop '); setSlashIndex(0); requestAnimationFrame(autoGrow) } })
    }
    if (onNewSession) items.push({ cmd: '/new', desc: t('input.slash.new'), run: () => { onNewSession(); close() } })
    if (onBranch) items.push({ cmd: '/branch', desc: t('input.slash.branch'), run: () => { onBranch(); close() } })
    if (onOpenSettings) items.push({ cmd: '/skills', desc: t('input.slash.skills'), run: () => { onOpenSettings(); close() } })
    if (onCompact) items.push({ cmd: '/compact', desc: t('input.slash.compact'), run: () => { onCompact(); close() } })
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
  }, [running, onStop, planMode, voiceMode, onVoiceModeChange, thinkingLevel, maxIterations, onMaxIterationsChange, models, skills, onPlanModeChange, onThinkingChange, onModelChange, onNewSession, onBranch, onOpenSettings, onCompact, engineId, engineCommands])

  const slashActive = draft.startsWith('/') && !draft.includes('\n') && !disabled && !slashDismissed
  const slashMatches = useMemo<SlashItem[]>(() => {
    if (!slashActive) return []
    if (slashSubMenu === 'model') {
      const filter = draft.slice('/model '.length).toLowerCase()
      return (models || [])
        .filter((m) => !filter || m.id.toLowerCase().includes(filter) || m.name.toLowerCase().includes(filter))
        .slice(0, 12)
        .map((m) => ({
          cmd: m.id === modelId ? `● ${m.name}` : m.name,
          desc: `${m.source === 'direct' ? t('input.directPrefix') : ''}${m.provider} · ${m.id}`,
          run: () => { onModelChange?.(m.id); setDraft(''); setSlashSubMenu(null); requestAnimationFrame(autoGrow) },
        }))
    }
    const q = draft.toLowerCase()
    return slashItems.filter((it) => it.cmd.toLowerCase().startsWith(q) || (q.length > 1 && it.desc.toLowerCase().includes(q.slice(1)))).slice(0, 10)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashActive, slashSubMenu, draft, slashItems, models, modelId])

  const inGroup = !!groupChat && (groupAgents?.length || 0) >= 2
  const mentionPool = useMemo<NormalAgentDef[]>(() => {
    if (!inGroup) return agents || []
    const saved = (agents || []).filter((a) => groupAgents!.includes(a.slug))
    const seen = new Set(saved.map((a) => a.slug))
    return [...saved, ...(groupTempAgents || []).filter((a) => !seen.has(a.slug))]
  }, [inGroup, agents, groupAgents, groupTempAgents])
  const mention = useMemo(() => {
    if (disabled || slashActive || mentionDismissed) return null
    const m = /(?:^|\s)@([^\s@]*)$/.exec(draft.slice(0, cursorPos))
    return m ? { query: m[1], start: cursorPos - m[1].length - 1 } : null
  }, [draft, cursorPos, disabled, slashActive, mentionDismissed])
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

  // ── [[ 文件引用:列当前工作区可引用文件,选中插入相对路径(与拖放/粘贴插路径同一契约,后端零改动)。
  //    仅 host 会话(云端/沙箱读不到本机路径)。候选 = listDir 惰性 BFS,忽略巨目录/隐藏项,双上限封顶。
  const fileRefCtx = useMemo(() => {
    if (disabled || slashActive || refDismissed || !isHost || !execConfig.cwd) return null
    const m = /\[\[([^\]\n]*)$/.exec(draft.slice(0, cursorPos))
    return m ? { query: m[1], start: cursorPos - m[1].length - 2 } : null
  }, [draft, cursorPos, disabled, slashActive, refDismissed, isHost, execConfig.cwd])
  useEffect(() => {
    if (!fileRefCtx) return
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
  }, [fileRefCtx, execConfig.cwd])
  const refMatches = useMemo<string[]>(() => {
    if (!fileRefCtx || !refFiles) return []
    const q = fileRefCtx.query.toLowerCase()
    const pool = q ? refFiles.filter((p) => p.toLowerCase().includes(q)) : refFiles
    // 文件名前缀命中 > 文件名包含 > 仅路径包含;同档路径短者先。
    const score = (p: string): number => {
      const base = p.split('/').pop()!.toLowerCase()
      return (base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2) * 10000 + p.length
    }
    return [...pool].sort((a, b) => score(a) - score(b)).slice(0, 10)
  }, [fileRefCtx, refFiles])
  const refActive = !!fileRefCtx && refMatches.length > 0
  useEffect(() => { setRefIndex(0) }, [fileRefCtx?.start, fileRefCtx?.query])

  const pickRef = (p: string) => {
    if (!fileRefCtx) return
    const before = draft.slice(0, fileRefCtx.start)
    const insert = `${/\s/.test(p) ? `"${p}"` : p} ` // 含空格加引号,与粘贴本机路径一致
    const next = before + insert + draft.slice(cursorPos)
    setDraft(next)
    const caret = before.length + insert.length
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = caret; setCursorPos(caret) }
      autoGrow()
    })
  }

  const send = () => {
    const text = draft.trim()
    if (!text) return
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
    if (onVoiceModeChange && /^\/(voice|text)$/i.test(text)) {
      const on = /^\/voice$/i.test(text)
      onVoiceModeChange(on)
      setHint(on ? t('input.slash.voiceOnHint') : t('input.slash.voiceOffHint'))
      setDraft('')
      requestAnimationFrame(autoGrow)
      return
    }
    if (disabled) return
    const quoted = quotedText ? `${quotedText.split('\n').map((l) => `> ${l}`).join('\n')}\n\n` : ''
    const outgoing = quoted + text
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
      setAttachments([])
      setWsFiles([])
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

  const setApproval = (m: NonNullable<AgentConfig['approvalMode']>) => {
    onExecConfigChange({ execMode: 'host', approvalMode: m, cwd: execConfig.cwd })
    setOpenMenu(null)
  }

  const modelGroups = useMemo(() => groupModelsByProvider(models || []), [models])
  const groupActive = !!groupChat && (groupAgents?.length || 0) >= 2
  const modeLabel = groupActive
    ? t('group.modeLabel', { n: groupAgents!.length })
    : planMode ? t('input.planMode') : (isHost ? t(approvalLabelKey[approval]) : t('input.normal'))
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
        <div
          className={`t2c-card${dragOver ? ' dragover' : ''}`}
          onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragOver(true) } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false) }}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const files = e.dataTransfer?.files
            if (!files?.length) return
            if (isHost && window.tangu?.getPathForFile) {
              const paths = Array.from(files)
                .map((f) => { try { return window.tangu!.getPathForFile!(f) } catch { return '' } })
                .filter(Boolean)
                .map((p) => (/\s/.test(p) ? `"${p}"` : p))
              if (paths.length) {
                setDraft((d) => (d ? `${d} ${paths.join(' ')}` : paths.join(' ')))
                setSlashDismissed(false)
                requestAnimationFrame(() => { taRef.current?.focus(); autoGrow() })
                return
              }
            }
            void pickWsFiles(files)
          }}
        >
          {hint && <div className="t2c-hint">{hint}</div>}
          {quotedText && (
            <div className="t2c-quote">
              <span className="t2c-quote-text">{quotedText.length > 280 ? `${quotedText.slice(0, 280)}…` : quotedText}</span>
              <button title={t('input.remove')} onClick={() => onClearQuote?.()} className="t2c-quote-x"><X size={12} /></button>
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
                    : <FileText size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
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
                  <Sparkles size={13} style={{ color: 'var(--accent)', flexShrink: 0 }} />
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
            value={draft}
            placeholder={disabled ? t('input.placeholderDisabled') : t('input.placeholder')}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value)
              setCursorPos(e.target.selectionStart || 0)
              setSlashDismissed(false)
              setMentionDismissed(false)
              setRefDismissed(false)
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
                  // 仅 host 会话才插入本机绝对路径(与 onDrop 一致);云端/沙箱会话模型读不到本机路径,
                  // 一律回退上传到会话工作区,避免「显示了路径但模型读不到、文件也没进工作区」。
                  let p = ''
                  if (isHost) { try { p = window.tangu?.getPathForFile?.(f) || '' } catch { p = '' } }
                  if (p) paths.push(/\s/.test(p) ? `"${p}"` : p)
                  else leftover.push(f) // 无路径(云端/网页/剪贴板非磁盘文件)→ 上传工作区
                }
                if (paths.length) {
                  setDraft((d) => (d ? `${d} ${paths.join(' ')}` : paths.join(' ')))
                  setSlashDismissed(false)
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
              if (slashActive && slashMatches.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return }
                if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) { e.preventDefault(); slashMatches[Math.min(slashIndex, slashMatches.length - 1)]?.run(); return }
                if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); setSlashSubMenu(null); return }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
            }}
          />
          {slashActive && slashMatches.length > 0 && (
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
              {refMatches.map((p, i) => (
                <button
                  key={p}
                  className="t2c-menu-item"
                  data-active={i === Math.min(refIndex, refMatches.length - 1) || undefined}
                  onMouseEnter={() => setRefIndex(i)}
                  onClick={() => pickRef(p)}
                >
                  <span className="t2c-menu-cmd">{p.split('/').pop()}</span>
                  <span className="t2c-menu-desc">{p}</span>
                </button>
              ))}
            </div>
          )}

          <div className="t2c-row">
            <span style={{ position: 'relative', display: 'inline-flex' }} data-cmenu>
              <button className="t2c-iconbtn" title={t('input.addContent')} disabled={disabled} onClick={() => setOpenMenu((m) => (m === 'add' ? null : 'add'))}>
                <Plus size={16} />
              </button>
              {openMenu === 'add' && (
                <div className="composer-menu left">
                  <button className="menu-item" onClick={() => { fileRef.current?.click(); setOpenMenu(null) }}>
                    <ImagePlus size={14} />
                    <span className="grow">{t('input.addImage')}</span>
                  </button>
                  <div className="menu-section" style={{ padding: '4px 8px 2px' }}>{t('input.otherFilesHint')}</div>
                </div>
              )}
            </span>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void pickFiles(e.target.files); e.target.value = '' }} />
            {showModeChip && (
              <span style={{ position: 'relative', display: 'inline-flex' }} data-cmenu>
                <button className={`t2c-pill${planMode ? ' active' : ''}`} title={t('input.modeChipTitle')} onClick={() => setOpenMenu((m) => (m === 'mode' ? null : 'mode'))}>
                  <span className="t2c-pill-label">{modeLabel}</span>
                  <ChevronDown size={10} />
                </button>
                {openMenu === 'mode' && (
                  <div className="composer-menu left">
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
                        {(['readonly', 'auto-edit', 'full-auto'] as const).map((m) => (
                          <button key={m} className={`menu-item${approval === m ? ' active' : ''}`} onClick={() => setApproval(m)}>
                            <span className="grow">{t(approvalLabelKey[m])}</span>
                            {approval === m && <Check size={13} />}
                          </button>
                        ))}
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
                <span className="t2c-ctxring" data-warn={warn || undefined}>
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <circle className="t2c-ctxring-track" cx="12" cy="12" r={R} />
                    <circle className="t2c-ctxring-fill" cx="12" cy="12" r={R} style={{ strokeDasharray: CIRC, strokeDashoffset: CIRC * (1 - pct / 100) }} />
                  </svg>
                  {/* 悬停详情:token 占用 / 会话累计 / 压缩(替代旧的横条+文字,平时只留进度圈) */}
                  <span className="t2c-ctxring-pop">
                    <span className="t2c-ctxring-pct">{t('input.ctxLabel')} {pct}%</span>
                    <span>{(ctxTokens || 0).toLocaleString()} / {contextWindow.toLocaleString()} tokens</span>
                    {!!sessionTokens && sessionTokens > 0 && <span>{t('input.sessionTokens', { n: sessionTokens.toLocaleString() })}</span>}
                    {onCompact && <button className="t2c-ctxring-compact" onClick={onCompact}>{t('input.slash.compact')}</button>}
                  </span>
                </span>
              )
            })()}
            {showModelPill && (
              <ModelPill
                disabled={disabled}
                modelId={isEngine ? engineModelId : modelId}
                groups={modelPillGroups}
                onSelect={isEngine ? (id) => onEngineModelChange?.(id) : (id) => onModelChange?.(id)}
                thinkingLevel={isEngine ? undefined : thinkingLevel}
                onThinkingChange={isEngine ? undefined : onThinkingChange}
                emptyLabel={isEngine ? t('input.engineModelDefault') : undefined}
              />
            )}
            <button className="t2c-iconbtn" title={t('input.micComingSoon')} disabled><Mic size={14} /></button>
            {running ? (
              <>
                {!!draft.trim() && (
                  <button className="t2c-send" onClick={send} disabled={disabled} title={t('input.send')}><ArrowUp size={16} /></button>
                )}
                <button className="t2c-stop" onClick={onStop}><Square size={10} /> {t('input.stop')}</button>
              </>
            ) : (
              <button className="t2c-send" onClick={send} disabled={disabled || !draft.trim()} title={t('input.send')}><ArrowUp size={16} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
