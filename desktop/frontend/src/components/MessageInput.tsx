/**
 * 输入区(Codex 两段式):
 * - 框内:auto-grow textarea + 底排「+ 附件菜单 / 🎤占位 / 发送·停止」;
 * - 框外:上下文 chip(云沙箱/本机·目录)、模式菜单(计划/审批)、右侧 模型·思考档 菜单。
 * 附件支持文件选择 / 粘贴 / 拖拽,chip 带缩略图。auto-grow 对齐 AI Studio(scrollHeight 撑高,截断)。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Send, Square, Plus, Mic, ImagePlus, X, Brain, ClipboardList, Check, ChevronDown,
} from 'lucide-react'
import type { AgentConfig, Attachment, ModelInfo, SkillInfo } from '../types'

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

const approvalLabel = { readonly: '只读·全审批', 'auto-edit': '自动编辑', 'full-auto': '全自动' } as const
const thinkingLabel = { off: '思考·关', low: '思考·浅', medium: '思考·中', high: '思考·深' } as const
const thinkingShort = { off: '标准', low: '浅', medium: '中', high: '深' } as const

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
  /** 计划模式开关(只读调研 → exit_plan_mode 提交计划)。 */
  planMode?: boolean
  onPlanModeChange?: (on: boolean) => void
  /** 斜杠命令数据源:技能列表 + 本会话已启用技能 + 各动作回调。 */
  skills?: SkillInfo[] | null
  enabledSkillIds?: string[]
  onToggleSkill?: (id: string) => void
  onNewSession?: () => void
  onOpenSettings?: () => void
  onExecConfigChange: (patch: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>) => void
  /** 返回是否已受理:失败(连接/参数错)返回 false,草稿保留不清空。 */
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean>
  onStop: () => void
}> = ({
  disabled, running, execConfig,
  models, modelId, onModelChange, thinkingLevel, onThinkingChange,
  planMode, onPlanModeChange, skills, enabledSkillIds, onToggleSkill, onNewSession, onOpenSettings,
  onExecConfigChange, onSend, onStop,
}) => {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
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
        desc: planMode ? '关闭计划模式' : '开启计划模式(只读调研 → 提交计划求批准)',
        run: () => { onPlanModeChange(!planMode); close() },
      })
    }
    if (onThinkingChange) {
      for (const lv of ['off', 'low', 'medium', 'high'] as const) {
        items.push({ cmd: `/think ${lv}`, desc: `思考深度设为 ${lv}${thinkingLevel === lv ? '(当前)' : ''}`, run: () => { onThinkingChange(lv); close() } })
      }
    }
    if (onModelChange && models?.length) {
      items.push({ cmd: '/model', desc: '选择本会话模型…', run: () => { setDraft('/model '); setSlashSubMenu('model'); setSlashIndex(0) } })
    }
    if (onNewSession) items.push({ cmd: '/new', desc: '新建会话', run: () => { onNewSession(); close() } })
    if (onOpenSettings) items.push({ cmd: '/skills', desc: '打开设置管理技能', run: () => { onOpenSettings(); close() } })
    if (onToggleSkill) {
      const enabled = new Set(enabledSkillIds || [])
      for (const s of skills || []) {
        items.push({
          cmd: `/skill:${s.id}`,
          desc: `${enabled.has(s.id) ? '停用' : '启用'}技能 ${s.name}`,
          run: () => { onToggleSkill(s.id); close() },
        })
      }
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planMode, thinkingLevel, models, skills, enabledSkillIds, onPlanModeChange, onThinkingChange, onModelChange, onNewSession, onOpenSettings, onToggleSkill])

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
          desc: `${m.source === 'direct' ? '直连·' : ''}${m.provider} · ${m.id}`,
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
    if (!text || disabled || running) return
    if (text.length > MAX_INPUT_CHARS) {
      setHint(`消息过长(${text.length.toLocaleString()} 字符,上限 ${MAX_INPUT_CHARS.toLocaleString()})——大段材料请保存为文件,让 agent 用工具按需读取,整段粘贴会按轮数翻倍烧 token。`)
      return
    }
    setHint(null)
    void onSend(text, attachments).then((accepted) => {
      if (!accepted) return // 失败保留草稿
      setDraft('')
      setAttachments([])
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
        skipped.push(`${f.name}(非图片)`)
        continue
      }
      if (f.size > MAX_ATTACH_BYTES) {
        skipped.push(`${f.name}(超 ${Math.round(MAX_ATTACH_BYTES / 1024 / 1024)}MB)`)
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
    setHint(skipped.length ? `已跳过:${skipped.join('、')}。图片随消息发给模型;其他文件请用右栏工作区上传。` : null)
    setAttachments((prev) => [...prev, ...next])
  }

  // ── 框外控制:审批档(执行环境由工作区决定,不在输入栏切换) ──
  const setApproval = (m: NonNullable<AgentConfig['approvalMode']>) => {
    onExecConfigChange({ execMode: 'host', approvalMode: m, cwd: execConfig.cwd })
    setOpenMenu(null)
  }

  // 模型分组:Forsion 托管 / 各直连 provider
  const forsionModels = (models || []).filter((m) => m.source === 'forsion')
  const directModels = (models || []).filter((m) => m.source === 'direct')
  const currentModel = (models || []).find((m) => m.id === modelId)

  // chip 文案
  const modeLabel = planMode ? '计划模式' : (isHost ? approvalLabel[approval] : '常规')
  const modelLabel = currentModel?.name || modelId || '选择模型'
  const effortSuffix = thinkingLevel && thinkingLevel !== 'off' ? ` · ${thinkingShort[thinkingLevel]}` : ''

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
            // 本机模式:拖入文件 → 把绝对路径粘进输入框(agent 用工具按路径读);云沙箱仍走图片附件。
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
            void pickFiles(files)
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
                  <button title="移除" onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>
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
            placeholder={disabled ? '先在设置里连接后端…' : '输入消息,输入 / 唤起技能(Enter 发送,Shift+Enter 换行)'}
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
                title="添加内容"
                disabled={disabled}
                onClick={() => setOpenMenu((m) => (m === 'add' ? null : 'add'))}
              >
                <Plus size={17} />
              </button>
              {openMenu === 'add' && (
                <div className="composer-menu left">
                  <button className="menu-item" onClick={() => { fileRef.current?.click(); setOpenMenu(null) }}>
                    <ImagePlus size={14} />
                    <span className="grow">添加图片</span>
                  </button>
                  <div className="menu-section" style={{ padding: '4px 8px 2px' }}>
                    其他文件请用右栏工作区上传
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
            <button className="icon-btn composer-mic" title="语音输入即将上线" disabled>
              <Mic size={16} />
            </button>
            {running ? (
              <button className="btn danger sm" onClick={onStop}>
                <Square size={12} /> 停止
              </button>
            ) : (
              <button className="btn primary sm" onClick={send} disabled={disabled || !draft.trim()}>
                <Send size={13} /> 发送
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
                title="模式:计划模式(只读调研→提交计划)与审批档(host)"
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
                      <div className="menu-section">计划模式</div>
                      <button
                        className={`menu-item${planMode ? ' active' : ''}`}
                        onClick={() => { onPlanModeChange(!planMode); setOpenMenu(null) }}
                      >
                        <ClipboardList size={14} />
                        <span className="grow">{planMode ? '计划模式·已开' : '开启计划模式'}</span>
                        {planMode && <Check size={13} />}
                      </button>
                    </>
                  )}
                  {isHost && (
                    <>
                      <div className="menu-section">审批档</div>
                      {(['readonly', 'auto-edit', 'full-auto'] as const).map((m) => (
                        <button key={m} className={`menu-item${approval === m ? ' active' : ''}`} onClick={() => setApproval(m)}>
                          <span className="grow">{approvalLabel[m]}</span>
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

          {showModelChip && (
            <span style={{ position: 'relative', display: 'inline-flex' }} data-cmenu>
              <button
                className="composer-chip"
                title="本会话模型与思考深度"
                onClick={() => setOpenMenu((m) => (m === 'model' ? null : 'model'))}
              >
                <span className="chip-label">{modelLabel}{effortSuffix}</span>
                <ChevronDown size={12} />
              </button>
              {openMenu === 'model' && (
                <div className="composer-menu right">
                  {onThinkingChange && (
                    <>
                      <div className="menu-section">思考深度</div>
                      {(['off', 'low', 'medium', 'high'] as const).map((lv) => (
                        <button
                          key={lv}
                          className={`menu-item${(thinkingLevel || 'off') === lv ? ' active' : ''}`}
                          onClick={() => { onThinkingChange(lv); setOpenMenu(null) }}
                        >
                          <Brain size={14} />
                          <span className="grow">{thinkingLabel[lv]}</span>
                          {(thinkingLevel || 'off') === lv && <Check size={13} />}
                        </button>
                      ))}
                    </>
                  )}
                  {onModelChange && !!models?.length && (
                    <>
                      {forsionModels.length > 0 && <div className="menu-section">Forsion 托管</div>}
                      {forsionModels.map((m) => (
                        <button
                          key={`f-${m.id}`}
                          className={`menu-item${m.id === modelId ? ' active' : ''}`}
                          onClick={() => { onModelChange(m.id); setOpenMenu(null) }}
                        >
                          <span className="grow">{m.name}</span>
                          {m.id === modelId && <Check size={13} />}
                        </button>
                      ))}
                      {directModels.length > 0 && <div className="menu-section">直连 Provider</div>}
                      {directModels.map((m) => (
                        <button
                          key={`d-${m.id}`}
                          className={`menu-item${m.id === modelId ? ' active' : ''}`}
                          onClick={() => { onModelChange(m.id); setOpenMenu(null) }}
                        >
                          <span className="grow">{m.name}</span>
                          <span className="menu-meta">{m.provider}</span>
                          {m.id === modelId && <Check size={13} />}
                        </button>
                      ))}
                    </>
                  )}
                  {onModelChange && !models?.length && (
                    <div className="menu-section" style={{ padding: '6px 8px' }}>模型加载中…</div>
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
