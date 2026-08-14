/**
 * 查看/编辑某 agent 的大脑:MEMORY.md(可编辑)、LOG/(按日期可编辑)、Library/(资料库:列表/图片预览/文本编辑/上传/删除)。
 * 仅本地后端可用(端点在云端 404)。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Loader2, X, Upload, Trash2, FileText, Image as ImageIcon, Undo2 } from 'lucide-react'
import {
  getAgentMemory, putAgentMemory, listAgentLogDates, getAgentLog, putAgentLog,
  listAgentLibrary, getAgentLibraryFile, putAgentLibraryFile, deleteAgentLibraryFile,
  getAgentHarness, rollbackHarnessEntry,
  type AgentLibraryFile, type HarnessEntry, type HarnessJournalLine,
} from '../services/backendService'
import type { TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

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

export const AgentMemoryModal: React.FC<{
  cfg: TanguDesktopConfig
  slug: string
  name: string
  onClose: () => void
}> = ({ cfg, slug, name, onClose }) => {
  const { t } = useI18n()
  const [tab, setTab] = useState<Tab>('memory')

  // 记忆
  const [memory, setMemory] = useState('')
  const [memBusy, setMemBusy] = useState(false)
  const [memSaved, setMemSaved] = useState(false)

  // 日志
  const [dates, setDates] = useState<string[]>([])
  const [logDate, setLogDate] = useState('')
  const [logContent, setLogContent] = useState('')
  const [logBusy, setLogBusy] = useState(false)
  const [logSaved, setLogSaved] = useState(false)

  // 资料库
  const [libFiles, setLibFiles] = useState<AgentLibraryFile[]>([])
  const [libSel, setLibSel] = useState<string | null>(null)
  const [libText, setLibText] = useState('')
  const [libPreview, setLibPreview] = useState<string | null>(null)
  const [libBinary, setLibBinary] = useState(false)
  const [libBusy, setLibBusy] = useState(false)
  const [libErr, setLibErr] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  // 进化史(工作笔记 + 本机编辑史)
  const [hEntries, setHEntries] = useState<HarnessEntry[]>([])
  const [hJournal, setHJournal] = useState<HarnessJournalLine[]>([])
  const [hErr, setHErr] = useState('')
  const [hBusy, setHBusy] = useState(false)

  const reloadLib = async (): Promise<void> => { try { setLibFiles(await listAgentLibrary(cfg, slug)) } catch { /* ignore */ } }
  const reloadHarness = async (): Promise<void> => {
    try { const r = await getAgentHarness(cfg, slug); setHEntries(r.entries); setHJournal(r.journal); setHErr('') }
    catch (e: any) { setHErr(e?.message || 'load failed') } // 吞掉会显示假「空」(Codex 评审 Minor)
  }

  useEffect(() => {
    void getAgentMemory(cfg, slug).then(setMemory).catch(() => {})
    void listAgentLogDates(cfg, slug).then((ds) => { setDates(ds); if (ds.length) setLogDate(ds[ds.length - 1]) }).catch(() => {})
    void reloadLib()
    void reloadHarness()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  useEffect(() => {
    if (!logDate) { setLogContent(''); return }
    void getAgentLog(cfg, slug, logDate).then(setLogContent).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logDate, slug])

  const saveMem = async (): Promise<void> => {
    setMemBusy(true); setMemSaved(false)
    try { await putAgentMemory(cfg, slug, memory); setMemSaved(true); setTimeout(() => setMemSaved(false), 1500) }
    finally { setMemBusy(false) }
  }
  const saveLog = async (): Promise<void> => {
    if (!logDate) return
    setLogBusy(true); setLogSaved(false)
    try { await putAgentLog(cfg, slug, logDate, logContent); setLogSaved(true); setTimeout(() => setLogSaved(false), 1500) }
    finally { setLogBusy(false) }
  }

  const openLib = async (fname: string): Promise<void> => {
    setLibSel(fname); setLibErr(''); setLibPreview(null); setLibText(''); setLibBinary(false)
    try {
      const f = await getAgentLibraryFile(cfg, slug, fname)
      if (f.isBinary) {
        setLibBinary(true)
        if (f.dataBase64 && (f.mimeType || '').startsWith('image/')) setLibPreview(`data:${f.mimeType};base64,${f.dataBase64}`)
      } else setLibText(f.content || '')
    } catch (e: any) { setLibErr(e?.message || 'load failed') }
  }
  const saveLibText = async (): Promise<void> => {
    if (!libSel) return
    setLibBusy(true); setLibErr('')
    try { await putAgentLibraryFile(cfg, slug, libSel, { content: libText, isBinary: false }); await reloadLib() }
    catch (e: any) { setLibErr(e?.message || 'save failed') }
    finally { setLibBusy(false) }
  }
  const delLib = async (fname: string): Promise<void> => {
    if (!window.confirm(t('settings.agents.libraryDeleteConfirm', { name: fname }))) return
    try {
      await deleteAgentLibraryFile(cfg, slug, fname)
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
      if (isTextName(file.name)) await putAgentLibraryFile(cfg, slug, file.name, { content: await file.text(), isBinary: false })
      else await putAgentLibraryFile(cfg, slug, file.name, { dataBase64: await fileToBase64(file), isBinary: true })
      await reloadLib(); await openLib(file.name)
    } catch (e: any) { setLibErr(e?.message || 'upload failed') }
    finally { setLibBusy(false) }
  }

  const doRollback = async (id: string, title: string): Promise<void> => {
    if (!window.confirm(t('settings.agents.harnessRollbackConfirm', { title }))) return
    setHBusy(true); setHErr('')
    try { await rollbackHarnessEntry(cfg, slug, id); await reloadHarness() }
    catch (e: any) { setHErr(e?.message || 'rollback failed') }
    finally { setHBusy(false) }
  }

  const tabBtn = (id: Tab, label: string): React.ReactNode => (
    <button
      className="btn sm"
      onClick={() => setTab(id)}
      style={tab === id ? { background: 'var(--accent)', color: 'var(--on-accent)' } : { background: 'transparent' }}
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

        {tab === 'memory' && (
          <div className="field">
            <label>{t('settings.agents.memory')}</label>
            <textarea rows={12} value={memory} onChange={(e) => setMemory(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <button className="btn primary sm" disabled={memBusy} onClick={() => void saveMem()}>
                {memBusy ? <Loader2 size={13} className="spin" /> : null} {t('common.save')}
              </button>
              {memSaved && <span style={{ fontSize: 12, color: 'var(--accent-ink)' }}>{t('settings.agents.memSaved')}</span>}
            </div>
          </div>
        )}

        {tab === 'log' && (
          <div className="field">
            <label>{t('settings.agents.log')}</label>
            {dates.length === 0
              ? <div className="hint">{t('settings.agents.noLog')}</div>
              : (
                <>
                  <select value={logDate} onChange={(e) => setLogDate(e.target.value)}>
                    {dates.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <textarea rows={12} value={logContent} onChange={(e) => setLogContent(e.target.value)} style={{ marginTop: 6 }} />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                    <button className="btn primary sm" disabled={logBusy} onClick={() => void saveLog()}>
                      {logBusy ? <Loader2 size={13} className="spin" /> : null} {t('common.save')}
                    </button>
                    {logSaved && <span style={{ fontSize: 12, color: 'var(--accent-ink)' }}>{t('settings.agents.memSaved')}</span>}
                  </div>
                </>
              )}
          </div>
        )}

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
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{libSel}</div>
                {libBinary
                  ? (
                    <>
                      {libPreview
                        ? <img src={libPreview} alt={libSel} style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 8, display: 'block' }} />
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

        {tab === 'harness' && (() => {
          // 回滚=条目级「恢复上一版」(在最近两版间往返);journal 是本机编辑史,不跨设备同步。
          const currentIds = new Set(hEntries.map((e) => e.id))
          const rev = [...hJournal].reverse()
          const latestIdx = new Map<string, number>()
          rev.forEach((l, i) => { if (!latestIdx.has(l.entryId)) latestIdx.set(l.entryId, i) })
          const actLabel = (l: HarnessJournalLine): string =>
            l.action === 'delete' ? t('settings.agents.harnessActDelete')
              : l.action === 'rollback' ? t('settings.agents.harnessActRollback')
                : l.before === null ? t('settings.agents.harnessActCreate') : t('settings.agents.harnessActUpdate')
          return (
            <div className="field">
              <div className="hint">{t('settings.agents.harnessHint')}</div>
              {hErr && <div className="hint" style={{ color: 'var(--danger)' }}>{hErr}</div>}
              {hEntries.length === 0
                ? <div className="hint">{t('settings.agents.harnessEmpty')}</div>
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {hEntries.map((e) => (
                      <div key={e.id} className="file-row" style={{ alignItems: 'flex-start' }}>
                        <span className="file-name" style={{ flex: 1, whiteSpace: 'normal' }}>
                          <b>{e.title}</b>
                          <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>{e.kind} · v{e.version} · {e.updatedAt}</span>
                          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{e.body}</div>
                          {e.evidence && <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t('settings.agents.harnessEvidence')}: {e.evidence}</div>}
                        </span>
                        {latestIdx.has(e.id) && (
                          <button className="icon-btn" disabled={hBusy} title={t('settings.agents.harnessRollback')} onClick={() => void doRollback(e.id, e.title)}>
                            <Undo2 size={13} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              {rev.length > 0 && (
                <div style={{ marginTop: 12, borderTop: 'var(--border-width) solid var(--border)', paddingTop: 10 }}>
                  <label>{t('settings.agents.harnessHistory')}</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>
                    {rev.map((l, i) => {
                      const title = l.after?.title || l.before?.title || l.entryId
                      const restorable = latestIdx.get(l.entryId) === i && !currentIds.has(l.entryId) && !!l.before
                      return (
                        <div key={`${l.ts}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                          <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>{String(l.ts).slice(0, 16).replace('T', ' ')}</span>
                          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{actLabel(l)}</span>
                          <span className="file-name" style={{ flex: 1 }}>{title}</span>
                          {restorable && (
                            <button className="btn ghost sm" disabled={hBusy} onClick={() => void doRollback(l.entryId, title)}>
                              {t('settings.agents.harnessRestore')}
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
