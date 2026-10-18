/**
 * 查看/编辑某 agent 的大脑:MEMORY.md(可编辑)、LOG/(按日期可编辑)、Library/(资料库:列表/图片预览/文本编辑/上传/删除)。
 * 仅本地后端可用(端点在云端 404)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Loader2, X, Upload, Trash2, FileText, Image as ImageIcon } from 'lucide-react'
import {
  listAgentLibrary, getAgentLibraryFile, putAgentLibraryFile, deleteAgentLibraryFile,
  type AgentLibraryFile,
} from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'
import { AgentMemoryPanel } from './AgentMemoryPanel'
import { AgentLogPanel } from './AgentLogPanel'
import { AgentHarnessPanel } from './AgentHarnessPanel'
import { homeTarget, connectionKey } from '../services/engine/targets'

// 与后端 agentRegistry 的文本扩展名口径一致(决定上传走 content 还是 dataBase64)。
const LIB_TEXT_EXTS = new Set(['md', 'markdown', 'txt', 'text', 'json', 'jsonl', 'toml', 'yaml', 'yml', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'log', 'ini', 'env', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'rb', 'php', 'sql'])
const extOf = (n: string): string => (n.split('.').pop() || '').toLowerCase()
const isTextName = (n: string): boolean => LIB_TEXT_EXTS.has(extOf(n))
const fmtSize = (b: number): string => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`)

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => { const s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)) }
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

type Tab = 'memory' | 'log' | 'library' | 'harness'

type AgentMemoryModalProps = {
  cfg: TanguDesktopConfig
  slug: string
  name: string
  shareDefaultMemory?: boolean
  onClose: () => void
}

export const AgentMemoryModal: React.FC<AgentMemoryModalProps> = (props) =>
  <AgentMemoryModalBody key={JSON.stringify([connectionKey(props.cfg), props.slug, props.shareDefaultMemory])} {...props} />

const AgentMemoryModalBody: React.FC<AgentMemoryModalProps> = ({ cfg, slug, name, shareDefaultMemory, onClose }) => {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('memory')
  // 日志面板自带草稿:第一次点到「日志」才挂(那时才读),之后常驻,切到别的页签只是藏起来
  const [logSeen, setLogSeen] = useState(false)
  useEffect(() => { if (tab === 'log') setLogSeen(true) }, [tab])

  // 资料库
  const [libFiles, setLibFiles] = useState<AgentLibraryFile[]>([])
  const [libSel, setLibSel] = useState<string | null>(null)
  const [libText, setLibText] = useState('')
  const [libPreview, setLibPreview] = useState<string | null>(null)
  const [libBinary, setLibBinary] = useState(false)
  const [libBusy, setLibBusy] = useState(false)
  const [libErr, setLibErr] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const reloadLib = async (): Promise<void> => { try { setLibFiles(await listAgentLibrary(homeTarget(), slug)) } catch { /* ignore */ } }

  useEffect(() => {
    void reloadLib()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])


  const openLib = async (fname: string): Promise<void> => {
    setLibSel(fname); setLibErr(''); setLibPreview(null); setLibText(''); setLibBinary(false)
    try {
      const f = await getAgentLibraryFile(homeTarget(), slug, fname)
      if (f.isBinary) {
        setLibBinary(true)
        if (f.dataBase64 && (f.mimeType || '').startsWith('image/')) setLibPreview(`data:${f.mimeType};base64,${f.dataBase64}`)
      } else setLibText(f.content || '')
    } catch (e: any) { setLibErr(e?.message || 'load failed') }
  }
  const saveLibText = async (): Promise<void> => {
    if (!libSel) return
    setLibBusy(true); setLibErr('')
    try { await putAgentLibraryFile(homeTarget(), slug, libSel, { content: libText, isBinary: false }); await reloadLib() }
    catch (e: any) { setLibErr(e?.message || 'save failed') }
    finally { setLibBusy(false) }
  }
  const delLib = async (fname: string): Promise<void> => {
    if (!window.confirm(t('settings.agents.libraryDeleteConfirm', { name: fname }))) return
    try {
      await deleteAgentLibraryFile(homeTarget(), slug, fname)
      if (libSel === fname) { setLibSel(null); setLibText(''); setLibPreview(null); setLibBinary(false) }
      await reloadLib()
    } catch (e: any) { setLibErr(e?.message || 'delete failed') }
  }
  const onPickLib = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (file.size > 5 * 1024 * 1024) { setLibErr(t('settings.agents.libraryTooLarge')); return }
    setLibBusy(true); setLibErr('')
    try {
      if (isTextName(file.name)) await putAgentLibraryFile(homeTarget(), slug, file.name, { content: await file.text(), isBinary: false })
      else await putAgentLibraryFile(homeTarget(), slug, file.name, { dataBase64: await fileToBase64(file), isBinary: true })
      await reloadLib(); await openLib(file.name)
    } catch (e: any) { setLibErr(e?.message || 'upload failed') }
    finally { setLibBusy(false) }
  }

  const tabBtn = (id: Tab, label: string): React.ReactNode => (
    <button
      className="btn sm"
      onClick={() => setTab(id)}
      style={tab === id ? { background: 'var(--accent-tint)', color: 'var(--text)' } : { background: 'transparent' }}
    >{label}</button>
  )

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay-scrim)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--bg-card)', border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-lg, 12px)', padding: 18, width: 'min(680px, 92vw)', maxHeight: '86vh', overflow: 'auto', boxShadow: 'var(--card-shadow)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <b>{t('settings.agents.memTitle', { name })}</b>
          <button className="icon-btn" onClick={onClose}><X size={15} /></button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {tabBtn('memory', t('settings.agents.tabMemory'))}
          {tabBtn('log', t('settings.agents.tabLog'))}
          {tabBtn('library', t('settings.agents.tabLibrary'))}
          {tabBtn('harness', t('settings.agents.tabHarness'))}
        </div>

        {tab === 'memory' && <AgentMemoryPanel cfg={cfg} slug={slug} shareDefaultMemory={shareDefaultMemory} />}

        {logSeen && <div hidden={tab !== 'log'}><AgentLogPanel cfg={cfg} slug={slug} active={tab === 'log'} /></div>}

        {tab === 'library' && (
          <div className="field">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <label style={{ margin: 0 }}>{t('settings.agents.library')}</label>
              <button className="btn sm" disabled={libBusy} onClick={() => fileInput.current?.click()}>
                {libBusy ? <Loader2 size={13} className="spin" /> : <Upload size={13} />} {t('settings.agents.libraryUpload')}
              </button>
              <input ref={fileInput} type="file" style={{ display: 'none' }} onChange={(e) => void onPickLib(e)} />
            </div>

            {libErr && <div className="hint" style={{ color: 'var(--danger)' }}>{libErr}</div>}

            {libFiles.length === 0
              ? <div className="hint">{t('settings.agents.libraryEmpty')}</div>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {libFiles.map((f) => (
                    <div
                      key={f.name}
                      className="file-row"
                      onClick={() => void openLib(f.name)}
                      style={{ cursor: 'pointer', background: libSel === f.name ? 'var(--overlay-light)' : undefined }}
                    >
                      {f.isBinary ? <ImageIcon size={13} style={{ flexShrink: 0 }} /> : <FileText size={13} style={{ flexShrink: 0 }} />}
                      <span className="file-name" style={{ flex: 1 }}>{f.name}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{fmtSize(f.size)}</span>
                      <button className="icon-btn" title={t('common.delete')} onClick={(e) => { e.stopPropagation(); void delLib(f.name) }}><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              )}

            {libSel && (
              <div style={{ marginTop: 12, borderTop: 'var(--border-width) solid var(--border)', paddingTop: 12 }}>
                <div style={{ fontSize: 'var(--ui-font-meta, 12px)', color: 'var(--text-muted)', marginBottom: 6 }}>{libSel}</div>
                {libBinary
                  ? (
                    <>
                      {libPreview
                        ? <img src={libPreview} alt={libSel} style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 'var(--radius-sm, 6px)', display: 'block' }} />
                        : <div className="hint">{t('settings.agents.libraryBinaryHint')}</div>}
                    </>
                  )
                  : (
                    <>
                      <textarea rows={10} value={libText} onChange={(e) => setLibText(e.target.value)} />
                      <div style={{ marginTop: 6 }}>
                        <button className="btn primary sm" disabled={libBusy} onClick={() => void saveLibText()}>
                          {libBusy ? <Loader2 size={13} className="spin" /> : null} {t('common.save')}
                        </button>
                      </div>
                    </>
                  )}
              </div>
            )}
          </div>
        )}

        {tab === 'harness' && <AgentHarnessPanel cfg={cfg} slug={slug} />}
      </div>
    </div>
  )
}
