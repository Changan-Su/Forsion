import React, { useEffect, useRef, useState } from 'react'
import { Eraser, Loader2, Pencil, Plus, RefreshCw, Search } from 'lucide-react'
import {
  getAgentMemorySnapshot, putAgentMemory, mutateAgentMemoryEntry, listAgentMemoryRevisions, restoreAgentMemory,
  getAgentMemoryDream, configureAgentMemoryDream, startAgentMemoryDream, cancelAgentMemoryDream,
  type AgentMemorySnapshot, type AgentMemoryRevision, type AgentMemoryDream, type AgentMemoryDreamConfig,
} from '../services/backendService'
import { registerMessages, useI18n } from '../i18n'
import type { TanguDesktopConfig } from '../types'

registerMessages({
  'agentMemory.search': { zh: '搜索记忆', en: 'Search memory' },
  'agentMemory.noMatches': { zh: '没有匹配的记忆', en: 'No matching memories' },
  'agentMemory.entries': { zh: '{count} 条记忆', en: 'Memory entries: {count}' },
  'agentMemory.empty': { zh: '这个 Agent 还没有长期记忆。', en: 'This Agent has no long-term memory yet.' },
  'agentMemory.unavailable': { zh: '记忆暂不可用', en: 'Memory unavailable' },
  'agentMemory.loading': { zh: '正在读取记忆…', en: 'Loading memory…' },
  'agentMemory.reload': { zh: '刷新', en: 'Refresh' },
  'agentMemory.version': { zh: '版本', en: 'Version' },
  'agentMemory.source.explicit': { zh: '明确记住', en: 'Explicit memory' },
  'agentMemory.source.historian': { zh: '对话提取', en: 'Conversation extraction' },
  'agentMemory.source.dream': { zh: '记忆整理', en: 'Memory maintenance' },
  'agentMemory.source.sync': { zh: '同步', en: 'Sync' },
  'agentMemory.source.manual': { zh: '手动编辑', en: 'Manual edit' },
  'agentMemory.source.restore': { zh: '版本恢复', en: 'Revision restore' },
  'agentMemory.source.migration': { zh: '旧版迁移', en: 'Legacy migration' },
  'agentMemory.source.external-edit': { zh: '文件编辑', en: 'File edit' },
  'agentMemory.source': { zh: '来源与证据', en: 'Source and evidence' },
  'agentMemory.forgetHint': { zh: '遗忘会移出活跃记忆，并阻止旧同步恢复；原文仍保留在版本历史中供审计，不是物理擦除。', en: 'Forget removes active memory and prevents old sync data from restoring it. Source text remains in revision history for auditing; it is not physically erased.' },
  'agentMemory.sharedHint': { zh: '此 Agent 已明确共享默认 Agent 的记忆与整理设置。编辑、整理、遗忘和恢复会影响共享记忆；历史搜索仍只限此 Agent。', en: 'This Agent explicitly shares the default Agent’s memory and maintenance settings. Editing, maintenance, forgetting and restoring affect shared memory. History search stays scoped to this Agent.' },
  'agentMemory.forget': { zh: '遗忘', en: 'Forget' },
  'agentMemory.edit': { zh: '编辑', en: 'Edit' },
  'agentMemory.add': { zh: '添加记忆', en: 'Add memory' },
  'agentMemory.fact': { zh: '要记住的事实', en: 'Fact to remember' },
  'agentMemory.saved': { zh: '记忆已更新', en: 'Memory updated' },
  'agentMemory.error': { zh: '操作失败，请刷新后重试。', en: 'The operation failed. Refresh and try again.' },
  'agentMemory.unsupported': { zh: '后端尚不支持版本化记忆，请更新后端后重试。', en: 'This backend does not support versioned memory. Update the backend and try again.' },
  'agentMemory.document': { zh: '记忆原文', en: 'Memory document' },
  'agentMemory.raw': { zh: '编辑原文', en: 'Edit source text' },
  'agentMemory.rawHint': { zh: '保存会检查读取时的版本；发生冲突时保留草稿，不覆盖新记忆。', en: 'Saving checks the version you opened. Conflicts preserve your draft and leave newer memory intact.' },
  'agentMemory.changed': { zh: '记忆已有新版本。请先保留所需草稿，再重新载入并合并修改。', en: 'A newer version is available. Keep any draft text you need, then reload and merge your changes.' },
  'agentMemory.discard': { zh: '放弃草稿并载入当前版本', en: 'Discard draft and load current version' },
  'agentMemory.revisions': { zh: '版本记录', en: 'Version history' },
  'agentMemory.noRevisions': { zh: '暂无版本记录。', en: 'No revisions yet.' },
  'agentMemory.restore': { zh: '恢复此版本', en: 'Restore this version' },
  'agentMemory.restoreHint': { zh: '恢复也会检查当前版本；已遗忘的条目不会恢复。', en: 'Restore also checks the current version. Forgotten entries stay forgotten.' },
  'agentMemory.dream': { zh: 'Dream · 记忆整理', en: 'Dream · Memory maintenance' },
  'agentMemory.dreamHint': { zh: '只整理此 Agent 的记忆和待审核候选，后台运行。自动整理默认关闭。', en: 'Consolidates this Agent’s memory and pending candidates in the background. Automatic maintenance is off by default.' },
  'agentMemory.auto': { zh: '自动整理', en: 'Automatic maintenance' },
  'agentMemory.run': { zh: '立即整理', en: 'Run now' },
  'agentMemory.stop': { zh: '取消整理', en: 'Cancel maintenance' },
  'agentMemory.pending': { zh: '{count} 条待审核候选', en: '{count} pending candidates' },
  'agentMemory.pendingShort': { zh: '{count} 条待整理', en: 'Awaiting maintenance: {count}' },
  'agentMemory.autoOn': { zh: '自动', en: 'Auto' },
  'agentMemory.autoOff': { zh: '手动', en: 'Manual' },
  'agentMemory.settings': { zh: '整理设置', en: 'Maintenance settings' },
  'agentMemory.model': { zh: '模型 ID（留空使用后台模型）', en: 'Model ID (blank uses the background model)' },
  'agentMemory.interval': { zh: '最小间隔（小时）', en: 'Minimum interval (hours)' },
  'agentMemory.timeout': { zh: '总时限（秒）', en: 'Total time limit (seconds)' },
  'agentMemory.tokens': { zh: '最大输出 tokens', en: 'Maximum output tokens' },
  'agentMemory.idle': { zh: '待命', en: 'Idle' },
  'agentMemory.running': { zh: '整理中', en: 'Running' },
  'agentMemory.cancelling': { zh: '正在取消', en: 'Cancelling' },
  'agentMemory.completed': { zh: '整理完成', en: 'Completed' },
  'agentMemory.skipped': { zh: '无需整理', en: 'Skipped' },
  'agentMemory.failed': { zh: '整理失败', en: 'Failed' },
  'agentMemory.cancelled': { zh: '已取消', en: 'Cancelled' },
})

