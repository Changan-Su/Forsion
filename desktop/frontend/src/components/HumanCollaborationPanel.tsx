import { useCallback, useEffect, useRef, useState } from 'react'
import { FileCode2, History, Loader2, MoreHorizontal, Pencil, RefreshCw, Undo2 } from 'lucide-react'
import { Markdown } from './Markdown'
import { CapabilityMenu } from './CapabilityMenu'
import { PortraitMoveCard } from './PortraitMoveCard'
import { ExternalImportEntry } from './ExternalImport'
import { useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { formatRelative, formatDateTime } from '../format/time'
import type { TanguDesktopConfig } from '../../../../tangu-agent/src/contracts/clientTypes'
import { ABOUT_HUMAN_LIMITS, clipWholeLines } from '../../../../tangu-agent/src/contracts/promptClip'
import { dismissPortraitOverflow, getPortraitOrganize, getPortraitOverflow, pinPortraitEntry, runPortraitOrganize, undoPortraitOrganize, type MemoryOrganizeView, type PortraitOverflowItem } from '../services/backendService'
import { splitPortrait } from '../../../../tangu-agent/src/contracts/memoryLayers'
import { stripMarks } from '../../../../tangu-agent/src/contracts/entryMark'
import { DetailTopics, LayerEntries, OrganizeBar, factOf, organizeOutcomeText, residentBlocks, type LayerItem } from './MemoryLayers'
import type { EngineTarget } from '../services/engine/targets'
import { getHumanDocument, saveHumanDocument, undoHumanChange, humanTargetKey, humanLegacy, HUMAN_CHANGED_EVENT, type HumanChange, type HumanDocument, type HumanTarget, type HumanJump } from '../services/humanCollaboration'
import './humanMessages'
import './humanCollaboration.css'

type Draft = { content: string; version: string }
const drafts = new Map<string, Draft>()
/** onRewrite:把「重写」那句话发进对话(由挂载处决定发给哪个会话)。null = 这里现在发不了(没有本机会话 / 计划模式),菜单项置灰并写明原因;
 *  不传 = 这一份不归当前会话的 Agent 写(项目页里「同时适用」的那几份),不出这一项。 */
type Props = { engine: EngineTarget; cfg: TanguDesktopConfig; target: HumanTarget; name: string; running?: boolean; jump?: HumanJump; onRewrite?: (() => void) | null }
export function HumanCollaborationPanel(props: Props) {
  const key = JSON.stringify([props.engine.key, props.engine.base, props.cfg.token, humanTargetKey(props.target)])
  return <HumanBody key={key} {...props} draftKey={key} />
}
/** 画像 / 我的笔记每轮进提示词的上限(引擎 renderAboutHuman 同一份契约):线画在哪由 clipWholeLines 算,引擎截的也是它,不在这里另算一份。 */
const PROMPT_LIMIT: Record<string, number> = { soul: ABOUT_HUMAN_LIMITS['SOUL.md'], memory: ABOUT_HUMAN_LIMITS['MEMORY.md'] }
const SOURCE_KEYS = { remember: 'human.source.remember', dream: 'human.source.dream', move: 'human.source.move', promote: 'human.source.promote', user: 'human.source.user', import: 'human.source.import' } as const
function HumanBody({ engine, target, name, running, jump, onRewrite, draftKey }: Props & { draftKey: string }) {
  const { t, locale } = useI18n()
  const agentDefs = useApp((s) => s.agentDefs)
  const sourceText = (source: HumanChange['source']) => {
    const key = source && SOURCE_KEYS[source.kind]
    return key ? t(key, { agent: agentDefs.find((a) => a.slug === source.agent)?.name || source.agent || '' }) : ''
  }
  // human/ 的四份各有自己的标题和空态;起手模板是 Agent 口吻的协作说明,只给 Agent / 项目那两份
  const file = target.kind === 'human' ? target.file.slice(0, -3).toLowerCase() : null
  const template = file ? '' : t('human.template')
  const [doc, setDoc] = useState<HumanDocument | null>(null)
  const [draft, setDraft] = useState<Draft | null>(() => drafts.get(draftKey) || null)
  const draftRef = useRef(draft); draftRef.current = draft
  const [source, setSource] = useState(false), [history, setHistory] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false), [latest, setLatest] = useState<HumanDocument | null>(null)
  // Dream 因为画像满了、记在各 Agent 那里的条目(只画像那份有;旧引擎 / 读不出 = 不提示)
  const [overflow, setOverflow] = useState<PortraitOverflowItem[]>([]), [overflowOpen, setOverflowOpen] = useState(false)
  // 记忆分层(11-09 第二步):整理记录 / 有没有后台模型;旧引擎没有这条路由 = null,界面照第一步
  const [organize, setOrganize] = useState<MemoryOrganizeView | null>(null), [organizing, setOrganizing] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null), caretAt = useRef<number | null>(null)
  const alive = useRef(true), seq = useRef(0), processedJump = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; seq.current++ } }, [])
  const changeDraft = (next: Draft | null) => { draftRef.current = next; setDraft(next); if (next) drafts.set(draftKey, next); else drafts.delete(draftKey) }
  const errorText = (e: any) => e?.code === 'HUMAN_LOCAL_ONLY' ? t('human.localOnly') : e?.code === 'HUMAN_REMOTE_DENIED' ? t('human.remoteDenied') : String(e?.message || e)
  const load = useCallback(async () => {
    const n = ++seq.current
    try { const d = await getHumanDocument(engine, target); if (alive.current && n === seq.current) { setDoc(d); const pending = draftRef.current; if (pending && pending.version !== d.version && pending.content === d.content) changeDraft(null); if (!draftRef.current) setError('') } }
    catch (e) { if (alive.current && n === seq.current) setError(errorText(e)) }
    if (file === 'soul') {
      try { const o = await getPortraitOverflow(engine); if (alive.current) setOverflow(o.items) } catch { if (alive.current) setOverflow([]) }
      try { const v = await getPortraitOrganize(engine); if (alive.current) setOrganize(v) } catch { if (alive.current) setOrganize(null) }
    }
  }, [draftKey, locale]) // identity is encoded by draftKey
  useEffect(() => { void load(); const refresh = () => { void load() }; window.addEventListener(HUMAN_CHANGED_EVENT, refresh); return () => window.removeEventListener(HUMAN_CHANGED_EVENT, refresh) }, [load, running])
  useEffect(() => {
    if (!doc || !jump?.at || processedJump.current === jump.at) return
    processedJump.current = jump.at
    if (jump.edit && !draftRef.current) changeDraft({ content: doc.content || template, version: doc.version })
    if (jump.changeId) setHistory(true)
  }, [jump, doc])
  const save = async (version = draft?.version) => {
    if (!draft || !version || busy) return
    const submitted = draft
    setBusy(true); setError(''); setNotice(''); ++seq.current
    try { const r = await saveHumanDocument(engine, target, draft.content, version, target.kind === 'human' ? t('human.userEditFile', { file: target.file }) : t('human.userEdit')); if (drafts.get(draftKey) === submitted) drafts.delete(draftKey); if (alive.current) { setDoc(r.document); changeDraft(null); setConflict(false); setLatest(null); setNotice(t('human.saved')) } }
    catch (e: any) { if (alive.current) { setConflict(e?.status === 409); setError(e?.status === 409 ? t('human.conflict') : errorText(e)) } }
    finally { if (alive.current) setBusy(false) }
  }
  const undo = async (change: HumanChange) => {
    if (busy || draft) return
    setBusy(true); setError(''); ++seq.current
    try { const r = await undoHumanChange(engine, target, change); if (alive.current) { setDoc(r.document); setNotice(t('human.undone')) } }
    catch (e: any) { if (alive.current) setError(e?.status === 409 ? t('human.undoConflict') : errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  // 「整理画像」第一步 = 进入编辑,光标停在线上(textarea 画不了高亮;编辑框下面随打随算还剩几条在线外)
  const tidy = () => {
    if (!doc || draft || busy) return
    // 线算在去掉记号的常驻上:光标落到线外第一条在原文里的位置
    const first = layered && over ? blocks.find((b) => b.outside) : null
    const at = first ? doc.content.indexOf(first.kind === 'entries' ? factOf(first.items[0]) : first.md.split('\n')[0]) : -1
    caretAt.current = at >= 0 ? at : null; changeDraft({ content: doc.content, version: doc.version })
  }
  /** 后台整理(配了后台模型才有这颗按钮):成了 / 没成都说一句,画像和记录重新读。 */
  const runOrganize = async () => {
    if (organizing || busy || draft) return
    setOrganizing(true); setError(''); setNotice('')
    try { const o = await runPortraitOrganize(engine); if (alive.current) setNotice(organizeOutcomeText(t, o, num)) }
    catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) { setOrganizing(false); void load() } }
  }
  const undoOrganize = async (id: string) => {
    if (busy || draft) return
    setBusy(true); setError(''); setNotice('')
    try { await undoPortraitOrganize(engine, id); if (alive.current) setNotice(t('memoryLayers.undoneNotice')) }
    catch (e: any) { if (alive.current) setError(e?.status === 409 ? t('human.undoConflict') : errorText(e)) }
    finally { if (alive.current) { setBusy(false); void load() } }
  }
  /** 钉住 / 取消;详情里的那条钉住 = 挪回常驻。按原句指,带着读到的版本(别处改过 = 409,重读)。 */
  const pin = async (item: LayerItem, pinned: boolean) => {
    if (!doc || busy || draft) return
    setBusy(true); setError(''); setNotice('')
    try { await pinPortraitEntry(engine, { fact: factOf(item), pinned, expectedVersion: doc.version }) }
    catch (e: any) { if (alive.current) setError(e?.status === 409 ? t('human.conflict') : errorText(e)) }
    finally { if (alive.current) { setBusy(false); void load() } }
  }
  useEffect(() => {
    const at = caretAt.current, ta = editorRef.current
    if (at === null || !ta || !draft) return
    caretAt.current = null
    ta.focus(); ta.setSelectionRange(at, at)
    const line = parseFloat(getComputedStyle(ta).lineHeight) || 20
    ta.scrollTop = Math.max(0, (draft.content.slice(0, at).split('\n').length - 3) * line)
  }, [draft])
  const dismissOverflow = async () => { try { await dismissPortraitOverflow(engine); if (alive.current) { setOverflow([]); setOverflowOpen(false) } } catch (e) { if (alive.current) setError(errorText(e)) } }
  const rewrite = () => { if (!onRewrite || running || draft) return; setError(''); onRewrite(); setNotice(t('human.rewrite.sent')) }
  const limit = file ? PROMPT_LIMIT[file] : undefined
  // 画像分层(11-09 第二步):量的是常驻(详情各节不算、行尾记号不算),和引擎注入同一个口径;线也画在常驻上
  const layered = file === 'soul'
  const layers = layered && doc ? splitPortrait(doc.content) : null
  const measured = (content: string) => (layered ? stripMarks(splitPortrait(content).resident) : content)
  const cut = doc && limit ? clipWholeLines(measured(doc.content), limit) : null
  const over = cut && cut.cutAt !== null ? cut : null
  const draftCut = draft && limit ? clipWholeLines(measured(draft.content), limit) : null
  const blocks = layers ? residentBlocks(layers.resident, over ? over.cutAt : null) : []
  const detailTopics = layers ? layers.topics.filter((x) => x.key !== 'archive').map((x) => ({ key: x.key, title: x.title, about: x.about, entries: x.entries.map((e) => ({ id: e.id, text: e.text, by: e.meta.by })) })) : []
  const archiveTopic = layers?.topics.find((x) => x.key === 'archive')
  const archive = archiveTopic ? { key: 'archive', title: archiveTopic.title, about: archiveTopic.about, entries: archiveTopic.entries.map((e) => ({ id: e.id, text: e.text, by: e.meta.by })) } : null
  const agentName = (slug: string) => agentDefs.find((a) => a.slug === slug)?.name || slug
  const num = (n: number) => (locale === 'zh' ? String(n) : new Intl.NumberFormat('en-US').format(n))
  const reviewLatest = async () => { try { const d = await getHumanDocument(engine, target); if (alive.current) setLatest(d) } catch (e) { if (alive.current) setError(errorText(e)) } }
  return <section className="human-panel" data-human-scope={target.kind} data-human-file={target.kind === 'human' ? target.file : undefined} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's' && draft) { e.preventDefault(); e.stopPropagation(); void save() } }}>
    <header className="human-heading"><div><h3>{t(file ? `human.file.${file}.title` : 'human.title')}</h3><p>{file ? t(`human.file.${file}.caption`) : target.kind === 'agent' ? t('human.agentScope', { name }) : t('human.projectScope')}</p></div><div className="human-actions">
      {!draft && <button type="button" className="profile-text-action" disabled={!doc || busy} onClick={() => doc && changeDraft({ content: doc.content || template, version: doc.version })}><Pencil size={13} />{t('human.edit')}</button>}
      <CapabilityMenu className="profile-text-action human-more" label={t('human.more')} disabled={!doc} items={[
        { id: 'source', label: t(source ? 'human.preview' : 'human.source'), icon: <FileCode2 size={14} />, onSelect: () => setSource(!source) },
        { id: 'history', label: t('human.history'), icon: <History size={14} />, onSelect: () => setHistory(!history) },
        ...(onRewrite !== undefined ? [{ id: 'rewrite', label: t('human.rewrite'), icon: <RefreshCw size={14} />, hint: onRewrite ? undefined : t('human.rewrite.unavailable'), disabled: !onRewrite || !!running || !!draft || !doc?.content.trim(), onSelect: rewrite }] : []),
      ]}><MoreHorizontal size={16} /></CapabilityMenu>
    </div></header>
    {error && <p className="agent-profile-error" role="alert">{error} {!doc && <button type="button" className="profile-text-action" onClick={() => void load()}>{t('human.retry')}</button>}</p>}
    {notice && <p className="human-notice" role="status">{notice}</p>}
    {doc && !draft && !file && humanLegacy(doc) && <p className="human-notice" data-human-legacy>{t('human.legacy')} {onRewrite && <button type="button" className="profile-text-action" disabled={!!running} onClick={rewrite}><RefreshCw size={12} />{t('human.rewrite')}</button>}</p>}
    {!doc && !error && <p className="agent-profile-muted" role="status"><Loader2 size={14} className="spin" /> {t('human.loading')}</p>}
    {doc && over && <p className="human-notice human-over" data-prompt-over-budget={file}>{t(file === 'soul' ? 'human.portraitOver' : 'human.notesOver', { limit: num(over.limit), chars: num(over.chars), n: over.outside })}
      {file === 'soul' && !draft && <button type="button" className="profile-text-action" disabled={busy} onClick={tidy} data-portrait-tidy><Pencil size={12} />{t('human.portraitTidy')}</button>}
      {file === 'soul' && !draft && organize && !organize.available && <span className="human-over-hint">{t('memoryLayers.noModel')}</span>}</p>}
    {doc && layered && !draft && organize && <OrganizeBar view={organize} busy={busy} running={organizing || organize.running} onOrganize={() => void runOrganize()} onUndo={(id) => void undoOrganize(id)}
      summary={<>{t('memoryLayers.residentChars', { chars: num(cut?.chars ?? 0), limit: num(limit ?? 0) })}{detailTopics.length > 0 && <> · {t('memoryLayers.detailCount', { n: detailTopics.length })}</>}</>} />}
    {doc && file === 'soul' && !draft && overflow.length > 0 && <div className="human-overflow" data-portrait-overflow>
      <p>{t('human.overflow.title', { n: overflow.length })}
        <button type="button" className="profile-text-action" aria-expanded={overflowOpen} onClick={() => setOverflowOpen(!overflowOpen)}>{t(overflowOpen ? 'human.overflow.hide' : 'human.overflow.show')}</button>
        <button type="button" className="profile-text-action" onClick={() => void dismissOverflow()}>{t('human.overflow.dismiss')}</button></p>
      {overflowOpen && <ul>{overflow.map((x) => <li key={`${x.agent}:${x.fact}`}>{t('human.overflow.item', { agent: agentName(x.agent), fact: x.fact })}</li>)}</ul>}
    </div>}
    {doc && file === 'soul' && !draft && <ExternalImportEntry engine={engine} />}
    {doc && file === 'soul' && !draft && <PortraitMoveCard engine={engine} />}
    {doc?.updatedAt && <p className="human-date">{t('human.updatedAt', { time: formatRelative(doc.updatedAt, { locale }) })}</p>}
    {draft ? <div className="human-editor"><textarea ref={editorRef} aria-label={file ? t('human.editFile', { name: t(`human.file.${file}.title`) }) : t('human.editLabel')} value={draft.content} maxLength={doc?.maxLength || 12000} rows={15} onChange={e => changeDraft({ ...draft, content: e.target.value })} disabled={busy} />
      {draftCut && <p className="human-draft-budget" data-prompt-draft-budget={draftCut.cutAt === null ? 'fits' : 'over'}>{draftCut.cutAt === null ? t('human.draftFits', { chars: num(draftCut.chars), limit: num(draftCut.limit) }) : t('human.draftOver', { chars: num(draftCut.chars), limit: num(draftCut.limit), n: draftCut.outside })}</p>}
      <div className="human-actions"><button type="button" className="btn primary sm" disabled={busy || conflict} onClick={() => void save()}>{busy && <Loader2 size={13} className="spin" />}{t('human.save')}</button><button type="button" className="btn sm" disabled={busy} onClick={() => { changeDraft(null); setConflict(false); setLatest(null); setError('') }}>{t('human.cancel')}</button></div>
      {conflict && <button type="button" className="profile-text-action" onClick={() => void reviewLatest()}>{t('human.latest')}</button>}
      {latest && <section className="human-latest"><div className="md-body"><Markdown content={latest.content} allowRun={false} /></div><button type="button" className="btn sm" disabled={busy} onClick={() => void save(latest.version)}>{t('human.merge')}</button></section>}
    </div> : doc && layered && !source && doc.content ? <div className="memory-layers" data-portrait-layers>
      {detailTopics.length > 0 && <h4 className="memory-layer-head">{t('memoryLayers.resident')}</h4>}
      {blocks.map((b, i) => {
        const node = b.kind === 'text' ? <div className="md-body" key={i}><Markdown content={b.md} allowRun={false} /></div>
          : <LayerEntries key={i} items={b.items} busy={busy} onPin={(it, p) => void pin(it, p)} />
        const first = b.outside && !blocks.slice(0, i).some((x) => x.outside)
        return b.outside ? <div key={i}>{first && <div className="human-cutline" role="separator" data-prompt-cutline><span>{t('human.cutline')}</span></div>}<div className="human-outside" data-prompt-outside>{node}</div></div> : node
      })}
      <DetailTopics topics={detailTopics} archive={archive} busy={busy} onPinBack={(it) => void pin({ ...it, id: `0:${it.text.split('\n')[0]}` }, true)} />
    </div> : doc && (doc.content ? over && !layered
      // 线内 / 线外分两段画,中间一条实线「Agent 每轮读到这里」,线外变淡;分在哪由 clipWholeLines(和引擎同一个函数)给
      ? <>{source ? <pre className="human-source">{doc.content.slice(0, over.cutAt!)}</pre> : <div className="md-body"><Markdown content={doc.content.slice(0, over.cutAt!)} allowRun={false} /></div>}
        <div className="human-cutline" role="separator" data-prompt-cutline><span>{t('human.cutline')}</span></div>
        <div className="human-outside" data-prompt-outside>{source ? <pre className="human-source">{doc.content.slice(over.cutAt!).replace(/^\s*\n/, '')}</pre> : <div className="md-body"><Markdown content={doc.content.slice(over.cutAt!)} allowRun={false} /></div>}</div></>
      : source ? <pre className="human-source">{doc.content}</pre> : <div className="md-body"><Markdown content={doc.content} allowRun={false} /></div> : <p className="human-empty">{t(file ? `human.file.${file}.empty` : 'human.empty')}</p>)}
    {source && doc && <div className="human-path"><span>{t('human.path')}</span><code>{doc.path}</code></div>}
    {history && doc && <section className="human-history"><h4>{t('human.history')}</h4>{!doc.history.length && <p>{t('human.noHistory')}</p>}
      {doc.history.map(change => <article key={change.id} data-human-change={change.id} className={change.id === jump?.changeId ? 'human-highlight' : undefined}>
        <strong>{change.summary}</strong><time dateTime={change.at}>{formatDateTime(change.at, { locale })}</time>
        {sourceText(change.source) && <p data-human-source={change.source!.kind}>{sourceText(change.source)}</p>}
        {change.evidence && <p>{change.evidence}</p>}
        {change.canUndo && <button type="button" className="profile-text-action" disabled={busy || !!draft} onClick={() => void undo(change)}><Undo2 size={12} />{t('human.undo')}</button>}
      </article>)}
    </section>}
  </section>
}
