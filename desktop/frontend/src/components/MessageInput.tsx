/**
 * 输入区(Codex 两段式):
 * - 框内:auto-grow textarea + 底排「+ 附件菜单 / 🎤占位 / 发送·停止」;
 * - 框外:上下文 chip(云沙箱/本机·目录)、模式菜单(计划/审批)、右侧 模型·思考档 菜单。
 * 附件支持文件选择 / 粘贴 / 拖拽,chip 带缩略图。auto-grow 对齐 AI Studio(scrollHeight 撑高,截断)。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Send, Square, Plus, Mic, ImagePlus, X, Brain, ClipboardList, Check, ChevronDown, FileText,
} from 'lucide-react'
import type { AgentConfig, Attachment, ModelInfo, NormalAgentDef, SkillInfo } from '../types'
import { useI18n } from '../i18n'
import { groupModelsByProvider } from './ModelGroupList'

/** 斜杠命令项(/ 触发的菜单;参考 hermes 的 slash 命令)。 */
interface SlashItem {
  cmd: string
  desc: string
  run: () => void
}

/** 框外控制排当前打开的弹出菜单。 */
type OpenMenu = 'add' | 'mode' | 'model' | null

const MAX_ATTACH_BYTES = 5 * 1024 * 1024
// 客户端输入帽(服务端 runs.ts 还有一道):大段材料整体粘贴会让 agent 每轮迭代全量重发,
// token 消耗 = 消息体量 × 轮数(2026-06-10 的百万 token 事故根因)。
const MAX_INPUT_CHARS = 150_000
// 工作区文件上限(云沙箱:拖入消息区的文件,发送时上传到会话工作区)。
const MAX_WS_BYTES = 25 * 1024 * 1024

const approvalLabelKey = { readonly: 'input.approval.readonly', 'auto-edit': 'input.approval.autoEdit', 'full-auto': 'input.approval.fullAuto' } as const
const thinkingLabelKey = { off: 'input.thinking.off', low: 'input.thinking.low', medium: 'input.thinking.medium', high: 'input.thinking.high' } as const
const thinkingShortKey = { off: 'input.thinkingShort.off', low: 'input.thinkingShort.low', medium: 'input.thinkingShort.medium', high: 'input.thinkingShort.high' } as const

