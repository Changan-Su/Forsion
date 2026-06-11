/**
 * 输入区:auto-grow textarea + 附件(base64) + 发送/停止 + 执行模式/审批档选择器(host 能力)。
 * auto-grow 模式对齐 AI Studio MessageInput(scrollHeight 撑高,max-height 截断)。
 */
import React, { useRef, useState } from 'react'
import { Send, Square, Paperclip, X, Monitor, Cloud, FolderOpen } from 'lucide-react'
import type { AgentConfig, Attachment } from '../types'

const MAX_ATTACH_BYTES = 5 * 1024 * 1024
// 客户端输入帽(服务端 runs.ts 还有一道):大段材料整体粘贴会让 agent 每轮迭代全量重发,
// token 消耗 = 消息体量 × 轮数(2026-06-10 的百万 token 事故根因)。
const MAX_INPUT_CHARS = 150_000

/** 选本机工作目录:Electron 用系统目录对话框,浏览器调试回退手输。 */
async function pickCwd(current?: string, fallback?: string): Promise<string | null> {
  if (window.tangu?.pickDirectory) {
    const dir = await window.tangu.pickDirectory()
    return dir || current || fallback || null
  }
  const v = window.prompt('输入工作目录绝对路径', current || fallback || '')
  return v?.trim() || null
}

export const MessageInput: React.FC<{
  disabled: boolean
  running: boolean
  execConfig: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>
  homeDir?: string
  onExecConfigChange: (patch: Pick<AgentConfig, 'execMode' | 'approvalMode' | 'cwd'>) => void
  /** 返回是否已受理:失败(连接/参数错)返回 false,草稿保留不清空。 */
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean>
  onStop: () => void
}> = ({ disabled, running, execConfig, homeDir, onExecConfigChange, onSend, onStop }) => {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [hint, setHint] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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

  const isHost = execConfig.execMode === 'host'
  const approvalLabel = { readonly: '只读·全审批', 'auto-edit': '自动编辑', 'full-auto': '全自动' } as const

  return (
    <div className="composer">
      <div className="composer-inner">
        <div className="composer-box">
          {hint && (
            <div style={{ fontSize: 12, color: 'var(--danger, #c0392b)', marginBottom: 6 }}>
              {hint}
            </div>
          )}
          {attachments.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {attachments.map((a, i) => (
                <span className="attach-chip" key={`${a.name}-${i}`}>
                  <span>{a.name}</span>
                  <button onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>
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
            placeholder={disabled ? '先在设置里连接后端…' : '给 Tangu 派个活(Enter 发送,Shift+Enter 换行)'}
            disabled={disabled}
            onChange={(e) => {
              setDraft(e.target.value)
              autoGrow()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="composer-bar">
            <button className="icon-btn" title="添加图片(随消息发给模型;其他文件请用右栏工作区上传)" onClick={() => fileRef.current?.click()}>
              <Paperclip size={15} />
            </button>
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
            <button
              className="mode-select"
              title="执行环境:云沙箱(隔离工作区)/ 本机(后端所在机器的真实文件系统,需审批)——与 TUI 的 host 模式一致"
              onClick={() => {
                if (isHost) {
                  onExecConfigChange({ execMode: 'sandbox', approvalMode: execConfig.approvalMode, cwd: execConfig.cwd })
                  return
                }
                // 切到本机:必须有工作目录(没有则弹目录选择,取消回退主目录)。
                void (async () => {
                  const cwd = execConfig.cwd || (await pickCwd(undefined, homeDir)) || homeDir
                  if (!cwd) return // 实在拿不到目录就不切换
                  onExecConfigChange({ execMode: 'host', approvalMode: execConfig.approvalMode || 'auto-edit', cwd })
                })()
              }}
            >
              {isHost ? <Monitor size={13} /> : <Cloud size={13} />}
              {isHost ? '本机' : '云沙箱'}
            </button>
            {isHost && (
              <>
                <button
                  className="mode-select"
                  title={`工作目录:${execConfig.cwd || '(未设置)'} —— 点击更换`}
                  onClick={() => {
                    void pickCwd(execConfig.cwd, homeDir).then((cwd) => {
                      if (cwd) onExecConfigChange({ execMode: 'host', approvalMode: execConfig.approvalMode, cwd })
                    })
                  }}
                >
                  <FolderOpen size={13} />
                  {execConfig.cwd ? (execConfig.cwd.split('/').filter(Boolean).pop() || execConfig.cwd) : '选择目录'}
                </button>
                <button
                  className="mode-select"
                  title="审批档:只读(写文件/跑命令都审)/ 自动编辑(只审命令)/ 全自动"
                  onClick={() => {
                    const order: AgentConfig['approvalMode'][] = ['readonly', 'auto-edit', 'full-auto']
                    const cur = order.indexOf(execConfig.approvalMode || 'auto-edit')
                    onExecConfigChange({ execMode: 'host', approvalMode: order[(cur + 1) % 3], cwd: execConfig.cwd })
                  }}
                >
                  {approvalLabel[execConfig.approvalMode || 'auto-edit']}
                </button>
              </>
            )}
            <span className="grow" />
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
      </div>
    </div>
  )
}