type Props = { cfg: TanguDesktopConfig; slug: string; shareDefaultMemory?: boolean; organized?: boolean }
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const hint: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere' }
const section: React.CSSProperties = { borderTop: 'var(--border-width) solid var(--border)', paddingTop: 12, marginTop: 12 }
const sourceText = (source: AgentMemoryRevision['source'], label: string) => [label, source.sessionId, source.messageId, source.runId].filter(Boolean).join(' · ')

/** Changing backend, account, or Agent remounts all state; an old request can never paint into a new identity. */
export const AgentMemoryPanel: React.FC<Props> = (props) => <AgentMemoryPanelBody key={JSON.stringify([props.cfg.backendUrl, props.cfg.token, props.slug, props.shareDefaultMemory])} {...props} />

const AgentMemoryPanelBody: React.FC<Props> = ({ cfg, slug, shareDefaultMemory, organized = false }) => {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [snapshot, setSnapshot] = useState<AgentMemorySnapshot | null>(null)
  const [dream, setDream] = useState<AgentMemoryDream | null>(null)
  const [configDraft, setConfigDraft] = useState<AgentMemoryDreamConfig | null>(null)
  const [revisions, setRevisions] = useState<AgentMemoryRevision[] | null>(null)
  const [draft, setDraft] = useState('')
  const [editorBase, setEditorBase] = useState({ version: '', content: '' })
  const [newFact, setNewFact] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string; version: string } | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const alive = useRef(true)
  const lock = useRef(false)
  const dirty = draft !== editorBase.content
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty
  const revisionRequest = useRef(0)

  const applySnapshot = (next: AgentMemorySnapshot, resetDraft = false) => {
    if (typeof next.version !== 'string' || !Array.isArray(next.entries)) throw new Error(t('agentMemory.unsupported'))
    if (!alive.current) return
    setSnapshot(next)
    if (resetDraft || !dirtyRef.current) { setDraft(next.content); setEditorBase({ version: next.version, content: next.content }) }
  }
  const fail = (e: unknown) => { if (alive.current) setError(e instanceof Error ? e.message : t('agentMemory.error')) }
  const load = async () => {
    const results = await Promise.allSettled([getAgentMemorySnapshot(cfg, slug), getAgentMemoryDream(cfg, slug)])
    if (!alive.current) return
    if (results[0].status === 'fulfilled') { try { applySnapshot(results[0].value) } catch (e) { fail(e) } } else fail(results[0].reason)
    if (results[1].status === 'fulfilled') { setDream(results[1].value); setConfigDraft(results[1].value.config) } else fail(results[1].reason)
  }
  const action = async (fn: () => Promise<void>) => {
    if (lock.current || !alive.current) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e) { fail(e) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true
    void action(load)
    return () => { alive.current = false }
    // Identity changes are handled by the wrapper key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!dream?.status.running) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const next = await getAgentMemoryDream(cfg, slug)
        if (cancelled || !alive.current) return
        setDream(next)
        if (!next.status.running) { applySnapshot(await getAgentMemorySnapshot(cfg, slug)); setRevisions(null) }
      } catch (e) { if (!cancelled) fail(e) }
    }, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dream])
  const update = async (fn: () => Promise<AgentMemorySnapshot>) => {
    const next = await fn()
    if (!alive.current) return
    applySnapshot(next, true); ++revisionRequest.current; setRevisions(null); setEditing(null); setNewFact(''); setNotice(t('agentMemory.saved'))
  }
  const loadRevisions = () => {
    const request = ++revisionRequest.current
    void listAgentMemoryRevisions(cfg, slug).then((items) => {
      if (alive.current && request === revisionRequest.current) setRevisions(items)
    }).catch(fail)
  }
  const writeDisabled = busy || Boolean(dream?.status.running) || !snapshot || dirty || Boolean(editing)
  // organized = Agent 详情「成长 › 记忆」:条目是主角,整理 / 原文 / 版本记录收成底部三个折叠块(09-19 前是四个二级标签 —— 窄栏里两排药丸叠在一起,正文被挤到半屏以下)。
  // 另一种(设置里的 Agent 大脑弹窗)保持原样:那边有自己的仪器(agent-memory.check)按现有 DOM 取元素。
  const dreamBody = dream && <>
    <p style={hint}>{t(shareDefaultMemory && slug !== 'xyra' ? 'agentMemory.sharedHint' : 'agentMemory.dreamHint')}</p>
    <div style={row}>
      <label style={row}><input type="checkbox" checked={dream.config.enabled} disabled={busy || dream.status.running}
        onChange={(e) => { const enabled = e.target.checked; void action(async () => {
          const next = await configureAgentMemoryDream(cfg, slug, { enabled })
          if (alive.current) { setDream(next); setConfigDraft(next.config) }
        }) }} />{t('agentMemory.auto')}</label>
      <button className="btn sm" disabled={busy || (!dream.status.running && (dirty || Boolean(editing)))} onClick={() => void action(async () => {
        const status = await (dream.status.running ? cancelAgentMemoryDream(cfg, slug) : startAgentMemoryDream(cfg, slug))
        if (alive.current) setDream((previous) => previous ? { ...previous, status } : previous)
      })}>{t(dream.status.running ? 'agentMemory.stop' : 'agentMemory.run')}</button>
      <span style={hint}>{t('agentMemory.pending', { count: dream.candidates })}</span>
    </div>
    {dream.status.detail && <p style={hint}>{dream.status.detail}</p>}
    {(dream.status.finishedAt || dream.status.startedAt) && <div style={hint}>{new Date(dream.status.finishedAt || dream.status.startedAt!).toLocaleString()}</div>}
    {configDraft && <details style={{ marginTop: 8 }}><summary>{t('agentMemory.settings')}</summary>
      <div className="field" style={{ marginTop: 10 }}><label htmlFor="memory-dream-model">{t('agentMemory.model')}</label>
        <input id="memory-dream-model" value={configDraft.modelId} disabled={busy || dream.status.running} onChange={(e) => setConfigDraft({ ...configDraft, modelId: e.target.value })} /></div>
      <div style={{ ...row, alignItems: 'start' }}>
        {([{ key: 'intervalHours', label: 'agentMemory.interval', min: 1, max: 168, scale: 1 },
          { key: 'timeoutMs', label: 'agentMemory.timeout', min: 5, max: 120, scale: 1000 },
          { key: 'maxOutputTokens', label: 'agentMemory.tokens', min: 1024, max: 8192, scale: 1 }] as const).map((field) => <div className="field" key={field.key} style={{ flex: '1 1 150px' }}>
            <label htmlFor={`memory-dream-${field.key}`}>{t(field.label)}</label><input type="number" id={`memory-dream-${field.key}`} min={field.min} max={field.max}
              value={configDraft[field.key] / field.scale} disabled={busy || dream.status.running}
              onChange={(e) => setConfigDraft({ ...configDraft, [field.key]: Number(e.target.value) * field.scale })} /></div>)}
      </div>
      <button className="btn sm" disabled={busy || dream.status.running} onClick={() => void action(async () => {
        const next = await configureAgentMemoryDream(cfg, slug, configDraft)
        if (alive.current) { setDream(next); setConfigDraft(next.config); setNotice(t('settings.agents.memSaved')) }
      })}>{t('common.save')}</button>
    </details>}
  </>
  const dreamState = dream && <span role="status" style={hint}>{dream.status.running && <Loader2 size={12} className="spin" />} {t(`agentMemory.${dream.status.state}`)}</span>
  const shown = snapshot ? snapshot.entries.filter((entry) => !organized || entry.content.toLowerCase().includes(query.trim().toLowerCase()) || editing?.id === entry.id) : []
  return <div className={organized ? 'profile-memory' : undefined} data-testid="agent-memory-panel" data-agent-slug={slug} style={{ minWidth: 0 }}>
    {organized ? <div className="harness-summary">
      <span>{snapshot ? t('agentMemory.entries', { count: snapshot.entries.length }) : t(busy ? 'agentMemory.loading' : 'agentMemory.unavailable')}{dream && dream.candidates > 0 && <> · {t('agentMemory.pendingShort', { count: dream.candidates })}</>}</span>
      <button type="button" className="profile-text-action" disabled={busy} onClick={() => void action(load)}><RefreshCw size={12} />{t('agentMemory.reload')}</button>
    </div> : <>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <strong>{snapshot ? t('agentMemory.entries', { count: snapshot.entries.length }) : t(busy ? 'agentMemory.loading' : 'agentMemory.unavailable')}</strong>
        <button className="btn sm" disabled={busy} onClick={() => void action(load)}><RefreshCw size={13} />{t('agentMemory.reload')}</button>
      </div>
      {snapshot && <div style={hint}>{t('agentMemory.version')}: <code title={snapshot.version}>{snapshot.version.slice(0, 8)}</code></div>}
    </>}
    {error && <div role="alert" style={{ ...hint, color: 'var(--danger)', marginTop: 8 }}>{error}</div>}
    {notice && <div role="status" style={{ ...hint, color: 'var(--accent-ink)', marginTop: 8 }}>{notice}</div>}

    {dream && !organized && <div style={section}>
      <div style={{ ...row, justifyContent: 'space-between' }}><strong>{t('agentMemory.dream')}</strong>{dreamState}</div>
      {dreamBody}
    </div>}
    {snapshot && <>
      <div className={organized ? 'memory-list' : undefined}>
      {organized && <label className="profile-search"><Search size={14} /><input aria-label={t('agentMemory.search')} placeholder={t('agentMemory.search')} value={query} onChange={(e) => setQuery(e.target.value)} /></label>}
      {!organized && <p style={{ ...hint, marginTop: 12 }}>{t('agentMemory.forgetHint')}</p>}
      <details className={organized ? 'memory-add' : undefined} style={organized ? undefined : section}><summary>{organized && <Plus size={13} />}{t('agentMemory.add')}</summary><div className="field" style={{ marginTop: 8 }}>
        <textarea aria-label={t('agentMemory.fact')} rows={2} value={newFact} disabled={writeDisabled} onChange={(e) => setNewFact(e.target.value)} />
        <button className="btn sm" disabled={writeDisabled || !newFact.trim()} onClick={() => void action(() => update(() => mutateAgentMemoryEntry(cfg, slug,
          { action: 'add', fact: newFact, expectedVersion: snapshot.version }))) }>{t('agentMemory.add')}</button></div></details>
      <ul className={organized ? 'harness-entries' : undefined} style={organized ? undefined : { listStyle: 'none', padding: 0, margin: 0 }}>
        {shown.map((entry) => <li key={entry.id} data-memory-entry-id={entry.id} className={organized ? 'harness-entry memory-entry' : undefined} style={organized ? undefined : section}>
          {editing?.id === entry.id ? <div className="field"><textarea aria-label={t('agentMemory.fact')} value={editing.text} disabled={busy} rows={3}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
            <div style={row}><button className="btn primary sm" disabled={busy || !editing.text.trim()} onClick={() => void action(() => update(() => mutateAgentMemoryEntry(cfg, slug,
              { action: 'update', id: entry.id, fact: editing.text, expectedVersion: editing.version }))) }>{t('common.save')}</button>
              <button className="btn sm" disabled={busy} onClick={() => setEditing(null)}>{t('common.cancel')}</button></div></div>
            : <p style={organized ? undefined : { margin: '0 0 8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{entry.content}</p>}
          {organized ? <div className="memory-entry-meta">
            {/* 来源直接写在折叠标题上(对话提取 / 明确记住 / 记忆整理…),展开才是会话与证据 id —— 一眼要看的是「这条怎么来的」,不是「来源与证据」四个字 */}
            <details><summary>{t(`agentMemory.source.${entry.source.kind}`)}</summary>
              <div>{sourceText(entry.source, '')}</div><code>{entry.id}</code>
              {entry.evidenceIds.length > 0 && <div>{entry.evidenceIds.join(' · ')}</div>}</details>
            <button type="button" className="harness-undo" disabled={writeDisabled} title={t('agentMemory.edit')} aria-label={t('agentMemory.edit')} onClick={() => setEditing({ id: entry.id, text: entry.content, version: snapshot.version })}><Pencil size={13} /></button>
            <button type="button" className="harness-undo" disabled={writeDisabled} title={t('agentMemory.forget')} aria-label={t('agentMemory.forget')} onClick={() => void action(() => update(() => mutateAgentMemoryEntry(cfg, slug,
              { action: 'forget', id: entry.id, expectedVersion: snapshot.version }))) }><Eraser size={13} /></button>
          </div> : <div style={{ ...row, justifyContent: 'space-between' }}>
            <details style={{ ...hint, flex: 1 }}><summary>{t('agentMemory.source')}</summary>
              <div>{sourceText(entry.source, t(`agentMemory.source.${entry.source.kind}`))}</div><code>{entry.id}</code>
              {entry.evidenceIds.length > 0 && <div>{entry.evidenceIds.join(' · ')}</div>}</details>
            <button className="btn sm" disabled={writeDisabled} onClick={() => setEditing({ id: entry.id, text: entry.content, version: snapshot.version })}>{t('agentMemory.edit')}</button>
            <button className="btn danger sm" disabled={writeDisabled} onClick={() => void action(() => update(() => mutateAgentMemoryEntry(cfg, slug,
              { action: 'forget', id: entry.id, expectedVersion: snapshot.version }))) }>{t('agentMemory.forget')}</button>
          </div>}
        </li>)}
      </ul>
      {organized && query && snapshot.entries.length > 0 && !shown.length && <p style={hint}>{t('agentMemory.noMatches')}</p>}
      {!snapshot.entries.length && <p className={organized ? 'profile-empty' : undefined} style={organized ? undefined : hint}>{t('agentMemory.empty')}</p>}
      {organized && snapshot.entries.length > 0 && <p className="memory-footnote">{t('agentMemory.forgetHint')}</p>}
      </div>
      {organized && dream && <details className="profile-disclosure"><summary>{t('agentMemory.dream')}<small>{t(dream.config.enabled ? 'agentMemory.autoOn' : 'agentMemory.autoOff')} · {t(`agentMemory.${dream.status.state}`)}</small></summary>{dreamBody}</details>}
      <details className={organized ? 'profile-disclosure' : undefined} style={organized ? undefined : section}><summary>{t('agentMemory.raw')}</summary><div className="field" style={{ marginTop: 8 }}>
        <p style={hint}>{t('agentMemory.rawHint')}</p>
        {dirty && editorBase.version !== snapshot.version && <p role="alert" style={{ ...hint, color: 'var(--danger)' }}>{t('agentMemory.changed')}</p>}
        <textarea aria-label={t('agentMemory.document')} rows={10} value={draft} disabled={busy || dream?.status.running || Boolean(editing)} onChange={(e) => { setDraft(e.target.value); setNotice('') }} />
        <div style={row}><button className="btn primary sm" disabled={busy || !dirty || dream?.status.running || Boolean(editing)}
          onClick={() => void action(() => update(() => putAgentMemory(cfg, slug, draft, editorBase.version)))}>{t('common.save')}</button>
          {dirty && <button className="btn sm" disabled={busy} onClick={() => { setDraft(snapshot.content); setEditorBase({ version: snapshot.version, content: snapshot.content }) }}>{t('agentMemory.discard')}</button>}</div>
      </div></details>
      <details className={organized ? 'profile-disclosure' : undefined} style={organized ? undefined : section} onToggle={(e) => { if (e.currentTarget.open && revisions === null) loadRevisions() }}><summary>{t('agentMemory.revisions')}{organized && <small><code title={snapshot.version}>{snapshot.version.slice(0, 8)}</code></small>}</summary>
        <p style={hint}>{t('agentMemory.restoreHint')}</p>
        <button className="btn sm" disabled={busy} onClick={loadRevisions}>{t('agentMemory.reload')}</button>
        {revisions?.length === 0 && <p style={hint}>{t('agentMemory.noRevisions')}</p>}
        {revisions?.map((revision) => <details key={revision.version} style={{ marginTop: 8 }}><summary style={hint} title={revision.version}>
          {new Date(revision.createdAt).toLocaleString()} · {revision.version.slice(0, 8)} · {t(`agentMemory.source.${revision.source.kind}`)}</summary>
          <pre style={{ ...hint, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{revision.content}</pre>
          <button className="btn sm" disabled={writeDisabled || revision.version === snapshot.version} onClick={() => void action(() => update(() => restoreAgentMemory(cfg, slug, revision.version, snapshot.version)))}>{t('agentMemory.restore')}</button>
        </details>)}
      </details>
    </>}
  </div>
}