export const MessageInput: React.FC<{
  disabled: boolean
  running: boolean
  execConfig: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>
  /** 会话内模型/思考深度切换器(models 为 null=未加载,隐藏选择器)。 */
  models?: ModelInfo[] | null
  modelId?: string
  onModelChange?: (modelId: string) => void
  thinkingLevel?: AgentConfig['thinkingLevel']
  onThinkingChange?: (level: NonNullable<AgentConfig['thinkingLevel']>) => void
  /** 会话级最大循环轮数(/loop 指令调节;缺省由后端取默认 90)。 */
  maxIterations?: number
  onMaxIterationsChange?: (n: number) => void
  /** 计划模式开关(只读调研 → exit_plan_mode 提交计划)。 */
  planMode?: boolean
  onPlanModeChange?: (on: boolean) => void
  /** 斜杠命令数据源:技能列表 + 本会话已启用技能 + 各动作回调。 */
  skills?: SkillInfo[] | null
  enabledSkillIds?: string[]
  onToggleSkill?: (id: string) => void
  /** Normal Agent 选用(斜杠 /agent:<slug>;''=取消)。 */
  agents?: NormalAgentDef[]
  activeAgentSlug?: string
  onSelectAgent?: (slug: string) => void
  onNewSession?: () => void
  onOpenSettings?: () => void
  onExecConfigChange: (patch: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>) => void
  /** 返回是否已受理:失败(连接/参数错)返回 false,草稿保留不清空。
   *  workspaceFiles:云沙箱拖入消息区的文件,发送时上传到会话工作区。 */
  onSend: (text: string, attachments: Attachment[], workspaceFiles?: Attachment[]) => Promise<boolean>
  onStop: () => void
  /** 上下文占比 + 会话消耗 + 压缩(输入框下方进度行)。 */
  contextWindow?: number
  ctxTokens?: number
  sessionTokens?: number
  onCompact?: () => void
}> = ({
  disabled, running, execConfig,
  models, modelId, onModelChange, thinkingLevel, onThinkingChange,
  maxIterations, onMaxIterationsChange,
  planMode, onPlanModeChange, skills, enabledSkillIds, onToggleSkill,
  agents, activeAgentSlug, onSelectAgent, onNewSession, onOpenSettings,
  onExecConfigChange, onSend, onStop,
  contextWindow, ctxTokens, sessionTokens, onCompact,
}) => {
  const { t } = useI18n()
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [wsFiles, setWsFiles] = useState<Attachment[]>([]) // 云沙箱待传工作区的文件
  const [hint, setHint] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashSubMenu, setSlashSubMenu] = useState<'model' | null>(null) // /model 的二级菜单
  const [slashDismissed, setSlashDismissed] = useState(false) // Esc 关菜单但保留草稿
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null) // 框外控制排弹出菜单
  const [dragOver, setDragOver] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const isHost = execConfig.execMode === 'host'
  const approval = execConfig.approvalMode || 'auto-edit'

  // 点击外部 / Esc 关闭框外弹出菜单
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

  // ── 斜杠命令(/ 开头且无换行 → 浮出菜单;Enter/Tab 执行而非发送)──
  const slashItems = useMemo<SlashItem[]>(() => {
    const items: SlashItem[] = []
    const close = () => {
      setDraft('')
      setSlashSubMenu(null)
      requestAnimationFrame(autoGrow)
    }
    if (onPlanModeChange) {
      items.push({
        cmd: '/plan',
        desc: planMode ? t('input.slash.planOff') : t('input.slash.planOn'),
        run: () => { onPlanModeChange(!planMode); close() },
      })
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
      // /loop <n>:设最大循环轮数。run() 仅填前缀,数字由 send() 解析(支持任意数,不止预设)。
      items.push({ cmd: '/loop', desc: t('input.slash.loop', { current: maxIterations || 90 }), run: () => { setDraft('/loop '); setSlashIndex(0); requestAnimationFrame(autoGrow) } })
    }
    if (onNewSession) items.push({ cmd: '/new', desc: t('input.slash.new'), run: () => { onNewSession(); close() } })
    if (onOpenSettings) items.push({ cmd: '/skills', desc: t('input.slash.skills'), run: () => { onOpenSettings(); close() } })
    if (onCompact) items.push({ cmd: '/compact', desc: t('input.slash.compact'), run: () => { onCompact(); close() } })
    if (onSelectAgent && agents && agents.length) {
      for (const a of agents) {
        items.push({
          cmd: `/agent:${a.slug}`,
          desc: `${activeAgentSlug === a.slug ? '✓ ' : ''}${a.name}${a.description ? ` — ${a.description}` : ''}`,
          run: () => { onSelectAgent(a.slug); close() },
        })
      }
      if (activeAgentSlug) items.push({ cmd: '/agent:off', desc: t('input.agentCleared'), run: () => { onSelectAgent(''); close() } })
    }
    if (onToggleSkill) {
      const enabled = new Set(enabledSkillIds || [])
      for (const s of skills || []) {
        items.push({
          cmd: `/skill:${s.id}`,
          desc: enabled.has(s.id) ? t('input.slash.skillDisable', { name: s.name }) : t('input.slash.skillEnable', { name: s.name }),
          run: () => { onToggleSkill(s.id); close() },
        })
      }
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planMode, thinkingLevel, maxIterations, onMaxIterationsChange, models, skills, enabledSkillIds, onPlanModeChange, onThinkingChange, onModelChange, onNewSession, onOpenSettings, onToggleSkill, onCompact, agents, activeAgentSlug, onSelectAgent])

  const slashActive = draft.startsWith('/') && !draft.includes('\n') && !disabled && !slashDismissed
  const slashMatches = useMemo<SlashItem[]>(() => {
    if (!slashActive) return []
    if (slashSubMenu === 'model') {
      // /model 二级:列模型,点选即切
      const filter = draft.slice('/model '.length).toLowerCase()
      return (models || [])
        .filter((m) => !filter || m.id.toLowerCase().includes(filter) || m.name.toLowerCase().includes(filter))
        .slice(0, 12)
        .map((m) => ({
          cmd: m.id === modelId ? `● ${m.name}` : m.name,
          desc: `${m.source === 'direct' ? t('input.directPrefix') : ''}${m.provider} · ${m.id}`,
          run: () => {
            onModelChange?.(m.id)
            setDraft('')
            setSlashSubMenu(null)
            requestAnimationFrame(autoGrow)
          },
        }))
    }
    const q = draft.toLowerCase()
    return slashItems.filter((it) => it.cmd.toLowerCase().startsWith(q) || (q.length > 1 && it.desc.toLowerCase().includes(q.slice(1)))).slice(0, 10)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashActive, slashSubMenu, draft, slashItems, models, modelId])

  const autoGrow = () => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }

  const send = () => {
    const text = draft.trim()
    if (!text) return
    // /loop <n>:会话级最大循环轮数(命令式,不发给 agent;运行中也可改,下一轮 run 生效)。
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
    if (disabled || running) return
    if (text.length > MAX_INPUT_CHARS) {
      setHint(t('input.tooLong', { len: text.length.toLocaleString(), max: MAX_INPUT_CHARS.toLocaleString() }))
      return
    }
    setHint(null)
    void onSend(text, attachments, wsFiles).then((accepted) => {
      if (!accepted) return // 失败保留草稿
      setDraft('')
      setAttachments([])
      setWsFiles([])
      requestAnimationFrame(autoGrow)
    })
  }

  const pickFiles = async (files: FileList | null) => {
    if (!files) return
    const next: Attachment[] = []
    const skipped: string[] = []
    for (const f of Array.from(files)) {
      // 只收图片:非图附件目前不进模型上下文(后端会忽略),收了反而像"已发给 AI"的假象。
      if (!f.type.startsWith('image/')) {
        skipped.push(t('input.skip.notImage', { name: f.name }))
        continue
      }
      if (f.size > MAX_ATTACH_BYTES) {
        skipped.push(t('input.skip.tooBig', { name: f.name, mb: String(Math.round(MAX_ATTACH_BYTES / 1024 / 1024)) }))
        continue
      }
      const buf = await f.arrayBuffer()
      let bin = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      next.push({ name: f.name, mimeType: f.type, data: btoa(bin), size: f.size })
    }
    setHint(skipped.length ? t('input.skip.imageHint', { items: skipped.join('、') }) : null)
    setAttachments((prev) => [...prev, ...next])
  }

  // 云沙箱:拖入消息区的任意文件 → 暂存为待传工作区的文件,发送时上传到会话工作区。
  const pickWsFiles = async (files: FileList | null) => {
    if (!files) return
    const next: Attachment[] = []
    const skipped: string[] = []
    for (const f of Array.from(files)) {
      if (f.size > MAX_WS_BYTES) {
        skipped.push(t('input.skip.tooBig', { name: f.name, mb: String(Math.round(MAX_WS_BYTES / 1024 / 1024)) }))
        continue
      }
      const buf = await f.arrayBuffer()
      let bin = ''
      const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      next.push({ name: f.name, mimeType: f.type || 'application/octet-stream', data: btoa(bin), size: f.size })
    }
    setHint(skipped.length ? t('input.skip.simple', { items: skipped.join('、') }) : null)
    setWsFiles((prev) => [...prev, ...next])
  }

  // ── 框外控制:审批档(执行环境由工作区决定,不在输入栏切换) ──
  const setApproval = (m: NonNullable<AgentConfig['approvalMode']>) => {
    onExecConfigChange({ execMode: 'host', approvalMode: m, cwd: execConfig.cwd })
    setOpenMenu(null)
  }

  // 模型分组:按 Provider 分类(与设置页一致)
  const modelGroups = useMemo(() => groupModelsByProvider(models || []), [models])
  const currentModel = (models || []).find((m) => m.id === modelId)

  // chip 文案
  const modeLabel = planMode ? t('input.planMode') : (isHost ? t(approvalLabelKey[approval]) : t('input.normal'))
  const modelLabel = currentModel?.name || modelId || t('input.selectModel')
  const effortSuffix = thinkingLevel && thinkingLevel !== 'off' ? ` · ${t(thinkingShortKey[thinkingLevel])}` : ''

  const showModeChip = !!onPlanModeChange || isHost
  const showModelChip = (!!onModelChange && !!models?.length) || !!onThinkingChange

  return (
    <div className="composer">
      <div className="composer-inner">
        <div
          className={`composer-box${dragOver ? ' dragover' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes('Files')) {
              e.preventDefault()
              setDragOver(true)
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const files = e.dataTransfer?.files
            if (!files?.length) return
            // 本机模式:拖入文件 → 把绝对路径粘进输入框(agent 用工具按路径读)。
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
            // 云沙箱:任意文件 → 暂存为待传工作区文件(chip 预览),发送时上传到会话工作区。
            void pickWsFiles(files)
          }}
        >
          {hint && (
            <div style={{ fontSize: 12, color: 'var(--danger, #c0392b)', marginBottom: 6 }}>
              {hint}
            </div>
          )}
          {attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {attachments.map((a, i) => (
                <span className="attach-chip" key={`${a.name}-${i}`}>
                  {a.mimeType.startsWith('image/') && (
                    <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
                  )}
                  <span>{a.name}</span>
                  <button title={t('input.remove')} onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {wsFiles.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
              {wsFiles.map((a, i) => (
                <span className="attach-chip" key={`ws-${a.name}-${i}`} title={t('input.wsUploadTitle', { name: a.name })}>
                  {a.mimeType.startsWith('image/')
                    ? <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
                    : <FileText size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                  <span>{a.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-faint)', flexShrink: 0 }}>{t('input.toWorkspace')}</span>
                  <button title={t('input.remove')} onClick={() => setWsFiles(wsFiles.filter((_, j) => j !== i))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={1}
            value={draft}
            placeholder={disabled ? t('input.placeholderDisabled') : t('input.placeholder')}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value)
              setSlashDismissed(false)
              autoGrow()
            }}
            onPaste={(e) => {
              // 粘贴图片(剪贴板含文件)→ 走附件;纯文本粘贴不受影响。
              if (e.clipboardData?.files?.length) {
                e.preventDefault()
                void pickFiles(e.clipboardData.files)
              }
            }}
            onKeyDown={(e) => {
              // 斜杠菜单导航:↑↓ 选择,Enter/Tab 执行(不发送),Esc 关菜单(保留草稿)
              if (slashActive && slashMatches.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSlashIndex((i) => (i + 1) % slashMatches.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
                  return
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  slashMatches[Math.min(slashIndex, slashMatches.length - 1)]?.run()
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSlashDismissed(true) // 仅关菜单,草稿保留(再次编辑会重新唤起)
                  setSlashSubMenu(null)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          {slashActive && slashMatches.length > 0 && (
            <div
              style={{
                position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: 6,
                background: 'var(--bg-card)', border: 'var(--border-width) solid var(--border)',
                borderRadius: 'var(--radius-md)', maxHeight: 240, overflowY: 'auto', zIndex: 30,
                boxShadow: '0 -4px 16px rgba(0,0,0,0.08)',
              }}
            >
              {slashMatches.map((it, i) => (
                <button
                  key={`${it.cmd}-${i}`}
                  className="file-row"
                  style={{ width: '100%', background: i === Math.min(slashIndex, slashMatches.length - 1) ? 'var(--bg-hover, rgba(127,127,127,0.12))' : undefined }}
                  onMouseEnter={() => setSlashIndex(i)}
                  onClick={() => it.run()}
                >
                  <span className="file-name" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{it.cmd}</span>
                  <span className="file-size">{it.desc}</span>
                </button>
              ))}
            </div>
          )}

          {/* 框内底排:+ 附件菜单 / 麦克风占位 / 发送·停止 */}
          <div className="composer-inrow">
            <span style={{ position: 'relative', display: 'inline-flex' }} data-cmenu>
              <button
                className="icon-btn"
                title={t('input.addContent')}
                disabled={disabled}
                onClick={() => setOpenMenu((m) => (m === 'add' ? null : 'add'))}
              >
                <Plus size={17} />
              </button>
              {openMenu === 'add' && (
                <div className="composer-menu left">
                  <button className="menu-item" onClick={() => { fileRef.current?.click(); setOpenMenu(null) }}>
                    <ImagePlus size={14} />
                    <span className="grow">{t('input.addImage')}</span>
                  </button>
                  <div className="menu-section" style={{ padding: '4px 8px 2px' }}>
                    {t('input.otherFilesHint')}
                  </div>
                </div>
              )}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void pickFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <span className="grow" />
            <button className="icon-btn composer-mic" title={t('input.micComingSoon')} disabled>
              <Mic size={16} />
            </button>
            {running ? (
              <button className="btn danger sm" onClick={onStop}>
                <Square size={12} /> {t('input.stop')}
              </button>
            ) : (
              <button className="btn primary sm" onClick={send} disabled={disabled || !draft.trim()}>
                <Send size={13} /> {t('input.send')}
              </button>
            )}
          </div>
        </div>

        {/* 框外控制排:模式(左)· 模型(右)。执行环境由工作区决定,不在此切换。 */}
        <div className="composer-actions">
          {showModeChip && (
            <span style={{ position: 'relative', display: 'inline-flex' }} data-cmenu>
              <button
                className={`composer-chip${planMode ? ' active' : ''}`}
                title={t('input.modeChipTitle')}
                onClick={() => setOpenMenu((m) => (m === 'mode' ? null : 'mode'))}
              >
                <ClipboardList size={13} />
                <span className="chip-label">{modeLabel}</span>
                <ChevronDown size={12} />
              </button>
              {openMenu === 'mode' && (
                <div className="composer-menu left">
                  {onPlanModeChange && (
                    <>
                      <div className="menu-section">{t('input.planMode')}</div>
                      <button
                        className={`menu-item${planMode ? ' active' : ''}`}
                        onClick={() => { onPlanModeChange(!planMode); setOpenMenu(null) }}
                      >
                        <ClipboardList size={14} />
                        <span className="grow">{planMode ? t('input.planModeOn') : t('input.planModeEnable')}</span>
                        {planMode && <Check size={13} />}
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

          <span className="grow" />

          {/* 上下文占比 + 本会话 token 消耗 */}
          {!!contextWindow && contextWindow > 0 && (() => {
            const pct = Math.min(100, Math.round(((ctxTokens || 0) / contextWindow) * 100))
            const warn = pct >= 80
            return (
              <span
                className="composer-ctx"
                title={`${(ctxTokens || 0).toLocaleString()} / ${contextWindow.toLocaleString()} tokens`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-dim, #888)', marginRight: 4 }}
              >
                <span style={{ width: 52, height: 5, borderRadius: 3, background: 'var(--bg-hover, rgba(127,127,127,0.18))', overflow: 'hidden', display: 'inline-block' }}>
                  <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: warn ? 'var(--danger, #e5534b)' : 'var(--accent, #6b7cff)' }} />
                </span>
                <span>{t('input.ctxLabel')} {pct}%</span>
                {!!sessionTokens && sessionTokens > 0 && <span>· {t('input.sessionTokens', { n: sessionTokens.toLocaleString() })}</span>}
              </span>
            )
          })()}
          {onCompact && (
            <button
              className="composer-chip"
              title={t('input.slash.compact')}
              onClick={() => onCompact()}
              disabled={disabled || running}
            >
              <FileText size={13} />
              <span className="chip-label">{t('input.compact')}</span>
            </button>
          )}

          {showModelChip && (
            <span style={{ position: 'relative', display: 'inline-flex' }} data-cmenu>
              <button
                className="composer-chip"
                title={t('input.modelChipTitle')}
                onClick={() => setOpenMenu((m) => (m === 'model' ? null : 'model'))}
              >
                <span className="chip-label">{modelLabel}{effortSuffix}</span>
                <ChevronDown size={12} />
              </button>
              {openMenu === 'model' && (
                <div className="composer-menu right">
                  {onThinkingChange && (
                    <>
                      <div className="menu-section">{t('input.thinkingSection')}</div>
                      {(['off', 'low', 'medium', 'high'] as const).map((lv) => (
                        <button
                          key={lv}
                          className={`menu-item${(thinkingLevel || 'off') === lv ? ' active' : ''}`}
                          onClick={() => { onThinkingChange(lv); setOpenMenu(null) }}
                        >
                          <Brain size={14} />
                          <span className="grow">{t(thinkingLabelKey[lv])}</span>
                          {(thinkingLevel || 'off') === lv && <Check size={13} />}
                        </button>
                      ))}
                    </>
                  )}
                  {onModelChange && !!models?.length && (
                    <>
                      {modelGroups.map((g) => (
                        <React.Fragment key={g.provider}>
                          <div className="menu-section">
                            {g.provider}
                            {g.source === 'direct' ? ` · ${t('model.group.direct')}` : g.source === 'forsion' ? ` · ${t('model.group.forsion')}` : ''}
                          </div>
                          {g.models.map((m) => (
                            <button
                              key={`${m.source}-${m.id}`}
                              className={`menu-item${m.id === modelId ? ' active' : ''}`}
                              onClick={() => { onModelChange(m.id); setOpenMenu(null) }}
                            >
                              <span className="grow">{m.name}</span>
                              {m.id === modelId && <Check size={13} />}
                            </button>
                          ))}
                        </React.Fragment>
                      ))}
                    </>
                  )}
                  {onModelChange && !models?.length && (
                    <div className="menu-section" style={{ padding: '6px 8px' }}>{t('common.loading')}</div>
                  )}
                </div>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
